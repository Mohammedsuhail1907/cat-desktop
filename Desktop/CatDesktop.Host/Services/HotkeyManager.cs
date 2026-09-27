using System.Globalization;
using System.Runtime.InteropServices;
using CatDesktop.Host.App;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Models;
using CatDesktop.Host.Native;

namespace CatDesktop.Host.Services;

/// <summary>
/// Registers the global keyboard shortcuts on a message-only window and raises <see cref="Pressed"/>
/// with the binding name. <see cref="Apply"/> is atomic: when any gesture cannot be registered the
/// previous set is restored and the caller receives a "denied" bridge error. <see cref="Suspend"/> releases the
/// shortcuts temporarily (the Settings recorder must be able to capture a gesture that is currently registered).
/// </summary>
public sealed class HotkeyManager : IDisposable
{
    private const int ErrorHotkeyAlreadyRegistered = 1409;
    /// <summary>Safety net: a suspension nobody ends (page reloaded, window closed mid-recording) ends by itself.</summary>
    private static readonly TimeSpan MaxSuspension = TimeSpan.FromSeconds(60);

    private static readonly IReadOnlyDictionary<string, int> BindingIds = new Dictionary<string, int>(StringComparer.Ordinal)
    {
        [Hotkeys.ToggleCatName] = 1,
        [Hotkeys.StartFocusName] = 2,
        [Hotkeys.QuickNoteName] = 3,
    };

    private sealed record Registration(int Id, string Name, string Gesture, uint Modifiers, uint VirtualKey);

    private readonly Logger _log;
    private readonly int _uiThreadId;
    private readonly MessageWindow _window;
    private readonly System.Windows.Forms.Timer _resumeTimer;
    /// <summary>The configured bindings. Registered with Windows unless <see cref="_suspended"/>.</summary>
    private List<Registration> _registered = new();
    private bool _suspended;
    private bool _disposed;

    public event Action<string>? Pressed;

    /// <summary>
    /// The bindings in effect (all null until the first successful Apply). While suspended they are still reported,
    /// although Windows does not deliver them until the suspension ends.
    /// </summary>
    public Hotkeys Current { get; private set; } = Hotkeys.None;

    public HotkeyManager(Logger log)
    {
        _log = log;
        _uiThreadId = Environment.CurrentManagedThreadId;
        _window = new MessageWindow(this);
        _resumeTimer = new System.Windows.Forms.Timer { Interval = (int)MaxSuspension.TotalMilliseconds };
        _resumeTimer.Tick += (_, _) =>
        {
            _log.Info($"Global hotkeys were suspended for {MaxSuspension.TotalSeconds:0} s; resuming them.");
            Suspend(false);
        };
    }

    public void Apply(Hotkeys hotkeys)
    {
        ArgumentNullException.ThrowIfNull(hotkeys);
        ObjectDisposedException.ThrowIf(_disposed, this);
        EnsureUiThread(nameof(Apply));

        var wanted = ParseBindings(hotkeys);

        // While suspended nothing is registered; the new set is still registered once to prove it is available.
        var previous = _registered;
        if (!_suspended) UnregisterAll(previous);

        var registered = new List<Registration>(wanted.Count);
        foreach (var binding in wanted)
        {
            if (Register(binding))
            {
                registered.Add(binding);
                continue;
            }

            var error = Marshal.GetLastPInvokeError();
            _log.Warn($"RegisterHotKey failed for {binding.Name} '{binding.Gesture}' (win32 error {error}); restoring previous shortcuts.");
            UnregisterAll(registered);
            _registered = _suspended ? previous : RegisterAll(previous);
            throw BridgeException.Denied(error == ErrorHotkeyAlreadyRegistered
                ? $"Shortcut '{binding.Gesture}' is already in use by another application."
                : $"Shortcut '{binding.Gesture}' could not be registered (error {error}).");
        }

        if (_suspended) UnregisterAll(registered); // registered again when the suspension ends
        _registered = registered;
        Current = new Hotkeys
        {
            ToggleCat = Normalise(hotkeys.ToggleCat),
            StartFocus = Normalise(hotkeys.StartFocus),
            QuickNote = Normalise(hotkeys.QuickNote),
        };
        _log.Info((registered.Count == 0
            ? "Global hotkeys: none registered."
            : "Global hotkeys: " + string.Join(", ", registered.Select(r => $"{r.Name}={r.Gesture}")))
            + (_suspended ? " (suspended)" : ""));
    }

    /// <summary>
    /// <paramref name="suspended"/> true releases every global shortcut (so the Settings recorder receives the keys);
    /// false registers them again, best effort. <see cref="Current"/> keeps reporting the configured bindings while
    /// suspended. A suspension ends by itself after <see cref="MaxSuspension"/>; suspending again restarts that clock.
    /// </summary>
    public void Suspend(bool suspended)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        EnsureUiThread(nameof(Suspend));

        if (suspended)
        {
            _resumeTimer.Stop();
            _resumeTimer.Start();
            if (_suspended) return;
            _suspended = true;
            UnregisterAll(_registered);
            _log.Info("Global hotkeys suspended.");
            return;
        }

        _resumeTimer.Stop();
        if (!_suspended) return;
        _suspended = false;
        var restored = RegisterAll(_registered); // logs every shortcut that could not be registered again
        if (restored.Count != _registered.Count)
        {
            // Another application took a shortcut meanwhile: report what is really in effect.
            Current = new Hotkeys
            {
                ToggleCat = restored.FirstOrDefault(r => r.Name == Hotkeys.ToggleCatName)?.Gesture,
                StartFocus = restored.FirstOrDefault(r => r.Name == Hotkeys.StartFocusName)?.Gesture,
                QuickNote = restored.FirstOrDefault(r => r.Name == Hotkeys.QuickNoteName)?.Gesture,
            };
        }
        _registered = restored;
        _log.Info("Global hotkeys resumed.");
    }

    private void EnsureUiThread(string member)
    {
        if (Environment.CurrentManagedThreadId != _uiThreadId)
        {
            throw new InvalidOperationException($"HotkeyManager.{member} must be called on the UI thread that created it.");
        }
    }

    /// <summary>
    /// Parses "Ctrl+Shift+P" style gestures. Modifiers: Ctrl/Control, Shift, Alt, Win. Key: a letter or digit,
    /// F1..F24, a named key (Space, Enter, Esc, Tab, Home, End, PageUp, PageDown, Insert, Delete, arrows) or any
    /// <see cref="Keys"/> name. At least one modifier is required unless the key is a function key.
    /// </summary>
    public static bool TryParse(string gesture, out uint modifiers, out uint virtualKey, out string error)
    {
        modifiers = 0;
        virtualKey = 0;
        error = "";

        if (string.IsNullOrWhiteSpace(gesture))
        {
            error = "Shortcut is empty.";
            return false;
        }

        var text = gesture.Trim();
        if (text.Length > 64)
        {
            error = "Shortcut text is too long.";
            return false;
        }

        // Work on locals so the out values stay zero whenever parsing fails part-way through.
        uint mods = 0;
        uint vk = 0;
        var hasKey = false;
        var isFunctionKey = false;
        foreach (var rawPart in text.Split('+'))
        {
            var part = rawPart.Trim();
            if (part.Length == 0)
            {
                error = $"Shortcut '{text}' contains an empty part.";
                return false;
            }

            var modifier = ParseModifier(part);
            if (modifier != 0)
            {
                mods |= modifier;
                continue;
            }

            if (hasKey)
            {
                error = $"Shortcut '{text}' has more than one key.";
                return false;
            }
            if (!TryParseKey(part, out vk, out isFunctionKey))
            {
                error = $"Unknown key '{part}' in shortcut '{text}'.";
                return false;
            }
            hasKey = true;
        }

        if (!hasKey)
        {
            error = $"Shortcut '{text}' has no key.";
            return false;
        }
        if (mods == 0 && !isFunctionKey)
        {
            error = $"Shortcut '{text}' needs at least one modifier (Ctrl, Shift, Alt or Win).";
            return false;
        }

        modifiers = mods;
        virtualKey = vk;
        return true;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _resumeTimer.Dispose();
        if (!_suspended) UnregisterAll(_registered);
        _registered = new List<Registration>();
        _window.DestroyHandle();
    }

    // ---- Registration -----------------------------------------------------------------------

    private static List<Registration> ParseBindings(Hotkeys hotkeys)
    {
        var result = new List<Registration>(BindingIds.Count);
        foreach (var (name, gesture) in hotkeys.Bindings())
        {
            if (!BindingIds.TryGetValue(name, out var id))
            {
                throw new InvalidOperationException($"No hotkey id is defined for binding '{name}'.");
            }
            if (!TryParse(gesture, out var modifiers, out var virtualKey, out var error))
            {
                throw BridgeException.Validation($"{name}: {error}");
            }
            var duplicate = result.FirstOrDefault(r => r.Modifiers == modifiers && r.VirtualKey == virtualKey);
            if (duplicate is not null)
            {
                throw BridgeException.Validation($"Shortcut '{gesture.Trim()}' is assigned to both {duplicate.Name} and {name}.");
            }
            result.Add(new Registration(id, name, gesture.Trim(), modifiers, virtualKey));
        }
        return result;
    }

    private bool Register(Registration binding)
        => NativeMethods.RegisterHotKey(_window.Handle, binding.Id, binding.Modifiers | NativeMethods.MOD_NOREPEAT, binding.VirtualKey);

    private List<Registration> RegisterAll(List<Registration> bindings)
    {
        var restored = new List<Registration>(bindings.Count);
        foreach (var binding in bindings)
        {
            if (Register(binding)) restored.Add(binding);
            else _log.Warn($"Could not restore shortcut {binding.Name} '{binding.Gesture}' (win32 error {Marshal.GetLastPInvokeError()}).");
        }
        return restored;
    }

    private void UnregisterAll(IEnumerable<Registration> bindings)
    {
        foreach (var binding in bindings)
        {
            if (!NativeMethods.UnregisterHotKey(_window.Handle, binding.Id))
            {
                _log.Warn($"UnregisterHotKey failed for {binding.Name} (win32 error {Marshal.GetLastPInvokeError()}).");
            }
        }
    }

    private void OnHotkeyMessage(int id)
    {
        var binding = _registered.FirstOrDefault(r => r.Id == id);
        if (binding is null) return;
        _log.Trace($"Hotkey {binding.Name} ({binding.Gesture}) pressed.");
        try
        {
            Pressed?.Invoke(binding.Name);
        }
        catch (Exception ex)
        {
            _log.Error($"Hotkey handler for {binding.Name} failed", ex);
        }
    }

    private static string? Normalise(string? gesture)
        => string.IsNullOrWhiteSpace(gesture) ? null : gesture.Trim();

    // ---- Gesture grammar --------------------------------------------------------------------

    private static uint ParseModifier(string part) => part.ToLowerInvariant() switch
    {
        "ctrl" or "control" => NativeMethods.MOD_CONTROL,
        "shift" => NativeMethods.MOD_SHIFT,
        "alt" => NativeMethods.MOD_ALT,
        "win" or "windows" => NativeMethods.MOD_WIN,
        _ => 0,
    };

    private static bool TryParseKey(string part, out uint virtualKey, out bool isFunctionKey)
    {
        virtualKey = 0;
        isFunctionKey = false;

        if (part.Length == 1)
        {
            var c = char.ToUpperInvariant(part[0]);
            if (c is (>= 'A' and <= 'Z') or (>= '0' and <= '9'))
            {
                virtualKey = c;
                return true;
            }
            return false;
        }

        if ((part[0] == 'F' || part[0] == 'f')
            && int.TryParse(part.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            && number is >= 1 and <= 24)
        {
            virtualKey = (uint)Keys.F1 + (uint)(number - 1);
            isFunctionKey = true;
            return true;
        }

        var named = part.ToLowerInvariant() switch
        {
            "space" => Keys.Space,
            "enter" or "return" => Keys.Enter,
            "esc" or "escape" => Keys.Escape,
            "tab" => Keys.Tab,
            "home" => Keys.Home,
            "end" => Keys.End,
            "pageup" or "pgup" => Keys.PageUp,
            "pagedown" or "pgdn" => Keys.PageDown,
            "insert" or "ins" => Keys.Insert,
            "delete" or "del" => Keys.Delete,
            "up" => Keys.Up,
            "down" => Keys.Down,
            "left" => Keys.Left,
            "right" => Keys.Right,
            "backspace" => Keys.Back,
            _ => Keys.None,
        };
        if (named != Keys.None)
        {
            virtualKey = (uint)named;
            return true;
        }

        // Enum.TryParse would also accept plain numbers and comma-separated flag lists; neither is a key name.
        if (char.IsDigit(part[0]) || part.Contains(',')) return false;
        if (!Enum.TryParse<Keys>(part, ignoreCase: true, out var key)) return false;
        if ((key & ~Keys.KeyCode) != 0) return false;
        var code = (uint)key;
        if (code is 0 or > 0xFE) return false;
        if (key is Keys.ShiftKey or Keys.LShiftKey or Keys.RShiftKey
            or Keys.ControlKey or Keys.LControlKey or Keys.RControlKey
            or Keys.Menu or Keys.LMenu or Keys.RMenu
            or Keys.LWin or Keys.RWin)
        {
            return false;
        }

        virtualKey = code;
        isFunctionKey = key is >= Keys.F1 and <= Keys.F24;
        return true;
    }

    // ---- Message-only window ----------------------------------------------------------------

    private sealed class MessageWindow : NativeWindow
    {
        private static readonly IntPtr HwndMessage = new(-3);
        private readonly HotkeyManager _owner;

        public MessageWindow(HotkeyManager owner)
        {
            _owner = owner;
            CreateHandle(new CreateParams { Parent = HwndMessage, Caption = "CatDesktop.Hotkeys" });
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == NativeMethods.WM_HOTKEY)
            {
                _owner.OnHotkeyMessage((int)m.WParam);
            }
            base.WndProc(ref m);
        }
    }
}

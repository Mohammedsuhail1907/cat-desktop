using System.Diagnostics;
using CatDesktop.Host.App;
using CatDesktop.Host.Native;

namespace CatDesktop.Host.Cat;

/// <summary>
/// The ONLY seam that makes the cat window ignore the mouse. <see cref="CatClickThrough"/> decides WHEN the window should
/// let clicks through; an implementation of this interface decides HOW. Swap the implementation passed to
/// <see cref="CatClickThrough"/> to change the technique.
/// </summary>
internal interface ICatMouseTransparency
{
    /// <summary>Short name for the log.</summary>
    string Name { get; }

    /// <summary>True when <see cref="Apply"/> really changes how the window receives the mouse.</summary>
    bool IsEffective { get; }

    /// <summary>
    /// Bring the window in line with the state: <paramref name="clickThroughMode"/> is the settings/override mode,
    /// <paramref name="ignoreMouse"/> whether clicks should pass through right now. Called again for a new window handle.
    /// </summary>
    void Apply(CatWindow window, bool clickThroughMode, bool ignoreMouse);
}

/// <summary>
/// WS_EX_LAYERED | WS_EX_TRANSPARENT with SetLayeredWindowAttributes(alpha 255, LWA_ALPHA): WindowFromPoint then skips the
/// window and clicks reach whatever is below. Requires the composition-hosted WebView2 (<see cref="CatCompositionHost"/>):
/// the windowed WebView2 control becomes invisible in a layered window, the visual-hosted one keeps rendering (verified
/// on the development machine). While click-through MODE is on but the cat is temporarily interactive (hover-to-interact)
/// only WS_EX_TRANSPARENT is removed, so the window is not switched between layered and normal composition on every
/// hover; with the mode off the window has neither style.
/// </summary>
internal sealed class LayeredMouseTransparency : ICatMouseTransparency
{
    public const int Mask = NativeMethods.WS_EX_LAYERED | NativeMethods.WS_EX_TRANSPARENT;

    public string Name => "WS_EX_LAYERED | WS_EX_TRANSPARENT on the composition-hosted window";

    public bool IsEffective => true;

    /// <summary>The extended styles for a state; the rest of the window's styles are left alone.</summary>
    public static int ExStyleFor(bool clickThroughMode, bool ignoreMouse)
        => !clickThroughMode ? 0 : NativeMethods.WS_EX_LAYERED | (ignoreMouse ? NativeMethods.WS_EX_TRANSPARENT : 0);

    public void Apply(CatWindow window, bool clickThroughMode, bool ignoreMouse)
    {
        var wanted = ExStyleFor(clickThroughMode, ignoreMouse);
        window.MouseExStyle = wanted; // CreateParams reproduces it for a recreated handle
        if (!window.IsHandleCreated || window.IsDisposed) return;

        var hwnd = window.Handle;
        var current = NativeMethods.GetWindowLong(hwnd, NativeMethods.GWL_EXSTYLE);
        var next = (current & ~Mask) | wanted;
        if (next != current) NativeMethods.SetWindowLong(hwnd, NativeMethods.GWL_EXSTYLE, next);
        // A layered window is not shown until its attributes are set; alpha 255 = fully opaque constant alpha, so the
        // page's own per-pixel alpha is all that shows.
        if ((wanted & NativeMethods.WS_EX_LAYERED) != 0) NativeMethods.SetLayeredWindowAttributes(hwnd, 0, 255, NativeMethods.LWA_ALPHA);
    }
}

/// <summary>
/// Click-through state of the cat window (contract §5 and cat.setClickThrough) and the hover-to-interact watcher.
/// The watcher polls the cursor at ~15 Hz, and only while click-through with hover is active and the window is visible:
/// after the cursor has stayed on the hit region for 350 ms the cat becomes interactive, and 800 ms after the cursor
/// left the window it goes back to click-through. Each switch raises <see cref="InteractiveChanged"/>. The state machine
/// runs the same whether or not the current <see cref="ICatMouseTransparency"/> is effective, so the UI sees one
/// consistent event sequence. UI thread only.
/// </summary>
internal sealed class CatClickThrough : IDisposable
{
    private const int PollIntervalMs = 66;
    public static readonly TimeSpan HoverDelay = TimeSpan.FromMilliseconds(350);
    public static readonly TimeSpan LeaveDelay = TimeSpan.FromMilliseconds(800);

    private readonly CatWindow _window;
    private readonly ICatMouseTransparency _transparency;
    private readonly Func<Point, bool> _isOnHitRegion;
    private readonly Func<bool> _isBusy;
    private readonly Logger _log;
    private readonly System.Windows.Forms.Timer _poll = new() { Interval = PollIntervalMs };
    private readonly Stopwatch _clock = Stopwatch.StartNew();

    private long _insideSinceMs = -1;
    private long _outsideSinceMs = -1;

    /// <param name="isOnHitRegion">Screen point (physical px) → is it on the cat's hit region.</param>
    /// <param name="isBusy">True while the cat must stay interactive regardless of the cursor (a drag is running).</param>
    public CatClickThrough(CatWindow window, ICatMouseTransparency transparency, Func<Point, bool> isOnHitRegion,
        Func<bool> isBusy, Logger log)
    {
        _window = window;
        _transparency = transparency;
        _isOnHitRegion = isOnHitRegion;
        _isBusy = isBusy;
        _log = log;
        _poll.Tick += OnPoll;
        log.Info($"Cat click-through technique: {transparency.Name}.");
    }

    /// <summary>Click-through mode: the window ignores the mouse unless hover-to-interact made it interactive.</summary>
    public bool Enabled { get; private set; }

    public bool HoverToInteract { get; private set; }

    /// <summary>In click-through mode: the cursor has rested on the cat, which currently receives the mouse.</summary>
    public bool Interactive { get; private set; }

    /// <summary>True when the window should currently let clicks through to the windows below.</summary>
    public bool IgnoresMouse => Enabled && !Interactive;

    public event Action<bool>? InteractiveChanged;

    /// <summary>
    /// Switch mode. Entering click-through (or changing its hover option) starts non-interactive; asking for the mode
    /// that is already in effect keeps the current hover state.
    /// </summary>
    public void Configure(bool enabled, bool hoverToInteract)
    {
        if (enabled == Enabled && (enabled && hoverToInteract) == HoverToInteract)
        {
            Refresh();
            return;
        }
        Enabled = enabled;
        HoverToInteract = enabled && hoverToInteract;
        Interactive = false;
        _insideSinceMs = -1;
        _outsideSinceMs = -1;
        _log.Trace($"Cat click-through: enabled={enabled} hoverToInteract={HoverToInteract} (effective={_transparency.IsEffective}).");
        Apply();
        UpdatePolling();
    }

    /// <summary>Re-applies the state (new window handle) and starts/stops polling (visibility changed).</summary>
    public void Refresh()
    {
        Apply();
        UpdatePolling();
    }

    public void Dispose()
    {
        _poll.Stop();
        _poll.Tick -= OnPoll;
        _poll.Dispose();
    }

    private void Apply()
    {
        if (_window.IsDisposed) return;
        _transparency.Apply(_window, Enabled, IgnoresMouse);
    }

    private void UpdatePolling()
    {
        var active = HoverToInteract && !_window.IsDisposed && _window.Visible;
        if (active && !_poll.Enabled) _poll.Start();
        else if (!active && _poll.Enabled) _poll.Stop();
    }

    private void OnPoll(object? sender, EventArgs e)
    {
        if (!HoverToInteract || _window.IsDisposed || !_window.Visible)
        {
            _poll.Stop();
            return;
        }
        if (!NativeMethods.GetCursorPos(out var p)) return; // locked workstation / secure desktop: keep the state
        var cursor = new Point(p.X, p.Y);
        var now = _clock.ElapsedMilliseconds;

        try
        {
            if (!Interactive)
            {
                if (!_isOnHitRegion(cursor))
                {
                    _insideSinceMs = -1;
                    return;
                }
                if (_insideSinceMs < 0) _insideSinceMs = now;
                if (now - _insideSinceMs >= HoverDelay.TotalMilliseconds) SetInteractive(true);
                return;
            }

            if (_window.Bounds.Contains(cursor) || _isBusy())
            {
                _outsideSinceMs = -1;
                return;
            }
            if (_outsideSinceMs < 0) _outsideSinceMs = now;
            if (now - _outsideSinceMs >= LeaveDelay.TotalMilliseconds) SetInteractive(false);
        }
        catch (Exception ex)
        {
            _log.Warn($"Cat hover watcher: {ex.Message}");
        }
    }

    private void SetInteractive(bool interactive)
    {
        Interactive = interactive;
        _insideSinceMs = -1;
        _outsideSinceMs = -1;
        Apply();
        InteractiveChanged?.Invoke(interactive);
    }
}

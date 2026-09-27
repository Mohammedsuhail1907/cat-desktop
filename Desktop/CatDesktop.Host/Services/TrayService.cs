using CatDesktop.Host.App;

namespace CatDesktop.Host.Services;

/// <summary>
/// System tray icon with its context menu and balloon notifications. <see cref="NotifyIcon"/> is
/// thread-affine, so every public member marshals to the UI thread that created the service.
/// </summary>
public sealed class TrayService : IDisposable
{
    private const string ProductName = "CatDesktop";
    private const int MaxBalloonTitleLength = 63;
    private const int MaxBalloonTextLength = 255;

    private readonly Logger _log;
    private readonly int _uiThreadId;
    private readonly SynchronizationContext _ui;
    private readonly ContextMenuStrip _menu;
    private readonly ToolStripMenuItem _catItem;
    private readonly ToolStripMenuItem _walkingItem;
    private readonly Font _boldFont;
    private readonly Icon? _ownedIcon;
    private readonly NotifyIcon _icon;
    private bool _trayHintShown;
    private bool _disposed;

    public event Action? OpenRequested;
    public event Action? ToggleCatRequested;
    public event Action? ToggleWalkingRequested;
    public event Action? StartFocusRequested;
    public event Action? ExitRequested;

    public TrayService(Logger log)
    {
        _log = log;
        _uiThreadId = Environment.CurrentManagedThreadId;

        _menu = new ContextMenuStrip();
        // Creating the first control installs the WinForms synchronization context on this thread.
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();

        var openItem = new ToolStripMenuItem("Open CatDesktop");
        _boldFont = new Font(openItem.Font, FontStyle.Bold);
        openItem.Font = _boldFont;
        openItem.Click += (_, _) => OpenRequested?.Invoke();

        _catItem = new ToolStripMenuItem("Show Cat");
        _catItem.Click += (_, _) => ToggleCatRequested?.Invoke();

        _walkingItem = new ToolStripMenuItem("Pause walking");
        _walkingItem.Click += (_, _) => ToggleWalkingRequested?.Invoke();

        var focusItem = new ToolStripMenuItem("Start / pause focus timer");
        focusItem.Click += (_, _) => StartFocusRequested?.Invoke();

        var exitItem = new ToolStripMenuItem("Exit");
        exitItem.Click += (_, _) => ExitRequested?.Invoke();

        _menu.Items.AddRange(new ToolStripItem[] { openItem, _catItem, _walkingItem, focusItem, new ToolStripSeparator(), exitItem });

        _ownedIcon = LoadIcon();
        _icon = new NotifyIcon
        {
            Icon = _ownedIcon ?? SystemIcons.Application,
            Text = ProductName,
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _icon.MouseDoubleClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) OpenRequested?.Invoke();
        };
        _icon.BalloonTipClicked += (_, _) => OpenRequested?.Invoke();
    }

    /// <summary>Switches the menu entry between "Show Cat" and "Hide Cat".</summary>
    public void SetCatVisible(bool visible)
        => OnUiThread(() => _catItem.Text = visible ? "Hide Cat" : "Show Cat");

    /// <summary>Switches the menu entry between "Pause walking" and "Resume walking" (CatSettings.autoWalk).</summary>
    public void SetWalkingPaused(bool paused)
        => OnUiThread(() => _walkingItem.Text = paused ? "Resume walking" : "Pause walking");

    public void ShowBalloon(string title, string text, ToolTipIcon icon = ToolTipIcon.None, int timeoutMs = 5000)
    {
        var tipTitle = Truncate(string.IsNullOrWhiteSpace(title) ? ProductName : title.Trim(), MaxBalloonTitleLength);
        // The shell rejects an empty body, so fall back to the title.
        var tipText = Truncate(string.IsNullOrWhiteSpace(text) ? tipTitle : text.Trim(), MaxBalloonTextLength);
        var timeout = Math.Max(1000, timeoutMs);

        OnUiThread(() =>
        {
            try
            {
                _icon.ShowBalloonTip(timeout, tipTitle, tipText, icon);
            }
            catch (Exception ex)
            {
                _log.Warn($"Tray balloon failed: {ex.Message}");
            }
        });
    }

    /// <summary>Shown the first time the main window is closed to the tray in this process.</summary>
    public void ShowRunningInTrayHint()
    {
        if (_trayHintShown) return;
        _trayHintShown = true;
        ShowBalloon(ProductName, "CatDesktop is still running in the tray. Double-click the tray icon to open it again.", ToolTipIcon.Info);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            _icon.Visible = false;
        }
        catch (Exception ex)
        {
            _log.Warn($"Could not hide the tray icon: {ex.Message}");
        }
        _icon.Dispose();
        _menu.Dispose();
        _boldFont.Dispose();
        _ownedIcon?.Dispose();
    }

    private void OnUiThread(Action action)
    {
        if (_disposed) return;
        if (Environment.CurrentManagedThreadId == _uiThreadId)
        {
            action();
            return;
        }
        _ui.Post(_ =>
        {
            if (!_disposed) action();
        }, null);
    }

    private Icon? LoadIcon()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Assets", "app.ico");
        if (!File.Exists(path))
        {
            _log.Warn($"Tray icon not found at {path}; using the default icon.");
            return null;
        }
        try
        {
            return new Icon(path);
        }
        catch (Exception ex)
        {
            _log.Warn($"Could not load the tray icon: {ex.Message}");
            return null;
        }
    }

    private static string Truncate(string value, int maxLength)
        => value.Length <= maxLength ? value : value[..maxLength];
}

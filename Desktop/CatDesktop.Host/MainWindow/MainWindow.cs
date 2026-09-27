using CatDesktop.Host.App;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.Native;
using CatDesktop.Host.Services;
using CatDesktop.Host.WebView;
using CatDesktop.Host.Windows;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;
using WindowStateModel = CatDesktop.Host.Models.WindowState;

namespace CatDesktop.Host.MainWindow;

/// <summary>
/// The framed application window that hosts the Angular shell. It persists its geometry per monitor,
/// follows the app theme (title bar + WebView background so there is no white flash) and exposes the
/// members the composition root and the bridge handlers need (show/hide/navigate/force close).
/// </summary>
public sealed class MainWindow : Form, IBridgeWindow
{
    private const string WindowId = "main";
    private const int DefaultWidth = 1280;
    private const int DefaultHeight = 800;
    private const int MinWidth = 960;
    private const int MinHeight = 600;
    private const uint SwpFrameChanged = 0x0020;

    private static readonly Color DarkBackground = Color.FromArgb(0x14, 0x12, 0x19);
    private static readonly Color LightBackground = Color.FromArgb(0xF6, 0xF5, 0xF8);
    private static readonly Color DarkForeground = Color.FromArgb(0xEE, 0xEE, 0xEE);
    private static readonly Color LightForeground = Color.FromArgb(0x1C, 0x19, 0x23);

    private readonly AppPaths _paths;
    private readonly BridgeEvents _events;
    private readonly WindowStateRepository _windowStates;
    private readonly Logger _log;
    private readonly WebView2 _webViewControl;
    private readonly System.Windows.Forms.Timer _stateTimer;

    private Rectangle _restoredBounds;
    private bool _restoreMaximized;
    private FormWindowState _lastWindowState = FormWindowState.Normal;
    private FormWindowState _lastVisibleState = FormWindowState.Normal;
    private bool _inSizeMove;
    private bool _forceClose;
    private bool _webViewStarted;
    private string _theme = "system";
    private bool _isDark;
    private Icon? _ownedIcon;
    private Label? _errorLabel;

    public MainWindow(HostConfig config, AppPaths paths, BridgeRouter router, BridgeEvents events,
        SettingsService settings, WindowStateRepository windowStates, Logger log)
    {
        _paths = paths;
        _events = events;
        _windowStates = windowStates;
        _log = log;

        Text = "CatDesktop";
        StartPosition = FormStartPosition.Manual;
        // MinimumSize is derived from the target screen in RestoreGeometry (FitMinimumSizeTo).
        LoadIcon();

        _webViewControl = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(_webViewControl);
        WebView = new WebViewHost(_webViewControl, this, config, paths, router, log);

        _stateTimer = new System.Windows.Forms.Timer { Interval = 400 };
        _stateTimer.Tick += (_, _) =>
        {
            _stateTimer.Stop();
            CommitState();
        };

        // The theme must be known before the WebView initialises so its background never flashes white.
        ApplyTheme(settings.Get("app.theme", "system"));
        RestoreGeometry();
        SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
        events.Register(this);

        // Create the native window right away, even when starting hidden in the tray: the WebView warms up
        // in the background and BeginInvoke calls from other threads (second instance) always have a handle.
        if (!IsHandleCreated) CreateHandle();
    }

    // ---- IBridgeWindow ----------------------------------------------------------------------

    public WindowKind Kind => WindowKind.Main;

    public Form Form => this;

    public WebViewHost WebView { get; }

    public WindowStateModel GetState() => BuildState(forPersistence: false);

    public void SetAlwaysOnTop(bool enabled)
    {
        if (IsDisposed || TopMost == enabled) return;
        TopMost = enabled;
        PostStateChanged();
    }

    // ---- Members used by the composition root -----------------------------------------------

    public void ShowAndActivate()
    {
        if (IsDisposed) return;
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized)
        {
            WindowState = _lastVisibleState == FormWindowState.Maximized ? FormWindowState.Maximized : FormWindowState.Normal;
        }
        Activate();
        NativeMethods.SetForegroundWindow(Handle);
    }

    public void HideToTray()
    {
        if (IsDisposed) return;
        Hide();
    }

    /// <summary>Persists the restore geometry (never the minimised placeholder bounds). Never throws.</summary>
    public void SaveState()
    {
        if (IsDisposed || !IsHandleCreated) return;
        var state = BuildState(forPersistence: true);
        if (state.Width <= 0 || state.Height <= 0) return;
        try
        {
            _windowStates.Save(state);
        }
        catch (Exception ex)
        {
            _log.Warn($"Main window state not saved: {ex.Message}");
        }
    }

    /// <summary>Closes the window regardless of the close-to-tray setting (used on application exit).</summary>
    public void ForceClose()
    {
        _forceClose = true;
        if (!IsDisposed) Close();
    }

    /// <summary>'system' | 'light' | 'dark'. Updates the title bar, form background and WebView background.</summary>
    public void ApplyTheme(string theme)
    {
        _theme = theme is "light" or "dark" ? theme : "system";
        _isDark = _theme switch
        {
            "dark" => true,
            "light" => false,
            _ => SystemPrefersDark(),
        };

        var background = _isDark ? DarkBackground : LightBackground;
        BackColor = background;
        _webViewControl.DefaultBackgroundColor = background;
        if (_errorLabel is not null)
        {
            _errorLabel.BackColor = background;
            _errorLabel.ForeColor = _isDark ? DarkForeground : LightForeground;
        }

        if (!IsHandleCreated) return;
        NativeMethods.SetImmersiveDarkMode(Handle, _isDark);
        // DWM repaints the caption only on the next frame change; nudge it so the switch is immediate.
        NativeMethods.SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0,
            NativeMethods.SWP_NOMOVE | NativeMethods.SWP_NOSIZE | NativeMethods.SWP_NOZORDER | NativeMethods.SWP_NOACTIVATE | SwpFrameChanged);
    }

    /// <summary>Brings the window to the front and asks the Angular shell to open <paramref name="route"/>.</summary>
    public void NavigateTo(string route)
    {
        ShowAndActivate();
        WebView.PostEvent("navigation.navigate", new { route });
    }

    // ---- Form overrides ---------------------------------------------------------------------

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        NativeMethods.SetImmersiveDarkMode(Handle, _isDark);
        if (_webViewStarted) return;
        _webViewStarted = true;
        StartWebViewAsync();
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // Started hidden in the tray, the window is first shown long after RestoreGeometry: fit it to the screens as
        // they are now (a monitor may have gone, the resolution or the DPI may have changed).
        var area = Screen.FromRectangle(_restoredBounds).WorkingArea;
        FitMinimumSizeTo(area);
        _restoredBounds = ClampToArea(_restoredBounds, area);
        // WinForms may have rescaled the bounds if the target monitor's DPI differs from the system DPI;
        // the saved bounds are physical pixels for that monitor, so re-apply them once the window is up.
        if (WindowState == FormWindowState.Normal && Bounds != _restoredBounds)
        {
            Bounds = _restoredBounds;
        }
        if (_restoreMaximized)
        {
            _restoreMaximized = false;
            WindowState = FormWindowState.Maximized;
        }
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e); // applies the suggested bounds and rescales MinimumSize by the DPI ratio
        if (e.Cancel) return;
        var area = Screen.FromRectangle(e.SuggestedRectangle).WorkingArea;
        FitMinimumSizeTo(area, e.DeviceDpiNew);
        if (WindowState == FormWindowState.Normal && (Width > area.Width || Height > area.Height))
        {
            Size = new Size(Math.Min(Width, area.Width), Math.Min(Height, area.Height));
        }
    }

    protected override void OnResizeBegin(EventArgs e)
    {
        base.OnResizeBegin(e);
        _inSizeMove = true;
        _stateTimer.Stop();
    }

    protected override void OnResizeEnd(EventArgs e)
    {
        base.OnResizeEnd(e);
        _inSizeMove = false;
        _stateTimer.Stop();
        CommitState();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        var state = WindowState;
        if (state != _lastWindowState)
        {
            _lastWindowState = state;
            if (state != FormWindowState.Minimized) _lastVisibleState = state;
            _stateTimer.Stop();
            CommitState();
            return;
        }
        ScheduleStateCommit();
    }

    protected override void OnMove(EventArgs e)
    {
        base.OnMove(e);
        ScheduleStateCommit();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        if (_forceClose) e.Cancel = false;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
            SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
            _events.Unregister(this);
            _stateTimer.Dispose();
        }
        base.Dispose(disposing);
        if (disposing)
        {
            _ownedIcon?.Dispose();
            _ownedIcon = null;
        }
    }

    // ---- Geometry ---------------------------------------------------------------------------

    private void RestoreGeometry()
    {
        WindowStateModel? saved = null;
        try
        {
            saved = _windowStates.Get(WindowId);
        }
        catch (Exception ex)
        {
            _log.Warn($"Could not read the saved main window state: {ex.Message}");
        }

        var area = FindScreen(saved?.Monitor).WorkingArea;
        FitMinimumSizeTo(area);
        Rectangle bounds;
        if (saved is not null && saved.Width > 0 && saved.Height > 0)
        {
            bounds = ClampToArea(new Rectangle(saved.X, saved.Y, saved.Width, saved.Height), area);
            _restoreMaximized = saved.IsMaximized;
        }
        else
        {
            var width = Math.Min(Scale(DefaultWidth), area.Width);
            var height = Math.Min(Scale(DefaultHeight), area.Height);
            bounds = new Rectangle(area.Left + (area.Width - width) / 2, area.Top + (area.Height - height) / 2, width, height);
        }

        _restoredBounds = bounds;
        Bounds = bounds;
    }

    private static Screen FindScreen(string? deviceName)
    {
        if (!string.IsNullOrEmpty(deviceName))
        {
            var match = Screen.AllScreens.FirstOrDefault(s => string.Equals(s.DeviceName, deviceName, StringComparison.OrdinalIgnoreCase));
            if (match is not null) return match;
        }
        return Screen.PrimaryScreen ?? Screen.FromPoint(Point.Empty);
    }

    private Rectangle ClampToArea(Rectangle rect, Rectangle area)
    {
        var width = Math.Min(Math.Max(rect.Width, MinimumSize.Width), area.Width);
        var height = Math.Min(Math.Max(rect.Height, MinimumSize.Height), area.Height);
        var x = Math.Clamp(rect.X, area.Left, Math.Max(area.Left, area.Right - width));
        var y = Math.Clamp(rect.Y, area.Top, Math.Max(area.Top, area.Bottom - height));
        return new Rectangle(x, y, width, height);
    }

    private int Scale(int logicalPixels, int? dpi = null) => (int)Math.Round(logicalPixels * (dpi ?? DeviceDpi) / 96.0);

    /// <summary>
    /// The design minimum at the window's DPI, but never more than the work area it has to fit in: at 150-200 % scaling
    /// on a small screen 960x600 logical px is larger than the screen, and the window would overflow under the taskbar.
    /// </summary>
    private void FitMinimumSizeTo(Rectangle area, int? dpi = null)
    {
        MinimumSize = new Size(Math.Min(Scale(MinWidth, dpi), area.Width), Math.Min(Scale(MinHeight, dpi), area.Height));
    }

    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        if (IsDisposed) return;
        if (InvokeRequired)
        {
            try { BeginInvoke(new Action(() => OnDisplaySettingsChanged(sender, e))); }
            catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException) { }
            return;
        }
        if (!IsHandleCreated) return;
        FitMinimumSizeTo(Screen.FromHandle(Handle).WorkingArea);
    }

    private WindowStateModel BuildState(bool forPersistence)
    {
        var state = WindowState;
        var minimized = state == FormWindowState.Minimized;
        // Persist the geometry the window returns to; report the geometry it currently occupies.
        var bounds = forPersistence
            ? (state == FormWindowState.Normal ? Bounds : RestoreBounds)
            : (minimized ? RestoreBounds : Bounds);
        var maximized = state == FormWindowState.Maximized || (minimized && _lastVisibleState == FormWindowState.Maximized);
        var screen = IsHandleCreated && !minimized ? Screen.FromControl(this) : Screen.FromRectangle(bounds);

        return new WindowStateModel
        {
            WindowId = WindowId,
            Monitor = screen.DeviceName,
            X = bounds.X,
            Y = bounds.Y,
            Width = bounds.Width,
            Height = bounds.Height,
            IsMaximized = maximized,
            IsMinimized = minimized,
            IsVisible = Visible,
            AlwaysOnTop = TopMost,
        };
    }

    private void ScheduleStateCommit()
    {
        if (_inSizeMove || !IsHandleCreated || !Visible || WindowState != FormWindowState.Normal) return;
        _stateTimer.Stop();
        _stateTimer.Start();
    }

    private void CommitState()
    {
        if (IsDisposed || !IsHandleCreated) return;
        if (WindowState != FormWindowState.Minimized) SaveState();
        PostStateChanged();
    }

    private void PostStateChanged() => WebView.PostEvent("window.stateChanged", GetState());

    // ---- WebView start-up -------------------------------------------------------------------

    private async void StartWebViewAsync()
    {
        try
        {
            await WebView.InitializeAsync("/");
        }
        catch (Exception ex) when (IsDisposed)
        {
            _log.Warn($"Main window: WebView2 initialisation aborted during shutdown: {ex.Message}");
        }
        catch (Exception ex)
        {
            _log.Error("Main window: WebView2 initialisation failed", ex);
            ShowStartupError(ex);
        }
    }

    private void ShowStartupError(Exception ex)
    {
        if (_errorLabel is not null) return;
        _webViewControl.Visible = false;
        _errorLabel = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Padding = new Padding(32),
            BackColor = _isDark ? DarkBackground : LightBackground,
            ForeColor = _isDark ? DarkForeground : LightForeground,
            Text = "CatDesktop could not start its user interface." + Environment.NewLine + Environment.NewLine
                   + ex.Message + Environment.NewLine + Environment.NewLine
                   + "Log folder: " + _paths.LogsDir,
        };
        Controls.Add(_errorLabel);
    }

    // ---- Theme ------------------------------------------------------------------------------

    private static bool SystemPrefersDark()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int value && value == 0;
        }
        catch
        {
            return false;
        }
    }

    private void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e)
    {
        if (e.Category != UserPreferenceCategory.General || _theme != "system" || IsDisposed) return;
        if (InvokeRequired)
        {
            try { BeginInvoke(new Action(() => ApplyTheme(_theme))); } catch (ObjectDisposedException) { }
            return;
        }
        ApplyTheme(_theme);
    }

    private void LoadIcon()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Assets", "app.ico");
        if (!File.Exists(path))
        {
            _log.Warn($"Window icon not found at {path}; using the default icon.");
            return;
        }
        try
        {
            _ownedIcon = new Icon(path);
            Icon = _ownedIcon;
        }
        catch (Exception ex)
        {
            _log.Warn($"Could not load the window icon: {ex.Message}");
        }
    }
}

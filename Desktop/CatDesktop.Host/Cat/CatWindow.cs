using System.ComponentModel;
using CatDesktop.Host.App;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Models;
using CatDesktop.Host.Native;
using CatDesktop.Host.WebView;
using CatDesktop.Host.Windows;

namespace CatDesktop.Host.Cat;

/// <summary>
/// The desktop cat's window: frameless, per-pixel transparent, always-on-top (per settings), hidden from the taskbar and
/// Alt+Tab, never activated by showing or moving. Window plumbing only: where it goes, how big it is and when it walks
/// is decided by <see cref="CatWindowService"/>.
///
/// Rendering: WS_EX_NOREDIRECTIONBITMAP (no GDI surface, nothing is painted by WinForms) and the WebView2 in visual
/// hosting mode (<see cref="CatCompositionHost"/>): its DirectComposition visual is the window's content, with true
/// per-pixel alpha. This hosting also keeps rendering while the window is layered + transparent (click-through),
/// which the windowed WebView2 control does not. Mouse input is forwarded to the WebView from <see cref="WndProc"/>.
/// The window is only ever hidden; it closes on <see cref="ForceClose"/>. Every member must be called on the UI thread.
/// </summary>
public sealed class CatWindow : Form, IBridgeWindow
{
    public const string Route = "/cat";

    private readonly BridgeEvents _events;
    private readonly Logger _log;
    private readonly CatCompositionHost _host;

    private Task? _initialisation;
    private bool _forceClose;
    /// <summary>
    /// The always-on-top state. Form.TopMost is not used after the handle exists, because its setter calls SetWindowPos
    /// without SWP_NOACTIVATE and so activates the cat (stealing keyboard focus from the app the user is typing in).
    /// </summary>
    private bool _alwaysOnTop;
    private IReadOnlyList<Rectangle> _region = Array.Empty<Rectangle>();

    public CatWindow(HostConfig config, AppPaths paths, BridgeRouter router, BridgeEvents events, Logger log, bool alwaysOnTop)
    {
        _events = events;
        _log = log;

        Text = "Cat";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        // Tiny windows are allowed (the small cat box is 112x84 CSS px).
        MinimumSize = new Size(1, 1);
        // Nothing is painted with GDI (there is no redirection surface to paint into).
        SetStyle(ControlStyles.Opaque | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
        _alwaysOnTop = alwaysOnTop;
        TopMost = alwaysOnTop; // no handle yet: only seeds CreateParams

        _host = new CatCompositionHost(this, log);
        WebView = new WebViewHost(_host, this, config, paths, router, log);
        events.Register(this);
    }

    // ---- IBridgeWindow ------------------------------------------------------------------------

    public WindowKind Kind => WindowKind.Cat;

    public Form Form => this;

    public WebViewHost WebView { get; }

    /// <summary>The cat box inside the window (physical px), kept up to date by <see cref="CatWindowService"/>.</summary>
    [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    public Rectangle BoxInWindow { get; set; }

    /// <summary>The cat box on screen (physical px).</summary>
    public Rectangle BoxOnScreen => new(Left + BoxInWindow.X, Top + BoxInWindow.Y, BoxInWindow.Width, BoxInWindow.Height);

    public bool AlwaysOnTop => _alwaysOnTop;

    /// <summary>
    /// Click-through extended styles (WS_EX_LAYERED / WS_EX_TRANSPARENT) owned by <see cref="LayeredMouseTransparency"/>.
    /// Kept here so CreateParams reproduces them for a recreated handle; the live window is updated by that class.
    /// </summary>
    [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    internal int MouseExStyle { get; set; }

    /// <summary>WindowState (contract §3) with windowId 'cat'; the monitor is the one holding the centre of the cat box.</summary>
    public WindowState GetState() => new()
    {
        WindowId = WindowKind.Cat.ToWindowId(),
        Monitor = CatMonitors.Nearest(CatGeometry.Centre(BoxOnScreen)).DeviceName,
        X = Left,
        Y = Top,
        Width = Width,
        Height = Height,
        IsMaximized = false,
        IsMinimized = false,
        IsVisible = Visible,
        AlwaysOnTop = _alwaysOnTop,
    };

    /// <summary>Runtime always-on-top (never activates the window).</summary>
    public void SetAlwaysOnTop(bool enabled)
    {
        _alwaysOnTop = enabled;
        if (IsHandleCreated) NativeMethods.SetTopMost(Handle, enabled); // SWP_NOACTIVATE: never takes focus
        else TopMost = enabled;
    }

    // ---- Events for the service ------------------------------------------------------------------

    /// <summary>Raised whenever the window becomes visible or hidden, whatever triggered it (not during shutdown).</summary>
    public event Action<bool>? VisibilityChanged;

    /// <summary>Raised after a new native window exists (first show, or a recreated handle).</summary>
    public event Action? HandleReady;

    /// <summary>Raised after WM_DPICHANGED was handled (WinForms has applied the suggested bounds).</summary>
    public event Action? DpiChangedHandled;

    /// <summary>Raised when something asked the window to close (Alt+F4): the service hides the cat.</summary>
    public event Action? HideRequested;

    // ---- Lifetime ---------------------------------------------------------------------------------

    /// <summary>Creates the native window and starts loading the cat page (CreateCatWindow). Idempotent; a failed WebView start may be retried.</summary>
    public void EnsureCreated()
    {
        if (IsDisposed) return;
        if (!IsHandleCreated) CreateHandle();
        _initialisation ??= InitialiseWebViewAsync();
    }

    /// <summary>Show without activating (the user keeps typing where they are).</summary>
    public void ShowNoActivate()
    {
        if (IsDisposed) return;
        EnsureCreated();
        if (!Visible) Show();
        if (_alwaysOnTop) NativeMethods.SetTopMost(Handle, true);
    }

    /// <summary>
    /// Show and give the page keyboard focus, for commands that need typing (quick note). Call it while this process
    /// may still take the foreground, e.g. straight from a global hotkey (WM_HOTKEY grants that) or a user action.
    /// </summary>
    public void ShowAndFocus()
    {
        ShowNoActivate();
        ActivateAndFocus();
    }

    /// <summary>
    /// window.focus from the cat page (its context menu or panel opened): activate the window and give the page keyboard
    /// focus, so the page learns about a click elsewhere through blur. No-op while hidden.
    /// </summary>
    public void ActivateAndFocus()
    {
        if (IsDisposed || !Visible) return;
        Activate();
        NativeMethods.SetForegroundWindow(Handle); // allowed after a click in the cat or a hotkey; otherwise Windows flashes instead
        _host.MoveFocus();
    }

    /// <summary>Close for real (application shutdown). Any other close request only hides the window.</summary>
    public void ForceClose()
    {
        _forceClose = true;
        Close();
    }

    // ---- Geometry plumbing ------------------------------------------------------------------------

    public void SetBoundsNoActivate(Rectangle bounds)
    {
        if (IsDisposed || bounds == Bounds) return;
        if (IsHandleCreated) NativeMethods.SetBoundsNoActivate(Handle, bounds.X, bounds.Y, bounds.Width, bounds.Height);
        else Bounds = bounds;
    }

    public void MoveNoActivate(Point location)
    {
        if (IsDisposed || location == Location) return;
        if (IsHandleCreated) NativeMethods.MoveWindowNoActivate(Handle, location.X, location.Y);
        else Location = location;
    }

    /// <summary>
    /// Window region = union of <paramref name="rects"/> (window-relative physical px); empty = the whole window. Only
    /// the region receives the mouse (clicks elsewhere reach the windows below) and only the region is shown.
    /// Remembered and re-applied to a new handle.
    /// </summary>
    public void SetRegion(IReadOnlyList<Rectangle> rects)
    {
        // Unchanged (e.g. "whole window" again on every scale change of a Settings slider): nothing to redo. A new handle
        // gets the region from OnHandleCreated anyway.
        if (rects.SequenceEqual(_region)) return;
        _region = rects.ToArray();
        ApplyRegion();
    }

    private void ApplyRegion()
    {
        if (!IsHandleCreated || IsDisposed) return;
        if (!NativeMethods.SetWindowRegion(Handle, _region))
        {
            _log.Warn($"Cat window region with {_region.Count} rectangle(s) could not be applied.");
        }
    }

    // ---- Form overrides -------------------------------------------------------------------------

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            // No GDI redirection surface: the DirectComposition visual is the content. Tool window: no taskbar button,
            // no Alt+Tab entry. Never WS_EX_NOACTIVATE - the quick note needs keyboard focus.
            cp.ExStyle |= NativeMethods.WS_EX_NOREDIRECTIONBITMAP | NativeMethods.WS_EX_TOOLWINDOW;
            // A recreated handle keeps the current always-on-top state (Form.TopMost is not kept up to date, see _alwaysOnTop).
            if (_alwaysOnTop) cp.ExStyle |= NativeMethods.WS_EX_TOPMOST;
            else cp.ExStyle &= ~NativeMethods.WS_EX_TOPMOST;
            cp.ExStyle = (cp.ExStyle & ~LayeredMouseTransparency.Mask) | MouseExStyle;
            // Double-click messages (the page relies on dblclick); WinForms' classes normally have it already.
            cp.ClassStyle |= NativeMethods.CS_DBLCLKS;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        // Nothing: the window has no GDI surface, the WebView's visual is the whole content.
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        // Nothing (see OnPaintBackground).
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        NativeMethods.SetCornerPreference(Handle, NativeMethods.DWMWCP_DONOTROUND);
        _host.OnHandleCreated();
        ApplyRegion();
        HandleReady?.Invoke();
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        _host.UpdateBounds();
    }

    protected override void OnMove(EventArgs e)
    {
        base.OnMove(e);
        _host.NotifyMoved();
    }

    protected override void OnGotFocus(EventArgs e)
    {
        base.OnGotFocus(e);
        // Activated (click, Alt+Tab is not possible, ShowAndFocus): keyboard input belongs to the page.
        _host.MoveFocus();
    }

    protected override void WndProc(ref Message m)
    {
        // Visual hosting receives no input by itself: mouse messages go to the WebView, not to WinForms.
        if (_host.TryForwardMouse(ref m)) return;
        if (m.Msg == NativeMethods.WM_SETCURSOR && _host.TrySetCursor(ref m)) return;

        base.WndProc(ref m);
        if (m.Msg == NativeMethods.WM_DPICHANGED && IsHandleCreated && !IsDisposed)
        {
            // WinForms has applied the suggested bounds: the WebView renders at the new scale and the service
            // re-derives the physical sizes (and the region) for the new DPI.
            _host.UpdateScale();
            DpiChangedHandled?.Invoke();
        }
    }

    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        _host.UpdateVisibility();
        // During shutdown the tray and the other window may already be gone; nobody needs the notification then.
        if (!_forceClose) VisibilityChanged?.Invoke(Visible);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        // Never veto the end of the Windows session (WM_QUERYENDSESSION arrives here as WindowsShutDown): the main
        // window's closing handler shuts the whole application down in order.
        if (_forceClose || e.CloseReason == CloseReason.WindowsShutDown) return;
        e.Cancel = true;
        if (HideRequested is { } hide) hide();
        else Hide();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _events.Unregister(this);
            _host.Dispose();
        }
        base.Dispose(disposing);
    }

    // ---- Initialisation -------------------------------------------------------------------------

    private async Task InitialiseWebViewAsync()
    {
        try
        {
            await WebView.InitializeAsync(Route);
            _log.Info("Cat WebView initialised (visual hosting); loading the cat page.");
        }
        catch (Exception ex)
        {
            _log.Error("Cat WebView2 could not be initialised", ex);
            _initialisation = null;
            if (!IsDisposed) Hide();
        }
    }
}

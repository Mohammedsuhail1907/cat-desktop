using System.Runtime.InteropServices;
using CatDesktop.Host.App;
using CatDesktop.Host.Native;
using CatDesktop.Host.WebView;
using Microsoft.Web.WebView2.Core;

namespace CatDesktop.Host.Cat;

/// <summary>
/// Visual (composition) hosting of the cat's WebView2: a <see cref="CoreWebView2CompositionController"/> renders into a
/// DirectComposition visual that is the root of a DComp target on the cat window (a WS_EX_NOREDIRECTIONBITMAP window).
/// This gives true per-pixel transparency without the DWM blur-behind trick, and - unlike the windowed control - keeps
/// rendering when the window is made layered + transparent for click-through (verified on the development machine).
///
/// Visual hosting receives no input by itself: <see cref="TryForwardMouse"/> forwards the window's mouse messages with
/// SendMouseInput, <see cref="TrySetCursor"/> shows the page's cursor, and focus is handed over with MoveFocus.
/// Keyboard input then reaches the WebView by itself. Every member must be called on the UI thread.
/// </summary>
internal sealed class CatCompositionHost : IWebViewHosting, IDisposable
{
    private readonly CatWindow _window;
    private readonly Logger _log;

    private IDCompositionDesktopDevice? _device;
    private IDCompositionTarget? _target;
    private IDCompositionVisual2? _visual;
    private IntPtr _targetWindow;
    private CoreWebView2CompositionController? _composition;
    private bool _trackingLeave;
    private bool _disposed;

    public CatCompositionHost(CatWindow window, Logger log)
    {
        _window = window;
        _log = log;
    }

    public Control Control => _window;

    /// <summary>The WebView's controller once created (null before, and after <see cref="Dispose"/>).</summary>
    public CoreWebView2Controller? Controller => _composition;

    public async Task<CoreWebView2> CreateCoreWebView2Async(CoreWebView2Environment environment)
    {
        if (_composition is not null) return _composition.CoreWebView2;
        var hwnd = _window.Handle; // creates the native window if needed
        EnsureVisualTree(hwnd);

        var composition = await environment.CreateCoreWebView2CompositionControllerAsync(hwnd);
        if (_disposed || _window.IsDisposed)
        {
            composition.Close();
            throw new ObjectDisposedException(nameof(CatWindow));
        }
        composition.RootVisualTarget = _visual;
        composition.DefaultBackgroundColor = Color.Transparent;
        // The host owns the scale: it follows the window's DPI (WM_DPICHANGED), like the physical window size does.
        composition.ShouldDetectMonitorScaleChanges = false;
        composition.RasterizationScale = NativeMethods.WindowScale(hwnd);
        composition.Bounds = new Rectangle(Point.Empty, _window.ClientSize);
        composition.IsVisible = _window.Visible;
        composition.CursorChanged += OnCursorChanged;
        _composition = composition;
        Commit();
        return composition.CoreWebView2;
    }

    // ---- Window life cycle (called by CatWindow) ----------------------------------------------------

    /// <summary>A (new) native window exists: point the DComp target and the controller at it.</summary>
    public void OnHandleCreated()
    {
        if (_visual is null || _window.Handle == _targetWindow) return; // first handle: set up lazily in CreateCoreWebView2Async
        try
        {
            EnsureVisualTree(_window.Handle);
            if (_composition is not null) _composition.ParentWindow = _window.Handle;
            Commit();
        }
        catch (Exception ex)
        {
            _log.Error("Cat composition target could not be moved to the new window handle", ex);
        }
    }

    public void UpdateBounds() => Try(c => c.Bounds = new Rectangle(Point.Empty, _window.ClientSize));

    public void UpdateScale() => Try(c => c.RasterizationScale = NativeMethods.WindowScale(_window.Handle));

    public void UpdateVisibility() => Try(c => c.IsVisible = _window.Visible);

    /// <summary>Lets the WebView place its popups (select lists, tooltips) correctly after the window moved.</summary>
    public void NotifyMoved() => Try(c => c.NotifyParentWindowPositionChanged());

    /// <summary>Gives the page keyboard focus.</summary>
    public void MoveFocus() => Try(c => c.MoveFocus(CoreWebView2MoveFocusReason.Programmatic));

    // ---- Input -----------------------------------------------------------------------------------------

    /// <summary>
    /// Forwards a mouse message to the WebView. Returns false for anything that is not a mouse message (or before the
    /// WebView exists), so the caller passes it on to the default handling.
    /// </summary>
    public bool TryForwardMouse(ref Message m)
    {
        var composition = _composition;
        if (composition is null || !TryTranslate(m.Msg, m.WParam, m.LParam, out var input)) return false;

        var hwnd = _window.Handle;
        var point = input.Point;
        if (input.ScreenCoordinates)
        {
            var p = new NativeMethods.POINT { X = point.X, Y = point.Y };
            NativeMethods.ScreenToClient(hwnd, ref p);
            point = new Point(p.X, p.Y);
        }

        if (m.Msg == NativeMethods.WM_MOUSEMOVE && !_trackingLeave)
        {
            // Ask for WM_MOUSELEAVE, so the page sees the pointer leave (hover styles, pointerleave).
            var track = new NativeMethods.TRACKMOUSEEVENT
            {
                cbSize = Marshal.SizeOf<NativeMethods.TRACKMOUSEEVENT>(),
                dwFlags = NativeMethods.TME_LEAVE,
                hwndTrack = hwnd,
            };
            _trackingLeave = NativeMethods.TrackMouseEvent(ref track);
        }
        else if (m.Msg == NativeMethods.WM_MOUSELEAVE)
        {
            _trackingLeave = false;
        }

        try
        {
            composition.SendMouseInput(input.Kind, input.Keys, input.MouseData, point);
        }
        catch (Exception ex)
        {
            _log.Warn($"Cat mouse input not forwarded: {ex.Message}");
        }

        // Capture while a button is down, so the page keeps getting moves/ups outside the window (pointer capture, drags).
        if (input.ButtonDown) NativeMethods.SetCapture(hwnd);
        else if (input.ButtonUp && ((int)input.Keys & NativeMethods.MK_ANY_BUTTON) == 0 && NativeMethods.GetCapture() == hwnd)
        {
            NativeMethods.ReleaseCapture();
        }

        // WM_XBUTTON* must return TRUE when handled; every other mouse message returns 0.
        m.Result = m.Msg is NativeMethods.WM_XBUTTONDOWN or NativeMethods.WM_XBUTTONUP or NativeMethods.WM_XBUTTONDBLCLK
            ? new IntPtr(1)
            : IntPtr.Zero;
        return true;
    }

    /// <summary>WM_SETCURSOR over the client area: show the page's cursor. False = let the default handling run.</summary>
    public bool TrySetCursor(ref Message m)
    {
        var composition = _composition;
        if (composition is null || ((long)m.LParam & 0xFFFF) != NativeMethods.HTCLIENT) return false;
        var cursor = SafeCursor(composition);
        if (cursor == IntPtr.Zero) return false;
        NativeMethods.SetCursor(cursor);
        m.Result = new IntPtr(1);
        return true;
    }

    /// <summary>A mouse message translated for SendMouseInput. Pure: unit-checkable without a window.</summary>
    internal readonly record struct MouseInput(
        CoreWebView2MouseEventKind Kind,
        CoreWebView2MouseEventVirtualKeys Keys,
        uint MouseData,
        Point Point,
        bool ScreenCoordinates,
        bool ButtonDown,
        bool ButtonUp);

    /// <summary>
    /// WM_* mouse message → SendMouseInput arguments. The WebView2 event kinds carry the WM_ values themselves; the
    /// virtual keys are the MK_ flags in the low word of wParam; mouseData is the signed wheel delta (sign-extended, as
    /// the native API expects) or the X button number from the high word; the point is the signed x/y in lParam, which
    /// is in SCREEN coordinates for the wheel messages and client coordinates otherwise. WM_MOUSELEAVE has no data.
    /// </summary>
    internal static bool TryTranslate(int msg, IntPtr wParam, IntPtr lParam, out MouseInput input)
    {
        input = default;
        var kind = msg switch
        {
            >= NativeMethods.WM_MOUSEMOVE and <= NativeMethods.WM_MOUSEHWHEEL => (CoreWebView2MouseEventKind)msg,
            NativeMethods.WM_MOUSELEAVE => CoreWebView2MouseEventKind.Leave,
            _ => (CoreWebView2MouseEventKind?)null,
        };
        if (kind is null) return false;

        if (msg == NativeMethods.WM_MOUSELEAVE)
        {
            input = new MouseInput(CoreWebView2MouseEventKind.Leave, CoreWebView2MouseEventVirtualKeys.None, 0, Point.Empty, false, false, false);
            return true;
        }

        var w = (long)wParam;
        var l = (long)lParam;
        var keys = (CoreWebView2MouseEventVirtualKeys)(w & 0xFFFF);
        var high = (int)((w >> 16) & 0xFFFF);
        var wheel = msg is NativeMethods.WM_MOUSEWHEEL or NativeMethods.WM_MOUSEHWHEEL;
        var xButton = msg is NativeMethods.WM_XBUTTONDOWN or NativeMethods.WM_XBUTTONUP or NativeMethods.WM_XBUTTONDBLCLK;
        var data = wheel ? unchecked((uint)(int)(short)high) : xButton ? (uint)high : 0u;
        var point = new Point((short)(l & 0xFFFF), (short)((l >> 16) & 0xFFFF));
        var down = msg is NativeMethods.WM_LBUTTONDOWN or NativeMethods.WM_RBUTTONDOWN or NativeMethods.WM_MBUTTONDOWN
            or NativeMethods.WM_XBUTTONDOWN or NativeMethods.WM_LBUTTONDBLCLK or NativeMethods.WM_RBUTTONDBLCLK
            or NativeMethods.WM_MBUTTONDBLCLK or NativeMethods.WM_XBUTTONDBLCLK;
        var up = msg is NativeMethods.WM_LBUTTONUP or NativeMethods.WM_RBUTTONUP or NativeMethods.WM_MBUTTONUP or NativeMethods.WM_XBUTTONUP;
        input = new MouseInput(kind.Value, keys, data, point, wheel, down, up);
        return true;
    }

    private void OnCursorChanged(object? sender, object e)
    {
        // WM_SETCURSOR for the move that changed the cursor has already been handled: apply it now when the pointer is
        // over the window (or captured by it), otherwise the new cursor would only show on the next move.
        var composition = _composition;
        if (composition is null || _window.IsDisposed || !_window.IsHandleCreated) return;
        var overWindow = _window.Bounds.Contains(NativeMethods.CursorPosition()) || NativeMethods.GetCapture() == _window.Handle;
        var cursor = SafeCursor(composition);
        if (overWindow && cursor != IntPtr.Zero) NativeMethods.SetCursor(cursor);
    }

    private IntPtr SafeCursor(CoreWebView2CompositionController composition)
    {
        try
        {
            return composition.Cursor;
        }
        catch (Exception ex)
        {
            _log.Trace($"Cat cursor unavailable: {ex.Message}");
            return IntPtr.Zero;
        }
    }

    // ---- DirectComposition ----------------------------------------------------------------------------

    /// <summary>Device and visual once per window object; a DComp target per native window handle.</summary>
    private void EnsureVisualTree(IntPtr hwnd)
    {
        _device ??= DirectComposition.CreateDesktopDevice();
        if (_visual is null)
        {
            Marshal.ThrowExceptionForHR(_device.CreateVisual(out var visual));
            _visual = visual;
        }
        if (_targetWindow == hwnd && _target is not null) return;
        if (_target is not null) Marshal.ReleaseComObject(_target);
        Marshal.ThrowExceptionForHR(_device.CreateTargetForHwnd(hwnd, true, out var target));
        Marshal.ThrowExceptionForHR(target.SetRoot(_visual));
        _target = target;
        _targetWindow = hwnd;
    }

    private void Commit()
    {
        var hr = _device?.Commit() ?? 0;
        if (hr < 0) _log.Warn($"DirectComposition commit failed (0x{hr:X8}).");
    }

    private void Try(Action<CoreWebView2CompositionController> action)
    {
        var composition = _composition;
        if (composition is null || _disposed) return;
        try
        {
            action(composition);
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException or ObjectDisposedException)
        {
            // The browser process died (the application restarts itself) or the controller was closed.
            _log.Trace($"Cat WebView controller call failed: {ex.Message}");
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        var composition = _composition;
        _composition = null;
        if (composition is not null)
        {
            composition.CursorChanged -= OnCursorChanged;
            try { composition.Close(); } catch (Exception) { /* browser already gone */ }
        }
        if (_target is not null) Marshal.ReleaseComObject(_target);
        if (_visual is not null) Marshal.ReleaseComObject(_visual);
        if (_device is not null) Marshal.ReleaseComObject(_device);
        _target = null;
        _visual = null;
        _device = null;
    }
}

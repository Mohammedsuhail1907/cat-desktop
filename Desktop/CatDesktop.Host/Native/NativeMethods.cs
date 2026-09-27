using System.Runtime.InteropServices;

namespace CatDesktop.Host.Native;

/// <summary>
/// Win32 / DWM interop used by the windows and services. Keep every P/Invoke here (the DirectComposition COM interop
/// used by the cat window's visual-hosted WebView2 is in DirectComposition.cs).
/// </summary>
internal static class NativeMethods
{
    // ---- Window messages -------------------------------------------------------------------
    public const int WM_HOTKEY = 0x0312;
    public const int WM_NCLBUTTONDOWN = 0x00A1;
    public const int WM_SYSCOMMAND = 0x0112;
    public const int WM_DPICHANGED = 0x02E0;
    public const int HTCAPTION = 0x2;
    public const int SC_MINIMIZE = 0xF020;

    // ---- Extended window styles ------------------------------------------------------------
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;   // hide from Alt+Tab / taskbar
    public const int WS_EX_TOPMOST = 0x00000008;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int WS_EX_TRANSPARENT = 0x00000020;          // with WS_EX_LAYERED: the window ignores the mouse
    public const int WS_EX_LAYERED = 0x00080000;
    public const int WS_EX_NOREDIRECTIONBITMAP = 0x00200000;  // no GDI surface: content comes from DirectComposition

    // ---- Class styles ----------------------------------------------------------------------
    public const int CS_DBLCLKS = 0x0008;

    // ---- Layered windows / regions ---------------------------------------------------------
    public const uint LWA_ALPHA = 0x00000002;
    public const int RGN_OR = 2;

    // ---- Mouse messages --------------------------------------------------------------------
    public const int WM_SETCURSOR = 0x0020;
    public const int WM_MOUSEMOVE = 0x0200;
    public const int WM_LBUTTONDOWN = 0x0201;
    public const int WM_LBUTTONUP = 0x0202;
    public const int WM_LBUTTONDBLCLK = 0x0203;
    public const int WM_RBUTTONDOWN = 0x0204;
    public const int WM_RBUTTONUP = 0x0205;
    public const int WM_RBUTTONDBLCLK = 0x0206;
    public const int WM_MBUTTONDOWN = 0x0207;
    public const int WM_MBUTTONUP = 0x0208;
    public const int WM_MBUTTONDBLCLK = 0x0209;
    public const int WM_MOUSEWHEEL = 0x020A;
    public const int WM_XBUTTONDOWN = 0x020B;
    public const int WM_XBUTTONUP = 0x020C;
    public const int WM_XBUTTONDBLCLK = 0x020D;
    public const int WM_MOUSEHWHEEL = 0x020E;
    public const int WM_MOUSELEAVE = 0x02A3;
    public const int HTCLIENT = 1;
    public const uint TME_LEAVE = 0x00000002;
    /// <summary>MK_LBUTTON | MK_RBUTTON | MK_MBUTTON | MK_XBUTTON1 | MK_XBUTTON2 in a mouse message's wParam.</summary>
    public const int MK_ANY_BUTTON = 0x0001 | 0x0002 | 0x0010 | 0x0020 | 0x0040;

    // ---- Virtual keys (GetAsyncKeyState) ---------------------------------------------------
    public const int VK_LBUTTON = 0x01;
    public const int VK_RBUTTON = 0x02;
    public const int VK_ESCAPE = 0x1B;

    // ---- Monitors ---------------------------------------------------------------------------
    public const uint MONITOR_DEFAULTTONEAREST = 0x00000002;
    public const int MDT_EFFECTIVE_DPI = 0;

    // ---- SetWindowPos ----------------------------------------------------------------------
    public static readonly IntPtr HWND_TOPMOST = new(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new(-2);
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;

    // ---- Hotkey modifiers ------------------------------------------------------------------
    public const uint MOD_ALT = 0x0001;
    public const uint MOD_CONTROL = 0x0002;
    public const uint MOD_SHIFT = 0x0004;
    public const uint MOD_WIN = 0x0008;
    public const uint MOD_NOREPEAT = 0x4000;

    // ---- DWM -------------------------------------------------------------------------------
    public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWA_BORDER_COLOR = 34;
    public const int DWMWCP_DEFAULT = 0;
    public const int DWMWCP_DONOTROUND = 1;
    public const int DWMWCP_ROUND = 2;
    public const int DWMWCP_ROUNDSMALL = 3;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateRectRgn(int nLeftRect, int nTopRect, int nRightRect, int nBottomRect);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteObject(IntPtr hObject);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    /// <summary>Lets any process (ASFW_ANY) take the foreground; only effective when the caller may set it itself.</summary>
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AllowSetForegroundWindow(int dwProcessId);

    public const int ASFW_ANY = -1;

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FlashWindow(IntPtr hWnd, bool bInvert);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);

    [StructLayout(LayoutKind.Sequential)]
    public struct TRACKMOUSEEVENT
    {
        public int cbSize;
        public uint dwFlags;
        public IntPtr hwndTrack;
        public uint dwHoverTime;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TrackMouseEvent(ref TRACKMOUSEEVENT lpEventTrack);

    [DllImport("user32.dll")]
    public static extern IntPtr SetCapture(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetCapture();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern IntPtr SetCursor(IntPtr hCursor);

    /// <summary>The system owns <paramref name="hRgn"/> after a successful call: never delete it. IntPtr.Zero = whole window.</summary>
    [DllImport("user32.dll")]
    public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, [MarshalAs(UnmanagedType.Bool)] bool bRedraw);

    [DllImport("gdi32.dll")]
    public static extern int CombineRgn(IntPtr hrgnDst, IntPtr hrgnSrc1, IntPtr hrgnSrc2, int iMode);

    /// <summary>High bit set = the key is down now. Reports the PHYSICAL mouse buttons (see <see cref="IsPrimaryMouseButtonDown"/>).</summary>
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("shcore.dll")]
    public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    // ---- Helpers ---------------------------------------------------------------------------

    public static void SetImmersiveDarkMode(IntPtr hwnd, bool dark)
    {
        var value = dark ? 1 : 0;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref value, sizeof(int));
    }

    public static void SetCornerPreference(IntPtr hwnd, int preference)
    {
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
    }

    public static Point CursorPosition()
    {
        return GetCursorPos(out var p) ? new Point(p.X, p.Y) : Cursor.Position;
    }

    public static void SetTopMost(IntPtr hwnd, bool topMost)
    {
        SetWindowPos(hwnd, topMost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    /// <summary>Move without activating (used by drag/throw so focus stays where the user has it).</summary>
    public static void MoveWindowNoActivate(IntPtr hwnd, int x, int y)
    {
        SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }

    public static void SetBoundsNoActivate(IntPtr hwnd, int x, int y, int width, int height)
    {
        SetWindowPos(hwnd, IntPtr.Zero, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
    }

    public static bool IsKeyDown(int virtualKey) => (GetAsyncKeyState(virtualKey) & 0x8000) != 0;

    /// <summary>
    /// The logical left (primary) mouse button. GetAsyncKeyState reports physical buttons, so with swapped buttons the
    /// primary button is VK_RBUTTON.
    /// </summary>
    public static bool IsPrimaryMouseButtonDown()
        => IsKeyDown(SystemInformation.MouseButtonsSwapped ? VK_RBUTTON : VK_LBUTTON);

    /// <summary>
    /// DPI scale (1.0 = 96 DPI) of a window, straight from Windows: equal to Form.DeviceDpi / 96 once WinForms has synced
    /// it, and already right while the window is being created (WM_CREATE), when DeviceDpi may still be the old value.
    /// </summary>
    public static double WindowScale(IntPtr hwnd)
    {
        var dpi = GetDpiForWindow(hwnd);
        return dpi > 0 ? dpi / 96.0 : 1.0;
    }

    /// <summary>Effective DPI scale (1.0 = 96 DPI) of the monitor nearest to <paramref name="point"/>; 1.0 when unknown.</summary>
    public static double MonitorScale(Point point)
    {
        try
        {
            var monitor = MonitorFromPoint(new POINT { X = point.X, Y = point.Y }, MONITOR_DEFAULTTONEAREST);
            if (monitor != IntPtr.Zero && GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, out var dpiX, out _) == 0 && dpiX > 0)
            {
                return dpiX / 96.0;
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            // shcore.dll is part of every supported Windows version; fall through to the default anyway.
        }
        return 1.0;
    }

    /// <summary>
    /// Restricts the window's mouse input (and painting) to the union of <paramref name="rects"/> (window-relative
    /// physical px); an empty list restores the whole window. Returns false when the region could not be applied.
    /// </summary>
    public static bool SetWindowRegion(IntPtr hwnd, IReadOnlyList<Rectangle> rects)
    {
        if (rects.Count == 0) return SetWindowRgn(hwnd, IntPtr.Zero, true) != 0;

        var region = CreateRectRgn(rects[0].Left, rects[0].Top, rects[0].Right, rects[0].Bottom);
        if (region == IntPtr.Zero) return false;
        for (var i = 1; i < rects.Count; i++)
        {
            var part = CreateRectRgn(rects[i].Left, rects[i].Top, rects[i].Right, rects[i].Bottom);
            if (part == IntPtr.Zero) continue;
            CombineRgn(region, region, part, RGN_OR);
            DeleteObject(part);
        }
        if (SetWindowRgn(hwnd, region, true) != 0) return true; // the system owns the region now
        DeleteObject(region);
        return false;
    }
}

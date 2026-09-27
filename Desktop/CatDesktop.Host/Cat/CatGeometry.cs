using CatDesktop.Host.Models;
using CatDesktop.Host.Native;

namespace CatDesktop.Host.Cat;

/// <summary>
/// One layout of the cat window (contract §7): window and cat box sizes in CSS px, the anchor corner that holds the box,
/// and the DPI scale used to turn them into physical px. Immutable; every physical value is derived the same way.
/// (Not to be confused with CatSettings.Scale, the cat size, which only decides <see cref="BoxCss"/>.)
/// </summary>
internal readonly record struct CatLayout(string Mode, string Anchor, Size WindowCss, Size BoxCss, double DpiScale)
{
    public Size WindowPx => CatGeometry.ToPhysical(WindowCss, DpiScale);

    public Size BoxPx => CatGeometry.ToPhysical(BoxCss, DpiScale);

    /// <summary>The cat box inside the window, physical px.</summary>
    public Rectangle BoxInWindowPx => CatGeometry.BoxInWindow(WindowPx, BoxPx, Anchor);

    /// <summary>The cat box inside the window, CSS px.</summary>
    public Rectangle BoxInWindowCss => CatGeometry.BoxInWindow(WindowCss, BoxCss, Anchor);

    /// <param name="catScale">CatSettings.Scale (cat size, 0.1-2).</param>
    /// <param name="dpiScale">The window's DPI / 96.</param>
    public static CatLayout Create(string mode, string anchor, double catScale, double dpiScale)
    {
        var box = CatGeometry.BoxCss(catScale);
        return new CatLayout(mode, anchor, CatGeometry.WindowCss(mode, box), box, dpiScale);
    }

    public CatLayoutResult ToResult() => new()
    {
        Mode = Mode,
        Anchor = Anchor,
        Width = WindowCss.Width,
        Height = WindowCss.Height,
        Box = Rect.From(BoxInWindowCss),
    };
}

/// <summary>Pure geometry of the cat window (contract §7). No window handles, no state.</summary>
internal static class CatGeometry
{
    /// <summary>Without a saved position the cat box stands on the primary work area's bottom edge, this far (CSS px) from its right edge.</summary>
    public const int DefaultRightMarginCss = 48;
    public const int ReferenceBoxWidthCss = 160;
    public const int ReferenceBoxHeightCss = 120;
    public const int MinBoxWidthCss = 16;
    public const int MinBoxHeightCss = 12;
    public const int MenuMinWidthCss = 240;
    public const int MenuExtraHeightCss = 360;
    public const int PanelMinWidthCss = 340;
    public const int PanelExtraHeightCss = 456;

    /// <summary>Cat box (4:3), CSS px: round(160 x scale) x round(120 x scale), at least 16 x 12.</summary>
    public static Size BoxCss(double catScale) => new(
        Math.Max(MinBoxWidthCss, (int)Math.Round(ReferenceBoxWidthCss * catScale, MidpointRounding.AwayFromZero)),
        Math.Max(MinBoxHeightCss, (int)Math.Round(ReferenceBoxHeightCss * catScale, MidpointRounding.AwayFromZero)));

    /// <summary>Window size for a layout mode, CSS px: the box alone, or the box plus the menu / panel area.</summary>
    public static Size WindowCss(string mode, Size box) => mode switch
    {
        CatLayoutModes.Menu => new Size(Math.Max(box.Width, MenuMinWidthCss), box.Height + MenuExtraHeightCss),
        CatLayoutModes.Panel => new Size(Math.Max(box.Width, PanelMinWidthCss), box.Height + PanelExtraHeightCss),
        _ => box,
    };

    public static int ToPhysical(double css, double scale) => (int)Math.Round(css * scale);

    public static Size ToPhysical(Size css, double scale) => new(ToPhysical(css.Width, scale), ToPhysical(css.Height, scale));

    /// <summary>The box placed in the <paramref name="anchor"/> corner of a window (any unit).</summary>
    public static Rectangle BoxInWindow(Size window, Size box, string anchor) => new(
        CatAnchors.IsRight(anchor) ? window.Width - box.Width : 0,
        CatAnchors.IsBottom(anchor) ? window.Height - box.Height : 0,
        box.Width,
        box.Height);

    /// <summary>
    /// The corner of the window that holds the box when the menu or panel opens: the extra area goes toward the side of
    /// the work area with more room (above/below the box, and left/right when the window is wider than the box).
    /// </summary>
    public static string ChooseAnchor(Rectangle boxOnScreen, Rectangle workArea)
    {
        var roomAbove = boxOnScreen.Top - workArea.Top;
        var roomBelow = workArea.Bottom - boxOnScreen.Bottom;
        var roomLeft = boxOnScreen.Left - workArea.Left;
        var roomRight = workArea.Right - boxOnScreen.Right;
        // Extra area above -> box at the bottom of the window; extra area to the left -> box at the right.
        return CatAnchors.From(bottom: roomAbove >= roomBelow, right: roomLeft >= roomRight);
    }

    /// <summary>
    /// Clamps a window into <paramref name="area"/>. When the window is larger than the area on an axis it is aligned to
    /// the area's start; in every case the cat box (<paramref name="boxInWindow"/>) ends up fully inside the area.
    /// </summary>
    public static Rectangle ClampWindowKeepingBox(Rectangle window, Rectangle boxInWindow, Rectangle area)
    {
        var x = ClampAxis(window.X, window.Width, area.Left, area.Right);
        var y = ClampAxis(window.Y, window.Height, area.Top, area.Bottom);
        // The box always fits (it is far smaller than any monitor), so this shift never pushes it out again.
        x = ClampAxis(x + boxInWindow.X, boxInWindow.Width, area.Left, area.Right) - boxInWindow.X;
        y = ClampAxis(y + boxInWindow.Y, boxInWindow.Height, area.Top, area.Bottom) - boxInWindow.Y;
        return new Rectangle(x, y, window.Width, window.Height);
    }

    public static Rectangle ClampInto(Rectangle rect, Rectangle area) => new(
        ClampAxis(rect.X, rect.Width, area.Left, area.Right),
        ClampAxis(rect.Y, rect.Height, area.Top, area.Bottom),
        rect.Width,
        rect.Height);

    private static int ClampAxis(int position, int size, int min, int max)
        => size >= max - min ? min : Math.Clamp(position, min, max - size);

    /// <summary>Default box position: standing on the bottom of the work area, <see cref="DefaultRightMarginCss"/> from its right edge.</summary>
    public static Point DefaultBoxLocation(Rectangle workArea, Size boxPx, double scale)
        => new(workArea.Right - ToPhysical(DefaultRightMarginCss, scale) - boxPx.Width, workArea.Bottom - boxPx.Height);

    /// <summary>
    /// A CSS rectangle in window coordinates as physical px, grown outward to whole pixels and clipped to the window.
    /// Returns an empty rectangle when nothing of it is inside the window.
    /// </summary>
    public static Rectangle CssToPhysicalClipped(RectangleF css, double scale, Size windowPx)
    {
        var left = (int)Math.Floor(css.Left * scale);
        var top = (int)Math.Floor(css.Top * scale);
        var right = (int)Math.Ceiling(css.Right * scale);
        var bottom = (int)Math.Ceiling(css.Bottom * scale);
        var rect = Rectangle.FromLTRB(left, top, right, bottom);
        rect.Intersect(new Rectangle(Point.Empty, windowPx));
        return rect.Width > 0 && rect.Height > 0 ? rect : Rectangle.Empty;
    }

    public static Point Centre(Rectangle r) => new(r.Left + r.Width / 2, r.Top + r.Height / 2);

    /// <summary>DIPs the box can move in each direction before it touches the work-area edge (never negative).</summary>
    public static CatRoom Room(Rectangle boxOnScreen, Rectangle workArea, double scale)
    {
        double Dips(int px) => Math.Floor(Math.Max(0, px) / scale * 100) / 100;
        return new CatRoom(
            Dips(boxOnScreen.Left - workArea.Left),
            Dips(workArea.Right - boxOnScreen.Right),
            Dips(boxOnScreen.Top - workArea.Top),
            Dips(workArea.Bottom - boxOnScreen.Bottom));
    }
}

/// <summary>Monitor lookups (physical px; the process is per-monitor DPI aware).</summary>
internal static class CatMonitors
{
    public static Screen Primary => Screen.PrimaryScreen ?? Screen.AllScreens[0];

    public static Screen? ByDeviceName(string? deviceName)
        => string.IsNullOrEmpty(deviceName)
            ? null
            : Screen.AllScreens.FirstOrDefault(s => string.Equals(s.DeviceName, deviceName, StringComparison.OrdinalIgnoreCase));

    /// <summary>The monitor whose bounds contain <paramref name="point"/>, or null when the point is on no monitor.</summary>
    public static Screen? Containing(Point point) => Screen.AllScreens.FirstOrDefault(s => s.Bounds.Contains(point));

    /// <summary>The monitor holding the point, else the nearest one.</summary>
    public static Screen Nearest(Point point) => Screen.FromPoint(point);

    public static double ScaleOf(Screen screen) => NativeMethods.MonitorScale(CatGeometry.Centre(screen.Bounds));

    public static MonitorInfo Describe(Screen screen) => new()
    {
        Id = screen.DeviceName,
        Primary = screen.Primary,
        Bounds = Rect.From(screen.Bounds),
        WorkArea = Rect.From(screen.WorkingArea),
        Scale = ScaleOf(screen),
    };

    public static List<MonitorInfo> DescribeAll() => Screen.AllScreens.Select(Describe).ToList();
}

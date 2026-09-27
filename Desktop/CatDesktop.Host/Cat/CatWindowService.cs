using System.Text.Json;
using CatDesktop.Host.App;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.Models;
using CatDesktop.Host.Native;
using CatDesktop.Host.Services;
using CatDesktop.Host.Windows;
using Microsoft.Win32;

namespace CatDesktop.Host.Cat;

/// <summary>
/// Everything the desktop cat does on the Windows side (contract §3 cat.*, §5, §7): owns the <see cref="CatWindow"/>,
/// the cat settings, the persisted position (window_states row "cat"), layout, hit region, click-through, walking,
/// dragging and the reaction to display changes. The window itself only does window plumbing; motion lives in
/// <see cref="CatWalker"/> / <see cref="CatDrag"/>, geometry in <see cref="CatGeometry"/>.
///
/// Source of truth for the position is the window's bounds plus the current <see cref="CatLayout"/> (which corner of the
/// window holds the cat box). The persisted position is always the cat box's top-left, so it does not depend on the
/// layout the app was closed in. Payloads are validated by the bridge handler before any method here is called.
/// Every member must be called on the UI thread.
/// </summary>
public sealed class CatWindowService : IDisposable
{
    public const int MaxHitRects = 16;
    private static readonly TimeSpan DisplayChangeDelay = TimeSpan.FromMilliseconds(300);

    private readonly SettingsService _settings;
    private readonly WindowStateRepository _windowStates;
    private readonly BridgeEvents _events;
    private readonly Logger _log;
    private readonly CatWindow _window;
    private readonly CatWalker _walker;
    private readonly CatDrag _drag;
    private readonly CatClickThrough _clickThrough;
    private readonly System.Windows.Forms.Timer _displayTimer = new();
    private readonly SynchronizationContext _ui;

    /// <summary>The layout last applied to the window (mode, anchor, CSS sizes, scale).</summary>
    private CatLayout _layout;
    private IReadOnlyList<RectangleF> _hitRectsCss = Array.Empty<RectangleF>();
    /// <summary>The hit region as applied (window-relative physical px); empty = the whole window.</summary>
    private IReadOnlyList<Rectangle> _hitRectsPx = Array.Empty<Rectangle>();
    /// <summary>cat.setClickThrough's runtime override of the settings-driven mode; null = follow the settings.</summary>
    private (bool Enabled, bool Hover)? _clickThroughOverride;
    private string _facing = CatFacings.Right;
    private string _monitorsSignature;

    private Point _dragStartLocation;
    /// <summary>Cursor position relative to the window's top-left when the drag started, in DIPs (survives DPI changes).</summary>
    private PointF _grabOffsetDips;
    private bool _lastDragMoved;
    /// <summary>
    /// The unclamped bottom-centre point of the last scale change and the box it produced. While the box is still there
    /// (nothing else moved the cat), the next scale change starts from that point instead of the rounded, maybe clamped box.
    /// </summary>
    private (double CentreX, double Bottom, Rectangle Placed)? _scaleAnchor;
    private bool _disposed;

    public CatWindowService(HostConfig config, AppPaths paths, BridgeRouter router, BridgeEvents events,
        SettingsService settings, WindowStateRepository windowStates, Logger log)
    {
        _settings = settings;
        _windowStates = windowStates;
        _events = events;
        _log = log;
        Settings = settings.Get(CatSettings.SettingsKey, CatSettings.Default).Normalised();

        _window = new CatWindow(config, paths, router, events, log, Settings.AlwaysOnTop);
        // Captured after the first control exists, so this is the WinForms context of the UI thread.
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();

        _walker = new CatWalker(location => _window.MoveNoActivate(location), log);
        _drag = new CatDrag(FollowCursor, OnDragEnded, log);
        _clickThrough = new CatClickThrough(_window, new LayeredMouseTransparency(), IsOnHitRegion, () => _drag.IsActive, log);
        _clickThrough.InteractiveChanged += interactive => SendToCat("cat.interactiveChanged", new { interactive });

        _window.VisibilityChanged += OnVisibilityChanged;
        _window.HandleReady += OnHandleReady;
        _window.DpiChangedHandled += OnDpiChanged;
        _window.HideRequested += () => HideCat();

        RestorePosition();
        ApplyClickThroughMode();
        _monitorsSignature = MonitorsSignature();

        _displayTimer.Interval = (int)DisplayChangeDelay.TotalMilliseconds;
        _displayTimer.Tick += (_, _) =>
        {
            _displayTimer.Stop();
            HandleDisplayChange();
        };
        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
        SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        // Keeps the cat in sync when cat.settings is changed behind its back (generic settings.set, data import).
        _settings.Changed += OnSettingChanged;
    }

    public CatWindow Window => _window;

    public CatSettings Settings { get; private set; }

    public bool IsVisible => !_window.IsDisposed && _window.Visible;

    /// <summary>Raised whenever the cat window becomes visible or hidden (after cat.visibilityChanged was broadcast).</summary>
    public event Action<bool>? VisibilityChanged;

    /// <summary>Raised after new cat settings were applied (after cat.settingsChanged was broadcast).</summary>
    public event Action<CatSettings>? SettingsChanged;

    // ---- Visibility -------------------------------------------------------------------------------

    /// <summary>Creates the native window and starts loading the cat page. Idempotent.</summary>
    public void CreateCatWindow() => _window.EnsureCreated();

    /// <summary>Shows the cat (false while CatSettings.enabled is false). Never activates the window.</summary>
    public bool ShowCat()
    {
        if (_window.IsDisposed || !Settings.Enabled) return false;
        CreateCatWindow();
        EnsureOnScreen();
        _window.ShowNoActivate();
        return _window.Visible;
    }

    /// <summary>Shows the cat and gives it keyboard focus (quick note). False while disabled.</summary>
    public bool ShowAndFocus()
    {
        if (!ShowCat()) return false;
        _window.ShowAndFocus();
        return true;
    }

    /// <summary>Hides the cat; a walk ends with reason 'hidden' and a drag is dropped (see <see cref="OnVisibilityChanged"/>).</summary>
    public void HideCat()
    {
        if (_window.IsDisposed) return;
        if (_window.Visible) _window.Hide();
    }

    public bool ToggleCat()
    {
        if (IsVisible)
        {
            HideCat();
            return false;
        }
        return ShowCat();
    }

    public void SetAlwaysOnTop(bool enabled) => _window.SetAlwaysOnTop(enabled);

    // ---- Position ---------------------------------------------------------------------------------

    public WindowState GetPosition() => _window.GetState();

    /// <summary>
    /// cat.moveTo: the window's top-left to (x, y) physical px, clamped so the window (and so the cat box) is inside the
    /// work area of the named monitor, else of the monitor containing the point, else of the primary monitor. Persisted.
    /// </summary>
    public WindowState SetCatPosition(int x, int y, string? monitor)
    {
        EndWalkForMove();
        var screen = CatMonitors.ByDeviceName(monitor) ?? CatMonitors.Containing(new Point(x, y)) ?? CatMonitors.Primary;
        var layout = CurrentLayout();
        var box = layout.BoxInWindowPx;
        Place(layout, new Point(x + box.X, y + box.Y), screen.WorkingArea);
        return PersistAndBroadcast();
    }

    /// <summary>cat.moveBy: move by (dx, dy) DIPs, clamped into the work area of the cat's current monitor. Persisted.</summary>
    public WindowState MoveCat(double dx, double dy)
    {
        EndWalkForMove();
        var layout = CurrentLayout();
        var box = _window.BoxOnScreen;
        var target = new Point(box.X + CatGeometry.ToPhysical(dx, layout.DpiScale), box.Y + CatGeometry.ToPhysical(dy, layout.DpiScale));
        Place(layout, target, MonitorOfBox(box).WorkingArea);
        return PersistAndBroadcast();
    }

    /// <summary>cat.savePosition (the host also saves after every walk, move, drag and layout change).</summary>
    public WindowState SaveCatPosition() => Persist();

    /// <summary>Called once at shutdown: finish any motion and persist.</summary>
    public void SaveState()
    {
        if (_window.IsDisposed) return;
        _drag.End(CatDragOutcome.Dropped);
        _walker.End(CatWalkEndReasons.Stopped);
        Persist();
    }

    public void ForceClose()
    {
        if (!_window.IsDisposed) _window.ForceClose();
    }

    // ---- Screen information -------------------------------------------------------------------------

    public CatScreenInfo GetScreenInformation()
    {
        var box = _window.BoxOnScreen;
        var screen = MonitorOfBox(box);
        return new CatScreenInfo
        {
            Monitor = CatMonitors.Describe(screen),
            Monitors = GetMonitorInformation(),
            Window = _window.GetState(),
            Box = Rect.From(_layout.BoxInWindowCss),
            Room = CatGeometry.Room(box, screen.WorkingArea, CurrentScale()),
        };
    }

    public List<MonitorInfo> GetMonitorInformation() => CatMonitors.DescribeAll();

    // ---- Walking ----------------------------------------------------------------------------------------

    /// <summary>
    /// cat.walk: a smooth walk by (dx, dy) DIPs at <paramref name="speed"/> DIP/s. The target is clamped so the cat box
    /// stays inside the current monitor's work area; the result reports what will really be walked. A walk in progress
    /// ends with 'replaced'. A walk that cannot move at all reports 0 and is followed by cat.walkEnded 'blocked'.
    /// </summary>
    public CatWalkResult Walk(double dx, double dy, double speed)
    {
        if (!IsVisible) throw BridgeException.Denied("The cat is hidden.");
        if (_drag.IsActive) throw BridgeException.Denied("The cat is being dragged.");
        if (_layout.Mode != CatLayoutModes.Cat) throw BridgeException.Denied("The cat can only walk in the 'cat' layout.");

        _walker.End(CatWalkEndReasons.Replaced);

        var scale = CurrentScale();
        var start = _window.Location;
        var box = _window.BoxOnScreen;
        var wanted = new Rectangle(box.X + CatGeometry.ToPhysical(dx, scale), box.Y + CatGeometry.ToPhysical(dy, scale), box.Width, box.Height);
        var clamped = CatGeometry.ClampInto(wanted, MonitorOfBox(box).WorkingArea); // walks never cross monitors
        var deltaX = clamped.X - box.X;
        var deltaY = clamped.Y - box.Y;

        _facing = deltaX < 0 || (deltaX == 0 && dx < 0) ? CatFacings.Left
            : deltaX > 0 || (deltaX == 0 && dx > 0) ? CatFacings.Right
            : _facing;

        if (deltaX == 0 && deltaY == 0)
        {
            var reason = dx == 0 && dy == 0 ? CatWalkEndReasons.Arrived : CatWalkEndReasons.Blocked;
            var ended = new CatWalkEnded(reason, start.X, start.Y);
            // Posted, so the event follows the response to this request.
            _ui.Post(_ => SendToCat("cat.walkEnded", ended), null);
            return new CatWalkResult { Dx = 0, Dy = 0, DurationMs = 0, AccelMs = 0, Facing = _facing };
        }

        var pathDips = Math.Sqrt((double)deltaX * deltaX + (double)deltaY * deltaY) / scale;
        var profile = CatWalkProfile.Create(pathDips, speed);
        _walker.Start(start, new Point(start.X + deltaX, start.Y + deltaY), pathDips, profile, OnWalkEnded);
        _log.Trace($"Cat walk {deltaX},{deltaY} px ({pathDips:0.#} DIP) at {speed:0.#} DIP/s: {profile.DurationSeconds * 1000:0} ms, accel {profile.AccelSeconds * 1000:0} ms.");
        return new CatWalkResult
        {
            Dx = Round2(deltaX / scale),
            Dy = Round2(deltaY / scale),
            DurationMs = (int)Math.Round(profile.DurationSeconds * 1000),
            AccelMs = (int)Math.Round(profile.AccelSeconds * 1000),
            Facing = _facing,
        };
    }

    /// <summary>cat.stop: decelerate to a stop within about 200 ms (walkEnded 'stopped'); no-op when not walking.</summary>
    public void StopWalk() => _walker.Stop();

    private void OnWalkEnded(string reason)
    {
        if (reason is CatWalkEndReasons.Replaced or CatWalkEndReasons.Layout)
        {
            // Replaced: the next walk goes on from here. Layout: setLayout persists and broadcasts right after.
            SendToCat("cat.walkEnded", new CatWalkEnded(reason, _window.Left, _window.Top));
            return;
        }
        var state = Persist(); // once per walk, never per frame
        SendToCat("cat.walkEnded", new CatWalkEnded(reason, state.X, state.Y));
        _events.Broadcast("cat.positionChanged", state);
    }

    /// <summary>An immediate move (moveTo/moveBy/display change) ends a walk on the spot.</summary>
    private void EndWalkForMove() => _walker.End(CatWalkEndReasons.Stopped);

    // ---- Dragging ---------------------------------------------------------------------------------------

    /// <summary>
    /// cat.dragStart: the window follows the native cursor (keeping the grab offset) until the primary button is released,
    /// or - with <paramref name="followUntilClick"/> - until the next click, Esc or 30 s. No-op while a drag is running.
    /// </summary>
    public void DragStart(bool followUntilClick)
    {
        if (_layout.Mode != CatLayoutModes.Cat) throw BridgeException.Denied("The cat can only be dragged in the 'cat' layout.");
        if (!IsVisible) throw BridgeException.Denied("The cat is hidden.");
        if (_drag.IsActive) return;

        _walker.End(CatWalkEndReasons.Dragged);

        var bounds = _window.Bounds;
        var cursor = NativeMethods.CursorPosition();
        // "Move Cat" (followUntilClick): the cat is picked up by the middle of its box. A normal drag keeps the point where
        // the pointer went down; if the pointer already left the window, the nearest edge point.
        var grab = followUntilClick
            ? CatGeometry.Centre(_window.BoxInWindow)
            : new Point(Math.Clamp(cursor.X - bounds.X, 0, bounds.Width - 1), Math.Clamp(cursor.Y - bounds.Y, 0, bounds.Height - 1));
        var scale = CurrentScale();
        _grabOffsetDips = new PointF((float)(grab.X / scale), (float)(grab.Y / scale));
        _dragStartLocation = bounds.Location;
        _lastDragMoved = false;

        _drag.Start(followUntilClick);
        SendToCat("cat.dragStateChanged", new { dragging = true });
        // Picked up right away (centred under the cursor), not only at the first frame; Esc still returns to the start.
        if (followUntilClick) FollowCursor(cursor);
        _log.Trace($"Cat drag started (followUntilClick={followUntilClick}).");
    }

    /// <summary>cat.dragEnd: ends a drag now. Returns whether the cat moved.</summary>
    public bool DragEnd()
    {
        if (!_drag.IsActive) return false;
        _drag.End(CatDragOutcome.Dropped);
        return _lastDragMoved;
    }

    /// <summary>One drag frame: window under the cursor, cat box kept fully inside the work area of the monitor under the cursor.</summary>
    private void FollowCursor(Point cursor)
    {
        var scale = CurrentScale();
        var box = _window.BoxInWindow;
        var location = new Point(cursor.X - CatGeometry.ToPhysical(_grabOffsetDips.X, scale), cursor.Y - CatGeometry.ToPhysical(_grabOffsetDips.Y, scale));
        var area = CatMonitors.Nearest(cursor).WorkingArea;
        var clamped = CatGeometry.ClampInto(new Rectangle(location.X + box.X, location.Y + box.Y, box.Width, box.Height), area);
        _window.MoveNoActivate(new Point(clamped.X - box.X, clamped.Y - box.Y));
    }

    private void OnDragEnded(CatDragOutcome outcome)
    {
        if (outcome == CatDragOutcome.Cancelled)
        {
            // Esc: back to where the drag started (still clamped, in case the displays changed meanwhile).
            var layout = CurrentLayout();
            var box = layout.BoxInWindowPx;
            var startBox = new Point(_dragStartLocation.X + box.X, _dragStartLocation.Y + box.Y);
            Place(layout, startBox, MonitorOfBox(new Rectangle(startBox, box.Size)).WorkingArea);
        }

        var end = _window.Location;
        var dx = end.X - _dragStartLocation.X;
        var dy = end.Y - _dragStartLocation.Y;
        _lastDragMoved = dx != 0 || dy != 0;
        var distance = Round2(Math.Sqrt((double)dx * dx + (double)dy * dy) / CurrentScale());
        var monitor = MonitorOfBox(_window.BoxOnScreen).DeviceName;

        SendToCat("cat.dragStateChanged", new { dragging = false });
        SendToCat("cat.dragEnded", new CatDragEnded(end.X, end.Y, monitor, _lastDragMoved, distance));
        if (_lastDragMoved) PersistAndBroadcast();
        _log.Trace($"Cat drag ended ({outcome}, moved={_lastDragMoved}, {distance} DIP).");
    }

    // ---- Layout & hit region ----------------------------------------------------------------------------

    /// <summary>
    /// cat.setLayout: resize the window for the context menu / companion panel. The cat box keeps its screen position when
    /// possible, the extra area opens toward the side with more room, and the whole window is clamped into the work area.
    /// </summary>
    public CatLayoutResult SetLayout(string mode)
    {
        _drag.End(CatDragOutcome.Dropped);
        _walker.End(CatWalkEndReasons.Layout);

        var box = _window.BoxOnScreen;
        var area = MonitorOfBox(box).WorkingArea;
        var anchor = CatGeometry.ChooseAnchor(box, area);
        var layout = CatLayout.Create(mode, anchor, Settings.Scale, CurrentScale());
        Place(layout, box.Location, area);
        ResetHitRegion();

        var result = layout.ToResult();
        SendToCat("cat.layoutChanged", result);
        PersistAndBroadcast();
        return result;
    }

    /// <summary>cat.setHitRegion: CSS rectangles in window coordinates; empty = the whole window. Kept for DPI changes.</summary>
    public void SetHitRegion(IReadOnlyList<RectangleF> rectsCss)
    {
        _hitRectsCss = rectsCss.ToArray();
        ApplyHitRegion();
    }

    private void ApplyHitRegion()
    {
        var scale = CurrentScale();
        var size = _layout.WindowPx;
        // Rectangles entirely outside the window are dropped; if none is left the whole window receives the mouse.
        _hitRectsPx = _hitRectsCss
            .Select(r => CatGeometry.CssToPhysicalClipped(r, scale, size))
            .Where(r => !r.IsEmpty)
            .ToArray();
        _window.SetRegion(_hitRectsPx);
    }

    private void ResetHitRegion()
    {
        _hitRectsCss = Array.Empty<RectangleF>();
        ApplyHitRegion();
    }

    private bool IsOnHitRegion(Point screenPoint)
    {
        var bounds = _window.Bounds;
        if (!bounds.Contains(screenPoint)) return false;
        if (_hitRectsPx.Count == 0) return true;
        var local = new Point(screenPoint.X - bounds.X, screenPoint.Y - bounds.Y);
        return _hitRectsPx.Any(r => r.Contains(local));
    }

    // ---- Click-through ----------------------------------------------------------------------------------

    /// <summary>cat.setClickThrough: runtime override of the settings-driven mode (until interaction settings change).</summary>
    public void SetClickThrough(bool enabled, bool hoverToInteract)
    {
        _clickThroughOverride = (enabled, hoverToInteract);
        ApplyClickThroughMode();
    }

    /// <summary>interaction=false → click-through without hover; clickThroughWhenIdle → click-through with hover; else interactive.</summary>
    private void ApplyClickThroughMode()
    {
        var (enabled, hover) = _clickThroughOverride
                               ?? (!Settings.Interaction ? (true, false) : Settings.ClickThroughWhenIdle ? (true, true) : (false, false));
        _clickThrough.Configure(enabled, hover);
    }

    // ---- Settings ---------------------------------------------------------------------------------------

    /// <summary>cat.saveSettings: normalise, store, apply, broadcast cat.settingsChanged.</summary>
    public CatSettings SaveSettings(CatSettings incoming)
    {
        ApplySettings(incoming.Normalised(), persist: true);
        return Settings;
    }

    /// <summary>Tray "Pause walking" / "Resume walking".</summary>
    public CatSettings SetAutoWalk(bool autoWalk) => SaveSettings(Settings with { AutoWalk = autoWalk });

    private void ApplySettings(CatSettings next, bool persist)
    {
        var previous = Settings;
        // Assigned before persisting so the settings.Changed observer (OnSettingChanged) sees the final value.
        Settings = next;
        if (persist) _settings.Set(CatSettings.SettingsKey, next);

        if (previous.AlwaysOnTop != next.AlwaysOnTop) _window.SetAlwaysOnTop(next.AlwaysOnTop);
        if (previous.Scale != next.Scale) ApplyScale();
        if (previous.Interaction != next.Interaction || previous.ClickThroughWhenIdle != next.ClickThroughWhenIdle)
        {
            _clickThroughOverride = null; // the settings take over again
            ApplyClickThroughMode();
        }
        if (previous.AutoWalk && !next.AutoWalk) _walker.Stop();

        if (!next.Enabled) HideCat();
        else if (!previous.Enabled) ShowCat(); // switched on in Settings: bring the cat back right away

        _events.Broadcast("cat.settingsChanged", next);
        SettingsChanged?.Invoke(next);
    }

    /// <summary>
    /// A new cat scale (contract cat.saveSettings): box and window are resized at once, keeping the cat box's bottom-centre
    /// point (its feet) where it was, then the box - and in menu/panel layout the whole window, same anchor - is clamped
    /// into the work area. One SetWindowPos per change, so a Settings slider sending several saves a second resizes
    /// smoothly. Consecutive changes reuse one bottom-centre anchor (see <see cref="_scaleAnchor"/>), so rounding never
    /// walks the cat sideways and a cat pushed in from a screen edge goes back when it shrinks again.
    /// </summary>
    private void ApplyScale()
    {
        _drag.End(CatDragOutcome.Dropped);
        _walker.End(CatWalkEndReasons.Layout);

        var box = _window.BoxOnScreen;
        var (centreX, bottom) = _scaleAnchor is { } anchor && anchor.Placed == box
            ? (anchor.CentreX, anchor.Bottom)
            : (box.X + box.Width / 2.0, (double)box.Bottom);
        var layout = CatLayout.Create(_layout.Mode, _layout.Anchor, Settings.Scale, CurrentScale());
        var size = layout.BoxPx;
        var location = new Point((int)Math.Round(centreX - size.Width / 2.0, MidpointRounding.AwayFromZero), (int)Math.Round(bottom) - size.Height);
        // The region belongs to the old size (the UI sends a new one after cat.layoutChanged). Cleared before the resize, so
        // the bigger window is never clipped to the old silhouette for a frame.
        ResetHitRegion();
        Place(layout, location, MonitorOfBox(box).WorkingArea);
        _scaleAnchor = (centreX, bottom, _window.BoxOnScreen);

        SendToCat("cat.layoutChanged", layout.ToResult());
        PersistAndBroadcast();
    }

    private void OnSettingChanged(string key, object? value)
    {
        if (key != CatSettings.SettingsKey || _disposed) return;
        var stored = _settings.Get(CatSettings.SettingsKey, CatSettings.Default).Normalised();
        if (stored == Settings) return; // our own write, or nothing that matters
        ApplySettings(stored, persist: false);
    }

    // ---- Commands ---------------------------------------------------------------------------------------

    /// <summary>cat.sendCommand / hotkeys: show the cat (when enabled) and forward cat.command to the cat window.</summary>
    public void SendCommand(string action, JsonElement? payload)
    {
        // The quick note is typed into: give the cat keyboard focus (the request comes from a user action).
        if (action == "quick-note") ShowAndFocus();
        else ShowCat();
        SendToCat("cat.command", payload is { } p ? new { action, payload = p } : new { action });
    }

    // ---- Window events ----------------------------------------------------------------------------------

    private void OnVisibilityChanged(bool visible)
    {
        if (!visible)
        {
            _drag.End(CatDragOutcome.Dropped);
            _walker.End(CatWalkEndReasons.Hidden);
        }
        _clickThrough.Refresh();
        _events.Broadcast("cat.visibilityChanged", new { visible });
        VisibilityChanged?.Invoke(visible);
    }

    /// <summary>A native window now exists: derive the physical sizes from its real DPI and re-apply region and state.</summary>
    private void OnHandleReady()
    {
        var box = _window.BoxOnScreen;
        Place(CurrentLayout(), box.Location, MonitorOfBox(box).WorkingArea);
        ApplyHitRegion();
        _clickThrough.Refresh();
    }

    /// <summary>
    /// WM_DPICHANGED (moved to a monitor with another scale, or the scale changed): WinForms has applied the suggested
    /// bounds. Keep the anchor corner of those bounds, re-derive the physical sizes, clamp, rescale the hit region.
    /// </summary>
    private void OnDpiChanged()
    {
        if (!_drag.IsActive) _walker.End(CatWalkEndReasons.Stopped);
        var layout = CurrentLayout();
        var bounds = _window.Bounds;
        var size = layout.WindowPx;
        var x = CatAnchors.IsRight(layout.Anchor) ? bounds.Right - size.Width : bounds.Left;
        var y = CatAnchors.IsBottom(layout.Anchor) ? bounds.Bottom - size.Height : bounds.Top;
        var box = layout.BoxInWindowPx;
        var boxOnScreen = new Rectangle(x + box.X, y + box.Y, box.Width, box.Height);
        // While dragging, the next drag frame clamps against the monitor under the cursor anyway.
        Place(layout, boxOnScreen.Location, MonitorOfBox(boxOnScreen).WorkingArea);
        ApplyHitRegion();
        _log.Info($"Cat window scale is now {CurrentScale():0.###}.");
        SendToCat("cat.screenChanged", GetScreenInformation());
        if (!_drag.IsActive) PersistAndBroadcast();
    }

    // ---- Display changes ----------------------------------------------------------------------------------

    private void OnDisplaySettingsChanged(object? sender, EventArgs e) => ScheduleDisplayCheck();

    private void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e)
    {
        // Desktop covers work-area changes (taskbar moved, resized, auto-hide toggled).
        if (e.Category == UserPreferenceCategory.Desktop) ScheduleDisplayCheck();
    }

    /// <summary>SystemEvents may arrive on another thread and in bursts: coalesce them on the UI thread.</summary>
    private void ScheduleDisplayCheck()
    {
        _ui.Post(_ =>
        {
            if (_disposed) return;
            _displayTimer.Stop();
            _displayTimer.Start();
        }, null);
    }

    /// <summary>
    /// Monitors, resolution, scale or work area changed: move the cat back into a valid work area (the primary one when
    /// its monitor is gone) and tell the cat window. Nothing happens when nothing relevant changed.
    /// </summary>
    private void HandleDisplayChange()
    {
        if (_disposed || _window.IsDisposed) return;
        var signature = MonitorsSignature();
        var box = _window.BoxOnScreen;
        var screen = CatMonitors.Containing(CatGeometry.Centre(box)) ?? CatMonitors.Primary;
        var onScreen = screen.WorkingArea.Contains(_window.Bounds) || screen.WorkingArea.Contains(box);
        if (signature == _monitorsSignature && onScreen) return;
        _monitorsSignature = signature;
        _log.Info($"Displays changed; the cat is on {screen.DeviceName} {(onScreen ? "(still inside its work area)" : "(moved back inside)")}.");

        if (!_drag.IsActive)
        {
            EndWalkForMove();
            Place(CurrentLayout(), box.Location, screen.WorkingArea);
        }
        SendToCat("cat.screenChanged", GetScreenInformation());
        PersistAndBroadcast();
    }

    /// <summary>Before showing: never show the cat outside every work area (displays may have changed while it was hidden).</summary>
    private void EnsureOnScreen()
    {
        var box = _window.BoxOnScreen;
        if (Screen.AllScreens.Any(s => s.WorkingArea.Contains(box))) return;
        var screen = CatMonitors.Containing(CatGeometry.Centre(box)) ?? CatMonitors.Primary;
        Place(CurrentLayout(), box.Location, screen.WorkingArea);
        Persist();
    }

    private static string MonitorsSignature()
        => string.Join("|", Screen.AllScreens.Select(s => $"{s.DeviceName}:{s.Bounds}:{s.WorkingArea}:{CatMonitors.ScaleOf(s)}"));

    // ---- Geometry ---------------------------------------------------------------------------------------

    /// <summary>The window's DPI scale (its DPI / 96, i.e. Form.DeviceDpi / 96); before the native window exists, the scale of its monitor.</summary>
    private double CurrentScale()
        => _window.IsHandleCreated
            ? NativeMethods.WindowScale(_window.Handle)
            : CatMonitors.ScaleOf(CatMonitors.Nearest(CatGeometry.Centre(_window.Bounds)));

    /// <summary>The current mode and anchor at the current size setting and scale.</summary>
    private CatLayout CurrentLayout() => CatLayout.Create(_layout.Mode, _layout.Anchor, Settings.Scale, CurrentScale());

    private static Screen MonitorOfBox(Rectangle box) => CatMonitors.Nearest(CatGeometry.Centre(box));

    /// <summary>
    /// Puts the window into <paramref name="layout"/> with the cat box's top-left at <paramref name="boxLocation"/> (physical
    /// px), clamped into <paramref name="area"/>. The only place that sizes the window.
    /// </summary>
    private void Place(CatLayout layout, Point boxLocation, Rectangle area)
    {
        var box = layout.BoxInWindowPx;
        var size = layout.WindowPx;
        var bounds = new Rectangle(boxLocation.X - box.X, boxLocation.Y - box.Y, size.Width, size.Height);
        bounds = CatGeometry.ClampWindowKeepingBox(bounds, box, area);
        _layout = layout;
        _window.BoxInWindow = box;
        // May raise WM_DPICHANGED synchronously (new monitor): OnDpiChanged then re-places with the new scale.
        _window.SetBoundsNoActivate(bounds);
    }

    /// <summary>Start-up position (contract §7): the saved monitor (else the primary) and box position, clamped; else the default spot.</summary>
    private void RestorePosition()
    {
        var stored = _windowStates.Get(WindowKind.Cat.ToWindowId());
        var screen = CatMonitors.ByDeviceName(stored?.Monitor) ?? CatMonitors.Primary;
        var scale = CatMonitors.ScaleOf(screen);
        var layout = CatLayout.Create(CatLayoutModes.Cat, CatAnchors.BottomRight, Settings.Scale, scale);
        var location = stored is null
            ? CatGeometry.DefaultBoxLocation(screen.WorkingArea, layout.BoxPx, scale)
            : new Point(stored.X, stored.Y);
        Place(layout, location, screen.WorkingArea);
        _log.Info($"Cat placed at {_window.Bounds} on {screen.DeviceName} ({(stored is null ? "default position" : "restored")}).");
    }

    // ---- Persistence & events -------------------------------------------------------------------------------

    /// <summary>Stores the cat box's top-left (the 'cat' layout position) and its monitor. Never throws.</summary>
    private WindowState Persist()
    {
        var box = _window.BoxOnScreen;
        try
        {
            _windowStates.Save(new WindowState
            {
                WindowId = WindowKind.Cat.ToWindowId(),
                Monitor = MonitorOfBox(box).DeviceName,
                X = box.X,
                Y = box.Y,
                Width = box.Width,
                Height = box.Height,
            });
        }
        catch (Exception ex)
        {
            _log.Warn($"Cat position not saved: {ex.Message}");
        }
        return _window.GetState();
    }

    private WindowState PersistAndBroadcast()
    {
        var state = Persist();
        _events.Broadcast("cat.positionChanged", state);
        return state;
    }

    private void SendToCat(string name, object data) => _events.Send(WindowKind.Cat, name, data);

    private static double Round2(double value) => Math.Round(value, 2);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
        _settings.Changed -= OnSettingChanged;
        _displayTimer.Dispose();
        _walker.Dispose();
        _drag.Dispose();
        _clickThrough.Dispose();
        if (!_window.IsDisposed)
        {
            _window.ForceClose();
            _window.Dispose();
        }
    }
}

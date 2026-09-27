using System.Diagnostics;
using CatDesktop.Host.App;
using CatDesktop.Host.Native;

namespace CatDesktop.Host.Cat;

/// <summary>How a drag ended.</summary>
internal enum CatDragOutcome
{
    /// <summary>Button released / next click / cat.dragEnd / timeout: the cat stays where it is.</summary>
    Dropped,
    /// <summary>Esc: the caller puts the cat back where the drag started.</summary>
    Cancelled,
}

/// <summary>
/// The native drag loop (contract cat.dragStart): polls the cursor at ~60 Hz on a UI-thread timer and hands every
/// position to <c>follow</c>, which places the window. The page cannot do this itself: once the window moves under the
/// pointer, DOM pointer coordinates are relative to a moving frame, and a fast pointer leaves the window altogether.
///
/// Normal drag: the primary button is down when the drag starts (the page sends dragStart from pointerdown); the drag
/// ends when it is up. followUntilClick ("Move Cat" in the context menu): the button may be up or still down from the
/// menu click; the drag ends on the NEXT complete click (down, then up), on Esc, or after 30 s.
/// Esc (a new press, in either mode) cancels. UI thread only.
/// </summary>
internal sealed class CatDrag : IDisposable
{
    private const int FrameIntervalMs = 15; // ~64 Hz, see CatWalker
    public static readonly TimeSpan FollowTimeout = TimeSpan.FromSeconds(30);

    private enum ClickPhase { WaitForRelease, Armed, Pressed }

    private readonly Action<Point> _follow;
    private readonly Action<CatDragOutcome> _ended;
    private readonly Logger _log;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = FrameIntervalMs };
    private readonly Stopwatch _clock = new();

    private ClickPhase _phase;
    private bool _escapeWasDown;
    private Point _lastCursor;

    public CatDrag(Action<Point> follow, Action<CatDragOutcome> ended, Logger log)
    {
        _follow = follow;
        _ended = ended;
        _log = log;
        _timer.Tick += OnTick;
    }

    public bool IsActive { get; private set; }

    public bool FollowUntilClick { get; private set; }

    /// <summary>Starts polling. The caller has recorded the start position and grab offset.</summary>
    public void Start(bool followUntilClick)
    {
        FollowUntilClick = followUntilClick;
        _phase = NativeMethods.IsPrimaryMouseButtonDown() ? ClickPhase.WaitForRelease : ClickPhase.Armed;
        // An Esc that is already held (e.g. the key that closed a menu) does not cancel; only a new press does.
        _escapeWasDown = NativeMethods.IsKeyDown(NativeMethods.VK_ESCAPE);
        _lastCursor = NativeMethods.CursorPosition();
        IsActive = true;
        _clock.Restart();
        _timer.Start();
    }

    /// <summary>Ends the drag now (no-op when not dragging) and reports <paramref name="outcome"/>.</summary>
    public void End(CatDragOutcome outcome)
    {
        if (!IsActive) return;
        IsActive = false;
        _timer.Stop();
        _ended(outcome);
    }

    public void Dispose()
    {
        IsActive = false;
        _timer.Stop();
        _timer.Tick -= OnTick;
        _timer.Dispose();
    }

    private void OnTick(object? sender, EventArgs e)
    {
        if (!IsActive)
        {
            _timer.Stop();
            return;
        }

        try
        {
            var escapeDown = NativeMethods.IsKeyDown(NativeMethods.VK_ESCAPE);
            if (escapeDown && !_escapeWasDown)
            {
                End(CatDragOutcome.Cancelled);
                return;
            }
            _escapeWasDown = escapeDown;

            // GetCursorPos fails while the workstation is locked or on a secure desktop: keep the last position.
            if (NativeMethods.GetCursorPos(out var p)) _lastCursor = new Point(p.X, p.Y);
            var buttonDown = NativeMethods.IsPrimaryMouseButtonDown();

            if (!FollowUntilClick)
            {
                // Released: the cat stays where the last frame put it. (Following first would make it jump to wherever
                // the cursor went after the release - or, when the button was already up at dragStart, to the cursor.)
                if (!buttonDown)
                {
                    End(CatDragOutcome.Dropped);
                    return;
                }
                _follow(_lastCursor);
                return;
            }

            _phase = (_phase, buttonDown) switch
            {
                (ClickPhase.WaitForRelease, false) => ClickPhase.Armed,
                (ClickPhase.Armed, true) => ClickPhase.Pressed,
                _ => _phase,
            };
            _follow(_lastCursor);
            if ((_phase == ClickPhase.Pressed && !buttonDown) || _clock.Elapsed >= FollowTimeout)
            {
                End(CatDragOutcome.Dropped);
            }
        }
        catch (Exception ex)
        {
            _log.Error("Cat drag aborted", ex);
            End(CatDragOutcome.Dropped);
        }
    }
}

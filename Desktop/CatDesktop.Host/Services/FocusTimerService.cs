using CatDesktop.Host.App;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.Models;

namespace CatDesktop.Host.Services;

/// <summary>
/// The Pomodoro-style focus timer. It runs in the host so the main window, the cat window and the tray always agree
/// (contract section 3 focus.*). State is guarded by a lock and may be read from any thread; the one-second tick runs on a
/// thread-pool timer. Its broadcast and phase completion (database writes, notifications, auto-start) are posted to the
/// UI thread that issued the bridge commands, so they are ordered with those commands and repositories and
/// notifications are always used from that thread.
/// </summary>
public sealed class FocusTimerService : IDisposable
{
    private const int TickIntervalMs = 1000;
    private const int MinMinutes = 1;
    private const int MaxMinutes = 180;

    private readonly SettingsService _settings;
    private readonly FocusSessionsRepository _sessions;
    private readonly BridgeEvents _events;
    private readonly NotificationService _notifications;
    private readonly Logger _log;
    private readonly object _gate = new();
    private readonly System.Threading.Timer _timer;

    private FocusState _state;
    private string? _sessionId;
    private DateTime? _endsAtUtc;
    private SynchronizationContext? _uiContext;
    private bool _disposed;

    public FocusTimerService(
        SettingsService settings,
        FocusSessionsRepository sessions,
        BridgeEvents events,
        NotificationService notifications,
        Logger log)
    {
        _settings = settings;
        _sessions = sessions;
        _events = events;
        _notifications = notifications;
        _log = log;

        var total = DurationSeconds(FocusPhases.Focus, GetSettings());
        _state = new FocusState { RemainingSeconds = total, TotalSeconds = total };
        _timer = new System.Threading.Timer(OnTimerTick, null, Timeout.Infinite, Timeout.Infinite);
    }

    public FocusState State
    {
        get { lock (_gate) return _state; }
    }

    public FocusSettings GetSettings() => _settings.Get(FocusSettings.SettingsKey, FocusSettings.Default).Normalised();

    /// <summary>Persist new durations/flags; while no phase is active the displayed duration follows the new settings.</summary>
    public FocusSettings SaveSettings(FocusSettings incoming)
    {
        var settings = incoming.Normalised();
        _settings.Set(FocusSettings.SettingsKey, settings);

        FocusState? snapshot = null;
        lock (_gate)
        {
            if (_state.Status is FocusStatuses.Idle or FocusStatuses.Completed)
            {
                var total = DurationSeconds(_state.Phase, settings);
                _state = _state with { RemainingSeconds = total, TotalSeconds = total };
                snapshot = _state;
            }
        }
        if (snapshot is not null) _events.Broadcast("focus.tick", snapshot);
        return settings;
    }

    public FocusStats GetStats() => _sessions.GetStats();

    /// <summary>
    /// Start <paramref name="phase"/> (default: the phase that is up next) for <paramref name="minutes"/> (default: the
    /// configured duration). A running or paused phase is abandoned and its session marked incomplete.
    /// </summary>
    public FocusState Start(string? phase, int? minutes)
    {
        if (phase is not null && !FocusPhases.IsValid(phase))
        {
            throw BridgeException.Validation("'phase' must be 'focus', 'shortBreak' or 'longBreak'.");
        }
        if (minutes is { } m && (m < MinMinutes || m > MaxMinutes))
        {
            throw BridgeException.Validation($"'minutes' must be between {MinMinutes} and {MaxMinutes}.");
        }

        CaptureUiContext();
        FocusState snapshot;
        lock (_gate)
        {
            ThrowIfDisposed();
            var settings = GetSettings();
            var targetPhase = phase ?? _state.Phase;
            var total = (minutes ?? DurationMinutes(targetPhase, settings)) * 60;
            var now = DateTime.UtcNow;

            var session = new FocusSession
            {
                Id = Timestamps.NewId(),
                Phase = targetPhase,
                StartedAt = Timestamps.ToIso(now),
                PlannedSeconds = total,
                Completed = false,
            };
            _sessions.Insert(session);
            CloseOpenSession(completed: false);

            _sessionId = session.Id;
            _endsAtUtc = now.AddSeconds(total);
            _state = _state with
            {
                Phase = targetPhase,
                Status = FocusStatuses.Running,
                RemainingSeconds = total,
                TotalSeconds = total,
                StartedAt = session.StartedAt,
                EndsAt = Timestamps.ToIso(_endsAtUtc.Value),
            };
            snapshot = _state;
            _timer.Change(TickIntervalMs, TickIntervalMs);
        }

        _events.Broadcast("focus.tick", snapshot);
        return snapshot;
    }

    public FocusState Pause()
    {
        CaptureUiContext();
        FocusState snapshot;
        bool changed;
        lock (_gate)
        {
            changed = _state.Status == FocusStatuses.Running && _endsAtUtc is not null;
            if (changed)
            {
                StopTimerCore();
                _state = _state with
                {
                    Status = FocusStatuses.Paused,
                    RemainingSeconds = SecondsUntil(_endsAtUtc!.Value),
                    EndsAt = null,
                };
                _endsAtUtc = null;
            }
            snapshot = _state;
        }
        if (changed) _events.Broadcast("focus.tick", snapshot);
        return snapshot;
    }

    public FocusState Resume()
    {
        CaptureUiContext();
        FocusState snapshot;
        bool changed;
        lock (_gate)
        {
            changed = _state.Status == FocusStatuses.Paused;
            if (changed)
            {
                ThrowIfDisposed();
                _endsAtUtc = DateTime.UtcNow.AddSeconds(_state.RemainingSeconds);
                _state = _state with { Status = FocusStatuses.Running, EndsAt = Timestamps.ToIso(_endsAtUtc.Value) };
                _timer.Change(TickIntervalMs, TickIntervalMs);
            }
            snapshot = _state;
        }
        if (changed) _events.Broadcast("focus.tick", snapshot);
        return snapshot;
    }

    /// <summary>Abandon the current phase and return to an idle focus phase; the session counter is kept.</summary>
    public FocusState Stop() => StopCore(resetCounter: false);

    /// <summary>Like <see cref="Stop"/> but also forgets the completed sessions of this run.</summary>
    public FocusState Reset() => StopCore(resetCounter: true);

    /// <summary>Move on to the next phase without counting the current one as completed.</summary>
    public FocusState Skip()
    {
        CaptureUiContext();
        return CompletePhase(completed: false, onlyIfSession: null);
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            StopTimerCore();
            _disposed = true;
            _timer.Dispose();
            try
            {
                CloseOpenSession(completed: false);
            }
            catch (Exception ex)
            {
                _log.Warn($"Focus session could not be closed at shutdown: {ex.Message}");
            }
        }
    }

    // ---- Internals ----------------------------------------------------------------------------

    private FocusState StopCore(bool resetCounter)
    {
        CaptureUiContext();
        FocusState snapshot;
        lock (_gate)
        {
            StopTimerCore();
            CloseOpenSession(completed: false);
            var total = DurationSeconds(FocusPhases.Focus, GetSettings());
            _endsAtUtc = null;
            _state = new FocusState
            {
                Phase = FocusPhases.Focus,
                Status = FocusStatuses.Idle,
                RemainingSeconds = total,
                TotalSeconds = total,
                CompletedFocusSessions = resetCounter ? 0 : _state.CompletedFocusSessions,
                StartedAt = null,
                EndsAt = null,
            };
            snapshot = _state;
        }
        _events.Broadcast("focus.tick", snapshot);
        return snapshot;
    }

    /// <summary>
    /// Finish the current phase and line up the next one. <paramref name="onlyIfSession"/> makes the call a no-op unless
    /// that session is still the running one (guards the posted tick completion against Stop/Skip/Start racing it).
    /// </summary>
    private FocusState CompletePhase(bool completed, string? onlyIfSession)
    {
        string finishedPhase;
        string nextPhase;
        int nextMinutes;
        FocusSettings settings;
        FocusState snapshot;
        bool autoStart;
        lock (_gate)
        {
            if (onlyIfSession is not null && (_disposed || _sessionId != onlyIfSession || _state.Status != FocusStatuses.Running))
            {
                return _state;
            }

            StopTimerCore();
            settings = GetSettings();
            finishedPhase = _state.Phase;
            var sessionsDone = _state.CompletedFocusSessions;
            if (completed && finishedPhase == FocusPhases.Focus) sessionsDone++;

            // Only a focus phase that was just completed can earn the long break (sessionsDone >= 1 then); a skipped one
            // must not repeat the long break that the unchanged counter already earned.
            nextPhase = finishedPhase == FocusPhases.Focus
                ? (completed && sessionsDone % settings.SessionsBeforeLongBreak == 0 ? FocusPhases.LongBreak : FocusPhases.ShortBreak)
                : FocusPhases.Focus;
            nextMinutes = DurationMinutes(nextPhase, settings);

            CloseOpenSession(completed);
            _endsAtUtc = null;
            _state = new FocusState
            {
                Phase = nextPhase,
                Status = FocusStatuses.Completed,
                RemainingSeconds = nextMinutes * 60,
                TotalSeconds = nextMinutes * 60,
                CompletedFocusSessions = sessionsDone,
                StartedAt = null,
                EndsAt = null,
            };
            snapshot = _state;
            autoStart = completed && (finishedPhase == FocusPhases.Focus ? settings.AutoStartBreaks : settings.AutoStartFocus);
        }

        if (completed)
        {
            if (settings.Notify) Notify(finishedPhase, nextMinutes, silent: !settings.Sound);
            _events.Broadcast("focus.completed", new { phase = finishedPhase, next = nextPhase });
        }
        _events.Broadcast("focus.tick", snapshot);

        return autoStart ? Start(nextPhase, null) : snapshot;
    }

    private void Notify(string finishedPhase, int nextMinutes, bool silent)
    {
        var (title, body) = finishedPhase == FocusPhases.Focus
            ? ("Focus session complete", $"Nice work. Time for a {nextMinutes}-minute break.")
            : ("Break over", "Back to focus.");
        try
        {
            _notifications.Show(title, body, silent);
        }
        catch (Exception ex)
        {
            _log.Warn($"Focus notification failed: {ex.Message}");
        }
    }

    private void OnTimerTick(object? state)
    {
        string? expiredSession = null;
        lock (_gate)
        {
            if (_disposed || _state.Status != FocusStatuses.Running || _endsAtUtc is null) return;
            var remaining = SecondsUntil(_endsAtUtc.Value);
            _state = _state with { RemainingSeconds = remaining };
            if (remaining == 0)
            {
                // Stop ticking until CompletePhase (or an auto-started phase) decides what happens next.
                StopTimerCore();
                expiredSession = _sessionId;
            }
        }

        if (expiredSession is null)
        {
            // Broadcast from the UI thread with the state current there, so ticks are ordered with the commands: a tick
            // that raced pause/stop would otherwise arrive after their broadcast and show a frozen 'running' timer.
            RunOnUiThread(() =>
            {
                FocusState current;
                lock (_gate)
                {
                    if (_disposed || _state.Status != FocusStatuses.Running) return;
                    current = _state;
                }
                _events.Broadcast("focus.tick", current);
            });
            return;
        }

        RunOnUiThread(() => CompletePhase(completed: true, onlyIfSession: expiredSession));
    }

    private void RunOnUiThread(Action action)
    {
        void Guarded()
        {
            try { action(); }
            catch (Exception ex) { _log.Error("Focus timer update failed", ex); }
        }

        SynchronizationContext? context;
        lock (_gate) context = _uiContext;
        if (context is null)
        {
            Guarded();
            return;
        }
        try
        {
            context.Post(_ => Guarded(), null);
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            // The UI thread's message loop is gone (shutdown); a timer callback must never crash the process.
        }
    }

    /// <summary>Remember the WinForms message loop of the caller so timer-driven work can be marshalled back to it.</summary>
    private void CaptureUiContext()
    {
        if (SynchronizationContext.Current is not WindowsFormsSynchronizationContext context) return;
        lock (_gate) _uiContext ??= context;
    }

    /// <summary>Caller holds the lock. Marks the in-memory session as ended in the database, if there is one.</summary>
    private void CloseOpenSession(bool completed)
    {
        if (_sessionId is null) return;
        var id = _sessionId;
        _sessionId = null;
        _sessions.Complete(id, Timestamps.NowIso(), completed);
    }

    private void StopTimerCore()
    {
        if (!_disposed) _timer.Change(Timeout.Infinite, Timeout.Infinite);
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(FocusTimerService));
    }

    private static int SecondsUntil(DateTime endsAtUtc)
        => (int)Math.Max(0, Math.Round((endsAtUtc - DateTime.UtcNow).TotalSeconds));

    private static int DurationMinutes(string phase, FocusSettings settings) => phase switch
    {
        FocusPhases.ShortBreak => settings.ShortBreakMinutes,
        FocusPhases.LongBreak => settings.LongBreakMinutes,
        _ => settings.FocusMinutes,
    };

    private static int DurationSeconds(string phase, FocusSettings settings) => DurationMinutes(phase, settings) * 60;
}

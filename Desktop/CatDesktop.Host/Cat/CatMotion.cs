using System.Diagnostics;
using CatDesktop.Host.App;

namespace CatDesktop.Host.Cat;

/// <summary>Distance along a path (DIPs) as a function of time since the curve started (seconds).</summary>
internal interface ICatMotionCurve
{
    double DurationSeconds { get; }
    double Distance { get; }
    double PositionAt(double t);
    double VelocityAt(double t);
}

/// <summary>
/// The walk's velocity profile (contract cat.walk): a trapezoid whose ramps are smoothstep curves. The cat accelerates
/// over <see cref="AccelSeconds"/> (at most 400 ms and at most 30 % of the walk), cruises at the requested speed and
/// decelerates symmetrically. Positions are closed-form, so sampling at any time (timer jitter, late frames) is exact.
/// </summary>
internal sealed class CatWalkProfile : ICatMotionCurve
{
    public const double MaxAccelSeconds = 0.4;
    public const double MaxAccelShare = 0.3;

    private CatWalkProfile(double distance, double speed, double duration, double accel)
    {
        Distance = distance;
        Speed = speed;
        DurationSeconds = duration;
        AccelSeconds = accel;
    }

    public double Distance { get; }
    public double Speed { get; }
    public double DurationSeconds { get; }
    public double AccelSeconds { get; }

    /// <summary>
    /// Each smoothstep ramp covers half of what the same time at full speed would, so D = V·(T − A). With A = 400 ms:
    /// T = D/V + 0.4 s, valid while 0.4 ≤ 0.3·T, i.e. D/V ≥ 0.4/0.3 − 0.4 s. Shorter walks use A = 0.3·T, T = D / (0.7·V).
    /// </summary>
    public static CatWalkProfile Create(double distance, double speed)
    {
        if (!(distance > 0) || !(speed > 0)) return new CatWalkProfile(0, Math.Max(0, speed), 0, 0);
        var cruiseSeconds = distance / speed;
        if (cruiseSeconds >= MaxAccelSeconds / MaxAccelShare - MaxAccelSeconds)
        {
            return new CatWalkProfile(distance, speed, cruiseSeconds + MaxAccelSeconds, MaxAccelSeconds);
        }
        var duration = distance / ((1 - MaxAccelShare) * speed);
        return new CatWalkProfile(distance, speed, duration, MaxAccelShare * duration);
    }

    public double PositionAt(double t)
    {
        if (t <= 0 || DurationSeconds <= 0) return 0;
        if (t >= DurationSeconds) return Distance;
        var a = AccelSeconds;
        if (t < a) return Speed * a * RampIntegral(t / a);
        if (t <= DurationSeconds - a) return Speed * a / 2 + Speed * (t - a);
        return Distance - Speed * a * RampIntegral((DurationSeconds - t) / a);
    }

    public double VelocityAt(double t)
    {
        if (t <= 0 || t >= DurationSeconds) return 0;
        var a = AccelSeconds;
        if (t < a) return Speed * SmoothStep(t / a);
        if (t <= DurationSeconds - a) return Speed;
        return Speed * SmoothStep((DurationSeconds - t) / a);
    }

    internal static double SmoothStep(double u) => u * u * (3 - 2 * u);

    /// <summary>∫₀ᵘ smoothstep = u³ − u⁴/2 (1/2 at u = 1).</summary>
    private static double RampIntegral(double u) => u * u * u - u * u * u * u / 2;
}

/// <summary>
/// A stop from a velocity: v(t) = v₀·(1 − smoothstep(t/T)), covering v₀·T/2. The stop never goes past
/// <c>remaining</c>: when it would, T is shortened (a firmer stop) so the cat halts exactly at the walk's end.
/// </summary>
internal sealed class CatStopCurve : ICatMotionCurve
{
    private readonly double _velocity;

    public CatStopCurve(double velocity, double remaining, double maxSeconds)
    {
        _velocity = Math.Max(0, velocity);
        remaining = Math.Max(0, remaining);
        if (_velocity < 1e-6 || remaining <= 0 || maxSeconds <= 0)
        {
            DurationSeconds = 0;
            Distance = 0;
            return;
        }
        var duration = maxSeconds;
        var distance = _velocity * duration / 2;
        if (distance > remaining)
        {
            duration = 2 * remaining / _velocity;
            distance = remaining;
        }
        DurationSeconds = duration;
        Distance = distance;
    }

    public double DurationSeconds { get; }
    public double Distance { get; }

    public double PositionAt(double t)
    {
        if (t <= 0 || DurationSeconds <= 0) return 0;
        if (t >= DurationSeconds) return Distance;
        var u = t / DurationSeconds;
        return _velocity * DurationSeconds * (u - u * u * u + u * u * u * u / 2);
    }

    public double VelocityAt(double t)
        => t <= 0 || t >= DurationSeconds ? 0 : _velocity * (1 - CatWalkProfile.SmoothStep(t / DurationSeconds));
}

/// <summary>
/// Drives one straight walk of the cat window on a UI-thread timer. Every frame the position is computed from the
/// elapsed time (Stopwatch) and the curve, then rounded once from double precision, so timer jitter changes neither
/// the speed nor the arrival point. Only the window position changes (no resize). UI thread only.
/// </summary>
internal sealed class CatWalker : IDisposable
{
    /// <summary>Requested timer interval. A WinForms timer fires on the next system tick at or after it, so a value
    /// just under one 15.6 ms tick gives ~64 Hz at the default timer resolution (16 would give ~32 Hz).</summary>
    private const int FrameIntervalMs = 15;
    public const double StopSeconds = 0.2;

    private readonly Action<Point> _move;
    private readonly Logger _log;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = FrameIntervalMs };
    private readonly Stopwatch _clock = new();

    private Point _start;
    private Point _target;
    private double _pathDips;
    private ICatMotionCurve? _curve;
    /// <summary>Distance already covered (DIPs) when the current curve started (non-zero for a stop curve).</summary>
    private double _curveOffset;
    private Action<string>? _ended;
    private Point _last;

    public CatWalker(Action<Point> move, Logger log)
    {
        _move = move;
        _log = log;
        _timer.Tick += OnTick;
    }

    public bool IsWalking => _curve is not null;

    public bool IsStopping => _curve is CatStopCurve;

    /// <summary>
    /// Walks from <paramref name="start"/> to <paramref name="target"/> (window top-left, physical px). The profile is
    /// defined over <paramref name="pathDips"/>, the same path in DIPs. <paramref name="ended"/> receives the reason.
    /// A walk in progress must be ended by the caller first (<see cref="End"/>).
    /// </summary>
    public void Start(Point start, Point target, double pathDips, CatWalkProfile profile, Action<string> ended)
    {
        _timer.Stop();
        _start = start;
        _target = target;
        _pathDips = pathDips;
        _curve = profile;
        _curveOffset = 0;
        _ended = ended;
        _last = start;
        _clock.Restart();
        _timer.Start();
    }

    /// <summary>Decelerate to a stop within <see cref="StopSeconds"/>; ends with reason 'stopped'. No-op unless walking.</summary>
    public void Stop()
    {
        if (_curve is null || _curve is CatStopCurve) return;
        var t = _clock.Elapsed.TotalSeconds;
        var covered = _curveOffset + _curve.PositionAt(t);
        var stop = new CatStopCurve(_curve.VelocityAt(t), _pathDips - covered, StopSeconds);
        _curveOffset = covered;
        _curve = stop;
        _clock.Restart();
        if (stop.DurationSeconds <= 0) Finish(Models.CatWalkEndReasons.Stopped);
    }

    /// <summary>End the walk right now (no deceleration) and report <paramref name="reason"/>. No-op unless walking.</summary>
    public void End(string reason)
    {
        if (_curve is null) return;
        Finish(reason);
    }

    public void Dispose()
    {
        _timer.Stop();
        _curve = null;
        _ended = null;
        _timer.Tick -= OnTick;
        _timer.Dispose();
    }

    private void OnTick(object? sender, EventArgs e)
    {
        var curve = _curve;
        if (curve is null)
        {
            _timer.Stop();
            return;
        }

        try
        {
            var t = _clock.Elapsed.TotalSeconds;
            var done = t >= curve.DurationSeconds;
            var covered = _curveOffset + curve.PositionAt(Math.Min(t, curve.DurationSeconds));
            if (done && curve is CatWalkProfile)
            {
                MoveTo(_target); // land exactly on the clamped target
                Finish(Models.CatWalkEndReasons.Arrived);
                return;
            }
            MoveTo(PointAlongPath(covered));
            if (done) Finish(Models.CatWalkEndReasons.Stopped);
        }
        catch (Exception ex)
        {
            _log.Error("Cat walk aborted", ex);
            Finish(Models.CatWalkEndReasons.Stopped);
        }
    }

    private Point PointAlongPath(double coveredDips)
    {
        var f = _pathDips <= 0 ? 1 : Math.Clamp(coveredDips / _pathDips, 0, 1);
        return new Point(
            (int)Math.Round(_start.X + (_target.X - _start.X) * f),
            (int)Math.Round(_start.Y + (_target.Y - _start.Y) * f));
    }

    private void MoveTo(Point point)
    {
        if (point == _last) return;
        _last = point;
        _move(point);
    }

    private void Finish(string reason)
    {
        _timer.Stop();
        var ended = _ended;
        _curve = null;
        _ended = null;
        ended?.Invoke(reason);
    }
}

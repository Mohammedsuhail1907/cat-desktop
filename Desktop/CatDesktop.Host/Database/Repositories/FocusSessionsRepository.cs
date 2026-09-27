using CatDesktop.Host.Models;
using Microsoft.Data.Sqlite;

namespace CatDesktop.Host.Database.Repositories;

/// <summary>Field limits for focus_sessions rows read from a backup file.</summary>
public static class FocusSessionRules
{
    public const int MaxIdLength = 64;
    public const int MaxPhaseLength = 32;
    /// <summary>The longest phase the timer can run (180 minutes, see FocusTimerService / FocusSettings).</summary>
    public const int MaxPlannedSeconds = 180 * 60;
}

/// <summary>Log of timer runs written by the focus timer service (runs on its own thread; every call opens its own connection).</summary>
public sealed class FocusSessionsRepository
{
    private const string Columns = "id, phase, started_at, ended_at, planned_seconds, completed";

    private readonly SqliteDatabase _db;

    public FocusSessionsRepository(SqliteDatabase db)
    {
        _db = db;
    }

    public void Insert(FocusSession session)
    {
        if (string.IsNullOrWhiteSpace(session.Id)) throw new ArgumentException("Session id is required.", nameof(session));
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "INSERT INTO focus_sessions (id, phase, started_at, ended_at, planned_seconds, completed) " +
            "VALUES ($id, $phase, $startedAt, $endedAt, $plannedSeconds, $completed);";
        cmd.AddParam("$id", session.Id);
        cmd.AddParam("$phase", session.Phase);
        cmd.AddParam("$startedAt", string.IsNullOrWhiteSpace(session.StartedAt) ? Timestamps.NowIso() : session.StartedAt);
        cmd.AddParam("$endedAt", session.EndedAt);
        cmd.AddParam("$plannedSeconds", session.PlannedSeconds);
        cmd.AddParam("$completed", session.Completed);
        cmd.ExecuteNonQuery();
    }

    /// <summary>Closes a session: <paramref name="completed"/> is false when the user stopped or skipped it early.</summary>
    public void Complete(string id, string endedAt, bool completed)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE focus_sessions SET ended_at = $endedAt, completed = $completed WHERE id = $id;";
        cmd.AddParam("$id", id);
        cmd.AddParam("$endedAt", endedAt);
        cmd.AddParam("$completed", completed);
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// Counts completed focus phases. "Today" is the local calendar day: local midnight is converted to the
    /// UTC ISO form all timestamps use, so plain string comparison selects the right rows.
    /// </summary>
    public FocusStats GetStats()
    {
        var todayLocal = DateTime.Today;
        var from = Timestamps.ToIso(todayLocal.ToUniversalTime());
        var to = Timestamps.ToIso(todayLocal.AddDays(1).ToUniversalTime());

        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "SELECT " +
            "COALESCE(SUM(CASE WHEN started_at >= $from AND started_at < $to THEN 1 ELSE 0 END), 0), " +
            "COALESCE(SUM(CASE WHEN started_at >= $from AND started_at < $to THEN planned_seconds ELSE 0 END), 0), " +
            "COUNT(*), " +
            "COALESCE(SUM(planned_seconds), 0) " +
            "FROM focus_sessions WHERE phase = $phase AND completed = 1;";
        cmd.AddParam("$from", from);
        cmd.AddParam("$to", to);
        cmd.AddParam("$phase", FocusPhases.Focus);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return new FocusStats();
        return new FocusStats
        {
            TodayFocusSessions = (int)reader.GetInt64(0),
            TodayFocusMinutes = ToMinutes(reader.GetInt64(1)),
            TotalFocusSessions = (int)reader.GetInt64(2),
            TotalFocusMinutes = ToMinutes(reader.GetInt64(3)),
        };
    }

    public List<FocusSession> ListRecent(int limit)
    {
        var sessions = new List<FocusSession>();
        if (limit <= 0) return sessions;
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM focus_sessions ORDER BY started_at DESC LIMIT $limit;";
        cmd.AddParam("$limit", limit);
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) sessions.Add(Read(reader));
        return sessions;
    }

    /// <summary>Every session, oldest first (backup export).</summary>
    public List<FocusSession> ListAll()
    {
        var sessions = new List<FocusSession>();
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM focus_sessions ORDER BY started_at, id;";
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) sessions.Add(Read(reader));
        return sessions;
    }

    /// <summary>
    /// Backup import inside a caller-managed transaction. A session that already exists is left alone:
    /// the local row is the authority (it may be the one the timer is running right now). Returns true when a row was added.
    /// </summary>
    internal bool InsertIfMissing(SqliteConnection conn, FocusSession session)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "INSERT INTO focus_sessions (id, phase, started_at, ended_at, planned_seconds, completed) " +
            "VALUES ($id, $phase, $startedAt, $endedAt, $plannedSeconds, $completed) " +
            "ON CONFLICT(id) DO NOTHING;";
        cmd.AddParam("$id", session.Id);
        cmd.AddParam("$phase", session.Phase);
        cmd.AddParam("$startedAt", session.StartedAt);
        cmd.AddParam("$endedAt", session.EndedAt);
        cmd.AddParam("$plannedSeconds", session.PlannedSeconds);
        cmd.AddParam("$completed", session.Completed);
        return cmd.ExecuteNonQuery() > 0;
    }

    private static FocusSession Read(SqliteDataReader r) => new()
    {
        Id = r.GetString(0),
        Phase = r.GetString(1),
        StartedAt = r.GetString(2),
        EndedAt = r.GetStringOrNull(3),
        PlannedSeconds = r.GetInt32(4),
        Completed = r.GetBool(5),
    };

    private static int ToMinutes(long seconds) => (int)Math.Round(seconds / 60.0, MidpointRounding.AwayFromZero);
}

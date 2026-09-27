using System.Globalization;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Models;
using Microsoft.Data.Sqlite;

namespace CatDesktop.Host.Database.Repositories;

/// <summary>Field limits and normalisation for tasks (contract tasks.*), shared by the bridge handler and the backup importer.</summary>
public static class TaskRules
{
    public const int MaxIdLength = 64;
    public const int MaxTitleLength = 500;
    public const int MaxNotesLength = 5000;
    public const int MinPriority = 0;
    public const int MaxPriority = 2;

    /// <summary>
    /// Allowed sort positions. Negative values are valid ("move above everything"); the bounds keep
    /// <see cref="TasksRepository.NextSortOrder"/> (MAX + 1) far away from int overflow.
    /// </summary>
    public const int MinSortOrder = -1_000_000;
    public const int MaxSortOrder = 1_000_000;

    /// <summary>
    /// Accepts any ISO-8601 date/time and returns the contract's UTC form. A value without zone
    /// information (e.g. from a datetime-local input) is taken as local time; an explicit offset or 'Z' wins.
    /// (DateTimeOffset is used because DateTime.TryParse refuses RoundtripKind together with AdjustToUniversal.)
    /// </summary>
    public static bool TryNormaliseIso(string? value, out string utcIso)
    {
        utcIso = "";
        if (string.IsNullOrWhiteSpace(value)) return false;
        if (!DateTimeOffset.TryParse(value.Trim(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var parsed))
        {
            return false;
        }
        utcIso = Timestamps.ToIso(parsed.UtcDateTime);
        return true;
    }
}

public sealed class TasksRepository
{
    private const string Columns = "id, title, notes, completed, priority, due_at, completed_at, sort_order, created_at, updated_at";

    private readonly SqliteDatabase _db;

    public TasksRepository(SqliteDatabase db)
    {
        _db = db;
    }

    /// <summary>Open tasks by sort order (then creation), followed by completed tasks newest-completed first.</summary>
    public List<TaskItem> List(bool includeCompleted)
    {
        var tasks = new List<TaskItem>();
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        // One query for both groups: the CASE keys only apply inside their own group, so the open block is
        // ordered by sort_order/created_at and the completed block by completed_at DESC.
        cmd.CommandText =
            $"SELECT {Columns} FROM tasks " +
            "WHERE completed = 0 OR $includeCompleted = 1 " +
            "ORDER BY completed ASC, " +
            "CASE WHEN completed = 0 THEN sort_order ELSE 0 END ASC, " +
            "CASE WHEN completed = 0 THEN created_at ELSE '' END ASC, " +
            "CASE WHEN completed = 1 THEN completed_at ELSE '' END DESC;";
        cmd.AddParam("$includeCompleted", includeCompleted);
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) tasks.Add(Read(reader));
        return tasks;
    }

    public TaskItem? Get(string id)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM tasks WHERE id = $id;";
        cmd.AddParam("$id", id);
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? Read(reader) : null;
    }

    /// <summary>Stores a new task. Missing id/timestamps are filled in; the stored record is returned.</summary>
    public TaskItem Insert(TaskItem task)
    {
        var now = Timestamps.NowIso();
        var stored = task with
        {
            Id = string.IsNullOrWhiteSpace(task.Id) ? Timestamps.NewId() : task.Id,
            CreatedAt = string.IsNullOrWhiteSpace(task.CreatedAt) ? now : task.CreatedAt,
            UpdatedAt = string.IsNullOrWhiteSpace(task.UpdatedAt) ? now : task.UpdatedAt,
        };
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "INSERT INTO tasks (id, title, notes, completed, priority, due_at, completed_at, sort_order, created_at, updated_at) " +
            "VALUES ($id, $title, $notes, $completed, $priority, $dueAt, $completedAt, $sortOrder, $createdAt, $updatedAt);";
        Bind(cmd, stored);
        cmd.ExecuteNonQuery();
        return stored;
    }

    /// <summary>Rewrites every mutable column of an existing task; throws not_found when the id is unknown.</summary>
    public TaskItem Update(TaskItem task)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "UPDATE tasks SET title = $title, notes = $notes, completed = $completed, priority = $priority, due_at = $dueAt, " +
            "completed_at = $completedAt, sort_order = $sortOrder, updated_at = $updatedAt WHERE id = $id;";
        cmd.AddParam("$id", task.Id);
        cmd.AddParam("$title", task.Title);
        cmd.AddParam("$notes", task.Notes);
        cmd.AddParam("$completed", task.Completed);
        cmd.AddParam("$priority", task.Priority);
        cmd.AddParam("$dueAt", task.DueAt);
        cmd.AddParam("$completedAt", task.CompletedAt);
        cmd.AddParam("$sortOrder", task.SortOrder);
        cmd.AddParam("$updatedAt", task.UpdatedAt);
        if (cmd.ExecuteNonQuery() == 0) throw BridgeException.NotFound($"Task '{task.Id}' does not exist.");
        return task;
    }

    public bool Delete(string id)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM tasks WHERE id = $id;";
        cmd.AddParam("$id", id);
        return cmd.ExecuteNonQuery() > 0;
    }

    /// <summary>Deletes every completed task and returns how many were removed.</summary>
    public int ClearCompleted()
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM tasks WHERE completed = 1;";
        return cmd.ExecuteNonQuery();
    }

    public int Count()
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM tasks;";
        return cmd.ExecuteScalarInt();
    }

    /// <summary>
    /// Sort position for a new task: after everything that exists, clamped into
    /// [<see cref="TaskRules.MinSortOrder"/>, <see cref="TaskRules.MaxSortOrder"/>]. The clamp runs in SQL (64-bit),
    /// so a row stored before the bounds existed (e.g. int.MaxValue) cannot overflow the result.
    /// </summary>
    public int NextSortOrder()
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT MAX(MIN(COALESCE(MAX(sort_order) + 1, 0), $max), $min) FROM tasks;";
        cmd.AddParam("$min", TaskRules.MinSortOrder);
        cmd.AddParam("$max", TaskRules.MaxSortOrder);
        return cmd.ExecuteScalarInt();
    }

    /// <summary>Insert-or-replace by id, keeping the record's own timestamps (backup import).</summary>
    public void Upsert(TaskItem task)
    {
        using var conn = _db.Open();
        Upsert(conn, task);
    }

    internal void Upsert(SqliteConnection conn, TaskItem task)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "INSERT INTO tasks (id, title, notes, completed, priority, due_at, completed_at, sort_order, created_at, updated_at) " +
            "VALUES ($id, $title, $notes, $completed, $priority, $dueAt, $completedAt, $sortOrder, $createdAt, $updatedAt) " +
            "ON CONFLICT(id) DO UPDATE SET title = excluded.title, notes = excluded.notes, completed = excluded.completed, " +
            "priority = excluded.priority, due_at = excluded.due_at, completed_at = excluded.completed_at, " +
            "sort_order = excluded.sort_order, created_at = excluded.created_at, updated_at = excluded.updated_at;";
        Bind(cmd, task);
        cmd.ExecuteNonQuery();
    }

    // ---- helpers ------------------------------------------------------------------------------

    private static void Bind(SqliteCommand cmd, TaskItem task)
    {
        cmd.AddParam("$id", task.Id);
        cmd.AddParam("$title", task.Title);
        cmd.AddParam("$notes", task.Notes);
        cmd.AddParam("$completed", task.Completed);
        cmd.AddParam("$priority", task.Priority);
        cmd.AddParam("$dueAt", task.DueAt);
        cmd.AddParam("$completedAt", task.CompletedAt);
        cmd.AddParam("$sortOrder", task.SortOrder);
        cmd.AddParam("$createdAt", task.CreatedAt);
        cmd.AddParam("$updatedAt", task.UpdatedAt);
    }

    private static TaskItem Read(SqliteDataReader r) => new()
    {
        Id = r.GetString(0),
        Title = r.GetString(1),
        Notes = r.GetStringOrNull(2),
        Completed = r.GetBool(3),
        Priority = r.GetInt32(4),
        DueAt = r.GetStringOrNull(5),
        CompletedAt = r.GetStringOrNull(6),
        SortOrder = r.GetInt32(7),
        CreatedAt = r.GetString(8),
        UpdatedAt = r.GetString(9),
    };
}

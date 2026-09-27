using CatDesktop.Host.Bridge;
using CatDesktop.Host.Models;
using Microsoft.Data.Sqlite;

namespace CatDesktop.Host.Database.Repositories;

/// <summary>Field limits for notes (contract notes.*), shared by the bridge handler and the backup importer.</summary>
public static class NoteRules
{
    public const int MaxIdLength = 64;
    public const int MaxTitleLength = 500;
    public const int MaxContentLength = 200_000;
    public const int MaxColorLength = 32;
    public const int MaxSearchLength = 200;
}

public sealed class NotesRepository
{
    private const string Columns = "id, title, content, color, pinned, created_at, updated_at";

    private readonly SqliteDatabase _db;

    public NotesRepository(SqliteDatabase db)
    {
        _db = db;
    }

    /// <summary>
    /// Pinned first, newest change first. <paramref name="search"/> (trimmed) matches title or content as a literal,
    /// Unicode case-insensitive substring (no wildcards), via the <see cref="SqliteDatabase.ContainsIgnoreCaseFunction"/> SQL function.
    /// </summary>
    public List<Note> List(string? search)
    {
        var notes = new List<Note>();
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        if (string.IsNullOrWhiteSpace(search))
        {
            cmd.CommandText = $"SELECT {Columns} FROM notes ORDER BY pinned DESC, updated_at DESC;";
        }
        else
        {
            const string contains = SqliteDatabase.ContainsIgnoreCaseFunction;
            cmd.CommandText =
                $"SELECT {Columns} FROM notes " +
                $"WHERE {contains}(title, $term) OR {contains}(content, $term) " +
                "ORDER BY pinned DESC, updated_at DESC;";
            cmd.AddParam("$term", search.Trim());
        }
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) notes.Add(Read(reader));
        return notes;
    }

    public Note? Get(string id)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM notes WHERE id = $id;";
        cmd.AddParam("$id", id);
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? Read(reader) : null;
    }

    /// <summary>Stores a new note. Missing id/timestamps are filled in; the stored record is returned.</summary>
    public Note Insert(Note note)
    {
        var now = Timestamps.NowIso();
        var stored = note with
        {
            Id = string.IsNullOrWhiteSpace(note.Id) ? Timestamps.NewId() : note.Id,
            CreatedAt = string.IsNullOrWhiteSpace(note.CreatedAt) ? now : note.CreatedAt,
            UpdatedAt = string.IsNullOrWhiteSpace(note.UpdatedAt) ? now : note.UpdatedAt,
        };
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "INSERT INTO notes (id, title, content, color, pinned, created_at, updated_at) " +
            "VALUES ($id, $title, $content, $color, $pinned, $createdAt, $updatedAt);";
        Bind(cmd, stored);
        cmd.ExecuteNonQuery();
        return stored;
    }

    /// <summary>Rewrites every mutable column of an existing note; throws not_found when the id is unknown.</summary>
    public Note Update(Note note)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "UPDATE notes SET title = $title, content = $content, color = $color, pinned = $pinned, updated_at = $updatedAt " +
            "WHERE id = $id;";
        cmd.AddParam("$id", note.Id);
        cmd.AddParam("$title", note.Title);
        cmd.AddParam("$content", note.Content);
        cmd.AddParam("$color", note.Color);
        cmd.AddParam("$pinned", note.Pinned);
        cmd.AddParam("$updatedAt", note.UpdatedAt);
        if (cmd.ExecuteNonQuery() == 0) throw BridgeException.NotFound($"Note '{note.Id}' does not exist.");
        return note;
    }

    public bool Delete(string id)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM notes WHERE id = $id;";
        cmd.AddParam("$id", id);
        return cmd.ExecuteNonQuery() > 0;
    }

    public int Count()
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM notes;";
        return cmd.ExecuteScalarInt();
    }

    /// <summary>Insert-or-replace by id, keeping the record's own timestamps (backup import).</summary>
    public void Upsert(Note note)
    {
        using var conn = _db.Open();
        Upsert(conn, note);
    }

    internal void Upsert(SqliteConnection conn, Note note)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "INSERT INTO notes (id, title, content, color, pinned, created_at, updated_at) " +
            "VALUES ($id, $title, $content, $color, $pinned, $createdAt, $updatedAt) " +
            "ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, color = excluded.color, " +
            "pinned = excluded.pinned, created_at = excluded.created_at, updated_at = excluded.updated_at;";
        Bind(cmd, note);
        cmd.ExecuteNonQuery();
    }

    // ---- helpers ------------------------------------------------------------------------------

    private static void Bind(SqliteCommand cmd, Note note)
    {
        cmd.AddParam("$id", note.Id);
        cmd.AddParam("$title", note.Title);
        cmd.AddParam("$content", note.Content);
        cmd.AddParam("$color", note.Color);
        cmd.AddParam("$pinned", note.Pinned);
        cmd.AddParam("$createdAt", note.CreatedAt);
        cmd.AddParam("$updatedAt", note.UpdatedAt);
    }

    private static Note Read(SqliteDataReader r) => new()
    {
        Id = r.GetString(0),
        Title = r.GetString(1),
        Content = r.GetString(2),
        Color = r.GetStringOrNull(3),
        Pinned = r.GetBool(4),
        CreatedAt = r.GetString(5),
        UpdatedAt = r.GetString(6),
    };
}

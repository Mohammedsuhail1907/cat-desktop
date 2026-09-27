using System.Text;
using System.Text.RegularExpressions;
using CatDesktop.Host.Models;
using Microsoft.Data.Sqlite;

namespace CatDesktop.Host.Database.Repositories;

/// <summary>Validation rules for the generic settings store, shared by the bridge handler and the backup importer.</summary>
public static partial class SettingRules
{
    public const int MaxKeyLength = 100;
    public const int MaxValueBytes = 256 * 1024;

    /// <summary>Owned by the host (window geometry); never accepted from a backup file.</summary>
    public const string MainWindowStateKey = "app.mainWindowState";

    [GeneratedRegex(@"^[a-zA-Z0-9_.\-]{1,100}$")]
    private static partial Regex KeyPattern();

    public static bool IsValidKey(string? key) => key is not null && KeyPattern().IsMatch(key);

    public static bool IsValidValueSize(string json) => Encoding.UTF8.GetByteCount(json) <= MaxValueBytes;
}

/// <summary>Raw key -> JSON text access to the settings table. <see cref="Services.SettingsService"/> adds caching and typing.</summary>
public sealed class SettingsRepository
{
    private readonly SqliteDatabase _db;

    public SettingsRepository(SqliteDatabase db)
    {
        _db = db;
    }

    /// <summary>
    /// Raised after another writer (the backup importer) changed rows behind the cache's back, so the
    /// settings service can reload. The settings service's own writes do not raise it.
    /// </summary>
    public event Action? Imported;

    public string? GetJson(string key)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT value FROM settings WHERE key = $key;";
        cmd.AddParam("$key", key);
        return cmd.ExecuteScalar() as string;
    }

    public void SetJson(string key, string json)
    {
        using var conn = _db.Open();
        SetJson(conn, key, json);
    }

    /// <summary>Upsert on a caller-managed connection, so imports can run in one transaction.</summary>
    internal void SetJson(SqliteConnection conn, string key, string json)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "INSERT INTO settings (key, value, updated_at) VALUES ($key, $value, $updatedAt) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;";
        cmd.AddParam("$key", key);
        cmd.AddParam("$value", json);
        cmd.AddParam("$updatedAt", Timestamps.NowIso());
        cmd.ExecuteNonQuery();
    }

    public void Remove(string key)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM settings WHERE key = $key;";
        cmd.AddParam("$key", key);
        cmd.ExecuteNonQuery();
    }

    public Dictionary<string, string> GetAllJson()
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT key, value FROM settings ORDER BY key;";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            result[reader.GetString(0)] = reader.GetString(1);
        }
        return result;
    }

    /// <summary>Tell cache holders that rows were written outside their control (see <see cref="Imported"/>).</summary>
    public void NotifyImported() => Imported?.Invoke();
}

using System.Globalization;
using System.Reflection;
using System.Text;
using CatDesktop.Host.App;
using CatDesktop.Host.Models;
using Microsoft.Data.Sqlite;

namespace CatDesktop.Host.Database;

/// <summary>
/// Owns the SQLite file: opens it, applies the embedded migrations once at startup and hands out
/// short-lived connections. Repositories run on the UI thread and on the focus-timer thread, so a
/// connection is never shared; every call does <c>using var conn = db.Open();</c>. WAL mode and the
/// pooled connections keep that cheap.
/// </summary>
public sealed class SqliteDatabase : IDisposable
{
    private const string MigrationResourcePrefix = "Migrations.";
    private const string MigrationResourceSuffix = ".sql";

    private readonly string _connectionString;
    private readonly Logger _log;
    private bool _initialized;
    private bool _disposed;

    public SqliteDatabase(string dbPath, Logger log)
    {
        if (string.IsNullOrWhiteSpace(dbPath)) throw new ArgumentException("Database path required", nameof(dbPath));
        Path = System.IO.Path.GetFullPath(dbPath);
        _log = log;
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Default,
            Pooling = true,
        }.ToString();
    }

    /// <summary>Absolute path of the database file.</summary>
    public string Path { get; }

    /// <summary>Highest migration version applied to this database (0 before <see cref="Initialize"/>).</summary>
    public int SchemaVersion { get; private set; }

    /// <summary>Size of the main file plus the write-ahead log, as shown to the user in data.getInfo.</summary>
    public long FileSizeBytes
    {
        get
        {
            long total = 0;
            foreach (var file in new[] { Path, Path + "-wal" })
            {
                try
                {
                    var info = new FileInfo(file);
                    if (info.Exists) total += info.Length;
                }
                catch (IOException) { /* a file that cannot be measured simply does not count */ }
                catch (UnauthorizedAccessException) { }
            }
            return total;
        }
    }

    /// <summary>Creates the file if needed, switches it to WAL and applies pending migrations in version order.</summary>
    public void Initialize()
    {
        ThrowIfDisposed();
        if (_initialized) return;

        var directory = System.IO.Path.GetDirectoryName(Path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        using var conn = new SqliteConnection(_connectionString);
        conn.Open();
        // journal_mode is persisted in the file; the other pragmas are per connection and repeated in Open().
        Execute(conn, "PRAGMA journal_mode=WAL;");
        ApplyConnectionPragmas(conn);
        Execute(conn, "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");

        var applied = ReadAppliedVersions(conn);
        var migrations = DiscoverMigrations();
        foreach (var migration in migrations)
        {
            if (applied.Contains(migration.Version)) continue;
            ApplyMigration(conn, migration);
            applied.Add(migration.Version);
        }

        SchemaVersion = applied.Count == 0 ? 0 : applied.Max();
        var newest = migrations.Count == 0 ? 0 : migrations[^1].Version;
        if (SchemaVersion > newest)
        {
            _log.Warn($"Database schema version {SchemaVersion} is newer than this build supports ({newest}). The file was probably written by a newer CatDesktop.");
        }

        _initialized = true;
        _log.Info($"Database ready at {Path} (schema v{SchemaVersion}, {FileSizeBytes / 1024} KB).");
    }

    /// <summary>
    /// SQL function <c>ci_contains(haystack, needle)</c>: 1 when <c>haystack</c> contains <c>needle</c> ignoring case
    /// for all of Unicode (SQLite's own LIKE/NOCASE only fold ASCII). Registered on every connection by <see cref="Open"/>.
    /// </summary>
    public const string ContainsIgnoreCaseFunction = "ci_contains";

    /// <summary>Returns a new open connection with the per-connection pragmas and SQL functions applied. Dispose it when done.</summary>
    public SqliteConnection Open()
    {
        ThrowIfDisposed();
        var conn = new SqliteConnection(_connectionString);
        try
        {
            RegisterFunctions(conn);
            conn.Open();
            ApplyConnectionPragmas(conn);
            return conn;
        }
        catch
        {
            conn.Dispose();
            throw;
        }
    }

    /// <summary>Folds the write-ahead log back into the main file so the .db on disk is complete.</summary>
    public void Checkpoint()
    {
        ThrowIfDisposed();
        using var conn = Open();
        Execute(conn, "PRAGMA wal_checkpoint(TRUNCATE);");
    }

    public void Dispose()
    {
        if (_disposed) return;
        try
        {
            if (_initialized) Checkpoint();
        }
        catch (Exception ex)
        {
            _log.Warn($"Database checkpoint on shutdown failed: {ex.Message}");
        }
        _disposed = true;
        SqliteConnection.ClearAllPools();
    }

    // ---- migrations ---------------------------------------------------------------------------

    private sealed record Migration(int Version, string Name, string ResourceName);

    private static List<Migration> DiscoverMigrations()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var migrations = new List<Migration>();
        foreach (var resource in assembly.GetManifestResourceNames())
        {
            if (!resource.StartsWith(MigrationResourcePrefix, StringComparison.Ordinal) ||
                !resource.EndsWith(MigrationResourceSuffix, StringComparison.Ordinal))
            {
                continue;
            }

            var name = resource[MigrationResourcePrefix.Length..^MigrationResourceSuffix.Length];
            var digits = new string(name.TakeWhile(char.IsAsciiDigit).ToArray());
            if (digits.Length == 0 || !int.TryParse(digits, NumberStyles.None, CultureInfo.InvariantCulture, out var version) || version <= 0)
            {
                throw new InvalidOperationException($"Migration resource '{resource}' does not start with a positive version number.");
            }
            migrations.Add(new Migration(version, name, resource));
        }

        migrations.Sort((a, b) => a.Version.CompareTo(b.Version));
        for (var i = 1; i < migrations.Count; i++)
        {
            if (migrations[i].Version == migrations[i - 1].Version)
            {
                throw new InvalidOperationException($"Two migrations share version {migrations[i].Version}: '{migrations[i - 1].Name}' and '{migrations[i].Name}'.");
            }
        }
        return migrations;
    }

    private static HashSet<int> ReadAppliedVersions(SqliteConnection conn)
    {
        var versions = new HashSet<int>();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT version FROM schema_migrations;";
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) versions.Add(reader.GetInt32(0));
        return versions;
    }

    private void ApplyMigration(SqliteConnection conn, Migration migration)
    {
        var sql = ReadResource(migration.ResourceName);
        using var tx = conn.BeginTransaction();
        try
        {
            // Microsoft.Data.Sqlite runs every ';'-separated statement of the script in one command.
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = sql;
                cmd.ExecuteNonQuery();
            }
            using (var record = conn.CreateCommand())
            {
                record.CommandText = "INSERT INTO schema_migrations (version, name, applied_at) VALUES ($version, $name, $appliedAt);";
                record.Parameters.AddWithValue("$version", migration.Version);
                record.Parameters.AddWithValue("$name", migration.Name);
                record.Parameters.AddWithValue("$appliedAt", Timestamps.NowIso());
                record.ExecuteNonQuery();
            }
            tx.Commit();
        }
        catch (Exception ex)
        {
            tx.Rollback();
            throw new InvalidOperationException($"Migration {migration.Version} ('{migration.Name}') failed: {ex.Message}", ex);
        }
        _log.Info($"Applied database migration {migration.Version} ({migration.Name}).");
    }

    private static string ReadResource(string resourceName)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
                           ?? throw new InvalidOperationException($"Embedded migration '{resourceName}' is missing.");
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    // ---- helpers ------------------------------------------------------------------------------

    private static void ApplyConnectionPragmas(SqliteConnection conn)
        => Execute(conn, "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");

    /// <summary>Registered before Open(), so Microsoft.Data.Sqlite binds the functions to whichever (pooled) handle it opens.</summary>
    private static void RegisterFunctions(SqliteConnection conn)
        => conn.CreateFunction<string?, string?, bool>(
            ContainsIgnoreCaseFunction,
            static (haystack, needle) => haystack is not null && needle is not null
                                         && haystack.Contains(needle, StringComparison.OrdinalIgnoreCase),
            isDeterministic: true);

    private static void Execute(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(SqliteDatabase));
    }
}

/// <summary>
/// Small conveniences shared by the repositories: NULL/boolean mapping in both directions so the SQL
/// stays readable. Kept next to <see cref="SqliteDatabase"/> because it is the only place they belong.
/// </summary>
internal static class SqliteExtensions
{
    /// <summary>Adds a parameter, mapping null to DBNull and bool to INTEGER 0/1.</summary>
    public static SqliteCommand AddParam(this SqliteCommand cmd, string name, object? value)
    {
        cmd.Parameters.AddWithValue(name, value switch
        {
            null => DBNull.Value,
            bool b => b ? 1 : 0,
            _ => value,
        });
        return cmd;
    }

    public static string? GetStringOrNull(this SqliteDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    public static bool GetBool(this SqliteDataReader reader, int ordinal)
        => !reader.IsDBNull(ordinal) && reader.GetInt64(ordinal) != 0;

    public static int ExecuteScalarInt(this SqliteCommand cmd)
    {
        var value = cmd.ExecuteScalar();
        return value is null || value is DBNull ? 0 : Convert.ToInt32(value, CultureInfo.InvariantCulture);
    }
}

using System.Reflection;
using System.Text.Json;
using CatDesktop.Host.App;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Database;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.Models;

namespace CatDesktop.Host.Services;

/// <summary>
/// Outcome of <see cref="BackupService.Import"/>. Imported settings are not listed: the import reloads
/// <see cref="SettingsService"/>, whose Changed event drives the settings.changed broadcasts.
/// </summary>
public sealed record BackupImportResult(bool Cancelled, int Notes, int Tasks)
{
    public static BackupImportResult CancelledByUser { get; } = new(true, 0, 0);
}

/// <summary>
/// JSON export/import of every user table through the standard file dialogs (contract data.*).
/// Import merges by id: existing notes/tasks with the same id are overwritten, others are kept; focus sessions
/// that already exist are kept as they are (history is only added). Files written before focus sessions were
/// exported simply have no "focusSessions" array and still import (same format version).
/// </summary>
public sealed class BackupService
{
    public const string Format = "catdesktop-backup";
    public const int Version = 1;
    public const long MaxImportBytes = 50L * 1024 * 1024;
    /// <summary>At most this many setting keys are taken from one file; each one may trigger a broadcast and side effects.</summary>
    public const int MaxImportSettings = 500;

    private const string FileFilter = "CatDesktop backup (*.json)|*.json";

    private readonly SqliteDatabase _db;
    private readonly NotesRepository _notes;
    private readonly TasksRepository _tasks;
    private readonly SettingsRepository _settings;
    private readonly QuickActionsRepository _actions;
    private readonly FocusSessionsRepository _focusSessions;
    private readonly Logger _log;

    public BackupService(SqliteDatabase db, NotesRepository notes, TasksRepository tasks, SettingsRepository settings,
        QuickActionsRepository actions, FocusSessionsRepository focusSessions, Logger log)
    {
        _db = db;
        _notes = notes;
        _tasks = tasks;
        _settings = settings;
        _actions = actions;
        _focusSessions = focusSessions;
        _log = log;
    }

    public DataInfo GetInfo() => new()
    {
        DatabasePath = _db.Path,
        SizeBytes = _db.FileSizeBytes,
        NoteCount = _notes.Count(),
        TaskCount = _tasks.Count(),
        SchemaVersion = _db.SchemaVersion,
    };

    // ---- export -------------------------------------------------------------------------------

    /// <summary>Asks for a target file and writes the backup. Returns the path, or null when the user cancelled.</summary>
    public string? Export(IWin32Window owner)
    {
        using var dialog = new SaveFileDialog
        {
            Title = "Export CatDesktop backup",
            Filter = FileFilter,
            DefaultExt = "json",
            AddExtension = true,
            OverwritePrompt = true,
            FileName = $"CatDesktop-backup-{DateTime.Now:yyyyMMdd-HHmm}.json",
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        };
        if (dialog.ShowDialog(owner) != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.FileName)) return null;

        ExportTo(dialog.FileName);
        return dialog.FileName;
    }

    /// <summary>
    /// Writes the backup document to <paramref name="path"/> (UTF-8, indented). The file is written to a temporary
    /// file next to it and then moved over the target, so a failed write never destroys an existing backup.
    /// </summary>
    public void ExportTo(string path)
    {
        var document = new BackupDocument
        {
            Format = Format,
            Version = Version,
            ExportedAt = Timestamps.NowIso(),
            AppVersion = CurrentAppVersion(),
            Notes = _notes.List(null),
            Tasks = _tasks.List(includeCompleted: true),
            Settings = ParsedSettings(),
            Actions = _actions.List(),
            FocusSessions = _focusSessions.ListAll(),
        };

        // Same folder, so the final move is a same-volume rename that replaces the target in one step.
        var temp = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, document, JsonOptions.Indented);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            TryDelete(temp);
            if (ex is IOException or UnauthorizedAccessException)
                throw BridgeException.Validation($"The backup could not be written: {ex.Message}");
            throw;
        }
        _log.Info($"Exported backup to {path} ({document.Notes.Count} notes, {document.Tasks.Count} tasks, {document.Settings.Count} settings, {document.FocusSessions.Count} focus sessions).");
    }

    private void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.Warn($"Temporary backup file {file} could not be removed: {ex.Message}");
        }
    }

    private Dictionary<string, JsonElement> ParsedSettings()
    {
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, json) in _settings.GetAllJson())
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                result[key] = doc.RootElement.Clone();
            }
            catch (JsonException ex)
            {
                _log.Warn($"Setting '{key}' holds invalid JSON and was left out of the backup: {ex.Message}");
            }
        }
        return result;
    }

    private static string CurrentAppVersion()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                      ?? assembly.GetName().Version?.ToString(3)
                      ?? "1.0.0";
        var plus = version.IndexOf('+');
        return plus > 0 ? version[..plus] : version;
    }

    // ---- import -------------------------------------------------------------------------------

    /// <summary>Asks for a backup file and merges it into the database. Invalid files fail with a validation error.</summary>
    public BackupImportResult Import(IWin32Window owner)
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Import CatDesktop backup",
            Filter = FileFilter + "|All files (*.*)|*.*",
            CheckFileExists = true,
            Multiselect = false,
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        };
        if (dialog.ShowDialog(owner) != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.FileName))
        {
            return BackupImportResult.CancelledByUser;
        }
        return ImportFrom(dialog.FileName);
    }

    /// <summary>Parses and applies one backup file in a single transaction. Entries that break the field rules are skipped, not fatal.</summary>
    public BackupImportResult ImportFrom(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw BridgeException.Validation("The selected backup file does not exist.");
        if (info.Length > MaxImportBytes) throw BridgeException.Validation("The backup file is larger than 50 MB and cannot be imported.");

        using var doc = ParseBackup(path);
        var root = doc.RootElement;
        ValidateHeader(root);

        var now = Timestamps.NowIso();
        var notes = ReadEntries(root, "notes", (el, _) => ReadNote(el, now));
        var tasks = ReadEntries(root, "tasks", (el, i) => ReadTask(el, i, now));
        var actions = ReadActions(root);
        var settings = ReadSettings(root);
        var focusSessions = ReadEntries(root, "focusSessions", (el, _) => ReadFocusSession(el));

        var addedSessions = 0;
        using (var conn = _db.Open())
        using (var tx = conn.BeginTransaction())
        {
            foreach (var note in notes) _notes.Upsert(conn, note);
            foreach (var task in tasks) _tasks.Upsert(conn, task);
            if (actions is not null) _actions.ReplaceAll(conn, actions);
            foreach (var (key, value) in settings) _settings.SetJson(conn, key, value.GetRawText());
            foreach (var session in focusSessions)
            {
                if (_focusSessions.InsertIfMissing(conn, session)) addedSessions++;
            }
            tx.Commit();
        }
        // Reloads SettingsService, which raises Changed (-> settings.changed broadcast) for every key that really changed.
        if (settings.Count > 0) _settings.NotifyImported();

        _log.Info($"Imported backup {path}: {notes.Count} notes, {tasks.Count} tasks, {settings.Count} settings, " +
                  $"{addedSessions} of {focusSessions.Count} focus sessions added, actions {(actions is null ? "unchanged" : "replaced")}.");
        return new BackupImportResult(false, notes.Count, tasks.Count);
    }

    private static JsonDocument ParseBackup(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            return JsonDocument.Parse(stream, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
        }
        catch (JsonException ex)
        {
            throw BridgeException.Validation($"The file is not valid JSON: {ex.Message}");
        }
        catch (IOException ex)
        {
            throw BridgeException.Validation($"The file could not be read: {ex.Message}");
        }
        catch (UnauthorizedAccessException ex)
        {
            throw BridgeException.Validation($"The file could not be read: {ex.Message}");
        }
    }

    private static void ValidateHeader(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw BridgeException.Validation("This is not a CatDesktop backup file.");
        var format = Payload.Element(root, "format");
        if (format.ValueKind != JsonValueKind.String || !string.Equals(format.GetString(), Format, StringComparison.Ordinal))
            throw BridgeException.Validation("This is not a CatDesktop backup file.");
        var version = Payload.Element(root, "version");
        if (version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var v))
            throw BridgeException.Validation("The backup file has no readable version number.");
        if (v != Version)
            throw BridgeException.Validation($"Backup version {v} is not supported by this CatDesktop (expected {Version}).");
    }

    /// <summary>Reads an optional array of objects; each entry that fails validation is skipped and counted in the log.</summary>
    private List<T> ReadEntries<T>(JsonElement root, string property, Func<JsonElement, int, T> read)
    {
        var result = new List<T>();
        var array = Payload.Element(root, property);
        if (Payload.IsMissing(array)) return result;
        if (array.ValueKind != JsonValueKind.Array) throw BridgeException.Validation($"'{property}' must be an array.");

        var index = 0;
        var skipped = 0;
        foreach (var element in array.EnumerateArray())
        {
            try
            {
                if (element.ValueKind != JsonValueKind.Object) throw BridgeException.Validation("entry is not an object");
                result.Add(read(element, index));
            }
            catch (BridgeException ex)
            {
                skipped++;
                _log.Warn($"Backup {property}[{index}] skipped: {ex.Message}");
            }
            index++;
        }
        if (skipped > 0) _log.Warn($"Backup import skipped {skipped} of {index} {property}.");
        return result;
    }

    private static Note ReadNote(JsonElement el, string now)
    {
        var createdAt = ReadTimestamp(el, "createdAt") ?? now;
        var color = Payload.OptionalString(el, "color", NoteRules.MaxColorLength);
        return new Note
        {
            Id = Payload.RequireString(el, "id", NoteRules.MaxIdLength).Trim(),
            Title = Payload.OptionalString(el, "title", NoteRules.MaxTitleLength) ?? "",
            Content = Payload.OptionalString(el, "content", NoteRules.MaxContentLength) ?? "",
            Color = string.IsNullOrWhiteSpace(color) ? null : color.Trim(),
            Pinned = Payload.OptionalBool(el, "pinned") ?? false,
            CreatedAt = createdAt,
            UpdatedAt = ReadTimestamp(el, "updatedAt") ?? createdAt,
        };
    }

    private static TaskItem ReadTask(JsonElement el, int index, string now)
    {
        var createdAt = ReadTimestamp(el, "createdAt") ?? now;
        var updatedAt = ReadTimestamp(el, "updatedAt") ?? createdAt;
        var completed = Payload.OptionalBool(el, "completed") ?? false;
        var notes = Payload.OptionalString(el, "notes", TaskRules.MaxNotesLength);
        return new TaskItem
        {
            Id = Payload.RequireString(el, "id", TaskRules.MaxIdLength).Trim(),
            Title = Payload.RequireString(el, "title", TaskRules.MaxTitleLength).Trim(),
            Notes = string.IsNullOrWhiteSpace(notes) ? null : notes,
            Completed = completed,
            Priority = Payload.OptionalInt(el, "priority", TaskRules.MinPriority, TaskRules.MaxPriority) ?? 0,
            DueAt = ReadTimestamp(el, "dueAt"),
            CompletedAt = completed ? ReadTimestamp(el, "completedAt") ?? updatedAt : null,
            // Clamped rather than rejected: an out-of-range position must not cost the task itself.
            SortOrder = Math.Clamp(Payload.OptionalInt(el, "sortOrder") ?? index, TaskRules.MinSortOrder, TaskRules.MaxSortOrder),
            CreatedAt = createdAt,
            UpdatedAt = updatedAt,
        };
    }

    /// <summary>A logged timer run. id, a known phase and a readable startedAt are required; the rest is normalised.</summary>
    private static FocusSession ReadFocusSession(JsonElement el)
    {
        var id = Payload.RequireString(el, "id", FocusSessionRules.MaxIdLength).Trim();
        var phase = Payload.RequireString(el, "phase", FocusSessionRules.MaxPhaseLength);
        if (!FocusPhases.IsValid(phase))
            throw BridgeException.Validation($"'phase' must be '{FocusPhases.Focus}', '{FocusPhases.ShortBreak}' or '{FocusPhases.LongBreak}'.");
        var startedAt = ReadTimestamp(el, "startedAt")
                        ?? throw BridgeException.Validation("'startedAt' is missing or not an ISO-8601 date/time.");
        return new FocusSession
        {
            Id = id,
            Phase = phase,
            StartedAt = startedAt,
            EndedAt = ReadTimestamp(el, "endedAt"),
            PlannedSeconds = Math.Clamp(Payload.OptionalInt(el, "plannedSeconds") ?? 0, 0, FocusSessionRules.MaxPlannedSeconds),
            Completed = Payload.OptionalBool(el, "completed") ?? false,
        };
    }

    /// <summary>A string timestamp normalised to UTC ISO; null when absent, null, or not a parseable date (hand-edited files).</summary>
    private static string? ReadTimestamp(JsonElement el, string name)
    {
        var raw = Payload.OptionalString(el, name, 64);
        return TaskRules.TryNormaliseIso(raw, out var iso) ? iso : null;
    }

    /// <summary>The action set to install, or null when the file has none or an invalid one (the current set is then kept).</summary>
    private List<QuickAction>? ReadActions(JsonElement root)
    {
        var element = Payload.Element(root, "actions");
        if (Payload.IsMissing(element)) return null;
        if (element.ValueKind != JsonValueKind.Array)
        {
            _log.Warn("Backup 'actions' is not an array; keeping the current quick actions.");
            return null;
        }
        try
        {
            var actions = element.Deserialize<List<QuickAction>>(JsonOptions.Default);
            if (actions is null) return null;
            // A backup written by the Pet Book may hold action types that no longer exist: drop them, keep the rest.
            var current = actions.Where(a => a is null || !QuickAction.RemovedTypes.Contains(a.ActionType, StringComparer.Ordinal)).ToList();
            if (current.Count < actions.Count) _log.Info($"Backup 'actions': {actions.Count - current.Count} Pet Book action(s) of removed types skipped.");
            return QuickActionRules.Normalise(current);
        }
        // ArgumentException as a safety net: a rule that trips over an unexpected null must not abort the whole import.
        catch (Exception ex) when (ex is JsonException or BridgeException or ArgumentException)
        {
            _log.Warn($"Backup 'actions' rejected; keeping the current quick actions: {ex.Message}");
            return null;
        }
    }

    /// <summary>
    /// Settings to write: valid keys with values within the size limit, minus the host-owned window state,
    /// and at most <see cref="MaxImportSettings"/> of them (the rest is skipped and logged).
    /// </summary>
    private Dictionary<string, JsonElement> ReadSettings(JsonElement root)
    {
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var element = Payload.Element(root, "settings");
        if (Payload.IsMissing(element)) return result;
        if (element.ValueKind != JsonValueKind.Object)
        {
            _log.Warn("Backup 'settings' is not an object; no settings imported.");
            return result;
        }

        // Counted before validation, so a hostile file cannot make the per-key warnings below unbounded either.
        var seen = 0;
        foreach (var property in element.EnumerateObject())
        {
            var key = property.Name;
            if (string.Equals(key, SettingRules.MainWindowStateKey, StringComparison.Ordinal)) continue;
            if (++seen > MaxImportSettings) continue;
            if (!SettingRules.IsValidKey(key))
            {
                _log.Warn($"Backup setting '{key}' skipped: invalid key.");
                continue;
            }
            if (!SettingRules.IsValidValueSize(property.Value.GetRawText()))
            {
                _log.Warn($"Backup setting '{key}' skipped: value exceeds {SettingRules.MaxValueBytes / 1024} KB.");
                continue;
            }
            // Clone: the JsonDocument is disposed before the caller sees these values.
            result[key] = property.Value.Clone();
        }
        if (seen > MaxImportSettings)
        {
            _log.Warn($"Backup has {seen} settings, more than the {MaxImportSettings} allowed; the last {seen - MaxImportSettings} were skipped.");
        }
        return result;
    }

    /// <summary>On-disk shape of a backup file (camelCase via JsonOptions).</summary>
    private sealed record BackupDocument
    {
        public string Format { get; init; } = BackupService.Format;
        public int Version { get; init; } = BackupService.Version;
        public string ExportedAt { get; init; } = "";
        public string AppVersion { get; init; } = "";
        public List<Note> Notes { get; init; } = new();
        public List<TaskItem> Tasks { get; init; } = new();
        public Dictionary<string, JsonElement> Settings { get; init; } = new();
        public List<QuickAction> Actions { get; init; } = new();
        /// <summary>Added within format version 1: older files lack it, which the importer treats as "none".</summary>
        public List<FocusSession> FocusSessions { get; init; } = new();
    }
}

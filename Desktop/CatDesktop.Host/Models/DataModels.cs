namespace CatDesktop.Host.Models;

/// <summary>Contract §3 notes.*</summary>
public sealed record Note
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public string Content { get; init; } = "";
    public string? Color { get; init; }
    public bool Pinned { get; init; }
    public string CreatedAt { get; init; } = "";
    public string UpdatedAt { get; init; } = "";
}

/// <summary>Contract §3 tasks.*</summary>
public sealed record TaskItem
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public string? Notes { get; init; }
    public bool Completed { get; init; }
    /// <summary>0 = normal, 1 = high, 2 = urgent</summary>
    public int Priority { get; init; }
    public string? DueAt { get; init; }
    public string? CompletedAt { get; init; }
    public int SortOrder { get; init; }
    public string CreatedAt { get; init; } = "";
    public string UpdatedAt { get; init; } = "";
}

/// <summary>Contract §3 app.getInfo</summary>
public sealed record AppInfo
{
    public string Version { get; init; } = "";
    public string WindowKind { get; init; } = "main";
    public bool DevMode { get; init; }
    public string DataDirectory { get; init; } = "";
    public string DatabasePath { get; init; } = "";
    public string Platform { get; init; } = "windows";
    public string StartedAt { get; init; } = "";
}

/// <summary>Contract §3 data.getInfo</summary>
public sealed record DataInfo
{
    public string DatabasePath { get; init; } = "";
    public long SizeBytes { get; init; }
    public int NoteCount { get; init; }
    public int TaskCount { get; init; }
    public int SchemaVersion { get; init; }
}

public static class Timestamps
{
    /// <summary>ISO-8601 UTC with milliseconds, e.g. 2026-09-26T10:15:00.000Z (contract §2).</summary>
    public static string NowIso() => DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");

    public static string ToIso(DateTime utc) => utc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");

    public static string NewId() => Guid.NewGuid().ToString();
}

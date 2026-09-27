namespace CatDesktop.Host.Models;

/// <summary>Quick action shown in the cat's companion panel (contract §3 actions.*).</summary>
public sealed record QuickAction
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Icon { get; init; } = "";
    public bool Enabled { get; init; } = true;
    public int Order { get; init; }
    public string? Route { get; init; }
    public string ActionType { get; init; } = "custom";
    public Dictionary<string, object?>? Payload { get; init; }

    public static readonly string[] KnownTypes =
    {
        "navigate", "quick-note", "tasks", "focus", "reminders", "pin", "search", "settings", "custom",
    };

    /// <summary>Pet Book action types that no longer exist (migration 002 deletes them; old backups may still hold them).</summary>
    public static readonly string[] RemovedTypes = { "toggle-compact", "return-home" };
}

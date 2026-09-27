namespace CatDesktop.Host.Models;

/// <summary>Contract §3 focus.* — stored as JSON under settings key "focus.settings".</summary>
public sealed record FocusSettings
{
    public const string SettingsKey = "focus.settings";

    public int FocusMinutes { get; init; } = 25;
    public int ShortBreakMinutes { get; init; } = 5;
    public int LongBreakMinutes { get; init; } = 15;
    public int SessionsBeforeLongBreak { get; init; } = 4;
    public bool AutoStartBreaks { get; init; } = false;
    public bool AutoStartFocus { get; init; } = false;
    public bool Notify { get; init; } = true;
    public bool Sound { get; init; } = true;

    public static FocusSettings Default => new();

    public FocusSettings Normalised() => this with
    {
        FocusMinutes = Math.Clamp(FocusMinutes, 1, 180),
        ShortBreakMinutes = Math.Clamp(ShortBreakMinutes, 1, 60),
        LongBreakMinutes = Math.Clamp(LongBreakMinutes, 1, 120),
        SessionsBeforeLongBreak = Math.Clamp(SessionsBeforeLongBreak, 1, 12),
    };
}

public static class FocusPhases
{
    public const string Focus = "focus";
    public const string ShortBreak = "shortBreak";
    public const string LongBreak = "longBreak";

    public static bool IsValid(string? phase) => phase is Focus or ShortBreak or LongBreak;
}

public static class FocusStatuses
{
    public const string Idle = "idle";
    public const string Running = "running";
    public const string Paused = "paused";
    public const string Completed = "completed";
}

public sealed record FocusState
{
    public string Phase { get; init; } = FocusPhases.Focus;
    public string Status { get; init; } = FocusStatuses.Idle;
    public int RemainingSeconds { get; init; }
    public int TotalSeconds { get; init; }
    public int CompletedFocusSessions { get; init; }
    public string? StartedAt { get; init; }
    public string? EndsAt { get; init; }
}

public sealed record FocusStats
{
    public int TodayFocusSessions { get; init; }
    public int TodayFocusMinutes { get; init; }
    public int TotalFocusSessions { get; init; }
    public int TotalFocusMinutes { get; init; }
}

public sealed record FocusSession
{
    public string Id { get; init; } = "";
    public string Phase { get; init; } = FocusPhases.Focus;
    public string StartedAt { get; init; } = "";
    public string? EndedAt { get; init; }
    public int PlannedSeconds { get; init; }
    public bool Completed { get; init; }
}

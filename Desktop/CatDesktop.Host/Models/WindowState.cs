namespace CatDesktop.Host.Models;

/// <summary>Physical-pixel window geometry + flags. Persisted in window_states and sent over the bridge.</summary>
public sealed record WindowState
{
    public string WindowId { get; init; } = "";
    public string? Monitor { get; init; }
    public int X { get; init; }
    public int Y { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public bool IsMaximized { get; init; }
    public bool IsMinimized { get; init; }
    public bool IsVisible { get; init; }
    public bool AlwaysOnTop { get; init; }
}

using CatDesktop.Host.Models;

namespace CatDesktop.Host.Database.Repositories;

/// <summary>
/// Persists window geometry per window id ("main" / "cat"). Only the restorable part of a
/// <see cref="WindowState"/> is stored; IsMinimized/IsVisible/AlwaysOnTop are runtime flags and come back false.
/// </summary>
public sealed class WindowStateRepository
{
    private readonly SqliteDatabase _db;

    public WindowStateRepository(SqliteDatabase db)
    {
        _db = db;
    }

    public WindowState? Get(string windowId)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT monitor, x, y, width, height, is_maximized FROM window_states WHERE window_id = $windowId;";
        cmd.AddParam("$windowId", windowId);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;
        return new WindowState
        {
            WindowId = windowId,
            Monitor = reader.GetStringOrNull(0),
            X = reader.GetInt32(1),
            Y = reader.GetInt32(2),
            Width = reader.GetInt32(3),
            Height = reader.GetInt32(4),
            IsMaximized = reader.GetBool(5),
        };
    }

    public void Save(WindowState state)
    {
        if (string.IsNullOrWhiteSpace(state.WindowId)) throw new ArgumentException("WindowId is required.", nameof(state));
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "INSERT OR REPLACE INTO window_states (window_id, monitor, x, y, width, height, is_maximized, updated_at) " +
            "VALUES ($windowId, $monitor, $x, $y, $width, $height, $isMaximized, $updatedAt);";
        cmd.AddParam("$windowId", state.WindowId);
        cmd.AddParam("$monitor", state.Monitor);
        cmd.AddParam("$x", state.X);
        cmd.AddParam("$y", state.Y);
        cmd.AddParam("$width", state.Width);
        cmd.AddParam("$height", state.Height);
        cmd.AddParam("$isMaximized", state.IsMaximized);
        cmd.AddParam("$updatedAt", Timestamps.NowIso());
        cmd.ExecuteNonQuery();
    }

    public void Delete(string windowId)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM window_states WHERE window_id = $windowId;";
        cmd.AddParam("$windowId", windowId);
        cmd.ExecuteNonQuery();
    }
}

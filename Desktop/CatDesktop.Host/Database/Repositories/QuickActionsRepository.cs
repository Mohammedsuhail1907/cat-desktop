using System.Text.Json;
using System.Text.RegularExpressions;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Models;
using Microsoft.Data.Sqlite;

namespace CatDesktop.Host.Database.Repositories;

/// <summary>
/// The default quick-action set: the rows seeded by Database/Migrations/001_initial.sql as renamed by 002_cat_companion.sql
/// ('pin' is now called "Always on Top"; it toggles CatSettings.alwaysOnTop).
/// </summary>
public static class QuickActionDefaults
{
    public static IReadOnlyList<QuickAction> All { get; } = new[]
    {
        new QuickAction { Id = "home", Name = "Home", Icon = "home", Order = 0, Route = "/dashboard", ActionType = "navigate" },
        new QuickAction { Id = "quick-note", Name = "Quick Note", Icon = "note", Order = 1, ActionType = "quick-note" },
        new QuickAction { Id = "tasks", Name = "Tasks", Icon = "tasks", Order = 2, ActionType = "tasks" },
        new QuickAction { Id = "focus", Name = "Focus Timer", Icon = "timer", Order = 3, ActionType = "focus" },
        new QuickAction { Id = "reminders", Name = "Reminders", Icon = "bell", Order = 4, ActionType = "reminders" },
        new QuickAction { Id = "pin", Name = "Always on Top", Icon = "pin", Order = 5, ActionType = "pin" },
        new QuickAction { Id = "search", Name = "Search", Icon = "search", Order = 6, Route = "/notes", ActionType = "search" },
        new QuickAction { Id = "settings", Name = "Settings", Icon = "settings", Order = 7, Route = "/settings", ActionType = "navigate" },
    };
}

/// <summary>Validation for a full action set (contract actions.save), shared by the bridge handler and the backup importer.</summary>
public static partial class QuickActionRules
{
    public const int MinActions = 1;
    public const int MaxActions = 24;
    public const int MaxNameLength = 60;
    public const int MaxIconLength = 60;
    public const int MaxRouteLength = 200;

    [GeneratedRegex(@"^[a-zA-Z0-9_\-]{1,64}$")]
    private static partial Regex IdPattern();

    /// <summary>
    /// Checks every rule and returns the set with <see cref="QuickAction.Order"/> re-assigned from the array
    /// position and blank routes folded to null. Throws a validation <see cref="BridgeException"/> on the first problem.
    /// </summary>
    public static List<QuickAction> Normalise(IReadOnlyList<QuickAction> actions)
    {
        if (actions.Count < MinActions || actions.Count > MaxActions)
            throw BridgeException.Validation($"'actions' must contain between {MinActions} and {MaxActions} items.");

        var ids = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<QuickAction>(actions.Count);
        for (var i = 0; i < actions.Count; i++)
        {
            var a = actions[i] ?? throw BridgeException.Validation($"actions[{i}] is null.");
            // "id": null deserialises to a null string despite the non-nullable property; Regex.IsMatch would throw on it.
            if (a.Id is null || !IdPattern().IsMatch(a.Id))
                throw BridgeException.Validation($"actions[{i}].id must match ^[a-zA-Z0-9_-]{{1,64}}$.");
            if (!ids.Add(a.Id))
                throw BridgeException.Validation($"actions[{i}].id '{a.Id}' is used twice.");
            var name = a.Name?.Trim() ?? "";
            if (name.Length is 0 or > MaxNameLength)
                throw BridgeException.Validation($"actions[{i}].name must be 1-{MaxNameLength} characters.");
            var icon = a.Icon?.Trim() ?? "";
            if (icon.Length is 0 or > MaxIconLength)
                throw BridgeException.Validation($"actions[{i}].icon must be 1-{MaxIconLength} characters.");
            if (!QuickAction.KnownTypes.Contains(a.ActionType, StringComparer.Ordinal))
                throw BridgeException.Validation($"actions[{i}].actionType '{a.ActionType}' is not supported.");
            var route = string.IsNullOrWhiteSpace(a.Route) ? null : a.Route.Trim();
            if (route is not null && (!route.StartsWith('/') || route.Length > MaxRouteLength))
                throw BridgeException.Validation($"actions[{i}].route must start with '/' and be at most {MaxRouteLength} characters.");

            result.Add(a with { Name = name, Icon = icon, Route = route, Order = i });
        }
        return result;
    }
}

public sealed class QuickActionsRepository
{
    private readonly SqliteDatabase _db;

    public QuickActionsRepository(SqliteDatabase db)
    {
        _db = db;
    }

    public List<QuickAction> List()
    {
        var actions = new List<QuickAction>();
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id, name, icon, enabled, sort_order, route, action_type, payload FROM quick_actions ORDER BY sort_order, id;";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            actions.Add(new QuickAction
            {
                Id = reader.GetString(0),
                Name = reader.GetString(1),
                Icon = reader.GetString(2),
                Enabled = reader.GetBool(3),
                Order = reader.GetInt32(4),
                Route = reader.GetStringOrNull(5),
                ActionType = reader.GetString(6),
                Payload = ReadPayload(reader.GetStringOrNull(7)),
            });
        }
        return actions;
    }

    /// <summary>Full replace: the table ends up containing exactly <paramref name="actions"/>, sort_order taken from Order.</summary>
    public void ReplaceAll(IEnumerable<QuickAction> actions)
    {
        using var conn = _db.Open();
        using var tx = conn.BeginTransaction();
        ReplaceAll(conn, actions);
        tx.Commit();
    }

    /// <summary>Same as <see cref="ReplaceAll(IEnumerable{QuickAction})"/> inside a caller-managed transaction.</summary>
    internal void ReplaceAll(SqliteConnection conn, IEnumerable<QuickAction> actions)
    {
        using (var clear = conn.CreateCommand())
        {
            clear.CommandText = "DELETE FROM quick_actions;";
            clear.ExecuteNonQuery();
        }

        using var insert = conn.CreateCommand();
        insert.CommandText =
            "INSERT INTO quick_actions (id, name, icon, enabled, sort_order, route, action_type, payload) " +
            "VALUES ($id, $name, $icon, $enabled, $sortOrder, $route, $actionType, $payload);";
        var pId = insert.Parameters.Add("$id", SqliteType.Text);
        var pName = insert.Parameters.Add("$name", SqliteType.Text);
        var pIcon = insert.Parameters.Add("$icon", SqliteType.Text);
        var pEnabled = insert.Parameters.Add("$enabled", SqliteType.Integer);
        var pSortOrder = insert.Parameters.Add("$sortOrder", SqliteType.Integer);
        var pRoute = insert.Parameters.Add("$route", SqliteType.Text);
        var pActionType = insert.Parameters.Add("$actionType", SqliteType.Text);
        var pPayload = insert.Parameters.Add("$payload", SqliteType.Text);

        foreach (var a in actions)
        {
            pId.Value = a.Id;
            pName.Value = a.Name;
            pIcon.Value = a.Icon;
            pEnabled.Value = a.Enabled ? 1 : 0;
            pSortOrder.Value = a.Order;
            pRoute.Value = (object?)a.Route ?? DBNull.Value;
            pActionType.Value = a.ActionType;
            pPayload.Value = a.Payload is { Count: > 0 } ? JsonSerializer.Serialize(a.Payload, JsonOptions.Default) : DBNull.Value;
            insert.ExecuteNonQuery();
        }
    }

    public void ResetToDefaults() => ReplaceAll(QuickActionDefaults.All);

    /// <summary>Payload column is JSON of the dictionary; anything unreadable is treated as "no payload" rather than breaking the list.</summary>
    private static Dictionary<string, object?>? ReadPayload(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, object?>>(json, JsonOptions.Default);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

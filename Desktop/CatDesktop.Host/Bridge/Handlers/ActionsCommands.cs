using System.Text.Json;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.Models;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>actions.* (contract section 3): the quick-action set of the cat's companion panel, always replaced as a whole.</summary>
public sealed class ActionsCommands
{
    private const string ChangedEvent = "actions.changed";

    private readonly QuickActionsRepository _actions;
    private readonly BridgeEvents _events;

    public ActionsCommands(QuickActionsRepository actions, BridgeEvents events)
    {
        _actions = actions;
        _events = events;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("actions.list", _ => _actions.List());

        router.Register("actions.save", (_, payload) =>
        {
            var normalised = QuickActionRules.Normalise(ReadActions(payload));
            _actions.ReplaceAll(normalised);
            _events.Broadcast(ChangedEvent);
            return _actions.List();
        });

        router.Register("actions.reset", _ =>
        {
            _actions.ResetToDefaults();
            _events.Broadcast(ChangedEvent);
            return _actions.List();
        });
    }

    private static List<QuickAction> ReadActions(JsonElement payload)
    {
        var element = Payload.Element(payload, "actions");
        if (element.ValueKind != JsonValueKind.Array) throw BridgeException.Validation("'actions' must be an array.");
        try
        {
            return element.Deserialize<List<QuickAction>>(JsonOptions.Default)
                   ?? throw BridgeException.Validation("'actions' could not be read.");
        }
        catch (JsonException ex)
        {
            throw BridgeException.Validation($"'actions' could not be read: {ex.Message}");
        }
    }
}

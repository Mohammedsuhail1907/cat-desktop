using System.Text.Json;
using CatDesktop.Host.Models;
using CatDesktop.Host.Services;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>Contract section 3 hotkeys.* commands.</summary>
public sealed class HotkeysCommands
{
    private const int MaxGestureLength = 40;

    private readonly HotkeyManager _hotkeys;
    private readonly SettingsService _settings;

    public HotkeysCommands(HotkeyManager hotkeys, SettingsService settings)
    {
        _hotkeys = hotkeys;
        _settings = settings;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("hotkeys.get", _ => _hotkeys.Current);
        router.Register("hotkeys.set", (_, payload) => Set(payload));
        // The Settings recorder suspends the global shortcuts so it can capture one that is currently registered.
        router.Register("hotkeys.suspend", (_, payload) =>
        {
            _hotkeys.Suspend(Payload.RequireBool(payload, "suspended"));
            return new { };
        });
    }

    private object? Set(JsonElement payload)
    {
        if (Payload.IsMissing(payload) || payload.ValueKind != JsonValueKind.Object)
        {
            throw BridgeException.Validation("Expected a Hotkeys object with toggleCat, startFocus and quickNote.");
        }

        var hotkeys = new Hotkeys
        {
            // The Pet Book's name is still understood when the new one is absent (contract: read as toggleCat).
            ToggleCat = Payload.Has(payload, Hotkeys.ToggleCatName) || !Payload.Has(payload, Hotkeys.LegacyToggleName)
                ? ReadGesture(payload, Hotkeys.ToggleCatName)
                : ReadGesture(payload, Hotkeys.LegacyToggleName),
            StartFocus = ReadGesture(payload, Hotkeys.StartFocusName),
            QuickNote = ReadGesture(payload, Hotkeys.QuickNoteName),
        };

        // Apply validates every gesture and registers atomically; it throws validation/denied errors that
        // propagate unchanged, so nothing is persisted unless the shortcuts are really in effect.
        _hotkeys.Apply(hotkeys);
        _settings.Set(Hotkeys.SettingsKey, _hotkeys.Current);
        return _hotkeys.Current;
    }

    /// <summary>A binding is either absent/null (unbound) or a non-empty gesture of at most 40 characters.</summary>
    private static string? ReadGesture(JsonElement payload, string name)
    {
        var gesture = Payload.OptionalString(payload, name, MaxGestureLength);
        return string.IsNullOrWhiteSpace(gesture) ? null : gesture.Trim();
    }
}

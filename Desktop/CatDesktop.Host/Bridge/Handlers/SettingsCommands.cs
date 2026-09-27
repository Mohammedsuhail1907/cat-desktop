using System.Text.Json;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.Services;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>settings.* (contract section 3): generic key -> JSON store. The composition root broadcasts settings.changed from <see cref="SettingsService.Changed"/>.</summary>
public sealed class SettingsCommands
{
    private readonly SettingsService _settings;

    public SettingsCommands(SettingsService settings)
    {
        _settings = settings;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("settings.getAll", _ => _settings.GetAll());

        router.Register("settings.get", (_, payload) =>
        {
            var key = RequireKey(payload);
            var value = _settings.GetElement(key);
            return new { key, value = value.HasValue ? (object)value.Value : null };
        });

        router.Register("settings.set", (_, payload) =>
        {
            var key = RequireKey(payload);
            if (!Payload.Has(payload, "value"))
                throw BridgeException.Validation("'value' is required (send null to clear a setting).");
            var value = Payload.Element(payload, "value");
            if (!SettingRules.IsValidValueSize(value.GetRawText()))
                throw BridgeException.Validation($"'value' exceeds {SettingRules.MaxValueBytes / 1024} KB.");

            _settings.Set(key, value);
            return new { key, value };
        });

        router.Register("settings.remove", (_, payload) =>
        {
            _settings.Remove(RequireKey(payload));
            return new { };
        });
    }

    private static string RequireKey(JsonElement payload)
    {
        var key = Payload.RequireString(payload, "key", SettingRules.MaxKeyLength);
        if (!SettingRules.IsValidKey(key))
            throw BridgeException.Validation("'key' may only contain letters, digits, '_', '.', '-' (1-100 characters).");
        return key;
    }
}

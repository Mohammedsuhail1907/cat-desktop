using System.Text.Json;
using CatDesktop.Host.App;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.Models;
using CatDesktop.Host.Services;
using CatDesktop.Host.Windows;

namespace CatDesktop.Host.Cat;

/// <summary>
/// One-time conversion of the Pet Book's stored state into the cat's (contract §5), run at start-up before anything
/// reads the cat settings or subscribes to settings changes. Idempotent: every step removes its legacy source, and a
/// step whose target already exists never overwrites it.
///   * "petbook.settings" → "cat.settings" (only while "cat.settings" is missing): enabled, alwaysOnTop, startWithApp
///     and opacity carry over, the Pet Book size becomes the scale (small 0.7, medium 1, large 1.4), everything else takes
///     the defaults (so sound stays off). The legacy key is removed.
///   * window_states "petbook" → "cat" (monitor and x/y; only while there is no "cat" row). The legacy row is deleted.
///     Independent of the settings step: the Pet Book saved its position at every exit, its settings only when changed.
///   * "hotkeys" still using "togglePetBook" (and no "toggleCat") is rewritten with the new name.
/// </summary>
internal static class CatLegacyMigration
{
    private const string LegacyWindowId = "petbook";

    public static void Run(SettingsService settings, WindowStateRepository windowStates, Logger log)
    {
        Try(log, "settings", () => ConvertSettings(settings, log));
        Try(log, "position", () => ConvertPosition(windowStates, log));
        Try(log, "hotkeys", () => ConvertHotkeys(settings, log));
    }

    private static void Try(Logger log, string step, Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            // A broken legacy value must never stop the app from starting: the cat simply starts with defaults.
            log.Warn($"Pet Book {step} could not be converted for the cat: {ex.Message}");
        }
    }

    private static void ConvertSettings(SettingsService settings, Logger log)
    {
        var legacy = settings.GetElement(CatSettings.LegacySettingsKey);
        if (legacy is null) return;

        if (settings.GetElement(CatSettings.SettingsKey) is null && legacy.Value.ValueKind == JsonValueKind.Object)
        {
            var old = legacy.Value;
            var defaults = CatSettings.Default;
            // A missing or wrongly typed legacy value takes the default instead of failing the conversion.
            var converted = defaults with
            {
                Enabled = ReadBool(old, "enabled") ?? defaults.Enabled,
                AlwaysOnTop = ReadBool(old, "alwaysOnTop") ?? defaults.AlwaysOnTop,
                StartWithApp = ReadBool(old, "startWithApp") ?? defaults.StartWithApp,
                Opacity = ReadNumber(old, "opacity") ?? defaults.Opacity,
                Scale = CatSettings.ScaleForLegacySize(ReadString(old, "size")),
            };
            settings.Set(CatSettings.SettingsKey, converted.Normalised());
            log.Info("Converted the Pet Book settings into cat.settings.");
        }
        settings.Remove(CatSettings.LegacySettingsKey);
        log.Info($"Removed the legacy setting '{CatSettings.LegacySettingsKey}'.");
    }

    private static bool? ReadBool(JsonElement obj, string name)
        => obj.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

    private static double? ReadNumber(JsonElement obj, string name)
        => obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? d : null;

    private static string? ReadString(JsonElement obj, string name)
        => obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static void ConvertPosition(WindowStateRepository windowStates, Logger log)
    {
        var legacy = windowStates.Get(LegacyWindowId);
        if (legacy is null) return;

        var catId = WindowKind.Cat.ToWindowId();
        if (windowStates.Get(catId) is null)
        {
            windowStates.Save(legacy with { WindowId = catId, IsMaximized = false });
            log.Info($"Converted the Pet Book position ({legacy.Monitor ?? "no monitor"} {legacy.X},{legacy.Y}) into the cat's start position.");
        }
        windowStates.Delete(LegacyWindowId);
    }

    private static void ConvertHotkeys(SettingsService settings, Logger log)
    {
        var stored = settings.GetElement(Hotkeys.SettingsKey);
        if (stored is not { ValueKind: JsonValueKind.Object } element) return;
        if (!element.TryGetProperty(Hotkeys.LegacyToggleName, out _) || element.TryGetProperty(Hotkeys.ToggleCatName, out _)) return;

        var hotkeys = element.Deserialize<Hotkeys>(JsonOptions.Default) ?? Hotkeys.Default;
        settings.Set(Hotkeys.SettingsKey, hotkeys);
        log.Info("Renamed the stored hotkey 'togglePetBook' to 'toggleCat'.");
    }
}

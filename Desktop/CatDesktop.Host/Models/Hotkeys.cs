using System.Text.Json;
using System.Text.Json.Serialization;

namespace CatDesktop.Host.Models;

/// <summary>
/// Contract §3 hotkeys.* — stored as JSON under settings key "hotkeys". Format "Ctrl+Shift+P".
/// A stored value that still uses the Pet Book name "togglePetBook" (and no "toggleCat") is read as <see cref="ToggleCat"/>.
/// </summary>
[JsonConverter(typeof(HotkeysJsonConverter))]
public sealed record Hotkeys
{
    public const string SettingsKey = "hotkeys";

    public const string ToggleCatName = "toggleCat";
    public const string StartFocusName = "startFocus";
    public const string QuickNoteName = "quickNote";
    /// <summary>The Pet Book's name for <see cref="ToggleCat"/>, still accepted when reading.</summary>
    public const string LegacyToggleName = "togglePetBook";

    public string? ToggleCat { get; init; } = "Ctrl+Shift+P";
    public string? StartFocus { get; init; } = "Ctrl+Shift+F";
    public string? QuickNote { get; init; } = "Ctrl+Shift+N";

    public static Hotkeys Default => new();

    public static Hotkeys None => new() { ToggleCat = null, StartFocus = null, QuickNote = null };

    public IEnumerable<(string Name, string Gesture)> Bindings()
    {
        if (!string.IsNullOrWhiteSpace(ToggleCat)) yield return (ToggleCatName, ToggleCat);
        if (!string.IsNullOrWhiteSpace(StartFocus)) yield return (StartFocusName, StartFocus);
        if (!string.IsNullOrWhiteSpace(QuickNote)) yield return (QuickNoteName, QuickNote);
    }

    /// <summary>A copy with the binding <paramref name="name"/> set to <paramref name="gesture"/>.</summary>
    public Hotkeys With(string name, string? gesture) => name switch
    {
        ToggleCatName => this with { ToggleCat = gesture },
        StartFocusName => this with { StartFocus = gesture },
        QuickNoteName => this with { QuickNote = gesture },
        _ => throw new ArgumentOutOfRangeException(nameof(name), name, "Unknown hotkey binding."),
    };
}

/// <summary>
/// Reads/writes <see cref="Hotkeys"/> as { toggleCat, startFocus, quickNote }. Absent properties keep their defaults
/// (like the plain serializer did); a legacy "togglePetBook" is used for toggleCat when "toggleCat" is absent.
/// </summary>
public sealed class HotkeysJsonConverter : JsonConverter<Hotkeys>
{
    public override Hotkeys Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartObject) throw new JsonException("Hotkeys must be a JSON object.");

        var result = Hotkeys.Default;
        var hasToggleCat = false;
        string? legacyToggle = null;
        var hasLegacyToggle = false;

        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.EndObject)
            {
                if (!hasToggleCat && hasLegacyToggle) result = result with { ToggleCat = legacyToggle };
                return result;
            }
            if (reader.TokenType != JsonTokenType.PropertyName) throw new JsonException("Unexpected token in Hotkeys.");

            var name = reader.GetString() ?? "";
            reader.Read();
            if (Is(name, Hotkeys.ToggleCatName))
            {
                result = result with { ToggleCat = ReadGesture(ref reader, name) };
                hasToggleCat = true;
            }
            else if (Is(name, Hotkeys.StartFocusName))
            {
                result = result with { StartFocus = ReadGesture(ref reader, name) };
            }
            else if (Is(name, Hotkeys.QuickNoteName))
            {
                result = result with { QuickNote = ReadGesture(ref reader, name) };
            }
            else if (Is(name, Hotkeys.LegacyToggleName))
            {
                legacyToggle = ReadGesture(ref reader, name);
                hasLegacyToggle = true;
            }
            else
            {
                reader.Skip(); // unknown property: ignored, like the default serializer
            }
        }
        throw new JsonException("Unterminated Hotkeys object.");
    }

    public override void Write(Utf8JsonWriter writer, Hotkeys value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        WriteGesture(writer, Hotkeys.ToggleCatName, value.ToggleCat);
        WriteGesture(writer, Hotkeys.StartFocusName, value.StartFocus);
        WriteGesture(writer, Hotkeys.QuickNoteName, value.QuickNote);
        writer.WriteEndObject();
    }

    private static bool Is(string name, string expected) => string.Equals(name, expected, StringComparison.OrdinalIgnoreCase);

    private static string? ReadGesture(ref Utf8JsonReader reader, string name) => reader.TokenType switch
    {
        JsonTokenType.Null => null,
        JsonTokenType.String => reader.GetString(),
        _ => throw new JsonException($"Hotkey '{name}' must be a string or null."),
    };

    private static void WriteGesture(Utf8JsonWriter writer, string name, string? gesture)
    {
        if (gesture is null) writer.WriteNull(name);
        else writer.WriteString(name, gesture);
    }
}

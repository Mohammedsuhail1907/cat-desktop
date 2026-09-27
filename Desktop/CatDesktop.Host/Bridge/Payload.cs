using System.Text.Json;

namespace CatDesktop.Host.Bridge;

/// <summary>
/// Helpers for reading/validating request payloads. Every accessor throws a
/// <see cref="BridgeException"/> with code "validation" so handlers stay short and safe.
/// </summary>
public static class Payload
{
    public static bool IsMissing(JsonElement payload) =>
        payload.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null;

    /// <summary>Deserialise the whole payload into <typeparamref name="T"/> (must be a JSON object).</summary>
    public static T Require<T>(JsonElement payload) where T : class
    {
        if (IsMissing(payload) || payload.ValueKind != JsonValueKind.Object)
            throw BridgeException.Validation($"Expected an object payload for {typeof(T).Name}.");
        try
        {
            return payload.Deserialize<T>(JsonOptions.Default)
                   ?? throw BridgeException.Validation($"Payload could not be read as {typeof(T).Name}.");
        }
        catch (JsonException ex)
        {
            throw BridgeException.Validation($"Invalid payload for {typeof(T).Name}: {ex.Message}");
        }
    }

    /// <summary>Deserialise when present, otherwise return <paramref name="fallback"/>.</summary>
    public static T Optional<T>(JsonElement payload, T fallback) where T : class
        => IsMissing(payload) ? fallback : Require<T>(payload);

    public static string RequireString(JsonElement payload, string name, int maxLength = 100_000)
    {
        var value = OptionalString(payload, name, maxLength);
        if (string.IsNullOrWhiteSpace(value)) throw BridgeException.Validation($"'{name}' is required.");
        return value;
    }

    public static string? OptionalString(JsonElement payload, string name, int maxLength = 100_000)
    {
        if (!TryGet(payload, name, out var el) || el.ValueKind == JsonValueKind.Null) return null;
        if (el.ValueKind != JsonValueKind.String) throw BridgeException.Validation($"'{name}' must be a string.");
        var s = el.GetString() ?? "";
        if (s.Length > maxLength) throw BridgeException.Validation($"'{name}' is too long (max {maxLength}).");
        return s;
    }

    public static bool RequireBool(JsonElement payload, string name)
        => OptionalBool(payload, name) ?? throw BridgeException.Validation($"'{name}' is required.");

    public static bool? OptionalBool(JsonElement payload, string name)
    {
        if (!TryGet(payload, name, out var el) || el.ValueKind == JsonValueKind.Null) return null;
        return el.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw BridgeException.Validation($"'{name}' must be a boolean."),
        };
    }

    public static int RequireInt(JsonElement payload, string name, int min = int.MinValue, int max = int.MaxValue)
        => OptionalInt(payload, name, min, max) ?? throw BridgeException.Validation($"'{name}' is required.");

    public static int? OptionalInt(JsonElement payload, string name, int min = int.MinValue, int max = int.MaxValue)
    {
        if (!TryGet(payload, name, out var el) || el.ValueKind == JsonValueKind.Null) return null;
        if (el.ValueKind != JsonValueKind.Number || !el.TryGetDouble(out var d) || double.IsNaN(d) || double.IsInfinity(d))
            throw BridgeException.Validation($"'{name}' must be a number.");
        var v = (int)Math.Round(d);
        if (v < min || v > max) throw BridgeException.Validation($"'{name}' must be between {min} and {max}.");
        return v;
    }

    public static double RequireDouble(JsonElement payload, string name, double min = double.MinValue, double max = double.MaxValue)
        => OptionalDouble(payload, name, min, max) ?? throw BridgeException.Validation($"'{name}' is required.");

    public static double? OptionalDouble(JsonElement payload, string name, double min = double.MinValue, double max = double.MaxValue)
    {
        if (!TryGet(payload, name, out var el) || el.ValueKind == JsonValueKind.Null) return null;
        if (el.ValueKind != JsonValueKind.Number || !el.TryGetDouble(out var d) || double.IsNaN(d) || double.IsInfinity(d))
            throw BridgeException.Validation($"'{name}' must be a number.");
        if (d < min || d > max) throw BridgeException.Validation($"'{name}' must be between {min} and {max}.");
        return d;
    }

    /// <summary>Returns the raw element for <paramref name="name"/> (Undefined when absent).</summary>
    public static JsonElement Element(JsonElement payload, string name)
        => TryGet(payload, name, out var el) ? el : default;

    public static bool Has(JsonElement payload, string name) => TryGet(payload, name, out _);

    private static bool TryGet(JsonElement payload, string name, out JsonElement element)
    {
        element = default;
        return payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out element);
    }
}

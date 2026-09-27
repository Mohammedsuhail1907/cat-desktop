using System.Text.Json;
using System.Text.Json.Serialization;

namespace CatDesktop.Host.Bridge;

/// <summary>Single JSON configuration for everything that crosses the bridge or is stored as JSON in SQLite.</summary>
public static class JsonOptions
{
    public static readonly JsonSerializerOptions Default = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
        // CatSettingsJsonConverter maps the legacy cat.settings 'size' to 'scale' wherever cat settings are read.
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase), new Models.CatSettingsJsonConverter() },
    };

    public static readonly JsonSerializerOptions Indented = new(Default) { WriteIndented = true };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Default);

    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Default);
}

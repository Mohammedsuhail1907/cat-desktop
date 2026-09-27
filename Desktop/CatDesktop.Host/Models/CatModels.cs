using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace CatDesktop.Host.Models;

/// <summary>
/// Contract §5. Stored as JSON under settings key "cat.settings". Read through <see cref="CatSettingsJsonConverter"/>
/// (registered in the bridge's JsonOptions), which maps the legacy 'size' of an older cat.settings to <see cref="Scale"/>.
/// </summary>
public sealed record CatSettings
{
    public const string SettingsKey = "cat.settings";
    /// <summary>The Pet Book's settings key; converted once at start-up (see Cat/CatLegacyMigration.cs).</summary>
    public const string LegacySettingsKey = "petbook.settings";

    public const double MinWalkingSpeed = 0.5;
    public const double MaxWalkingSpeed = 2.0;
    public const double MinScale = 0.1;
    public const double MaxScale = 2.0;
    public const double MinOpacity = 0.3;
    public const double MaxOpacity = 1.0;

    public bool Enabled { get; init; } = true;
    public bool StartWithApp { get; init; } = true;
    public bool AutoWalk { get; init; } = true;
    public bool AlwaysOnTop { get; init; } = true;
    public bool Interaction { get; init; } = true;
    public bool ClickThroughWhenIdle { get; init; }
    public bool RandomIdle { get; init; } = true;
    public bool RandomActions { get; init; } = true;
    public bool Sound { get; init; }
    public double WalkingSpeed { get; init; } = 1.0;
    /// <summary>Cat size: 0.1-2 of the reference box (160 x 120 CSS px), 2 decimals.</summary>
    public double Scale { get; init; } = 1.0;
    /// <summary>Theme id (^[a-z0-9][a-z0-9-]{0,31}$). Stored as given, never interpreted by the host.</summary>
    public string Theme { get; init; } = CatThemes.Default;
    public double Opacity { get; init; } = 1.0;

    public static CatSettings Default => new();

    /// <summary>Clamp/normalise anything a client (or an old backup) could have stored.</summary>
    public CatSettings Normalised() => this with
    {
        WalkingSpeed = Math.Clamp(double.IsFinite(WalkingSpeed) ? WalkingSpeed : 1.0, MinWalkingSpeed, MaxWalkingSpeed),
        Scale = NormaliseScale(Scale),
        Theme = CatThemes.IsValid(Theme) ? Theme : CatThemes.Default,
        Opacity = Math.Clamp(double.IsFinite(Opacity) ? Opacity : 1.0, MinOpacity, MaxOpacity),
    };

    /// <summary>0.1-2, rounded to 2 decimals; anything that is not a number becomes 1.</summary>
    public static double NormaliseScale(double scale)
        => Math.Round(Math.Clamp(double.IsFinite(scale) ? scale : 1.0, MinScale, MaxScale), 2, MidpointRounding.AwayFromZero);

    /// <summary>The scale of a size preset from before scales existed (cat.settings and the Pet Book): small 0.7, medium 1, large 1.4.</summary>
    public static double ScaleForLegacySize(string? size) => size switch
    {
        "small" => 0.7,
        "large" => 1.4,
        _ => 1.0,
    };
}

/// <summary>Theme ids are validated by pattern only: the catalogue lives in the UI (cat-sprite/cat-themes.ts).</summary>
public static partial class CatThemes
{
    public const string Default = "classic";

    [GeneratedRegex("^[a-z0-9][a-z0-9-]{0,31}$")]
    private static partial Regex Pattern();

    public static bool IsValid(string? theme) => theme is not null && Pattern().IsMatch(theme);
}

/// <summary>
/// Reads <see cref="CatSettings"/> like the default serializer, except that an object with the legacy "size"
/// ("small" | "medium" | "large") and no "scale" gets the matching scale; "size" itself is always dropped, so it never
/// reaches the model, the bridge or the next save. Writes the plain contract fields.
/// </summary>
public sealed class CatSettingsJsonConverter : JsonConverter<CatSettings>
{
    /// <summary>The same options without this converter, for the plain (de)serialization of the record itself.</summary>
    private static readonly ConditionalWeakTable<JsonSerializerOptions, JsonSerializerOptions> Plain = new();

    public override CatSettings Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (JsonNode.Parse(ref reader) is not JsonObject obj) throw new JsonException("CatSettings must be a JSON object.");

        var hasScale = false;
        string? legacySize = null;
        foreach (var (name, value) in obj.ToList())
        {
            if (string.Equals(name, "scale", StringComparison.OrdinalIgnoreCase)) hasScale = true;
            if (!string.Equals(name, "size", StringComparison.OrdinalIgnoreCase)) continue;
            if (value is JsonValue v && v.TryGetValue<string>(out var s)) legacySize = s;
            obj.Remove(name);
        }
        if (!hasScale && legacySize is not null) obj["scale"] = CatSettings.ScaleForLegacySize(legacySize);

        return obj.Deserialize<CatSettings>(PlainOptions(options)) ?? throw new JsonException("CatSettings could not be read.");
    }

    public override void Write(Utf8JsonWriter writer, CatSettings value, JsonSerializerOptions options)
        => JsonSerializer.Serialize(writer, value, PlainOptions(options));

    private static JsonSerializerOptions PlainOptions(JsonSerializerOptions options)
        => Plain.GetValue(options, static o =>
        {
            var copy = new JsonSerializerOptions(o);
            for (var i = copy.Converters.Count - 1; i >= 0; i--)
            {
                if (copy.Converters[i] is CatSettingsJsonConverter) copy.Converters.RemoveAt(i);
            }
            return copy;
        });
}

public static class CatLayoutModes
{
    public const string Cat = "cat";
    public const string Menu = "menu";
    public const string Panel = "panel";

    public static bool IsValid(string? mode) => mode is Cat or Menu or Panel;
}

/// <summary>The window corner that holds the cat box: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'.</summary>
public static class CatAnchors
{
    public const string TopLeft = "top-left";
    public const string TopRight = "top-right";
    public const string BottomLeft = "bottom-left";
    public const string BottomRight = "bottom-right";

    public static bool IsRight(string anchor) => anchor.EndsWith("right", StringComparison.Ordinal);

    public static bool IsBottom(string anchor) => anchor.StartsWith("bottom", StringComparison.Ordinal);

    public static string From(bool bottom, bool right) => (bottom ? "bottom-" : "top-") + (right ? "right" : "left");
}

public static class CatFacings
{
    public const string Left = "left";
    public const string Right = "right";
}

/// <summary>Reasons of the cat.walkEnded event.</summary>
public static class CatWalkEndReasons
{
    public const string Arrived = "arrived";
    public const string Stopped = "stopped";
    public const string Replaced = "replaced";
    public const string Dragged = "dragged";
    public const string Hidden = "hidden";
    public const string Layout = "layout";
    public const string Blocked = "blocked";
}

/// <summary>Contract Rect. Physical px for monitor bounds/work areas, CSS px for the cat box inside the window.</summary>
public sealed record Rect(int X, int Y, int Width, int Height)
{
    public static Rect From(Rectangle r) => new(r.X, r.Y, r.Width, r.Height);
}

public sealed record MonitorInfo
{
    /// <summary>Device name, e.g. \\.\DISPLAY1.</summary>
    public string Id { get; init; } = "";
    public bool Primary { get; init; }
    public Rect Bounds { get; init; } = new(0, 0, 0, 0);
    public Rect WorkArea { get; init; } = new(0, 0, 0, 0);
    public double Scale { get; init; } = 1.0;
}

/// <summary>DIPs the cat box can move before it touches the work-area edge.</summary>
public sealed record CatRoom(double Left, double Right, double Up, double Down);

public sealed record CatScreenInfo
{
    /// <summary>The monitor holding the centre of the cat box.</summary>
    public MonitorInfo Monitor { get; init; } = new();
    public IReadOnlyList<MonitorInfo> Monitors { get; init; } = Array.Empty<MonitorInfo>();
    public WindowState Window { get; init; } = new();
    /// <summary>The cat box inside the window, CSS px.</summary>
    public Rect Box { get; init; } = new(0, 0, 0, 0);
    public CatRoom Room { get; init; } = new(0, 0, 0, 0);
}

public sealed record CatWalkResult
{
    /// <summary>Distance actually walked, DIPs (0 when blocked).</summary>
    public double Dx { get; init; }
    public double Dy { get; init; }
    public int DurationMs { get; init; }
    public int AccelMs { get; init; }
    /// <summary>'left' | 'right'</summary>
    public string Facing { get; init; } = CatFacings.Right;
}

public sealed record CatLayoutResult
{
    /// <summary>'cat' | 'menu' | 'panel'</summary>
    public string Mode { get; init; } = CatLayoutModes.Cat;
    public string Anchor { get; init; } = CatAnchors.BottomRight;
    /// <summary>Window size, CSS px.</summary>
    public int Width { get; init; }
    public int Height { get; init; }
    /// <summary>The cat box inside the window, CSS px.</summary>
    public Rect Box { get; init; } = new(0, 0, 0, 0);
}

/// <summary>Data of cat.walkEnded (x/y = window top-left, physical px).</summary>
public sealed record CatWalkEnded(string Reason, int X, int Y);

/// <summary>Data of cat.dragEnded (x/y = window top-left, physical px; distance in DIPs).</summary>
public sealed record CatDragEnded(int X, int Y, string Monitor, bool Moved, double Distance);

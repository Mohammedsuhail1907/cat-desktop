using System.Text.Json;
using CatDesktop.Host.App;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Database.Repositories;

namespace CatDesktop.Host.Services;

/// <summary>
/// Typed, cached view of the settings table. Reads never touch the database after start-up, which
/// matters because the focus timer thread asks for its settings every tick. Writes go straight through
/// and raise <see cref="Changed"/> so the composition root can broadcast and apply side effects.
/// </summary>
public sealed class SettingsService
{
    private readonly SettingsRepository _repo;
    private readonly Logger _log;
    private readonly object _gate = new();
    private Dictionary<string, string> _cache;

    public SettingsService(SettingsRepository repo, Logger log)
    {
        _repo = repo;
        _log = log;
        _cache = repo.GetAllJson();
        // The backup importer writes rows directly through the repository; refresh when it tells us.
        _repo.Imported += Reload;
    }

    /// <summary>
    /// key, normalised value. JSON strings/booleans/numbers/null arrive as string/bool/double/null; objects and
    /// arrays as a <see cref="JsonElement"/>; CLR values passed to <see cref="Set"/> arrive unchanged.
    /// </summary>
    public event Action<string, object?>? Changed;

    /// <summary>Deserialises the stored JSON, or returns <paramref name="fallback"/> when the key is missing or unreadable.</summary>
    public T Get<T>(string key, T fallback)
    {
        string? json;
        lock (_gate)
        {
            if (!_cache.TryGetValue(key, out json)) return fallback;
        }
        try
        {
            var value = JsonSerializer.Deserialize<T>(json, JsonOptions.Default);
            return value is null ? fallback : value;
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException)
        {
            _log.Warn($"Setting '{key}' could not be read as {typeof(T).Name}; using the default. {ex.Message}");
            return fallback;
        }
    }

    /// <summary>The stored value as a JSON element (clone, safe to keep), or null when the key is absent or unreadable.</summary>
    public JsonElement? GetElement(string key)
    {
        string? json;
        lock (_gate)
        {
            if (!_cache.TryGetValue(key, out json)) return null;
        }
        return Parse(key, json);
    }

    /// <summary>Stores <paramref name="value"/> as JSON (a <see cref="JsonElement"/> is written verbatim) and raises <see cref="Changed"/>.</summary>
    public void Set(string key, object? value)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("Setting key is required.", nameof(key));
        var json = value is JsonElement element
            ? (element.ValueKind == JsonValueKind.Undefined ? "null" : element.GetRawText())
            : JsonSerializer.Serialize(value, JsonOptions.Default);

        _repo.SetJson(key, json);
        lock (_gate) _cache[key] = json;
        Changed?.Invoke(key, Normalise(value));
    }

    public void Remove(string key)
    {
        _repo.Remove(key);
        lock (_gate) _cache.Remove(key);
        Changed?.Invoke(key, null);
    }

    /// <summary>Every setting as a parsed JSON element (clones; the caller may keep them).</summary>
    public IReadOnlyDictionary<string, JsonElement> GetAll()
    {
        KeyValuePair<string, string>[] snapshot;
        lock (_gate) snapshot = _cache.ToArray();

        var result = new Dictionary<string, JsonElement>(snapshot.Length, StringComparer.Ordinal);
        foreach (var (key, json) in snapshot)
        {
            var element = Parse(key, json);
            if (element.HasValue) result[key] = element.Value;
        }
        return result;
    }

    /// <summary>
    /// Re-reads the table and raises <see cref="Changed"/> for every key whose JSON differs from the cache
    /// (added, changed, or removed -> null). Used after a backup import wrote settings behind the cache; this is
    /// the only source of the import's settings.changed broadcasts (the composition root's Changed handler sends them).
    /// </summary>
    public void Reload()
    {
        var fresh = _repo.GetAllJson();
        var changes = new List<(string Key, string? Json)>();
        lock (_gate)
        {
            foreach (var (key, json) in fresh)
            {
                if (!_cache.TryGetValue(key, out var old) || !string.Equals(old, json, StringComparison.Ordinal))
                    changes.Add((key, json));
            }
            foreach (var key in _cache.Keys)
            {
                if (!fresh.ContainsKey(key)) changes.Add((key, null));
            }
            _cache = fresh;
        }

        foreach (var (key, json) in changes)
        {
            var element = json is null ? null : Parse(key, json);
            var value = element.HasValue ? Normalise(element.Value) : null;
            // Each subscriber on its own: one failing side effect (e.g. applying cat settings) must not cost the
            // other subscribers, such as the settings.changed broadcast, this key or any of the remaining keys.
            foreach (var handler in Changed?.GetInvocationList() ?? Array.Empty<Delegate>())
            {
                try
                {
                    ((Action<string, object?>)handler)(key, value);
                }
                catch (Exception ex)
                {
                    _log.Warn($"Setting '{key}' was reloaded, but a change handler failed: {ex.Message}");
                }
            }
        }
    }

    private JsonElement? Parse(string key, string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            _log.Warn($"Setting '{key}' holds invalid JSON and is ignored: {ex.Message}");
            return null;
        }
    }

    private static object? Normalise(object? value) => value is JsonElement element ? Normalise(element) : value;

    private static object? Normalise(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number => element.GetDouble(),
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        _ => element.Clone(),
    };
}

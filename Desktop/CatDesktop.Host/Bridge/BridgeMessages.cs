using System.Text.Json;
using System.Text.Json.Serialization;

namespace CatDesktop.Host.Bridge;

/// <summary>Angular → host request envelope (see docs/DESKTOP-CONTRACT.md §2).</summary>
public sealed class BridgeRequest
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("command")] public string Command { get; set; } = "";
    [JsonPropertyName("payload")] public JsonElement Payload { get; set; }
}

/// <summary>Host → Angular response envelope.</summary>
public sealed class BridgeResponse
{
    [JsonPropertyName("kind")] public string Kind { get; init; } = "response";
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("ok")] public bool Ok { get; init; }
    [JsonPropertyName("result")] public object? Result { get; init; }
    [JsonPropertyName("error")] public BridgeError? Error { get; init; }

    public static BridgeResponse Success(string id, object? result) => new() { Id = id, Ok = true, Result = result ?? new { } };
    public static BridgeResponse Failure(string id, string code, string message) => new() { Id = id, Ok = false, Error = new BridgeError(code, message) };
}

/// <summary>Host → Angular unsolicited event envelope.</summary>
public sealed class BridgeEvent
{
    [JsonPropertyName("kind")] public string Kind { get; init; } = "event";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("data")] public object? Data { get; init; }
}

public sealed record BridgeError(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message);

/// <summary>Well-known error codes. Anything else is mapped to <see cref="Internal"/>.</summary>
public static class BridgeErrorCodes
{
    public const string Validation = "validation";
    public const string NotFound = "not_found";
    public const string Unsupported = "unsupported";
    public const string Denied = "denied";
    public const string Internal = "internal";
}

/// <summary>Throw from a command handler to return a well-formed error to Angular.</summary>
public sealed class BridgeException : Exception
{
    public string Code { get; }

    public BridgeException(string code, string message) : base(message) => Code = code;

    public static BridgeException Validation(string message) => new(BridgeErrorCodes.Validation, message);
    public static BridgeException NotFound(string message) => new(BridgeErrorCodes.NotFound, message);
    public static BridgeException Denied(string message) => new(BridgeErrorCodes.Denied, message);
    public static BridgeException Unsupported(string message) => new(BridgeErrorCodes.Unsupported, message);
}

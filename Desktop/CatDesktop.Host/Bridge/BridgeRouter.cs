using System.Text.Json;
using CatDesktop.Host.App;

namespace CatDesktop.Host.Bridge;

/// <summary>
/// Central dispatcher for Angular → host commands. Handlers register by command name; the router
/// validates the envelope, invokes the handler on the UI thread and returns a well-formed response.
/// Only registered commands exist – there is no reflection or dynamic invocation.
/// </summary>
public sealed class BridgeRouter
{
    public delegate Task<object?> AsyncHandler(BridgeContext context, JsonElement payload);

    private readonly Dictionary<string, AsyncHandler> _handlers = new(StringComparer.Ordinal);
    private readonly Logger _log;

    public BridgeRouter(Logger log)
    {
        _log = log;
    }

    public IReadOnlyCollection<string> Commands => _handlers.Keys;

    public void Register(string command, AsyncHandler handler)
    {
        if (string.IsNullOrWhiteSpace(command)) throw new ArgumentException("Command name required", nameof(command));
        if (!_handlers.TryAdd(command, handler))
            throw new InvalidOperationException($"Bridge command '{command}' is registered twice.");
    }

    /// <summary>Synchronous convenience overload.</summary>
    public void Register(string command, Func<BridgeContext, JsonElement, object?> handler)
        => Register(command, (ctx, payload) => Task.FromResult(handler(ctx, payload)));

    /// <summary>Handler that ignores the payload.</summary>
    public void Register(string command, Func<BridgeContext, object?> handler)
        => Register(command, (ctx, _) => Task.FromResult(handler(ctx)));

    /// <summary>
    /// Parse and execute one raw message. <paramref name="respond"/> receives the serialised response envelope.
    /// Never throws – every failure becomes an error response (or is logged when there is no request id).
    /// </summary>
    public async Task DispatchAsync(string rawMessage, BridgeContext context, Action<string> respond)
    {
        BridgeRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<BridgeRequest>(rawMessage, JsonOptions.Default);
        }
        catch (JsonException ex)
        {
            _log.Warn($"Bridge: unparseable message from {context.Kind}: {ex.Message}");
            return;
        }

        if (request is null || string.IsNullOrEmpty(request.Id))
        {
            _log.Warn($"Bridge: message without id from {context.Kind} ignored.");
            return;
        }

        if (request.Kind != "request")
        {
            respond(Serialize(BridgeResponse.Failure(request.Id, BridgeErrorCodes.Unsupported, $"Unsupported message kind '{request.Kind}'.")));
            return;
        }

        if (!_handlers.TryGetValue(request.Command, out var handler))
        {
            _log.Warn($"Bridge: unknown command '{request.Command}' from {context.Kind}.");
            respond(Serialize(BridgeResponse.Failure(request.Id, BridgeErrorCodes.Unsupported, $"Unknown command '{request.Command}'.")));
            return;
        }

        _log.Trace($"Bridge ← {context.Kind} {request.Command}");
        try
        {
            var result = await handler(context, request.Payload).ConfigureAwait(true);
            respond(Serialize(BridgeResponse.Success(request.Id, result)));
        }
        catch (BridgeException ex)
        {
            _log.Trace($"Bridge {request.Command} → {ex.Code}: {ex.Message}");
            respond(Serialize(BridgeResponse.Failure(request.Id, ex.Code, ex.Message)));
        }
        catch (Exception ex)
        {
            _log.Error($"Bridge: '{request.Command}' failed", ex);
            respond(Serialize(BridgeResponse.Failure(request.Id, BridgeErrorCodes.Internal, "The desktop host hit an unexpected error. See the log for details.")));
        }
    }

    private static string Serialize(BridgeResponse response) => JsonSerializer.Serialize(response, JsonOptions.Default);
}

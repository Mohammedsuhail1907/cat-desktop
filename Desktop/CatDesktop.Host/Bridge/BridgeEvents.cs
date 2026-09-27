using System.Text.Json;
using CatDesktop.Host.App;
using CatDesktop.Host.Windows;

namespace CatDesktop.Host.Bridge;

/// <summary>
/// Host → Angular event fan-out. Windows register on creation; events are marshalled to each
/// window's UI thread by <see cref="WebView.WebViewHost.PostEvent"/>, so this class may be called from any thread.
/// </summary>
public sealed class BridgeEvents
{
    private readonly List<IBridgeWindow> _windows = new();
    private readonly object _gate = new();
    private readonly Logger _log;

    public BridgeEvents(Logger log)
    {
        _log = log;
    }

    public void Register(IBridgeWindow window)
    {
        lock (_gate)
        {
            if (!_windows.Contains(window)) _windows.Add(window);
        }
    }

    public void Unregister(IBridgeWindow window)
    {
        lock (_gate) _windows.Remove(window);
    }

    /// <summary>Send to every open window.</summary>
    public void Broadcast(string name, object? data = null)
    {
        var json = Serialize(name, data);
        foreach (var window in Snapshot())
        {
            window.WebView.PostEventJson(json);
        }
    }

    /// <summary>Send to windows of one kind only (e.g. the cat window).</summary>
    public void Send(WindowKind kind, string name, object? data = null)
    {
        var json = Serialize(name, data);
        foreach (var window in Snapshot())
        {
            if (window.Kind == kind) window.WebView.PostEventJson(json);
        }
    }

    private IBridgeWindow[] Snapshot()
    {
        lock (_gate) return _windows.ToArray();
    }

    private string Serialize(string name, object? data)
    {
        _log.Trace($"Bridge → event {name}");
        return JsonSerializer.Serialize(new BridgeEvent { Name = name, Data = data ?? new { } }, JsonOptions.Default);
    }
}

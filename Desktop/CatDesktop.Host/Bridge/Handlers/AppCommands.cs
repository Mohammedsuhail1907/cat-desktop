using System.Diagnostics;
using System.Text.Json;
using CatDesktop.Host.App;
using CatDesktop.Host.Models;
using CatDesktop.Host.Services;
using CatDesktop.Host.WebView;
using CatDesktop.Host.Windows;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>Contract section 3 app.* commands.</summary>
public sealed class AppCommands
{
    private const int MaxTitleLength = 200;
    private const int MaxBodyLength = 1000;
    private const int MaxUrlLength = 2048;

    private readonly HostConfig _config;
    private readonly AppPaths _paths;
    private readonly NotificationService _notifications;
    private readonly Action _exit;
    private readonly string _startedAt = Timestamps.NowIso();

    public AppCommands(HostConfig config, AppPaths paths, NotificationService notifications, Action exit)
    {
        _config = config;
        _paths = paths;
        _notifications = notifications;
        _exit = exit;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("app.getInfo", GetInfo);
        router.Register("app.openExternal", (_, payload) => OpenExternal(payload));
        router.Register("app.showNotification", (_, payload) => ShowNotification(payload));
        router.Register("app.openDataFolder", _ => OpenDataFolder());
        router.Register("app.exit", Exit);
    }

    private object? GetInfo(BridgeContext ctx) => new AppInfo
    {
        Version = _config.Version,
        WindowKind = ctx.Kind.ToWireName(),
        DevMode = _config.IsDevMode,
        DataDirectory = _paths.RootDataDir,
        DatabasePath = _paths.DatabasePath,
        Platform = "windows",
        StartedAt = _startedAt,
    };

    private static object? OpenExternal(JsonElement payload)
    {
        var url = Payload.RequireString(payload, "url", MaxUrlLength).Trim();
        if (!AppUrls.IsExternalHttp(url))
        {
            throw BridgeException.Denied("Only http(s) links can be opened in the browser.");
        }
        WebViewHost.OpenExternal(url);
        return new { };
    }

    private object? ShowNotification(JsonElement payload)
    {
        var title = Payload.RequireString(payload, "title", MaxTitleLength).Trim();
        var body = (Payload.OptionalString(payload, "body", MaxBodyLength) ?? "").Trim();
        var silent = Payload.OptionalBool(payload, "silent") ?? false;
        _notifications.Show(title, body, silent);
        return new { };
    }

    private object? OpenDataFolder()
    {
        Directory.CreateDirectory(_paths.RootDataDir);
        using var process = Process.Start(new ProcessStartInfo("explorer.exe", $"\"{_paths.RootDataDir}\"") { UseShellExecute = false });
        return new { };
    }

    private object? Exit(BridgeContext ctx)
    {
        // Queue the shutdown so the response envelope reaches the UI before the windows are torn down.
        ctx.Window.Form.BeginInvoke(_exit);
        return new { };
    }
}

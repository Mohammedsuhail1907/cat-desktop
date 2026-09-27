using System.Text.Json;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>Contract section 3 navigation.* commands.</summary>
public sealed class NavigationCommands
{
    private const int MaxRouteLength = 200;

    private readonly MainWindow.MainWindow _mainWindow;

    /// <param name="events">
    /// Accepted for the composition root's signature; the navigation event is targeted at the main window
    /// alone, so the window posts it on its own WebView rather than through the broadcaster.
    /// </param>
    public NavigationCommands(MainWindow.MainWindow mainWindow, BridgeEvents events)
    {
        _mainWindow = mainWindow;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("navigation.navigate", (_, payload) => Navigate(payload));
    }

    private object? Navigate(JsonElement payload)
    {
        var route = Payload.RequireString(payload, "route", MaxRouteLength);
        if (!route.StartsWith('/') || route.StartsWith("//", StringComparison.Ordinal)
            || route.Contains("://", StringComparison.Ordinal) || route.Any(char.IsWhiteSpace))
        {
            throw BridgeException.Validation("'route' must be an in-app route such as '/notes'.");
        }

        _mainWindow.NavigateTo(route);
        return new { };
    }
}

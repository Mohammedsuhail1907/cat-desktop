using CatDesktop.Host.App;

namespace CatDesktop.Host.WebView;

/// <summary>Where the Angular UI lives and how routes are addressed (hash routing).</summary>
public static class AppUrls
{
    /// <summary>Virtual host name mapped onto the wwwroot folder in production.</summary>
    public const string VirtualHost = "app.catdesktop.local";

    public const string ProductionOrigin = "https://" + VirtualHost;

    public static string Origin(HostConfig config) => config.DevUrl ?? ProductionOrigin;

    /// <summary>Builds the full URL for an Angular route, e.g. "/cat".</summary>
    public static string Build(HostConfig config, string route)
    {
        if (string.IsNullOrEmpty(route)) route = "/";
        if (!route.StartsWith('/')) route = "/" + route;
        return config.IsDevMode
            ? $"{config.DevUrl}/#{route}"
            : $"{ProductionOrigin}/index.html#{route}";
    }

    public static bool IsAppOrigin(HostConfig config, string? uri)
    {
        if (string.IsNullOrEmpty(uri)) return false;
        var origin = Origin(config);
        return uri.StartsWith(origin + "/", StringComparison.OrdinalIgnoreCase)
               || string.Equals(uri, origin, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Production only. Angular's hash location shows the app as "https://app.catdesktop.local/#/route" (without
    /// index.html), but the virtual host serves files, not a directory index, so loading that address again (a reload)
    /// fails. Returns the index.html URL with the same route for such an address, otherwise null.
    /// </summary>
    public static string? IndexUrlForRoot(HostConfig config, string? uri)
    {
        if (config.IsDevMode || !Uri.TryCreate(uri, UriKind.Absolute, out var u)) return null;
        if (!string.Equals(u.Host, VirtualHost, StringComparison.OrdinalIgnoreCase) || u.AbsolutePath != "/") return null;
        return $"{ProductionOrigin}/index.html{u.Query}{u.Fragment}";
    }

    public static bool IsExternalHttp(string? uri)
        => Uri.TryCreate(uri, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps);
}

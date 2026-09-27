using System.Reflection;

namespace CatDesktop.Host.App;

/// <summary>
/// Runtime configuration resolved from command line / environment. Immutable after start.
///
/// Precedence for the UI source:
///   1. --dev-url &lt;url&gt;            explicit Angular dev server
///   2. --dev                        shorthand for --dev-url http://127.0.0.1:4280
///   3. CATDESKTOP_DEV_URL env var
///   4. (Debug builds only) when no wwwroot/index.html exists, fall back to http://127.0.0.1:4280
///   5. otherwise the production build served from wwwroot through the virtual host.
/// </summary>
public sealed class HostConfig
{
    /// <summary>CatDesktop's own dev-server address (angular.json serve options), not 4200, so another Angular project cannot answer instead.</summary>
    public const string DefaultDevUrl = "http://127.0.0.1:4280";

    /// <summary>Angular dev server URL, or null when serving the packaged production build.</summary>
    public string? DevUrl { get; private init; }

    /// <summary>True when the UI comes from a dev server.</summary>
    public bool IsDevMode => DevUrl is not null;

    /// <summary>DevTools / context menus. Only honoured in dev mode or with --devtools.</summary>
    public bool DevToolsEnabled { get; private init; }

    /// <summary>Trace-level logging (every bridge command/event). On in dev mode, or with --verbose / CATDESKTOP_VERBOSE=1.</summary>
    public bool Verbose { get; private init; }

    /// <summary>Start hidden in the tray (used by the "start with Windows" shortcut).</summary>
    public bool StartHidden { get; private init; }

    /// <summary>
    /// Command-line switch added when the app relaunches itself after its WebView2 browser process died. The new
    /// instance waits for the old one to exit instead of activating it.
    /// </summary>
    public const string RestartArgument = "--restart";

    /// <summary>This process was started by an automatic restart (<see cref="RestartArgument"/>).</summary>
    public bool IsRestart { get; private init; }

    /// <summary>The command-line arguments as received (a restart passes them on).</summary>
    public IReadOnlyList<string> Arguments { get; private init; } = Array.Empty<string>();

    public string Version { get; private init; } = "1.0.0";

    public static HostConfig FromArguments(string[] args)
    {
        string? devUrl = null;
        bool devTools = false;
        bool startHidden = false;
        bool verbose = false;
        bool restart = false;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i].ToLowerInvariant())
            {
                case "--dev-url" when i + 1 < args.Length:
                    devUrl = args[++i];
                    break;
                case "--dev":
                    devUrl ??= DefaultDevUrl;
                    break;
                case "--devtools":
                    devTools = true;
                    break;
                case "--verbose":
                    verbose = true;
                    break;
                case "--hidden":
                case "--minimized":
                    startHidden = true;
                    break;
                case RestartArgument:
                    restart = true;
                    break;
            }
        }

        devUrl ??= Environment.GetEnvironmentVariable("CATDESKTOP_DEV_URL");
        if (string.IsNullOrWhiteSpace(devUrl)) devUrl = null;

#if DEBUG
        if (devUrl is null && !File.Exists(Path.Combine(AppContext.BaseDirectory, "wwwroot", "index.html")))
        {
            devUrl = DefaultDevUrl;
        }
#endif

        if (devUrl is not null)
        {
            devUrl = devUrl.TrimEnd('/');
            if (!Uri.TryCreate(devUrl, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https"))
            {
                throw new ArgumentException($"Invalid dev URL '{devUrl}'. Expected http(s)://host:port");
            }
        }

        var version = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                      ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString(3)
                      ?? "1.0.0";
        var plus = version.IndexOf('+');
        if (plus > 0) version = version[..plus];

        return new HostConfig
        {
            DevUrl = devUrl,
            DevToolsEnabled = devTools || devUrl is not null,
            StartHidden = startHidden,
            IsRestart = restart,
            Arguments = args.ToArray(),
            Verbose =verbose || devUrl is not null || Environment.GetEnvironmentVariable("CATDESKTOP_VERBOSE") == "1",
            Version = version,
        };
    }
}

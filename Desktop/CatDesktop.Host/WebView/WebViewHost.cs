using System.Diagnostics;
using System.Net;
using System.Text.Json;
using CatDesktop.Host.App;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CatDesktop.Host.WebView;

/// <summary>
/// Where a <see cref="WebViewHost"/> gets its CoreWebView2 from: the WinForms WebView2 control (windowed hosting, main
/// window) or a composition controller that renders into a DirectComposition visual (the cat window).
/// </summary>
public interface IWebViewHosting
{
    /// <summary>The control whose UI thread owns the WebView: used for Invoke/BeginInvoke, handle and disposal checks.</summary>
    Control Control { get; }

    /// <summary>Creates the WebView in this hosting mode (once) and returns its CoreWebView2.</summary>
    Task<CoreWebView2> CreateCoreWebView2Async(CoreWebView2Environment environment);
}

/// <summary>Windowed hosting through the WinForms <see cref="WebView2"/> control.</summary>
public sealed class WindowedWebViewHosting : IWebViewHosting
{
    private readonly WebView2 _control;

    public WindowedWebViewHosting(WebView2 control)
    {
        _control = control;
    }

    public Control Control => _control;

    public async Task<CoreWebView2> CreateCoreWebView2Async(CoreWebView2Environment environment)
    {
        await _control.EnsureCoreWebView2Async(environment);
        return _control.CoreWebView2 ?? throw new InvalidOperationException("CoreWebView2 failed to initialise.");
    }
}

/// <summary>
/// Owns one WebView (hosted through an <see cref="IWebViewHosting"/>): environment creation (shared per process), hardened
/// settings, virtual-host mapping for the production build, init-script injection, navigation guards and
/// the bridge plumbing (web messages in, JSON events/responses out).
/// </summary>
public sealed class WebViewHost
{
    private static Task<CoreWebView2Environment>? _sharedEnvironment;
    private static readonly object EnvGate = new();

    private readonly IWebViewHosting _hosting;
    /// <summary>Owner of the UI thread (the WebView2 control, or the cat form itself in composition hosting).</summary>
    private readonly Control _control;
    private readonly IBridgeWindow _owner;
    private readonly HostConfig _config;
    private readonly AppPaths _paths;
    private readonly BridgeRouter _router;
    private readonly Logger _log;
    private readonly Queue<string> _queuedEvents = new();
    /// <summary>
    /// True while events can be posted directly: the current document has sent a web message (its bridge listener
    /// exists) and no app navigation that may replace it is in flight. Otherwise events are queued; every new document
    /// (initial load, reload, recovery after a renderer crash) starts queuing again. See <see cref="UpdateReadiness"/>.
    /// </summary>
    private volatile bool _ready;
    /// <summary>The current document has sent at least one web message (reset when a new document starts loading).</summary>
    private bool _documentSpoke;
    /// <summary>
    /// An allowed app navigation is in flight (NavigationStarting until ContentLoading or NavigationCompleted). The current
    /// document is about to be replaced, so an event posted to it now would be lost with it: events queue for the next one.
    /// </summary>
    private bool _navigating;
    /// <summary>Id of that navigation; null while the replacement for a cancelled reload (see OnNavigationStarting) has not started.</summary>
    private ulong? _navigationId;
    /// <summary>Set after the browser process died: the CoreWebView2 is closed for good and must not be touched.</summary>
    private volatile bool _browserExited;
    /// <summary>Lets the navigation guard pass the host's own "dev server not reachable" page (a data: URL) once.</summary>
    private bool _devErrorPagePending;
    /// <summary>Navigation id of that page, so its own completion is never mistaken for (or retried as) the app.</summary>
    private ulong? _devErrorPageNavigationId;
    /// <summary>The app URL most recently requested; the dev error page's Retry goes back there.</summary>
    private string? _lastAppUrl;

    public WebViewHost(WebView2 control, IBridgeWindow owner, HostConfig config, AppPaths paths, BridgeRouter router, Logger log)
        : this(new WindowedWebViewHosting(control), owner, config, paths, router, log)
    {
    }

    public WebViewHost(IWebViewHosting hosting, IBridgeWindow owner, HostConfig config, AppPaths paths, BridgeRouter router, Logger log)
    {
        _hosting = hosting;
        _control = hosting.Control;
        _owner = owner;
        _config = config;
        _paths = paths;
        _router = router;
        _log = log;
    }

    public Control Control => _control;
    public CoreWebView2? Core { get; private set; }
    public bool IsReady => _ready;

    /// <summary>
    /// Raised on the UI thread each time the window becomes ready for events – a newly loaded app document sent its first
    /// bridge message, or a navigation ended without replacing the document – right after the queued events were delivered.
    /// </summary>
    public event Action? Ready;

    /// <summary>Raised on the UI thread after each successful navigation of the app (document loaded).</summary>
    public event Action? NavigationCompleted;

    /// <summary>
    /// Raised on the UI thread when the WebView2 browser process ended unexpectedly. The WebView is closed for good and
    /// cannot recover on its own; the owner decides how to recover (the composition root restarts the application).
    /// </summary>
    public event Action? BrowserProcessExited;

    public static Task<CoreWebView2Environment> GetEnvironmentAsync(AppPaths paths, HostConfig config)
    {
        lock (EnvGate)
        {
            if (_sharedEnvironment is not null) return _sharedEnvironment;

            // Sounds from the focus timer / the cat must not require a user gesture.
            var browserArguments = "--autoplay-policy=no-user-gesture-required";
#if DEBUG
            // Automated end-to-end tests (tests/e2e) drive the UI over the Chrome DevTools Protocol.
            // Compiled into Debug builds only, bound to 127.0.0.1, and only when explicitly requested.
            var cdpPort = Environment.GetEnvironmentVariable("CATDESKTOP_CDP_PORT");
            if (int.TryParse(cdpPort, out var port) && port is > 1024 and < 65536)
            {
                browserArguments += $" --remote-debugging-address=127.0.0.1 --remote-debugging-port={port}";
            }
#endif
            var options = new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = browserArguments,
                AllowSingleSignOnUsingOSPrimaryAccount = false,
                ExclusiveUserDataFolderAccess = true,
            };
            _sharedEnvironment = CoreWebView2Environment.CreateAsync(null, paths.WebView2UserDataDir, options);
            return _sharedEnvironment;
        }
    }

    public async Task InitializeAsync(string route)
    {
        var environment = await GetEnvironmentAsync(_paths, _config);
        var core = await _hosting.CreateCoreWebView2Async(environment);
        Core = core;
        ApplySecuritySettings(core);

        if (!_config.IsDevMode)
        {
            if (!_paths.HasProductionUi)
            {
                throw new FileNotFoundException(
                    "The user interface files are missing (wwwroot/index.html). Re-install CatDesktop or run the build script.",
                    Path.Combine(_paths.WwwRootDir, "index.html"));
            }
            core.SetVirtualHostNameToFolderMapping(AppUrls.VirtualHost, _paths.WwwRootDir, CoreWebView2HostResourceAccessKind.Deny);
        }

        await core.AddScriptToExecuteOnDocumentCreatedAsync(BuildInitScript());

        core.WebMessageReceived += OnWebMessageReceived;
        core.NavigationStarting += OnNavigationStarting;
        // A new document has no bridge listener yet: queue events until it speaks. Not raised for hash (same-document)
        // navigations, which keep the listener.
        core.ContentLoading += (_, _) =>
        {
            _documentSpoke = false;
            _navigating = false;
            UpdateReadiness();
        };
        core.NewWindowRequested += OnNewWindowRequested;
        core.NavigationCompleted += OnNavigationCompleted;
        core.ProcessFailed += OnProcessFailed;
        core.DocumentTitleChanged += (_, _) => _log.Trace($"[{_owner.Kind}] title: {core.DocumentTitle}");

        var url = AppUrls.Build(_config, route);
        _log.Info($"[{_owner.Kind}] navigating to {url}");
        _lastAppUrl = url;
        core.Navigate(url);
        // Events stay queued until the page's first web message (OnWebMessageReceived): posting them now would reach
        // the document before Angular has subscribed, and they would be lost.
    }

    public void Navigate(string route)
    {
        if (Core is null) return;
        _lastAppUrl = AppUrls.Build(_config, route);
        Core.Navigate(_lastAppUrl);
    }

    public void Reload() => Core?.Reload();

    public void OpenDevTools()
    {
        if (_config.DevToolsEnabled) Core?.OpenDevToolsWindow();
    }

    /// <summary>
    /// Send an already-serialised event envelope. Safe from any thread; queued until the current document is listening
    /// (its first web message).
    /// </summary>
    public void PostEventJson(string json)
    {
        if (_control.IsDisposed || _browserExited) return;
        if (_control.InvokeRequired)
        {
            try { _control.BeginInvoke(new Action(() => PostEventJson(json))); }
            catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException)
            {
                // The window handle was destroyed in the meantime (shutdown): nobody is listening any more.
            }
            return;
        }

        if (!_ready)
        {
            lock (_queuedEvents)
            {
                _queuedEvents.Enqueue(json);
                while (_queuedEvents.Count > 500) _queuedEvents.Dequeue();
            }
            return;
        }

        // Without a window handle InvokeRequired is false on every thread, so this may be a thread-pool caller during
        // shutdown: CoreWebView2 must not be touched then.
        if (!_control.IsHandleCreated) return;

        try { Core?.PostWebMessageAsJson(json); }
        catch (Exception ex) { _log.Warn($"[{_owner.Kind}] PostWebMessageAsJson failed: {ex.Message}"); }
    }

    public void PostEvent(string name, object? data = null)
        => PostEventJson(JsonSerializer.Serialize(new BridgeEvent { Name = name, Data = data ?? new { } }, JsonOptions.Default));

    /// <summary>
    /// Recomputes <see cref="_ready"/> (UI thread). When the window becomes ready, the queued events are delivered in
    /// order – ahead of the response to the message that made it ready.
    /// </summary>
    private void UpdateReadiness()
    {
        var ready = _documentSpoke && !_navigating && !_browserExited;
        if (ready == _ready) return;
        _ready = ready;
        if (!ready) return;
        FlushQueuedEvents();
        Ready?.Invoke();
    }

    private void FlushQueuedEvents()
    {
        string[] pending;
        lock (_queuedEvents)
        {
            pending = _queuedEvents.ToArray();
            _queuedEvents.Clear();
        }
        foreach (var json in pending) PostEventJson(json);
    }

    private void ApplySecuritySettings(CoreWebView2 core)
    {
        var s = core.Settings;
        var dev = _config.DevToolsEnabled;
        s.AreHostObjectsAllowed = false;
        s.IsWebMessageEnabled = true;
        s.IsScriptEnabled = true;
        s.AreDevToolsEnabled = dev;
        s.AreDefaultContextMenusEnabled = dev;
        s.AreDefaultScriptDialogsEnabled = true;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = dev;
        s.IsBuiltInErrorPageEnabled = dev;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsReputationCheckingRequired = false;
        s.UserAgent = $"{s.UserAgent} CatDesktop/{_config.Version}";
    }

    private string BuildInitScript()
    {
        var env = new
        {
            hosted = true,
            windowKind = _owner.Kind.ToWireName(),
            version = _config.Version,
            devMode = _config.IsDevMode,
        };
        var json = JsonSerializer.Serialize(env, JsonOptions.Default);
        // The script runs when the document is created, before <html> exists (documentElement is null), so the root
        // element is tagged as soon as the parser inserts it.
        return $$"""
            (function () {
              Object.defineProperty(window, '__catdesktop', { value: Object.freeze({{json}}), writable: false, configurable: false });
              window.addEventListener('dragover', function (e) { e.preventDefault(); });
              window.addEventListener('drop', function (e) { e.preventDefault(); });
              var tagRoot = function () {
                var root = document.documentElement;
                if (!root) return false;
                root.classList.add('catdesktop-hosted', 'catdesktop-{{_owner.Kind.ToWireName()}}');
                return true;
              };
              if (!tagRoot()) {
                var observer = new MutationObserver(function () { if (tagRoot()) observer.disconnect(); });
                observer.observe(document, { childList: true });
              }
            })();
            """;
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!AppUrls.IsAppOrigin(_config, e.Source))
        {
            _log.Warn($"[{_owner.Kind}] dropped web message from unexpected origin '{e.Source}'.");
            return;
        }

        if (!_documentSpoke)
        {
            // The first message of a new document: the Angular bridge registers its listener (and the core services
            // subscribe) before it sends anything, so the queued events can be delivered now, ahead of the response.
            // (While a navigation is in flight the sender is the outgoing document; delivery then waits for the outcome.)
            _documentSpoke = true;
            UpdateReadiness();
        }

        string raw;
        try
        {
            raw = e.TryGetWebMessageAsString();
        }
        catch (Exception)
        {
            // Angular always posts a JSON string; anything else (objects, arrays) is not part of the contract.
            _log.Warn($"[{_owner.Kind}] dropped non-string web message.");
            return;
        }

        var context = new BridgeContext(_owner);
        _ = _router.DispatchAsync(raw, context, json =>
        {
            try { Core?.PostWebMessageAsJson(json); }
            catch (Exception ex) { _log.Warn($"[{_owner.Kind}] failed to post response: {ex.Message}"); }
        });
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        // The pass for the dev error page covers exactly the navigation that follows its NavigateToString call.
        var devErrorPage = _devErrorPagePending;
        _devErrorPagePending = false;

        if (AppUrls.IsAppOrigin(_config, e.Uri))
        {
            _log.Trace($"[{_owner.Kind}] navigation {e.NavigationId} starting: {e.Uri}");
            // The current document may be on its way out: from now on events queue for the next one (contract §2).
            _navigating = true;
            _navigationId = e.NavigationId;
            // A reload of the address Angular shows (".../#/route", no index.html) would fail on the virtual host: this
            // affects the renderer-crash recovery below and any location.reload(). Load index.html with the same route.
            if (IsReload(e) && AppUrls.IndexUrlForRoot(_config, e.Uri) is { } indexUrl)
            {
                e.Cancel = true;
                _navigationId = null; // the replacement navigation below reports its own id
                try { _control.BeginInvoke(new Action(() => Core?.Navigate(indexUrl))); }
                catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException) { }
            }
            UpdateReadiness();
            return;
        }
        if (devErrorPage && (e.Uri.StartsWith("data:text/html", StringComparison.OrdinalIgnoreCase)
                             || string.Equals(e.Uri, "about:blank", StringComparison.OrdinalIgnoreCase)))
        {
            // The host's own NavigateToString page (dev mode only), requested in OnNavigationCompleted.
            _devErrorPageNavigationId = e.NavigationId;
            return;
        }

        e.Cancel = true;
        _log.Info($"[{_owner.Kind}] blocked navigation to '{e.Uri}'.");
        if (AppUrls.IsExternalHttp(e.Uri)) OpenExternal(e.Uri);
    }

    private static bool IsReload(CoreWebView2NavigationStartingEventArgs e)
    {
        try { return e.NavigationKind == CoreWebView2NavigationKind.Reload; }
        catch (Exception) { return false; } // runtime older than the NavigationKind API
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (AppUrls.IsExternalHttp(e.Uri)) OpenExternal(e.Uri);
        else _log.Info($"[{_owner.Kind}] ignored new-window request for '{e.Uri}'.");
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        var devErrorPage = e.NavigationId == _devErrorPageNavigationId;
        if (_navigating && e.NavigationId == _navigationId)
        {
            // Finished without creating a new document (cancelled, failed before commit, or same-document): the current
            // document stays and gets the events queued meanwhile. After a ContentLoading, _navigating is already false.
            _navigating = false;
            _log.Trace($"[{_owner.Kind}] navigation {e.NavigationId} ended without a new document ({e.WebErrorStatus}).");
            UpdateReadiness();
        }
        if (!e.IsSuccess)
        {
            // Cancelled by OnNavigationStarting (or superseded by a newer navigation): the current page stays, nothing failed.
            // Treating it as a failure would also loop in dev mode, because the guard cancels the error page itself.
            if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;

            _log.Warn($"[{_owner.Kind}] navigation failed: {e.WebErrorStatus}");
            // Never answer a failure of the error page itself with the error page again (that would loop).
            if (_config.IsDevMode && !devErrorPage)
            {
                _devErrorPagePending = true;
                Core?.NavigateToString(DevServerUnavailablePage());
            }
            return;
        }
        if (devErrorPage) return; // the host's own page, not the app
        NavigationCompleted?.Invoke();
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        _log.Error($"[{_owner.Kind}] WebView2 process failed: {e.ProcessFailedKind} ({e.Reason}) exit={e.ExitCode}");
        if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
        {
            // The reloaded document has to announce itself again before events are delivered.
            _documentSpoke = false;
            UpdateReadiness();
            try { Core?.Reload(); } catch { /* best effort */ }
        }
        else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            // The WebView is closed for good (every CoreWebView2 call would throw now); only a new one can recover.
            _browserExited = true;
            UpdateReadiness();
            BrowserProcessExited?.Invoke();
        }
    }

    public static void OpenExternal(string url)
    {
        if (!AppUrls.IsExternalHttp(url)) return;
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            // No default browser – nothing sensible to do.
        }
    }

    /// <summary>
    /// Dev mode only. A plain reload (F5) would only reload this page (and the navigation guard cancels that), so Retry
    /// and F5 / Ctrl+R navigate back to the app URL instead, which the guard allows.
    /// </summary>
    private string DevServerUnavailablePage()
    {
        var retryUrl = _lastAppUrl ?? AppUrls.Build(_config, "/");
        var retryHref = WebUtility.HtmlEncode(retryUrl);
        var retryJs = JsonSerializer.Serialize(retryUrl); // default encoder escapes <, > and & for an inline script
        return $$"""
            <!doctype html>
            <html><head><meta charset="utf-8"><title>Dev server not reachable</title></head>
            <body style="font-family:Segoe UI,sans-serif;background:#141414;color:#eee;padding:40px">
            <h2>Angular dev server not reachable</h2>
            <p>CatDesktop is running in development mode and tried to load <code>{{WebUtility.HtmlEncode(_config.DevUrl ?? "")}}</code>.</p>
            <p>Start it with <code>npm start</code> inside <code>cat-desktop/</code>, then click <b>Retry</b> (or press <b>F5</b>).</p>
            <p><a href="{{retryHref}}" style="display:inline-block;padding:8px 20px;border-radius:6px;background:#7c5cff;color:#fff;text-decoration:none">Retry</a></p>
            <script>
              document.addEventListener('keydown', function (e) {
                if (e.key === 'F5' || (e.ctrlKey && (e.key === 'r' || e.key === 'R'))) {
                  e.preventDefault();
                  location.href = {{retryJs}};
                }
              });
            </script>
            </body></html>
            """;
    }
}

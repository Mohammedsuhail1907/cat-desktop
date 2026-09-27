using System.Diagnostics;
using System.Text.Json;
using CatDesktop.Host.Bridge;
using CatDesktop.Host.Bridge.Handlers;
using CatDesktop.Host.Cat;
using CatDesktop.Host.Database;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.MainWindow;
using CatDesktop.Host.Models;
using CatDesktop.Host.Services;
using CatDesktop.Host.Windows;

namespace CatDesktop.Host.App;

/// <summary>
/// Composition root. Creates the database, services, both windows and the tray, registers every bridge
/// command and wires cross-cutting events. Lives for the whole process; disposing it shuts the app down.
///
/// Constructor / member expectations for the classes used here (see docs/DESKTOP-CONTRACT.md):
///   SqliteDatabase(string dbPath, Logger)                 Initialize(); int SchemaVersion; IDisposable
///   *Repository(SqliteDatabase)
///   SettingsService(SettingsRepository, Logger)           T Get&lt;T&gt;(key, fallback); Set(key, value); event Changed(key, value)
///   TrayService(Logger)                                   events OpenRequested / ToggleCatRequested / ToggleWalkingRequested / StartFocusRequested / ExitRequested; SetCatVisible(bool); SetWalkingPaused(bool)
///   NotificationService(TrayService, Logger)              Show(title, body, silent)
///   FocusTimerService(SettingsService, FocusSessionsRepository, BridgeEvents, NotificationService, Logger)
///   HotkeyManager(Logger)                                 event Pressed(name); Apply(Hotkeys); Suspend(bool)
///   StartupService()                                      SetEnabled(bool); IsEnabled()
///   BackupService(SqliteDatabase, NotesRepository, TasksRepository, SettingsRepository, QuickActionsRepository, FocusSessionsRepository, Logger)
///   MainWindow(HostConfig, AppPaths, BridgeRouter, BridgeEvents, SettingsService, WindowStateRepository, Logger)
///   CatWindowService(HostConfig, AppPaths, BridgeRouter, BridgeEvents, SettingsService, WindowStateRepository, Logger)  owns CatWindow
///   *Commands(...).Register(BridgeRouter)
/// </summary>
public sealed class DesktopApplication : ApplicationContext
{
    private readonly HostConfig _config;
    private readonly AppPaths _paths;
    private readonly Logger _log;

    private readonly SqliteDatabase _db;
    private readonly SettingsService _settings;
    private readonly BridgeRouter _router;
    private readonly BridgeEvents _events;
    private readonly TrayService _tray;
    private readonly NotificationService _notifications;
    private readonly FocusTimerService _focusTimer;
    private readonly HotkeyManager _hotkeys;
    private readonly StartupService _startup;
    private readonly MainWindow.MainWindow _mainWindow;
    private readonly CatWindowService _cat;

    /// <summary>A restarted instance whose browser dies again this soon gives up instead of restarting in a loop.</summary>
    private static readonly TimeSpan RestartLoopWindow = TimeSpan.FromSeconds(60);
    private readonly long _startedAtTicks = Environment.TickCount64;

#if DEBUG
    private static readonly bool IsDebugBuild = true;
#else
    private static readonly bool IsDebugBuild = false;
#endif

    private bool _exiting;
    /// <summary>At most one recovery from a browser-process crash per process (both windows report the same crash).</summary>
    private bool _browserCrashHandled;

    public DesktopApplication(HostConfig config, AppPaths paths, Logger log)
    {
        _config = config;
        _paths = paths;
        _log = log;

        // ---- Persistence ---------------------------------------------------------------------
        _db = new SqliteDatabase(paths.DatabasePath, log);
        _db.Initialize();
        var settingsRepo = new SettingsRepository(_db);
        var notesRepo = new NotesRepository(_db);
        var tasksRepo = new TasksRepository(_db);
        var actionsRepo = new QuickActionsRepository(_db);
        var windowStatesRepo = new WindowStateRepository(_db);
        var focusSessionsRepo = new FocusSessionsRepository(_db);
        _settings = new SettingsService(settingsRepo, log);
        // Once, before anything reads the cat settings or listens for setting changes: Pet Book state -> cat state.
        CatLegacyMigration.Run(_settings, windowStatesRepo, log);

        // ---- Bridge --------------------------------------------------------------------------
        _router = new BridgeRouter(log);
        _events = new BridgeEvents(log);

        // ---- Services ------------------------------------------------------------------------
        _tray = new TrayService(log);
        _notifications = new NotificationService(_tray, log);
        _focusTimer = new FocusTimerService(_settings, focusSessionsRepo, _events, _notifications, log);
        _hotkeys = new HotkeyManager(log);
        _startup = new StartupService();
        var backup = new BackupService(_db, notesRepo, tasksRepo, settingsRepo, actionsRepo, focusSessionsRepo, log);

        // ---- Windows -------------------------------------------------------------------------
        _mainWindow = new MainWindow.MainWindow(config, paths, _router, _events, _settings, windowStatesRepo, log);
        _cat = new CatWindowService(config, paths, _router, _events, _settings, windowStatesRepo, log);

        // ---- Bridge command handlers ---------------------------------------------------------
        new AppCommands(config, paths, _notifications, ExitApplication).Register(_router);
        new WindowCommands(log).Register(_router);
        new NavigationCommands(_mainWindow, _events).Register(_router);
        new SettingsCommands(_settings).Register(_router);
        new NotesCommands(notesRepo, _events).Register(_router);
        new TasksCommands(tasksRepo, _events).Register(_router);
        new ActionsCommands(actionsRepo, _events).Register(_router);
        new CatCommands(_cat).Register(_router);
        new FocusCommands(_focusTimer).Register(_router);
        new HotkeysCommands(_hotkeys, _settings).Register(_router);
        new DataCommands(backup, _mainWindow, _events).Register(_router);
        log.Info($"Bridge ready with {_router.Commands.Count} commands.");

        // ---- Cross-cutting wiring ------------------------------------------------------------
        _settings.Changed += OnSettingChanged;
        ReconcileStartWithWindows();

        _tray.OpenRequested += () => _mainWindow.ShowAndActivate();
        _tray.ToggleCatRequested += () => _cat.ToggleCat();
        _tray.ToggleWalkingRequested += () => _cat.SetAutoWalk(!_cat.Settings.AutoWalk);
        _tray.StartFocusRequested += ToggleFocusFromShortcut;
        _tray.ExitRequested += ExitApplication;

        // The service broadcasts cat.visibilityChanged / cat.settingsChanged itself; the tray only mirrors them.
        _cat.VisibilityChanged += visible => _tray.SetCatVisible(visible);
        _cat.SettingsChanged += cat => _tray.SetWalkingPaused(!cat.AutoWalk);
        _tray.SetWalkingPaused(!_cat.Settings.AutoWalk);

        _hotkeys.Pressed += OnHotkeyPressed;
        RegisterStartupHotkeys(_settings.Get(Hotkeys.SettingsKey, Hotkeys.Default));

        _mainWindow.FormClosing += OnMainWindowClosing;
        _mainWindow.ApplyTheme(_settings.Get("app.theme", "system"));
        // Backup for the main window's WM_QUERYENDSESSION handling: a session end always shuts down in order.
        Microsoft.Win32.SystemEvents.SessionEnding += OnSessionEnding;

        _mainWindow.WebView.BrowserProcessExited += OnBrowserProcessExited;
        _cat.Window.WebView.BrowserProcessExited += OnBrowserProcessExited;

        // No MainForm: ApplicationContext would show it in Application.Run, even when starting hidden. Every way the
        // main window closes ends in ExitApplication, which ends the message loop itself.
        Start();
    }

    // ---- Lifecycle --------------------------------------------------------------------------

    private void Start()
    {
        if (_config.StartHidden)
        {
            _log.Info("Starting hidden (tray only).");
        }
        else
        {
            _mainWindow.Show();
        }

        // After the main window, so the cat never comes up first.
        if (_cat.Settings.Enabled && _cat.Settings.StartWithApp)
        {
            _cat.ShowCat();
        }
    }

    /// <summary>
    /// Makes the "app.startWithWindows" setting and the Run registry value agree, once per start. The installer's
    /// "start with Windows" task writes the Run value without the setting: while the setting is absent it is seeded from
    /// the registry; from then on the setting owns it (which also re-points the value at this executable and removes a
    /// value an upgrade re-added after the user turned the option off). Skipped for an isolated data folder (tests, a
    /// second profile), in dev mode and in Debug builds: those must not re-point the real per-user Run value at a test
    /// or development executable just by starting.
    /// </summary>
    private void ReconcileStartWithWindows()
    {
        const string key = "app.startWithWindows";
        if (IsDebugBuild || _paths.IsIsolated || _config.IsDevMode) return;
        try
        {
            var stored = _settings.GetElement(key);
            if (stored is null)
            {
                _settings.Set(key, _startup.IsEnabled()); // OnSettingChanged applies it to the registry
            }
            else
            {
                _startup.SetEnabled(stored.Value.ValueKind == JsonValueKind.True);
            }
        }
        catch (Exception ex)
        {
            _log.Warn($"Could not reconcile the start-with-Windows registration: {ex.Message}");
        }
    }

    /// <summary>
    /// Registers the saved shortcuts. HotkeyManager.Apply is atomic (all or nothing), which is right for the
    /// Settings page but wrong at startup: one shortcut taken by another app must not disable the others.
    /// So on failure fall back to adding the bindings one at a time and keep whatever could be registered.
    /// </summary>
    private void RegisterStartupHotkeys(Hotkeys wanted)
    {
        try
        {
            _hotkeys.Apply(wanted);
            return;
        }
        catch (Exception ex)
        {
            _log.Warn($"Could not register all global hotkeys at once: {ex.Message.TrimEnd('.')}. Trying them individually.");
        }

        var accepted = Hotkeys.None;
        foreach (var (name, gesture) in wanted.Bindings())
        {
            var candidate = accepted.With(name, gesture);
            try
            {
                _hotkeys.Apply(candidate);
                accepted = candidate;
            }
            catch (Exception ex)
            {
                _log.Warn($"Hotkey '{gesture}' ({name}) not registered: {ex.Message}");
            }
        }
    }

    /// <summary>Called (from a background thread) when a second copy of the app was launched.</summary>
    public void ActivateFromOtherInstance()
    {
        if (_mainWindow.IsDisposed) return;
        try
        {
            _mainWindow.BeginInvoke(new Action(() => _mainWindow.ShowAndActivate()));
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { /* no window handle yet (started hidden) – nothing to activate */ }
    }

    private void OnMainWindowClosing(object? sender, FormClosingEventArgs e)
    {
        if (_exiting) return;

        var closeToTray = _settings.Get("app.closeToTray", false);
        if (closeToTray && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            _mainWindow.HideToTray();
            _tray.ShowRunningInTrayHint();
            return;
        }

        e.Cancel = true;
        ExitApplication();
    }

    public void ExitApplication()
    {
        if (_exiting) return;
        _exiting = true;
        _log.Info("Shutting down…");
        Microsoft.Win32.SystemEvents.SessionEnding -= OnSessionEnding;

        try { _mainWindow.SaveState(); } catch (Exception ex) { _log.Warn($"main window state not saved: {ex.Message}"); }
        try { _cat.SaveState(); } catch (Exception ex) { _log.Warn($"cat window state not saved: {ex.Message}"); }

        SafeDispose(_hotkeys);
        SafeDispose(_focusTimer);
        SafeDispose(_tray);

        try { _cat.ForceClose(); } catch { /* ignore */ }
        try { _mainWindow.ForceClose(); } catch { /* ignore */ }

        SafeDispose(_cat);
        SafeDispose(_db);
        ExitThread();
    }

    // ---- Event handlers ---------------------------------------------------------------------

    private void OnSettingChanged(string key, object? value)
    {
        _events.Broadcast("settings.changed", new { key, value });

        switch (key)
        {
            case "app.theme":
                var theme = value as string ?? "system";
                _mainWindow.ApplyTheme(theme);
                _events.Broadcast("app.themeChanged", new { theme });
                break;
            case "app.startWithWindows":
                try { _startup.SetEnabled(value is true); }
                catch (Exception ex) { _log.Warn($"Could not update startup registration: {ex.Message}"); }
                break;
            case Hotkeys.SettingsKey:
                // Written behind hotkeys.set's back (data.import, settings.set/remove): register what is stored now.
                // hotkeys.set stores exactly what it just registered, so its own write finds nothing to do here.
                var wanted = _settings.Get(Hotkeys.SettingsKey, Hotkeys.Default);
                if (wanted != _hotkeys.Current) RegisterStartupHotkeys(wanted);
                break;
        }
    }

    private void OnSessionEnding(object? sender, Microsoft.Win32.SessionEndingEventArgs e)
    {
        _log.Info($"Windows session ending ({e.Reason}).");
        ExitApplication();
    }

    /// <summary>
    /// The shared WebView2 browser process died: both windows are dead for good. Recover by restarting the whole
    /// application, once per process, unless this process is itself a restart whose browser died again right away.
    /// </summary>
    private void OnBrowserProcessExited()
    {
        if (_exiting || _browserCrashHandled) return;
        _browserCrashHandled = true;
        // Leave the WebView2 event callback before the windows and their WebView2 controls are torn down.
        try
        {
            _mainWindow.BeginInvoke(new Action(RecoverFromBrowserCrash));
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            RecoverFromBrowserCrash();
        }
    }

    private void RecoverFromBrowserCrash()
    {
        if (_exiting) return;
        var uptime = TimeSpan.FromMilliseconds(Environment.TickCount64 - _startedAtTicks);
        if (_config.IsRestart && uptime < RestartLoopWindow)
        {
            _log.Error($"The WebView2 browser process exited again {uptime.TotalSeconds:0} s after an automatic restart; not restarting.");
            ShowBrowserFailure();
            ExitApplication();
            return;
        }

        _log.Error("The WebView2 browser process exited; restarting CatDesktop.");
        try
        {
            var start = new ProcessStartInfo(Environment.ProcessPath ?? Application.ExecutablePath)
            {
                UseShellExecute = false,
                WorkingDirectory = Environment.CurrentDirectory,
            };
            // Come back the way the user left it: a tray-only start (--hidden) is dropped once the main window is open.
            var mainWindowOpen = !_mainWindow.IsDisposed && _mainWindow.Visible;
            foreach (var argument in _config.Arguments)
            {
                if (string.Equals(argument, HostConfig.RestartArgument, StringComparison.OrdinalIgnoreCase)) continue;
                if (mainWindowOpen && argument.ToLowerInvariant() is "--hidden" or "--minimized") continue;
                start.ArgumentList.Add(argument);
            }
            start.ArgumentList.Add(HostConfig.RestartArgument);
            using var process = Process.Start(start);
        }
        catch (Exception ex)
        {
            _log.Error("Automatic restart failed", ex);
            ShowBrowserFailure();
        }
        ExitApplication(); // the new instance waits for this one to release the single-instance guard
    }

    private void ShowBrowserFailure()
    {
        MessageBox.Show(
            "CatDesktop's embedded browser (Microsoft Edge WebView2) stopped working and could not be restarted, so CatDesktop will close."
            + "\n\nStart CatDesktop again. If this keeps happening, repair or reinstall the Microsoft Edge WebView2 Runtime."
            + "\n\nSee the log folder for details:\n" + _paths.LogsDir,
            "CatDesktop", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private void OnHotkeyPressed(string name)
    {
        _log.Trace($"Hotkey {name}");
        _events.Broadcast("hotkey.pressed", new { name });
        switch (name)
        {
            case Hotkeys.ToggleCatName:
                _cat.ToggleCat();
                break;
            case Hotkeys.StartFocusName:
                ToggleFocusFromShortcut();
                break;
            case Hotkeys.QuickNoteName:
                // Focus now, while WM_HOTKEY still lets this process take the foreground: the user is about to type.
                _cat.SendCommand("quick-note", null);
                break;
        }
    }

    private void ToggleFocusFromShortcut()
    {
        var state = _focusTimer.State;
        switch (state.Status)
        {
            case FocusStatuses.Running: _focusTimer.Pause(); break;
            case FocusStatuses.Paused: _focusTimer.Resume(); break;
            default: _focusTimer.Start(null, null); break;
        }
    }

    private void SafeDispose(IDisposable? disposable)
    {
        try { disposable?.Dispose(); }
        catch (Exception ex) { _log.Warn($"Dispose failed: {ex.Message}"); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_exiting)
        {
            ExitApplication();
        }
        base.Dispose(disposing);
    }
}

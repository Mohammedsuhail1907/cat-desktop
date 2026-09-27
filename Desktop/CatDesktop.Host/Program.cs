using CatDesktop.Host.App;

namespace CatDesktop.Host;

/// <summary>
/// Entry point. Responsibilities: single-instance guard, global exception handling,
/// creating the composition root (<see cref="DesktopApplication"/>) and running the message loop.
/// </summary>
internal static class Program
{
    /// <summary>How long an automatic restart waits for the previous instance to finish shutting down.</summary>
    private static readonly TimeSpan RestartWait = TimeSpan.FromSeconds(15);

    [STAThread]
    private static int Main(string[] args)
    {
        var config = HostConfig.FromArguments(args);
        var paths = AppPaths.Create();
        paths.EnsureDirectories();
        var log = new Logger(paths.LogsDir, verbose: config.Verbose);

        var isolationKey = paths.IsIsolated ? paths.RootDataDir : null;
        // After an automatic restart the previous instance is still exiting: wait for it rather than activating it.
        using var instance = SingleInstance.TryAcquire(isolationKey, config.IsRestart ? RestartWait : TimeSpan.Zero);
        if (instance is null)
        {
            if (config.IsRestart)
            {
                log.Error($"Automatic restart abandoned: the previous instance did not exit within {RestartWait.TotalSeconds:0} s.");
                return 1;
            }
            // Another copy is already running: ask it to come to the front and quit quietly.
            SingleInstance.SignalExistingInstance(isolationKey);
            log.Info("Another instance is running; activated it and exiting.");
            return 0;
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => log.Error("Unhandled UI exception", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => log.Error("Unhandled exception", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) => { log.Error("Unobserved task exception", e.Exception); e.SetObserved(); };

        log.Info($"CatDesktop {config.Version} starting. devMode={config.IsDevMode} devUrl={config.DevUrl ?? "-"} data={paths.RootDataDir}"
                 + (config.IsRestart ? " (automatic restart)" : ""));

        try
        {
            using var app = new DesktopApplication(config, paths, log);
            instance.Activated += () => app.ActivateFromOtherInstance();
            Application.Run(app);
            log.Info("CatDesktop exited normally.");
            return 0;
        }
        catch (Exception ex)
        {
            log.Error("Fatal startup error", ex);
            MessageBox.Show(
                "CatDesktop could not start.\n\n" + ex.Message + "\n\nSee the log folder for details:\n" + paths.LogsDir,
                "CatDesktop", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}

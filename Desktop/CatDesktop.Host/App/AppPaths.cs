namespace CatDesktop.Host.App;

/// <summary>
/// All writable locations live under %LOCALAPPDATA%\CatDesktop so nothing is written to the
/// installation directory. Read-only UI assets (wwwroot) ship next to the executable.
/// </summary>
public sealed class AppPaths
{
    public const string ProductFolderName = "CatDesktop";

    public string RootDataDir { get; }
    public string DatabaseDir { get; }
    public string DatabasePath { get; }
    public string WebView2UserDataDir { get; }
    public string LogsDir { get; }
    public string BackupsDir { get; }
    public string WwwRootDir { get; }
    public string InstallDir { get; }

    private AppPaths(string rootDataDir, string installDir)
    {
        RootDataDir = rootDataDir;
        InstallDir = installDir;
        DatabaseDir = Path.Combine(rootDataDir, "Database");
        DatabasePath = Path.Combine(DatabaseDir, "application.db");
        WebView2UserDataDir = Path.Combine(rootDataDir, "WebView2");
        LogsDir = Path.Combine(rootDataDir, "Logs");
        BackupsDir = Path.Combine(rootDataDir, "Backups");
        WwwRootDir = Path.Combine(installDir, "wwwroot");
    }

    /// <summary>
    /// Environment variable that points the app at a different data folder (automated tests, a second profile).
    /// Unset in normal use.
    /// </summary>
    public const string DataDirOverrideVariable = "CATDESKTOP_DATA_DIR";

    /// <summary>True when <see cref="DataDirOverrideVariable"/> selected a non-default data folder.</summary>
    public bool IsIsolated { get; private init; }

    public static AppPaths Create()
    {
        var overrideDir = Environment.GetEnvironmentVariable(DataDirOverrideVariable);
        if (!string.IsNullOrWhiteSpace(overrideDir))
        {
            return new AppPaths(Path.GetFullPath(overrideDir), AppContext.BaseDirectory) { IsIsolated = true };
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.Create);
        return new AppPaths(Path.Combine(local, ProductFolderName), AppContext.BaseDirectory);
    }

    public void EnsureDirectories()
    {
        Directory.CreateDirectory(RootDataDir);
        Directory.CreateDirectory(DatabaseDir);
        Directory.CreateDirectory(WebView2UserDataDir);
        Directory.CreateDirectory(LogsDir);
        Directory.CreateDirectory(BackupsDir);
    }

    public bool HasProductionUi => File.Exists(Path.Combine(WwwRootDir, "index.html"));
}

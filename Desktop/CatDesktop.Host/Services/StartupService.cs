using Microsoft.Win32;

namespace CatDesktop.Host.Services;

/// <summary>
/// "Start with Windows" via the per-user Run key. The registered command starts the app hidden in the tray.
/// </summary>
public sealed class StartupService
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "CatDesktop";

    public bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        return key?.GetValue(ValueName) is string command && !string.IsNullOrWhiteSpace(command);
    }

    public void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true)
                        ?? throw new InvalidOperationException("The Run registry key could not be opened.");
        if (enabled)
        {
            // Always rewrite the value so a moved or updated installation keeps pointing at the right executable.
            key.SetValue(ValueName, BuildCommand(), RegistryValueKind.String);
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }

    private static string BuildCommand() => $"\"{ExecutablePath()}\" --hidden";

    private static string ExecutablePath() => Environment.ProcessPath ?? Application.ExecutablePath;
}

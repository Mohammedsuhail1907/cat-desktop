using System.Media;
using CatDesktop.Host.App;

namespace CatDesktop.Host.Services;

/// <summary>
/// User-facing notifications: a tray balloon plus an optional system sound. Callable from any thread
/// because <see cref="TrayService"/> marshals to the UI thread and system sounds play asynchronously.
/// </summary>
public sealed class NotificationService
{
    private readonly TrayService _tray;
    private readonly Logger _log;

    public NotificationService(TrayService tray, Logger log)
    {
        _tray = tray;
        _log = log;
    }

    public void Show(string title, string body, bool silent = false)
    {
        _log.Trace($"Notification: {title}");
        _tray.ShowBalloon(title, body, ToolTipIcon.None);
        if (!silent) Play(SystemSounds.Asterisk);
    }

    /// <summary>Distinct sound for the end of a focus/break phase.</summary>
    public void PlayCompletionSound() => Play(SystemSounds.Exclamation);

    private void Play(SystemSound sound)
    {
        try
        {
            sound.Play();
        }
        catch (Exception ex)
        {
            _log.Warn($"System sound failed: {ex.Message}");
        }
    }
}

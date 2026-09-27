using CatDesktop.Host.Native;

namespace CatDesktop.Host.App;

/// <summary>
/// Guarantees a single running copy per user session and data folder. The second copy signals a named event and exits;
/// the first copy raises <see cref="Activated"/> (on a background thread – callers marshal to the UI thread).
/// The default data folder uses the fixed names below (the installer's AppMutex relies on them); an isolated data
/// folder (CATDESKTOP_DATA_DIR) gets its own suffixed names so a test profile can run beside the real app.
/// </summary>
public sealed class SingleInstance : IDisposable
{
    private const string MutexBaseName = @"Local\CatDesktop.SingleInstance.v1";
    private const string EventBaseName = @"Local\CatDesktop.Activate.v1";

    private readonly Mutex _mutex;
    private readonly EventWaitHandle _activateEvent;
    private readonly Thread _listener;
    private volatile bool _disposed;

    public event Action? Activated;

    private SingleInstance(Mutex mutex, string eventName)
    {
        _mutex = mutex;
        _activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, eventName);
        _listener = new Thread(Listen) { IsBackground = true, Name = "SingleInstanceListener" };
        _listener.Start();
    }

    /// <summary>Returns the guard for the first instance, or null when another instance already owns it.</summary>
    /// <param name="isolationKey">Null for the default data folder; otherwise any stable string (the custom data folder).</param>
    /// <param name="waitForRelease">
    /// Zero: fail at once when another instance owns the guard. Otherwise wait up to this long for it to be released
    /// (an automatic restart waits for the previous, exiting instance).
    /// </param>
    public static SingleInstance? TryAcquire(string? isolationKey, TimeSpan waitForRelease = default)
    {
        var mutexName = MutexBaseName + Suffix(isolationKey);
        var eventName = EventBaseName + Suffix(isolationKey);
        if (waitForRelease <= TimeSpan.Zero)
        {
            var mutex = new Mutex(true, mutexName, out var createdNew);
            if (createdNew) return new SingleInstance(mutex, eventName);
            mutex.Dispose();
            return null;
        }

        var waiting = new Mutex(false, mutexName);
        bool acquired;
        try
        {
            acquired = waiting.WaitOne(waitForRelease);
        }
        catch (AbandonedMutexException)
        {
            acquired = true; // the previous owner ended without releasing it; the mutex is ours now
        }
        if (acquired) return new SingleInstance(waiting, eventName);
        waiting.Dispose();
        return null;
    }

    public static void SignalExistingInstance(string? isolationKey)
    {
        try
        {
            using var handle = EventWaitHandle.OpenExisting(EventBaseName + Suffix(isolationKey));
            // This process was just started by the user, so it may pass its right to take the foreground on;
            // without it the running instance could only flash its taskbar button.
            NativeMethods.AllowSetForegroundWindow(NativeMethods.ASFW_ANY);
            handle.Set();
        }
        catch
        {
            // The other instance is probably still starting up; nothing else to do.
        }
    }

    private static string Suffix(string? isolationKey)
    {
        if (string.IsNullOrEmpty(isolationKey)) return "";
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(isolationKey.ToUpperInvariant()));
        return "." + Convert.ToHexString(hash, 0, 6);
    }

    private void Listen()
    {
        while (!_disposed)
        {
            try
            {
                if (_activateEvent.WaitOne(TimeSpan.FromSeconds(1)))
                {
                    Activated?.Invoke();
                }
            }
            catch (ObjectDisposedException) { return; }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _mutex.ReleaseMutex(); } catch { /* ignore */ }
        _mutex.Dispose();
        _activateEvent.Dispose();
    }
}

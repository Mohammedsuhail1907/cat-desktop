using System.Text;

namespace CatDesktop.Host.App;

/// <summary>
/// Minimal thread-safe rolling file logger (one file per day) with a small in-memory ring for diagnostics.
/// Deliberately dependency-free so packaging stays lean.
/// </summary>
public sealed class Logger
{
    private readonly string _dir;
    private readonly bool _verbose;
    private readonly object _gate = new();
    private readonly Queue<string> _recent = new();

    public Logger(string logsDir, bool verbose)
    {
        _dir = logsDir;
        _verbose = verbose;
        try { Directory.CreateDirectory(_dir); } catch { /* logging must never crash the app */ }
        CleanupOldLogs();
    }

    public bool Verbose => _verbose;

    public void Trace(string message) { if (_verbose) Write("TRACE", message); }
    public void Info(string message) => Write("INFO ", message);
    public void Warn(string message) => Write("WARN ", message);
    public void Error(string message, Exception? ex = null) => Write("ERROR", ex is null ? message : $"{message}: {ex}");

    public IReadOnlyList<string> Recent()
    {
        lock (_gate) return _recent.ToArray();
    }

    private void Write(string level, string message)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] [{Environment.CurrentManagedThreadId,3}] {message}";
        lock (_gate)
        {
            _recent.Enqueue(line);
            while (_recent.Count > 200) _recent.Dequeue();
            try
            {
                File.AppendAllText(Path.Combine(_dir, $"host-{DateTime.Now:yyyyMMdd}.log"), line + Environment.NewLine, Encoding.UTF8);
            }
            catch { /* ignore IO problems */ }
        }
        System.Diagnostics.Debug.WriteLine(line);
    }

    private void CleanupOldLogs()
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(_dir, "host-*.log"))
            {
                if (File.GetLastWriteTimeUtc(file) < DateTime.UtcNow.AddDays(-14)) File.Delete(file);
            }
        }
        catch { /* ignore */ }
    }
}

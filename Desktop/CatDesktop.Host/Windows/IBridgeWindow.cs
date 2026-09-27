using CatDesktop.Host.Models;
using CatDesktop.Host.WebView;

namespace CatDesktop.Host.Windows;

public enum WindowKind
{
    Main,
    Cat,
}

public static class WindowKindExtensions
{
    /// <summary>Wire name used in JSON ('main' | 'cat').</summary>
    public static string ToWireName(this WindowKind kind) => kind == WindowKind.Cat ? "cat" : "main";

    /// <summary>Row key in the window_states table.</summary>
    public static string ToWindowId(this WindowKind kind) => kind == WindowKind.Cat ? "cat" : "main";
}

/// <summary>Anything that hosts a WebView2 and can receive bridge events.</summary>
public interface IBridgeWindow
{
    WindowKind Kind { get; }
    Form Form { get; }
    WebViewHost WebView { get; }

    /// <summary>Current physical-pixel bounds and flags (see contract §3 window.getState).</summary>
    WindowState GetState();

    void SetAlwaysOnTop(bool enabled);
}

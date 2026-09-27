using CatDesktop.Host.Windows;

namespace CatDesktop.Host.Bridge;

/// <summary>Identifies which window issued a bridge request. Handlers use it for window.* commands and targeted events.</summary>
public sealed class BridgeContext
{
    public BridgeContext(IBridgeWindow window)
    {
        Window = window;
    }

    public IBridgeWindow Window { get; }

    public WindowKind Kind => Window.Kind;
}

using System.Text.Json;
using CatDesktop.Host.App;
using CatDesktop.Host.Native;
using CatDesktop.Host.Windows;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>Contract section 3 window.* commands. Every command acts on the window that sent the request.</summary>
public sealed class WindowCommands
{
    private readonly Logger _log;

    public WindowCommands(Logger log)
    {
        _log = log;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("window.minimize", Minimize);
        router.Register("window.maximize", Maximize);
        router.Register("window.restore", Restore);
        router.Register("window.close", Close);
        router.Register("window.focus", Focus);
        router.Register("window.getState", ctx => ctx.Window.GetState());
        router.Register("window.setAlwaysOnTop", (ctx, payload) => SetAlwaysOnTop(ctx, payload));
    }

    private static object? Minimize(BridgeContext ctx)
    {
        RequireFramedWindow(ctx, "minimized");
        ctx.Window.Form.WindowState = FormWindowState.Minimized;
        return new { };
    }

    private static object? Maximize(BridgeContext ctx)
    {
        RequireFramedWindow(ctx, "maximized");
        ctx.Window.Form.WindowState = FormWindowState.Maximized;
        return new { };
    }

    private static object? Restore(BridgeContext ctx)
    {
        ctx.Window.Form.WindowState = FormWindowState.Normal;
        return new { };
    }

    private object? Close(BridgeContext ctx)
    {
        var form = ctx.Window.Form;
        if (ctx.Kind == WindowKind.Cat)
        {
            // The cat window only ever hides; the cat service reacts to its visibility change (walk/drag end, events).
            _log.Trace("window.close from the cat window: hiding.");
            form.Hide();
            return new { };
        }

        // Queue the close so the response goes out before the FormClosing logic (close-to-tray or exit) runs.
        _log.Trace("window.close from the main window: closing.");
        form.BeginInvoke(new Action(form.Close));
        return new { };
    }

    private static object? Focus(BridgeContext ctx)
    {
        if (ctx.Window is MainWindow.MainWindow main)
        {
            main.ShowAndActivate();
            return new { };
        }
        if (ctx.Window is Cat.CatWindow cat)
        {
            // The cat UI calls this when its menu or panel opens: activate and hand keyboard focus to the WebView.
            cat.ActivateAndFocus();
            return new { };
        }

        var form = ctx.Window.Form;
        if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
        if (form.Visible)
        {
            form.Activate();
            NativeMethods.SetForegroundWindow(form.Handle);
        }
        return new { };
    }

    private static object? SetAlwaysOnTop(BridgeContext ctx, JsonElement payload)
    {
        var enabled = Payload.RequireBool(payload, "enabled");
        ctx.Window.SetAlwaysOnTop(enabled);
        return new { };
    }

    /// <summary>
    /// The frameless, transparent cat window must never be minimised or maximised: a maximised transparent
    /// window would cover the whole screen and swallow input.
    /// </summary>
    private static void RequireFramedWindow(BridgeContext ctx, string verb)
    {
        if (ctx.Kind == WindowKind.Cat)
        {
            throw BridgeException.Unsupported($"The cat window cannot be {verb}; use cat.hide instead.");
        }
    }
}

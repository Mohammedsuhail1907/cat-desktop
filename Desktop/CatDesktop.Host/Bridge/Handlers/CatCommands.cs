using System.Text.Json;
using CatDesktop.Host.Cat;
using CatDesktop.Host.Models;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>
/// cat.* commands (contract section 3): control the desktop cat from any window. Every payload is validated here,
/// before <see cref="CatWindowService"/> is called, so a rejected request never has a side effect.
/// </summary>
public sealed class CatCommands
{
    /// <summary>Physical px: far beyond any real desktop, but keeps arithmetic well inside int.</summary>
    private const int CoordinateLimit = 100_000;
    /// <summary>DIPs for moveBy / walk distances.</summary>
    private const double DistanceLimit = 10_000;
    private const double MinWalkSpeed = 10;
    private const double MaxWalkSpeed = 600;
    /// <summary>CSS px for hit rectangles (the largest window is a few hundred CSS px).</summary>
    private const double HitRectLimit = 10_000;
    private const int MaxActionLength = 64;
    private const int MaxMonitorNameLength = 64;

    private readonly CatWindowService _cat;

    public CatCommands(CatWindowService cat)
    {
        _cat = cat;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("cat.show", _ => new { visible = _cat.ShowCat() });
        router.Register("cat.hide", _ =>
        {
            _cat.HideCat();
            return new { visible = _cat.IsVisible };
        });
        router.Register("cat.toggle", _ => new { visible = _cat.ToggleCat() });
        router.Register("cat.isVisible", _ => new { visible = _cat.IsVisible });

        router.Register("cat.getPosition", _ => _cat.GetPosition());
        router.Register("cat.moveTo", (_, payload) =>
        {
            var x = Payload.RequireInt(payload, "x", -CoordinateLimit, CoordinateLimit);
            var y = Payload.RequireInt(payload, "y", -CoordinateLimit, CoordinateLimit);
            var monitor = Payload.OptionalString(payload, "monitor", MaxMonitorNameLength);
            return _cat.SetCatPosition(x, y, string.IsNullOrWhiteSpace(monitor) ? null : monitor);
        });
        router.Register("cat.moveBy", (_, payload) =>
        {
            var dx = Payload.RequireDouble(payload, "dx", -DistanceLimit, DistanceLimit);
            var dy = Payload.RequireDouble(payload, "dy", -DistanceLimit, DistanceLimit);
            return _cat.MoveCat(dx, dy);
        });
        router.Register("cat.savePosition", _ => _cat.SaveCatPosition());

        router.Register("cat.walk", (_, payload) =>
        {
            var dx = Payload.RequireDouble(payload, "dx", -DistanceLimit, DistanceLimit);
            var dy = Payload.OptionalDouble(payload, "dy", -DistanceLimit, DistanceLimit) ?? 0;
            var speed = Payload.RequireDouble(payload, "speed", MinWalkSpeed, MaxWalkSpeed);
            return _cat.Walk(dx, dy, speed);
        });
        router.Register("cat.stop", _ =>
        {
            _cat.StopWalk();
            return new { };
        });

        router.Register("cat.getScreenInfo", _ => _cat.GetScreenInformation());
        router.Register("cat.getMonitors", _ => _cat.GetMonitorInformation());

        router.Register("cat.dragStart", (_, payload) =>
        {
            var followUntilClick = Payload.OptionalBool(payload, "followUntilClick") ?? false;
            _cat.DragStart(followUntilClick);
            return new { };
        });
        router.Register("cat.dragEnd", _ => new { moved = _cat.DragEnd() });

        router.Register("cat.setLayout", (_, payload) =>
        {
            var mode = Payload.RequireString(payload, "mode", 16);
            if (!CatLayoutModes.IsValid(mode)) throw BridgeException.Validation("'mode' must be 'cat', 'menu' or 'panel'.");
            return _cat.SetLayout(mode);
        });
        router.Register("cat.setHitRegion", (_, payload) =>
        {
            _cat.SetHitRegion(ReadHitRects(payload));
            return new { };
        });
        router.Register("cat.setClickThrough", (_, payload) =>
        {
            var enabled = Payload.RequireBool(payload, "enabled");
            var hover = Payload.OptionalBool(payload, "hoverToInteract") ?? true;
            _cat.SetClickThrough(enabled, hover);
            return new { };
        });
        router.Register("cat.setAlwaysOnTop", (_, payload) =>
        {
            _cat.SetAlwaysOnTop(Payload.RequireBool(payload, "enabled"));
            return new { };
        });

        router.Register("cat.getSettings", _ => _cat.Settings);
        router.Register("cat.saveSettings", (_, payload) => _cat.SaveSettings(Payload.Require<CatSettings>(payload)));

        router.Register("cat.sendCommand", (_, payload) =>
        {
            var action = Payload.RequireString(payload, "action", MaxActionLength);
            var extra = Payload.Element(payload, "payload");
            // Clone: the request's JsonElement is only valid for the lifetime of the dispatch.
            JsonElement? forwarded = Payload.IsMissing(extra) ? null : extra.Clone();
            _cat.SendCommand(action, forwarded);
            return new { };
        });
    }

    /// <summary>{ rects: Rect[] } with 0-16 finite rectangles (CSS px, window coordinates, non-negative sizes).</summary>
    private static List<RectangleF> ReadHitRects(JsonElement payload)
    {
        var array = Payload.Element(payload, "rects");
        if (array.ValueKind != JsonValueKind.Array) throw BridgeException.Validation("'rects' must be an array.");
        var count = array.GetArrayLength();
        if (count > CatWindowService.MaxHitRects)
            throw BridgeException.Validation($"'rects' may hold at most {CatWindowService.MaxHitRects} rectangles.");

        var rects = new List<RectangleF>(count);
        var index = 0;
        foreach (var item in array.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) throw BridgeException.Validation($"rects[{index}] must be an object.");
            try
            {
                var x = Payload.RequireDouble(item, "x", -HitRectLimit, HitRectLimit);
                var y = Payload.RequireDouble(item, "y", -HitRectLimit, HitRectLimit);
                var width = Payload.RequireDouble(item, "width", 0, HitRectLimit);
                var height = Payload.RequireDouble(item, "height", 0, HitRectLimit);
                rects.Add(new RectangleF((float)x, (float)y, (float)width, (float)height));
            }
            catch (BridgeException ex)
            {
                throw BridgeException.Validation($"rects[{index}]: {ex.Message}");
            }
            index++;
        }
        return rects;
    }
}

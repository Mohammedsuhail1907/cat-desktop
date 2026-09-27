using CatDesktop.Host.Models;
using CatDesktop.Host.Services;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>focus.* commands (contract section 3). The timer itself lives in <see cref="FocusTimerService"/>.</summary>
public sealed class FocusCommands
{
    private readonly FocusTimerService _timer;

    public FocusCommands(FocusTimerService timer)
    {
        _timer = timer;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("focus.getState", _ => _timer.State);
        router.Register("focus.start", (_, payload) =>
        {
            var phase = Payload.OptionalString(payload, "phase", 32);
            var minutes = Payload.OptionalInt(payload, "minutes", 1, 180);
            return _timer.Start(phase, minutes);
        });
        router.Register("focus.pause", _ => _timer.Pause());
        router.Register("focus.resume", _ => _timer.Resume());
        router.Register("focus.stop", _ => _timer.Stop());
        router.Register("focus.reset", _ => _timer.Reset());
        router.Register("focus.skip", _ => _timer.Skip());
        router.Register("focus.getSettings", _ => _timer.GetSettings());
        router.Register("focus.saveSettings", (_, payload) => _timer.SaveSettings(Payload.Require<FocusSettings>(payload)));
        router.Register("focus.getStats", _ => _timer.GetStats());
    }
}

using CatDesktop.Host.Services;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>data.* (contract section 3): database info plus export/import through file dialogs owned by the main window.</summary>
public sealed class DataCommands
{
    private readonly BackupService _backup;
    private readonly Form _owner;
    private readonly BridgeEvents _events;

    public DataCommands(BackupService backup, Form owner, BridgeEvents events)
    {
        _backup = backup;
        _owner = owner;
        _events = events;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("data.getInfo", _ => _backup.GetInfo());

        router.Register("data.export", _ =>
        {
            var path = _backup.Export(_owner);
            return new { cancelled = path is null, path };
        });

        router.Register("data.import", _ =>
        {
            var result = _backup.Import(_owner);
            if (!result.Cancelled)
            {
                _events.Broadcast("notes.changed");
                _events.Broadcast("tasks.changed");
                _events.Broadcast("actions.changed");
                // settings.changed is not sent here: the import reloads SettingsService, whose Changed handler in the
                // composition root broadcasts it (and applies side effects) once per key whose value really changed.
            }
            return new { cancelled = result.Cancelled, notes = result.Notes, tasks = result.Tasks };
        });
    }
}

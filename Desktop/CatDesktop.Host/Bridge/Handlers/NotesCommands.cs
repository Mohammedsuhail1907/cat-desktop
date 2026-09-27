using System.Text.Json;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.Models;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>notes.* (contract section 3). Every payload field is validated before the repository is touched.</summary>
public sealed class NotesCommands
{
    private const string ChangedEvent = "notes.changed";

    private readonly NotesRepository _notes;
    private readonly BridgeEvents _events;

    public NotesCommands(NotesRepository notes, BridgeEvents events)
    {
        _notes = notes;
        _events = events;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("notes.list", (_, payload) => _notes.List(Payload.OptionalString(payload, "search", NoteRules.MaxSearchLength)));

        router.Register("notes.get", (_, payload) => Find(RequireId(payload)));

        router.Register("notes.create", (_, payload) =>
        {
            var now = Timestamps.NowIso();
            var note = new Note
            {
                Id = Timestamps.NewId(),
                Title = ReadTitle(payload) ?? "",
                Content = ReadContent(payload) ?? "",
                Color = ReadColor(payload),
                Pinned = Payload.OptionalBool(payload, "pinned") ?? false,
                CreatedAt = now,
                UpdatedAt = now,
            };
            var stored = _notes.Insert(note);
            _events.Broadcast(ChangedEvent);
            return stored;
        });

        router.Register("notes.update", (_, payload) =>
        {
            var id = RequireId(payload);
            var hasTitle = Payload.Has(payload, "title");
            var hasContent = Payload.Has(payload, "content");
            var hasColor = Payload.Has(payload, "color");
            var hasPinned = Payload.Has(payload, "pinned");
            var title = hasTitle ? ReadTitle(payload) ?? "" : null;
            var content = hasContent ? ReadContent(payload) ?? "" : null;
            var color = hasColor ? ReadColor(payload) : null;
            var pinned = hasPinned ? Payload.RequireBool(payload, "pinned") : (bool?)null;

            var existing = Find(id);
            var updated = existing with
            {
                Title = hasTitle ? title! : existing.Title,
                Content = hasContent ? content! : existing.Content,
                Color = hasColor ? color : existing.Color,
                Pinned = pinned ?? existing.Pinned,
                UpdatedAt = Timestamps.NowIso(),
            };
            _notes.Update(updated);
            _events.Broadcast(ChangedEvent);
            return updated;
        });

        router.Register("notes.delete", (_, payload) =>
        {
            var id = RequireId(payload);
            if (!_notes.Delete(id)) throw BridgeException.NotFound($"Note '{id}' does not exist.");
            _events.Broadcast(ChangedEvent);
            return new { };
        });
    }

    private Note Find(string id) => _notes.Get(id) ?? throw BridgeException.NotFound($"Note '{id}' does not exist.");

    private static string RequireId(JsonElement payload) => Payload.RequireString(payload, "id", NoteRules.MaxIdLength).Trim();

    private static string? ReadTitle(JsonElement payload) => Payload.OptionalString(payload, "title", NoteRules.MaxTitleLength);

    private static string? ReadContent(JsonElement payload) => Payload.OptionalString(payload, "content", NoteRules.MaxContentLength);

    /// <summary>Colour is a short token (CSS name or hex); blank means "no colour".</summary>
    private static string? ReadColor(JsonElement payload)
    {
        var color = Payload.OptionalString(payload, "color", NoteRules.MaxColorLength);
        return string.IsNullOrWhiteSpace(color) ? null : color.Trim();
    }
}

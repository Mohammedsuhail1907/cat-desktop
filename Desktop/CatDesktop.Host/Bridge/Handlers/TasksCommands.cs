using System.Text.Json;
using CatDesktop.Host.Database.Repositories;
using CatDesktop.Host.Models;

namespace CatDesktop.Host.Bridge.Handlers;

/// <summary>tasks.* (contract section 3). Every payload field is validated before the repository is touched.</summary>
public sealed class TasksCommands
{
    private const string ChangedEvent = "tasks.changed";

    private readonly TasksRepository _tasks;
    private readonly BridgeEvents _events;

    public TasksCommands(TasksRepository tasks, BridgeEvents events)
    {
        _tasks = tasks;
        _events = events;
    }

    public void Register(BridgeRouter router)
    {
        router.Register("tasks.list", (_, payload) => _tasks.List(Payload.OptionalBool(payload, "includeCompleted") ?? false));

        router.Register("tasks.create", (_, payload) =>
        {
            var title = Payload.RequireString(payload, "title", TaskRules.MaxTitleLength).Trim();
            var notes = ReadNotes(payload);
            var priority = Payload.OptionalInt(payload, "priority", TaskRules.MinPriority, TaskRules.MaxPriority) ?? 0;
            var dueAt = ReadDueAt(payload);

            var now = Timestamps.NowIso();
            var task = new TaskItem
            {
                Id = Timestamps.NewId(),
                Title = title,
                Notes = notes,
                Completed = false,
                Priority = priority,
                DueAt = dueAt,
                CompletedAt = null,
                SortOrder = _tasks.NextSortOrder(),
                CreatedAt = now,
                UpdatedAt = now,
            };
            var stored = _tasks.Insert(task);
            _events.Broadcast(ChangedEvent);
            return stored;
        });

        router.Register("tasks.update", (_, payload) =>
        {
            var id = RequireId(payload);
            var hasTitle = Payload.Has(payload, "title");
            var hasNotes = Payload.Has(payload, "notes");
            var hasPriority = Payload.Has(payload, "priority");
            var hasDueAt = Payload.Has(payload, "dueAt");
            var hasCompleted = Payload.Has(payload, "completed");
            var hasSortOrder = Payload.Has(payload, "sortOrder");
            var title = hasTitle ? Payload.RequireString(payload, "title", TaskRules.MaxTitleLength).Trim() : null;
            var notes = hasNotes ? ReadNotes(payload) : null;
            var priority = hasPriority ? Payload.RequireInt(payload, "priority", TaskRules.MinPriority, TaskRules.MaxPriority) : (int?)null;
            var dueAt = hasDueAt ? ReadDueAt(payload) : null;
            var completed = hasCompleted ? Payload.RequireBool(payload, "completed") : (bool?)null;
            var sortOrder = hasSortOrder ? Payload.RequireInt(payload, "sortOrder", TaskRules.MinSortOrder, TaskRules.MaxSortOrder) : (int?)null;

            var now = Timestamps.NowIso();
            var existing = Find(id);
            var updated = existing with
            {
                Title = hasTitle ? title! : existing.Title,
                Notes = hasNotes ? notes : existing.Notes,
                Priority = priority ?? existing.Priority,
                DueAt = hasDueAt ? dueAt : existing.DueAt,
                SortOrder = sortOrder ?? existing.SortOrder,
                UpdatedAt = now,
            };
            if (completed.HasValue) updated = WithCompletion(updated, completed.Value, now);

            _tasks.Update(updated);
            _events.Broadcast(ChangedEvent);
            return updated;
        });

        router.Register("tasks.toggle", (_, payload) =>
        {
            var existing = Find(RequireId(payload));
            var now = Timestamps.NowIso();
            var updated = WithCompletion(existing with { UpdatedAt = now }, !existing.Completed, now);
            _tasks.Update(updated);
            _events.Broadcast(ChangedEvent);
            return updated;
        });

        router.Register("tasks.delete", (_, payload) =>
        {
            var id = RequireId(payload);
            if (!_tasks.Delete(id)) throw BridgeException.NotFound($"Task '{id}' does not exist.");
            _events.Broadcast(ChangedEvent);
            return new { };
        });

        router.Register("tasks.clearCompleted", _ =>
        {
            var deleted = _tasks.ClearCompleted();
            if (deleted > 0) _events.Broadcast(ChangedEvent);
            return new { deleted };
        });
    }

    private TaskItem Find(string id) => _tasks.Get(id) ?? throw BridgeException.NotFound($"Task '{id}' does not exist.");

    private static string RequireId(JsonElement payload) => Payload.RequireString(payload, "id", TaskRules.MaxIdLength).Trim();

    private static string? ReadNotes(JsonElement payload)
    {
        var notes = Payload.OptionalString(payload, "notes", TaskRules.MaxNotesLength);
        return string.IsNullOrWhiteSpace(notes) ? null : notes;
    }

    /// <summary>dueAt: null clears, otherwise any ISO-8601 date/time, stored in the contract's UTC form.</summary>
    private static string? ReadDueAt(JsonElement payload)
    {
        var raw = Payload.OptionalString(payload, "dueAt", 64);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (!TaskRules.TryNormaliseIso(raw, out var iso))
            throw BridgeException.Validation("'dueAt' must be an ISO-8601 date/time (e.g. 2026-09-26T10:15:00.000Z).");
        return iso;
    }

    /// <summary>Completing stamps completedAt once (an already completed task keeps its stamp); re-opening clears it.</summary>
    private static TaskItem WithCompletion(TaskItem task, bool completed, string now) => task with
    {
        Completed = completed,
        CompletedAt = completed ? (task.Completed && task.CompletedAt is not null ? task.CompletedAt : now) : null,
    };
}

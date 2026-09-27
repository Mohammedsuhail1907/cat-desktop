import { Injectable, computed, inject, signal } from '@angular/core';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';
import { Note, NoteCreate, NoteUpdate } from '../models';

@Injectable({ providedIn: 'root' })
export class NotesService {
  private readonly bridge = inject(DesktopBridgeService);
  private lastSearch = '';
  /** False until a page asked for the list; until then a change event has nothing to keep fresh. */
  private loadedOnce = false;

  readonly notes = signal<Note[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** The search the current `notes` list was loaded with ('' = unfiltered). */
  readonly query = signal('');
  readonly pinned = computed(() => this.notes().filter((n) => n.pinned));
  readonly count = computed(() => this.notes().length);

  constructor() {
    this.bridge.on('notes.changed').subscribe(() => {
      if (this.loadedOnce) void this.refresh(this.lastSearch);
    });
  }

  async refresh(search = ''): Promise<void> {
    this.lastSearch = search;
    this.loadedOnce = true;
    this.loading.set(true);
    try {
      const notes = await this.bridge.invoke('notes.list', search ? { search } : {});
      this.notes.set(notes);
      this.query.set(search);
      this.error.set(null);
    } catch (err) {
      this.error.set(String((err as Error).message ?? err));
    } finally {
      this.loading.set(false);
    }
  }

  get(id: string): Promise<Note> {
    return this.bridge.invoke('notes.get', { id });
  }

  async create(input: NoteCreate): Promise<Note> {
    const note = await this.bridge.invoke('notes.create', input);
    this.notes.update((list) => [note, ...list]);
    return note;
  }

  async update(input: NoteUpdate): Promise<Note> {
    const note = await this.bridge.invoke('notes.update', input);
    this.notes.update((list) => list.map((n) => (n.id === note.id ? note : n)));
    return note;
  }

  async delete(id: string): Promise<void> {
    await this.bridge.invoke('notes.delete', { id });
    this.notes.update((list) => list.filter((n) => n.id !== id));
  }

  togglePinned(note: Note): Promise<Note> {
    return this.update({ id: note.id, pinned: !note.pinned });
  }
}

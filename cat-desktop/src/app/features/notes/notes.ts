import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Note } from '../../core/models';
import { NotesService } from '../../core/services/notes.service';
import { ConfirmDialog } from '../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { RelativeTimePipe } from '../../shared/pipes/relative-time.pipe';

export const NOTE_COLORS: readonly (string | null)[] = [null, '#ffd166', '#06d6a0', '#4cc9f0', '#f8a5c2', '#c9b6ff'];

const SEARCH_DEBOUNCE_MS = 200;
const AUTOSAVE_DEBOUNCE_MS = 600;

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

@Component({
  selector: 'app-notes',
  imports: [Icon, EmptyState, ConfirmDialog, RelativeTimePipe],
  templateUrl: './notes.html',
  styleUrl: './notes.scss',
})
export class Notes {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirm = viewChild.required(ConfirmDialog);
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  protected readonly notes = inject(NotesService);
  protected readonly colors = NOTE_COLORS;

  protected readonly search = signal('');
  protected readonly selectedId = signal<string | null>(null);
  protected readonly draftTitle = signal('');
  protected readonly draftContent = signal('');
  protected readonly saveState = signal<SaveState>('clean');
  protected readonly error = signal<string | null>(null);
  /**
   * Latest known version of the open note. A search-filtered list can leave it out (a new note, or one edited so it
   * no longer matches); the editor then keeps working on this copy instead of closing mid-edit.
   */
  private readonly openNote = signal<Note | null>(null);

  protected readonly selected = computed<Note | null>(() => {
    const id = this.selectedId();
    if (!id) return null;
    const listed = this.notes.notes().find((n) => n.id === id);
    if (listed) return listed;
    const open = this.openNote();
    return open?.id === id && this.notes.query() !== '' ? open : null;
  });
  protected readonly sortedNotes = computed(() => {
    const list = this.notes.notes();
    const open = this.selected();
    const all = open && !list.some((n) => n.id === open.id) ? [open, ...list] : list;
    return [...all].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  });
  protected readonly hasSearch = computed(() => this.search().trim().length > 0);

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Id of the note whose content is currently in the draft signals. */
  private loadedId: string | null = null;

  constructor() {
    // Debounced server-side search.
    let firstRun = true;
    effect(() => {
      const query = this.search().trim();
      if (firstRun) {
        firstRun = false; // the shell already loaded the unfiltered list
        return;
      }
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.notes.refresh(query), SEARCH_DEBOUNCE_MS);
    });

    // Keep the draft in sync with the selected note unless the user has unsaved edits.
    effect(() => {
      const note = this.selected();
      untracked(() => {
        if (!note) {
          // Keep the draft bound while the selected note is only briefly missing from the list (a refresh racing a
          // create), so pending keystrokes still save; drop it once another note or none is selected.
          if (this.loadedId !== this.selectedId()) this.loadedId = null;
          return;
        }
        const switchingNote = note.id !== this.loadedId;
        if (switchingNote || this.saveState() === 'clean' || this.saveState() === 'saved') {
          this.loadedId = note.id;
          this.draftTitle.set(note.title);
          this.draftContent.set(note.content);
          if (switchingNote) this.saveState.set('clean');
        }
      });
    });

    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      if (params.get('new') === '1') {
        void this.createNote();
        return;
      }
      const id = params.get('id');
      if (id && id !== this.selectedId()) this.switchTo(id);
    });

    this.destroyRef.onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      if (this.saveTimer) clearTimeout(this.saveTimer);
      void this.flushSave();
      // Leave the shared list unfiltered for the other pages.
      if (this.hasSearch()) void this.notes.refresh();
    });
  }

  // ---- list ---------------------------------------------------------------------------------

  protected onSearch(value: string): void {
    this.search.set(value);
  }

  protected clearSearch(): void {
    this.search.set('');
  }

  protected select(note: Note): void {
    if (note.id === this.selectedId()) return;
    this.openNote.set(note);
    this.switchTo(note.id);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { id: note.id }, replaceUrl: true });
  }

  protected snippet(note: Note): string {
    const line = note.content.split('\n').find((l) => l.trim().length > 0) ?? '';
    return line.trim().slice(0, 120);
  }

  protected async createNote(): Promise<void> {
    try {
      const note = await this.notes.create({});
      this.openNote.set(note);
      this.switchTo(note.id);
      await this.router.navigate([], { relativeTo: this.route, queryParams: { id: note.id }, replaceUrl: true });
      afterNextRender(() => this.titleInput()?.nativeElement.focus(), { injector: this.injector });
      this.error.set(null);
    } catch (err) {
      this.error.set((err as Error).message ?? String(err));
    }
  }

  // ---- editor -------------------------------------------------------------------------------

  protected onTitleInput(value: string): void {
    this.draftTitle.set(value);
    this.markDirty();
  }

  protected onContentInput(value: string): void {
    this.draftContent.set(value);
    this.markDirty();
  }

  protected async setColor(color: string | null): Promise<void> {
    const note = this.selected();
    if (!note || note.color === color) return;
    await this.mutate(async () => this.remember(await this.notes.update({ id: note.id, color })));
  }

  protected async togglePin(): Promise<void> {
    const note = this.selected();
    if (!note) return;
    await this.mutate(async () => this.remember(await this.notes.togglePinned(note)));
  }

  protected async deleteSelected(): Promise<void> {
    const note = this.selected();
    if (!note) return;
    const ok = await this.confirm().open(`"${note.title || 'Untitled note'}" will be removed permanently.`, {
      title: 'Delete note?',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveState.set('clean');
    await this.mutate(async () => {
      await this.notes.delete(note.id);
      this.selectedId.set(null);
      this.openNote.set(null);
      await this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
    });
  }

  private switchTo(id: string): void {
    // Persist edits of the note we are leaving before the draft is replaced.
    if (this.saveTimer) clearTimeout(this.saveTimer);
    void this.flushSave();
    this.selectedId.set(id);
  }

  private markDirty(): void {
    this.saveState.set('dirty');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushSave(), AUTOSAVE_DEBOUNCE_MS);
  }

  private async flushSave(): Promise<void> {
    const id = this.loadedId;
    if (!id || (this.saveState() !== 'dirty' && this.saveState() !== 'error')) return;
    const payload = { id, title: this.draftTitle(), content: this.draftContent() };
    this.saveState.set('saving');
    try {
      this.remember(await this.notes.update(payload));
      // Only report on the note still being edited; edits made in flight re-marked it dirty.
      if (this.loadedId === id && this.saveState() === 'saving') this.saveState.set('saved');
      this.error.set(null);
    } catch (err) {
      if (this.loadedId === id) this.saveState.set('error');
      this.error.set((err as Error).message ?? String(err));
    }
  }

  /** Keep the fallback copy of the open note current (see `openNote`). */
  private remember(note: Note): void {
    if (note.id === this.selectedId()) this.openNote.set(note);
  }

  private async mutate(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      this.error.set(null);
    } catch (err) {
      this.error.set((err as Error).message ?? String(err));
    }
  }
}

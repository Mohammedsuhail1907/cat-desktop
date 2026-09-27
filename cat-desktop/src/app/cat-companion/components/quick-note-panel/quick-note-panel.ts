import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, output, signal, viewChild } from '@angular/core';
import { NotesService } from '../../../core/services/notes.service';
import { QuickNoteDraftService } from '../../services/quick-note-draft.service';

const TOAST_MS = 1600;

/** Capture a note without leaving what you were doing. Ctrl+Enter saves; the draft outlives the panel. */
@Component({
  selector: 'app-quick-note-panel',
  templateUrl: './quick-note-panel.html',
  styleUrl: './quick-note-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickNotePanel {
  private readonly notes = inject(NotesService);
  protected readonly draft = inject(QuickNoteDraftService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly textarea = viewChild.required<ElementRef<HTMLTextAreaElement>>('content');
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  readonly cancelled = output<void>();

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly toast = signal<string | null>(null);
  protected readonly canSave = computed(() => !this.saving() && !this.draft.isEmpty());

  constructor() {
    afterNextRender(() => this.textarea().nativeElement.focus());
    this.destroyRef.onDestroy(() => {
      if (this.toastTimer) clearTimeout(this.toastTimer);
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void this.save();
    } else if (event.key === 'Escape' && !this.draft.isEmpty()) {
      // Keep the panel open while there is typed text; the window's document-level Escape closes it.
      event.stopPropagation();
    }
  }

  /** Enter in the title continues into the body instead of submitting a title-only note. */
  protected onTitleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.isComposing) return;
    event.preventDefault();
    this.textarea().nativeElement.focus();
  }

  /** Cancel discards the draft on purpose; collapsing or switching panels keeps it. */
  protected cancel(): void {
    this.draft.clear();
    this.cancelled.emit();
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.notes.create({ title: this.draft.title().trim(), content: this.draft.body().trim() });
      this.draft.clear();
      this.showToast('Saved');
      this.textarea().nativeElement.focus();
    } catch (err) {
      this.error.set((err as Error).message ?? 'Could not save the note.');
    } finally {
      this.saving.set(false);
    }
  }

  private showToast(text: string): void {
    this.toast.set(text);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), TOAST_MS);
  }
}

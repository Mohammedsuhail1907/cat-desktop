import { Injectable, computed, signal } from '@angular/core';

const STORAGE_KEY = 'catdesktop.quickNoteDraft';

interface StoredDraft {
  title: string;
  body: string;
}

/**
 * The unsaved quick note. Lives outside QuickNotePanel so closing the companion panel, clicking the cat or
 * switching panels never throws typed text away; mirrored to localStorage so it also survives a page
 * reload. Only a successful save or the Cancel button clears it.
 */
@Injectable({ providedIn: 'root' })
export class QuickNoteDraftService {
  private readonly stored = readStored();
  private readonly titleState = signal(this.stored.title);
  private readonly bodyState = signal(this.stored.body);

  readonly title = this.titleState.asReadonly();
  readonly body = this.bodyState.asReadonly();
  readonly isEmpty = computed(() => this.title().trim().length === 0 && this.body().trim().length === 0);

  setTitle(value: string): void {
    this.titleState.set(value);
    this.persist();
  }

  setBody(value: string): void {
    this.bodyState.set(value);
    this.persist();
  }

  clear(): void {
    this.titleState.set('');
    this.bodyState.set('');
    this.persist();
  }

  private persist(): void {
    try {
      if (this.isEmpty()) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify({ title: this.title(), body: this.body() } satisfies StoredDraft));
    } catch {
      /* private mode or quota - the in-memory draft still survives closing the panel */
    }
  }
}

function readStored(): StoredDraft {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { title: '', body: '' };
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      body: typeof parsed.body === 'string' ? parsed.body : '',
    };
  } catch {
    return { title: '', body: '' };
  }
}

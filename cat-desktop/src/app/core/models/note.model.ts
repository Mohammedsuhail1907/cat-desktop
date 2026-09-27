export interface Note {
  id: string;
  title: string;
  content: string;
  color: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteCreate {
  title?: string;
  content?: string;
  color?: string | null;
  pinned?: boolean;
}

export interface NoteUpdate extends NoteCreate {
  id: string;
}

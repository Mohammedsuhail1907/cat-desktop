import { WindowKind } from './window.model';

export interface AppInfo {
  version: string;
  windowKind: WindowKind;
  devMode: boolean;
  dataDirectory: string;
  databasePath: string;
  platform: 'windows' | 'browser';
  startedAt: string;
}

export interface DataInfo {
  databasePath: string;
  sizeBytes: number;
  noteCount: number;
  taskCount: number;
  schemaVersion: number;
}

export interface ExportResult {
  cancelled: boolean;
  path?: string;
}

export interface ImportResult {
  cancelled: boolean;
  notes: number;
  tasks: number;
}

export interface NotificationRequest {
  title: string;
  body: string;
  silent?: boolean;
}

/** Injected by the host before any script runs (contract §1). */
export interface CatDesktopEnvironment {
  hosted: boolean;
  windowKind: WindowKind;
  version: string;
  devMode: boolean;
}

export type FocusPhase = 'focus' | 'shortBreak' | 'longBreak';
export type FocusStatus = 'idle' | 'running' | 'paused' | 'completed';

export interface FocusSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
  autoStartBreaks: boolean;
  autoStartFocus: boolean;
  notify: boolean;
  sound: boolean;
}

export const DEFAULT_FOCUS_SETTINGS: FocusSettings = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
  autoStartBreaks: false,
  autoStartFocus: false,
  notify: true,
  sound: true,
};

export interface FocusState {
  phase: FocusPhase;
  status: FocusStatus;
  remainingSeconds: number;
  totalSeconds: number;
  completedFocusSessions: number;
  startedAt: string | null;
  endsAt: string | null;
}

export const IDLE_FOCUS_STATE: FocusState = {
  phase: 'focus',
  status: 'idle',
  remainingSeconds: 25 * 60,
  totalSeconds: 25 * 60,
  completedFocusSessions: 0,
  startedAt: null,
  endsAt: null,
};

export interface FocusStats {
  todayFocusSessions: number;
  todayFocusMinutes: number;
  totalFocusSessions: number;
  totalFocusMinutes: number;
}

export interface FocusCompleted {
  phase: FocusPhase;
  next: FocusPhase;
}

export interface FocusStartRequest {
  phase?: FocusPhase;
  minutes?: number;
}

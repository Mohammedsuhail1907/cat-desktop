export type QuickActionType =
  | 'navigate'
  | 'quick-note'
  | 'tasks'
  | 'focus'
  | 'reminders'
  | 'pin'
  | 'search'
  | 'settings'
  | 'custom';

/** Configurable quick action shown in the cat's companion panel (contract §3 actions.*). 'pin' toggles always-on-top. */
export interface QuickAction {
  id: string;
  name: string;
  icon: string;
  enabled: boolean;
  order: number;
  route?: string;
  actionType: QuickActionType;
  payload?: Record<string, unknown>;
}

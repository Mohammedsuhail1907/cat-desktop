import { Routes } from '@angular/router';

/**
 * Hash routing (see app.config.ts) so the packaged build works from a static folder:
 *   main window  → …/index.html#/dashboard
 *   cat window   → …/index.html#/cat
 */
export const routes: Routes = [
  {
    path: 'cat',
    title: 'Cat',
    loadComponent: () => import('./cat-companion/cat-companion-window').then((m) => m.CatCompanionWindow),
  },
  {
    path: '',
    loadComponent: () => import('./layout/shell/shell').then((m) => m.Shell),
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      { path: 'dashboard', title: 'Dashboard', loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard) },
      { path: 'notes', title: 'Notes', loadComponent: () => import('./features/notes/notes').then((m) => m.Notes) },
      { path: 'tasks', title: 'Tasks', loadComponent: () => import('./features/tasks/tasks').then((m) => m.Tasks) },
      { path: 'focus', title: 'Focus', loadComponent: () => import('./features/focus/focus').then((m) => m.Focus) },
      { path: 'settings', title: 'Settings', loadComponent: () => import('./features/settings/settings').then((m) => m.Settings) },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];

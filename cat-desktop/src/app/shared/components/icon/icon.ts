import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Inline stroke icons (24x24 viewBox, currentColor, 1.8 stroke). Every icon is a list of SVG
 * path strings so no HTML sanitiser bypass is needed; circles are expressed as arc commands.
 */
const ICONS: Record<string, readonly string[]> = {
  home: ['M3 11l9-8 9 8', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
  note: ['M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  tasks: ['M3.5 6l1.5 1.5L7.5 5', 'M3.5 12l1.5 1.5 2.5-2.5', 'M3.5 18l1.5 1.5 2.5-2.5', 'M11 6h9.5', 'M11 12h9.5', 'M11 18h9.5'],
  timer: ['M12 6a8 8 0 1 0 0 16 8 8 0 1 0 0-16z', 'M12 10v4l2.5 2.5', 'M9 2h6', 'M12 2v4'],
  bell: ['M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7', 'M10 20a2 2 0 0 0 4 0'],
  pin: ['M9 3h6l-1 7 3 3v1H7v-1l3-3z', 'M12 14v7'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 1 0 0-14z', 'M20 20l-3.5-3.5'],
  settings: [
    'M10.05 4.66L10.41 2.13L13.59 2.13L13.95 4.66L15.81 5.43L17.85 3.89L20.11 6.15L18.57 8.19L19.34 10.05L21.87 10.41L21.87 13.59L19.34 13.95L18.57 15.81L20.11 17.85L17.85 20.11L15.81 18.57L13.95 19.34L13.59 21.87L10.41 21.87L10.05 19.34L8.19 18.57L6.15 20.11L3.89 17.85L5.43 15.81L4.66 13.95L2.13 13.59L2.13 10.41L4.66 10.05L5.43 8.19L3.89 6.15L6.15 3.89L8.19 5.43z',
    'M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 1 0 0-6.4z',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v5', 'M14 11v5'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  play: ['M7 5v14l11-7z'],
  pause: ['M8 5v14', 'M16 5v14'],
  stop: ['M6 6h12v12H6z'],
  skip: ['M5 5v14l10-7z', 'M19 5v14'],
  refresh: ['M4 12a8 8 0 0 1 13.66-5.66L20 8', 'M20 3v5h-5', 'M20 12a8 8 0 0 1-13.66 5.66L4 16', 'M4 21v-5h5'],
  cat: ['M4 12V4.5L8.8 8h6.4L20 4.5V12', 'M20 12a8 8 0 0 1-16 0', 'M9 13h.01', 'M15 13h.01', 'M11 16h2', 'M2 15h3', 'M19 15h3'],
  paw: [
    'M6.5 8.1a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 1 0 0-3.8z',
    'M10 4.6a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 1 0 0-3.8z',
    'M14 4.6a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 1 0 0-3.8z',
    'M17.5 8.1a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 1 0 0-3.8z',
    'M12 12c-3 0-6 3-6 6a3 3 0 0 0 3 3c1.2 0 2-.6 3-.6s1.8.6 3 .6a3 3 0 0 0 3-3c0-3-3-6-6-6z',
  ],
  sparkles: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z', 'M5 2.5l.6 1.4 1.4.6-1.4.6L5 6.5l-.6-1.4L3 4.5l1.4-.6z'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-up': ['M6 15l6-6 6 6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6'],
  folder: ['M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M4 19h16'],
  upload: ['M12 15V4', 'M7 9l5-5 5 5', 'M4 19h16'],
  keyboard: ['M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M7 10h.01', 'M10.5 10h.01', 'M14 10h.01', 'M17.5 10h.01', 'M8 14h8'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8z', 'M12 2v2', 'M12 20v2', 'M2 12h2', 'M20 12h2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  monitor: ['M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M8 20h8', 'M12 16v4'],
  resize: ['M14 4h6v6', 'M20 4l-6.5 6.5', 'M10 20H4v-6', 'M4 20l6.5-6.5'],
  move: ['M12 3v18', 'M3 12h18', 'M9 6l3-3 3 3', 'M9 18l3 3 3-3', 'M6 9l-3 3 3 3', 'M18 9l3 3-3 3'],
  drag: ['M9 5a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', 'M15 5a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', 'M9 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', 'M15 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', 'M9 17a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', 'M15 17a1 1 0 1 0 0 2 1 1 0 1 0 0-2z'],
  more: ['M5 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', 'M12 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', 'M19 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2z'],
  edit: ['M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z', 'M13.5 6.5l3 3'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z'],
  'eye-off': ['M3 3l18 18', 'M10.6 10.6a3 3 0 0 0 4.2 4.2', 'M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.3-1', 'M9.9 5.8A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4'],
  'arrow-up': ['M12 19V5', 'M6 11l6-6 6 6'],
  'arrow-down': ['M12 5v14', 'M6 13l6 6 6-6'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z', 'M12 11v5', 'M12 8h.01'],
  calendar: ['M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  flag: ['M5 21V4', 'M5 4h12l-2 4 2 4H5'],
  database: ['M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z', 'M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6', 'M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z', 'M12 7v5l3 2'],
  palette: ['M12 3a9 9 0 0 0 0 18c1.4 0 2-.9 2-2 0-.6-.3-1-.3-1.5 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4c0-5-4-9-9-9z', 'M7.5 11h.01', 'M10.5 7.5h.01', 'M15 7.5h.01'],
  volume: ['M4 10v4h3l4 3V7l-4 3z', 'M15 9.5a3.5 3.5 0 0 1 0 5', 'M17.5 7a7 7 0 0 1 0 10'],
  save: ['M5 4h11l3 3v13H5z', 'M8 4v5h7V4', 'M8 20v-6h8v6'],
  window: ['M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M3 9h18'],
  warning: ['M12 3.5l9.5 16.5H2.5z', 'M12 10v4', 'M12 17.5h.01'],
};

const FALLBACK: readonly string[] = ['M12 10a2 2 0 1 0 0 4 2 2 0 1 0 0-4z'];

/** Names that can be used with `<app-icon>`; also offered in the quick-action icon picker. */
export const ICON_NAMES: readonly string[] = Object.keys(ICONS);

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      line-height: 0;
      vertical-align: middle;
    }
  `,
})
export class Icon {
  readonly name = input.required<string>();
  readonly size = input(20);

  protected readonly paths = computed(() => ICONS[this.name()] ?? FALLBACK);
}

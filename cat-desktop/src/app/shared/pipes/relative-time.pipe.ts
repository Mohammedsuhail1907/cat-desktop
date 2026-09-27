import { Pipe, PipeTransform } from '@angular/core';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Human-friendly relative timestamp: "just now", "5 min ago", "yesterday", "3 days ago", "12 Mar". */
export function relativeTime(value: string | Date | null | undefined, now: number = Date.now()): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return '';

  const diff = now - time;
  if (diff < 0) return formatFuture(-diff, date, now);
  if (diff < 45_000) return 'just now';
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))} min ago`;
  if (diff < DAY && sameDay(date, new Date(now))) return `${Math.round(diff / HOUR)} h ago`;

  const days = calendarDaysBetween(date, new Date(now));
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 365) return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatFuture(ahead: number, date: Date, now: number): string {
  if (ahead < MINUTE) return 'in a moment';
  if (ahead < HOUR) return `in ${Math.round(ahead / MINUTE)} min`;
  if (sameDay(date, new Date(now))) return `in ${Math.round(ahead / HOUR)} h`;
  const days = calendarDaysBetween(new Date(now), date);
  if (days <= 1) return 'tomorrow';
  if (days < 7) return `in ${days} days`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function calendarDaysBetween(earlier: Date, later: Date): number {
  const a = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate()).getTime();
  const b = new Date(later.getFullYear(), later.getMonth(), later.getDate()).getTime();
  return Math.round((b - a) / DAY);
}

@Pipe({ name: 'relativeTime' })
export class RelativeTimePipe implements PipeTransform {
  transform(value: string | Date | null | undefined): string {
    return relativeTime(value);
  }
}

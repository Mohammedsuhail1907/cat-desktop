import { Pipe, PipeTransform } from '@angular/core';
import { formatSeconds } from '../../core/services/focus-timer.service';

/** Seconds → "m:ss" (or "h:mm:ss" past an hour). */
@Pipe({ name: 'duration' })
export class DurationPipe implements PipeTransform {
  transform(seconds: number | null | undefined): string {
    return formatSeconds(seconds ?? 0);
  }
}

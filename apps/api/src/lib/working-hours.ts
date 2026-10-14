/**
 * Working-hours arithmetic for SLA deadlines (PRD §14a: "the UI shows a computed deadline, not a raw duration").
 *
 * The window is plain config (`app_config['sla'].working_hours_windows`), not code:
 *   { utc_offset_minutes: 300, days: [1..6] (ISO, Mon=1…Sun=7), start_minute: 540, end_minute: 1080 }
 * Pakistan has had no DST since 2009, so a fixed offset is exact there; revisit before reusing this elsewhere.
 */
export interface WorkingWindows {
  utc_offset_minutes: number;
  days: number[];
  start_minute: number;
  end_minute: number;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const valid = (w: WorkingWindows): boolean =>
  Array.isArray(w.days) && w.days.some((d) => d >= 1 && d <= 7) &&
  Number.isInteger(w.start_minute) && Number.isInteger(w.end_minute) &&
  w.start_minute >= 0 && w.end_minute <= 1440 && w.end_minute > w.start_minute;

/**
 * `from` + `hours` of WORKING time. Time outside the window (nights, off days) does not count.
 * A malformed window falls back to plain elapsed hours rather than looping forever or failing a
 * support message — a wrong deadline is recoverable, a lost message is not.
 */
export function addWorkingHours(from: Date, hours: number, w: WorkingWindows): Date {
  if (!valid(w)) return new Date(from.getTime() + hours * 60 * MIN);

  let remaining = Math.round(hours * 60); // minutes
  let t = from.getTime() + w.utc_offset_minutes * MIN; // "local clock" as if it were UTC
  // Bounded: at most a couple of weeks of days are ever walked for realistic SLAs.
  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    const dayStart = Math.floor(t / DAY) * DAY;
    const isoDow = ((new Date(dayStart).getUTCDay() + 6) % 7) + 1;
    const minuteOfDay = Math.floor((t - dayStart) / MIN);
    if (w.days.includes(isoDow) && minuteOfDay < w.end_minute) {
      const start = Math.max(minuteOfDay, w.start_minute);
      const available = w.end_minute - start;
      const used = Math.min(available, remaining);
      remaining -= used;
      t = dayStart + (start + used) * MIN;
      if (remaining === 0) break;
    }
    t = dayStart + DAY + w.start_minute * MIN; // next day's opening
  }
  return new Date(t - w.utc_offset_minutes * MIN);
}

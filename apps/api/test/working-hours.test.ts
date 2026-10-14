import { describe, expect, it } from 'vitest';
import { addWorkingHours, type WorkingWindows } from '../src/lib/working-hours.js';

// Mon–Sat 09:00–18:00 in UTC+5 (Pakistan).
const W: WorkingWindows = { utc_offset_minutes: 300, days: [1, 2, 3, 4, 5, 6], start_minute: 540, end_minute: 1080 };
/** "2030-01-07 10:00 PKT" → Date (2030-01-07 is a Monday). */
const pkt = (s: string) => new Date(new Date(`${s.replace(' ', 'T')}:00Z`).getTime() - 300 * 60_000);
const show = (d: Date) => new Date(d.getTime() + 300 * 60_000).toISOString().slice(0, 16).replace('T', ' ');

describe('addWorkingHours (PRD §14a)', () => {
  it('inside the window it is plain elapsed time', () => {
    expect(show(addWorkingHours(pkt('2030-01-07 10:00'), 2, W))).toBe('2030-01-07 12:00');
  });

  it('time after closing rolls to the next opening', () => {
    expect(show(addWorkingHours(pkt('2030-01-07 17:00'), 2, W))).toBe('2030-01-08 10:00'); // 1h Mon + 1h Tue
  });

  it('before opening starts at opening; after closing starts next morning', () => {
    expect(show(addWorkingHours(pkt('2030-01-07 06:00'), 1, W))).toBe('2030-01-07 10:00');
    expect(show(addWorkingHours(pkt('2030-01-07 20:00'), 1, W))).toBe('2030-01-08 10:00');
  });

  it('Sunday does not count: Saturday 17:30 + 1h → Monday 09:30', () => {
    expect(show(addWorkingHours(pkt('2030-01-05 17:30'), 1, W))).toBe('2030-01-07 09:30');
  });

  it('a Sunday submission starts Monday morning', () => {
    expect(show(addWorkingHours(pkt('2030-01-06 11:00'), 2, W))).toBe('2030-01-07 11:00');
  });

  it('24 working hours from Monday 10:00 = 8h Mon + 9h Tue + 7h Wed → Wednesday 16:00', () => {
    expect(show(addWorkingHours(pkt('2030-01-07 10:00'), 24, W))).toBe('2030-01-09 16:00');
  });

  it('48 working hours spans a Sunday', () => {
    // Fri 10:00: 8h Fri + 9h Sat (17) + [Sun off] 9h Mon (26) + 9h Tue (35) + 9h Wed (44) + 4h Thu → Thu 13:00
    expect(show(addWorkingHours(pkt('2030-01-04 10:00'), 48, W))).toBe('2030-01-10 13:00');
  });

  it('exactly reaching closing time stays on that day', () => {
    expect(show(addWorkingHours(pkt('2030-01-07 10:00'), 8, W))).toBe('2030-01-07 18:00');
  });

  it('is monotonic in hours and never earlier than the start', () => {
    const start = pkt('2030-01-08 13:20');
    let prev = start.getTime();
    for (let h = 0; h <= 60; h += 3) {
      const t = addWorkingHours(start, h, W).getTime();
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('a malformed window degrades to elapsed hours instead of looping or throwing', () => {
    const start = pkt('2030-01-07 10:00');
    for (const bad of [{ ...W, days: [] }, { ...W, end_minute: 100 }, { ...W, days: [9] }, { ...W, start_minute: -5 }]) {
      expect(addWorkingHours(start, 5, bad).getTime()).toBe(start.getTime() + 5 * 3_600_000);
    }
  });
});

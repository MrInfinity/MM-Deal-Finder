// Store opening hours: normalize the formats each dispensary uses, and answer "is it open now?"
// in the store's own time zone (the western Panhandle is on Central time).
import type { Store, WeekHours } from './types.ts';

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = typeof DAYS[number];

/** "9:00 am" / "9:00AM" / "9 pm" → "09:00" / "21:00" */
export function to24h(s: string): string | null {
  const m = String(s).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3] === 'pm') h += 12;
  return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`;
}

/** "9:00 am - 8:45 pm" → [["09:00","20:45"]]; "Closed" → []; unparseable → null */
export function parseRange(s: string | null | undefined): Array<[string, string]> | null {
  if (s == null) return null;
  if (/closed/i.test(s)) return [];
  const m = String(s).match(/(\d{1,2}(?::\d{2})?\s*[ap]m)\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*[ap]m)/i);
  if (!m) return null;
  const a = to24h(m[1]), b = to24h(m[2]);
  return a && b ? [[a, b]] : null;
}

/** Florida time zone by location, unless the source says otherwise. */
export function storeTimeZone(store: Pick<Store, 'lat' | 'lng' | 'tz'>): string {
  if (store.tz) return store.tz;
  // Central time west of the Apalachicola River; coastal Gulf County (Port St. Joe) stays Eastern.
  if (store.lng < -85.0 && !(store.lat < 29.92 && store.lng > -85.4)) return 'America/Chicago';
  return 'America/New_York';
}

function localParts(date: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export function fmtTime(hhmm: string): string {
  const m = mins(hhmm), h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

export interface OpenStatus { open: boolean; label: string; closingSoon?: boolean }

/** null when the store's hours are unknown. */
export function openStatus(store: Pick<Store, 'hours' | 'lat' | 'lng' | 'tz'>, now: Date = new Date()): OpenStatus | null {
  const hours = store.hours;
  if (!hours || !DAYS.some((d) => hours[d]?.length)) return null;
  const { day, minutes } = localParts(now, storeTimeZone(store));
  if (day < 0) return null;
  for (const [o, c] of hours[DAYS[day]] ?? []) {
    const open = mins(o), close = mins(c) <= open ? mins(c) + 1440 : mins(c);
    if (minutes >= open && minutes < close) {
      const left = close - minutes;
      return { open: true, closingSoon: left <= 60, label: left <= 60 ? `Closes soon · ${fmtTime(c)}` : `Open · closes ${fmtTime(c)}` };
    }
  }
  // Next opening within a week.
  for (let i = 0; i < 7; i++) {
    const d = (day + i) % 7;
    const slots = [...(hours[DAYS[d]] ?? [])].sort((a, b) => mins(a[0]) - mins(b[0]));
    for (const [o] of slots) {
      if (i === 0 && mins(o) <= minutes) continue;
      const when = i === 0 ? '' : i === 1 ? 'tomorrow ' : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]} `;
      return { open: false, label: `Closed · opens ${when}${fmtTime(o)}` };
    }
  }
  return { open: false, label: 'Closed' };
}

export function isOpenNow(store: Pick<Store, 'hours' | 'lat' | 'lng' | 'tz'>, now?: Date): boolean {
  return openStatus(store, now)?.open === true;
}

export function emptyWeek(): WeekHours { return { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] }; }

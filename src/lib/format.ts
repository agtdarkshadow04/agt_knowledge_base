/**
 * Dates, times and numbers through `Intl`, in the reader's language and time
 * zone (I18N-5). The time zone is `auto` (the browser's) or a fixed UTC offset.
 */

/** The fixed offsets the settings dialog offers, from UTC−12:00 to UTC+14:00, with the half and quarter hours in use. */
export const TIME_ZONE_OFFSETS = [
  '-12:00', '-11:00', '-10:00', '-09:30', '-09:00', '-08:00', '-07:00', '-06:00', '-05:00', '-04:00', '-03:30', '-03:00',
  '-02:00', '-01:00', '+00:00', '+01:00', '+02:00', '+03:00', '+03:30', '+04:00', '+04:30', '+05:00', '+05:30', '+05:45',
  '+06:00', '+06:30', '+07:00', '+08:00', '+08:45', '+09:00', '+09:30', '+10:00', '+10:30', '+11:00', '+12:00', '+12:45',
  '+13:00', '+14:00',
] as const;

export type TimeZoneSetting = 'auto' | typeof TIME_ZONE_OFFSETS[number];

export function isTimeZoneSetting(value: unknown): value is TimeZoneSetting {
  return value === 'auto' || (TIME_ZONE_OFFSETS as readonly unknown[]).includes(value);
}

export interface FormatOptions {
  /** A BCP 47 tag (`pt-BR` for `pt`, I18N-1). */
  tag: string;
  timeZone: TimeZoneSetting;
}

function zone(timeZone: TimeZoneSetting) {
  return timeZone === 'auto' ? undefined : timeZone;
}

function valid(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A date and time with its UTC offset, e.g. `2 Jan 2026, 14:30 GMT+1`. */
export function formatDateTime(value: string | Date, { tag, timeZone }: FormatOptions) {
  const date = valid(value);
  if (!date) return String(value);
  return new Intl.DateTimeFormat(tag, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: zone(timeZone), timeZoneName: 'shortOffset',
  }).format(date);
}

/** A date alone, e.g. `2 Jan 2026`. */
export function formatDate(value: string | Date, { tag, timeZone }: FormatOptions) {
  const date = valid(value);
  if (!date) return String(value);
  return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: zone(timeZone) }).format(date);
}

export function formatNumber(value: number, { tag }: Pick<FormatOptions, 'tag'>) {
  return new Intl.NumberFormat(tag).format(value);
}

/** A byte count in the largest unit that keeps it above 1 (`1.5 MB`), with the locale's digits and unit names. */
export function formatBytes(value: number, { tag }: Pick<FormatOptions, 'tag'>) {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let amount = value;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(tag, { style: 'unit', unit: units[unit], unitDisplay: 'short', maximumFractionDigits: unit === 0 ? 0 : 1 }).format(amount);
}

/** The offset as the settings dialog shows it, e.g. `UTC+05:30`. */
export function offsetLabel(offset: typeof TIME_ZONE_OFFSETS[number]) {
  return `UTC${offset.replace('-', '−')}`;
}

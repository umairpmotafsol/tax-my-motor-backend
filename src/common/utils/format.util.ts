/**
 * The formatting the three front ends already agree on, moved to the
 * one place that now owns the data. A registration stored one way and
 * displayed another is how "AB12CDE" and "AB12 CDE" end up as two
 * different vehicles.
 */

/** "ab12 cde" -> "AB12CDE". The storage form. */
export function normaliseReg(reg: string): string {
  return (reg ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "AB12CDE" -> "AB12 CDE". The display form. */
export function formatReg(reg: string): string {
  const bare = normaliseReg(reg);
  const current = /^([A-Z]{2}\d{2})([A-Z]{3})$/.exec(bare);
  return current ? current[1] + ' ' + current[2] : bare;
}

/** UK plates run 2-8 characters once spacing is removed. */
export function isValidReg(reg: string): boolean {
  const bare = normaliseReg(reg);
  return bare.length >= 2 && bare.length <= 8;
}

export const gbp = (amount: number): string => '£' + Number(amount).toFixed(2);

/** Money is rounded to the penny before it is stored, never after. */
export const toPence = (amount: number): number => Math.round(amount * 100) / 100;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "31 Aug 2026" — the order-date format every screen shows. */
export function formatOrderDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  return day + ' ' + MONTHS[date.getMonth()] + ' ' + date.getFullYear();
}

/** "28 / 08 / 2026" — the spacing the printed V62 form uses. */
export function formatV62Date(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return dd + ' / ' + mm + ' / ' + date.getFullYear();
}

export function initials(name: string): string {
  return (name ?? '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0].toUpperCase())
    .join('');
}

/** Same calendar day — what the admin's "today" filters mean. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Midnight this morning, for "today" queries. */
export function startOfDay(date: Date = new Date()): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

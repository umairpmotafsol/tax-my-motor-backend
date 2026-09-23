import { BANK_FIELDS, BankField } from '../enums/bank.enum';

/**
 * The same mandate rules the customer app applies as you type, enforced
 * again here. The client check is a courtesy; this one is the rule —
 * a sort code with five digits is a typo, not a judgement call, and
 * sending it round the supplier review loop wastes everybody's turn.
 */
export type BankDetailsInput = Record<BankField, string>;

/** Typed straight through, so both of these format as you go. */
export function formatSortCode(value: string): string {
  return value
    .replace(/\D/g, '')
    .slice(0, 6)
    .replace(/(\d{2})(?=\d)/g, '$1-');
}

export function formatDob(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join('/');
}

/**
 * DD/MM/YYYY, and a date that exists — 31/02/1990 parses in JavaScript
 * by rolling over into March, so the round-trip is what catches it.
 */
export function parseDob(value: string): Date | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, dd, mm, yyyy] = match;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  const roundTrips =
    date.getFullYear() === Number(yyyy) &&
    date.getMonth() === Number(mm) - 1 &&
    date.getDate() === Number(dd);
  return roundTrips ? date : null;
}

/** Whole years old, birthday-aware. */
export function ageFrom(dob: Date, on: Date = new Date()): number {
  const years = on.getFullYear() - dob.getFullYear();
  const beforeBirthday =
    on.getMonth() < dob.getMonth() ||
    (on.getMonth() === dob.getMonth() && on.getDate() < dob.getDate());
  return beforeBirthday ? years - 1 : years;
}

export function bankFieldValid(field: BankField, value: string): boolean {
  const trimmed = (value ?? '').trim();
  switch (field) {
    case BankField.AccountHolder:
      return trimmed.length > 2;
    case BankField.AccountNumber:
      return /^\d{8}$/.test(trimmed);
    case BankField.SortCode:
      return /^\d{2}-\d{2}-\d{2}$/.test(trimmed);
    case BankField.DateOfBirth: {
      const dob = parseDob(trimmed);
      // A Direct Debit mandate has to be signed by an adult.
      return !!dob && ageFrom(dob) >= 18 && ageFrom(dob) < 120;
    }
    default:
      return false;
  }
}

/** Every field that is wrong, in the order they appear on screen. */
export function bankProblems(bank: Partial<BankDetailsInput>): BankField[] {
  return BANK_FIELDS.filter(field => !bankFieldValid(field, bank[field] ?? ''));
}

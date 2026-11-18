/**
 * Reading a registration (VRM) off a photographed DVLA tax receipt, and
 * deciding whether it is the vehicle the order is for.
 *
 * The receipt prints it on its own line — "VRM: RJ63HXD" — so that label
 * is what we look for first. OCR is not exact, though: on the receipt this
 * was built from, Tesseract read the 6 in RJ63HXD as a B (PaddleOCR, the
 * engine now in use, gets it right). Any engine will now and then swap
 * characters that look alike, and a plain string comparison would reject
 * the right receipt, so the comparison treats look-alike characters as
 * equal — a safety net that costs nothing when the reading is clean. The price of that is a receipt
 * for another car that differs from this one only by look-alikes would
 * pass; that is a far smaller risk than turning away good receipts, and
 * the pairs are kept deliberately few.
 *
 * Pure functions, no OCR in here, so the matching is tested on its own.
 */

/** Characters OCR commonly swaps for one another. Each pair is symmetric. */
const LOOK_ALIKES: ReadonlyArray<readonly [string, string]> = [
  ['0', 'O'],
  ['0', 'D'],
  ['0', 'Q'],
  ['O', 'Q'],
  ['1', 'I'],
  ['1', 'L'],
  ['I', 'L'],
  ['2', 'Z'],
  ['5', 'S'],
  ['6', 'G'],
  ['6', 'B'],
  ['8', 'B'],
];

const CONFUSABLE = new Set<string>(LOOK_ALIKES.flatMap(([a, b]) => [a + b, b + a]));

/** A UK registration is 2 to 8 characters with no spaces once normalised. */
const MIN_VRM = 4;
const MAX_VRM = 8;

export type ReceiptVerdict =
  | { status: 'match'; vrm: string }
  | { status: 'mismatch'; vrm: string }
  | { status: 'unreadable' };

/** Upper case, letters and digits only: "rj63 hxd" -> "RJ63HXD". */
export function normaliseVrm(value: string): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameChar(a: string, b: string): boolean {
  return a === b || CONFUSABLE.has(a + b);
}

/** Equal length, and every character equal or a look-alike of its partner. */
export function vrmsMatch(expected: string, found: string): boolean {
  const a = normaliseVrm(expected);
  const b = normaliseVrm(found);
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (!sameChar(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

/**
 * What follows a "VRM" label, if the text has one. The label itself is
 * matched loosely (OCR turns the M into an H now and then), and only the
 * rest of that one line is taken.
 */
function labelled(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const hit = /\bV[RK][MHN]\b\W*(.*)$/i.exec(line);
    if (hit) {
      const value = normaliseVrm(hit[1]);
      if (value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

/** Whether `expected` appears anywhere in the text, look-alikes allowed. */
function appearsIn(text: string, expected: string): boolean {
  const want = normaliseVrm(expected);
  if (want.length < MIN_VRM) {
    return false;
  }
  return text.split(/\r?\n/).some(line => {
    const compact = normaliseVrm(line);
    for (let start = 0; start + want.length <= compact.length; start += 1) {
      if (vrmsMatch(want, compact.slice(start, start + want.length))) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Compares the receipt's text with the order's registration.
 *
 * - `match`      the receipt names this vehicle.
 * - `mismatch`   it clearly names a different one (`vrm` is what it said).
 * - `unreadable` no registration could be found, or what was found is not
 *                the shape of one. The supplier is asked to retake, not
 *                told the receipt is wrong.
 */
export function checkReceipt(text: string, expectedReg: string): ReceiptVerdict {
  const expected = normaliseVrm(expectedReg);
  const found = labelled(text ?? '');

  if (found && found.length >= MIN_VRM && found.length <= MAX_VRM + 2) {
    /* A stray character or two after the plate is OCR noise, not part of it. */
    const trimmed = found.length > expected.length ? found.slice(0, expected.length) : found;
    return vrmsMatch(expected, trimmed)
      ? { status: 'match', vrm: expected }
      : { status: 'mismatch', vrm: found.slice(0, MAX_VRM) };
  }

  /* No usable label: good enough if this vehicle's plate is there anyway. */
  if (appearsIn(text ?? '', expected)) {
    return { status: 'match', vrm: expected };
  }
  return { status: 'unreadable' };
}

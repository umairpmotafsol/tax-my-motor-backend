/**
 * A person's name, kept two ways.
 *
 * Customers give a first and a last name. `name`, the two joined, is
 * still stored beside them because everything that only needs to show
 * or search a name (orders, the V62, emails, the supplier app) reads
 * that one field.
 */
export interface NameParts {
  firstName: string;
  lastName: string;
}

/** "Alex Morgan" from its parts, without a stray space when one is blank. */
export function joinName(firstName?: string | null, lastName?: string | null): string {
  return [firstName, lastName]
    .map(part => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * The parts of a name that was only ever stored whole: the first word,
 * then everything after it. "Mary Ann Smith" reads as "Mary" and
 * "Ann Smith", which is the less wrong guess for a UK name.
 */
export function splitName(full?: string | null): NameParts {
  const words = (full ?? '').trim().split(/\s+/).filter(Boolean);
  return { firstName: words[0] ?? '', lastName: words.slice(1).join(' ') };
}

/**
 * The parts for a record that may predate them: the stored parts when
 * there are any, otherwise read from the whole name.
 */
export function nameParts(record: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): NameParts {
  if (record.firstName || record.lastName) {
    return { firstName: record.firstName ?? '', lastName: record.lastName ?? '' };
  }
  return splitName(record.name);
}

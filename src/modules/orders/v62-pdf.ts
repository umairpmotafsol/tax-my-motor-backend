import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

import { normaliseReg } from '../../common/utils/format.util';
import { V62Submission } from './schemas/order.schema';

/**
 * The DVLA V62, filled in.
 *
 * The page is a scan of the blank form (rev. 11/25) with the answers
 * drawn over it, so what an admin downloads is the form DVLA expects
 * rather than a summary of it. Every position below is in PDF points
 * from the bottom-left corner of an A4 page, and was measured against
 * that scan — a new revision of the form means a new scan and a pass
 * over these numbers, nothing else.
 */
const PAGE = { width: 595.276, height: 841.89 };
const INK = rgb(0.12, 0.12, 0.12);

/** A row of one-character boxes: where the first is centred, and how far apart they sit. */
interface Comb {
  y: number;
  first: number;
  step: number;
  boxes: number;
  size: number;
}

const REG: Comb = { y: 753.62, first: 177.63, step: 15.6, boxes: 7, size: 16 };
const VIN: Comb = { y: 654.87, first: 194.35, step: 12.2, boxes: 17, size: 12 };
const HOUSE_NUMBER: Comb = { y: 484.24, first: 86.97, step: 15.6, boxes: 4, size: 10 };
const POSTCODE: Comb = { y: 426.93, first: 67.43, step: 15.7, boxes: 8, size: 13 };
const PHONE: Comb = { y: 404.05, first: 140.77, step: 15.63, boxes: 16, size: 12 };

/** DD MM YYYY, in three groups of boxes with a gap between them. */
const DATE_ACQUIRED = {
  y: 351.47,
  centres: [178.39, 192.99, 212.39, 226.99, 250.39, 264.99, 279.59, 294.19],
};
const DATE_SIGNED = {
  y: 55.96,
  centres: [266.62, 281.22, 300.62, 315.22, 338.62, 353.22, 367.82, 382.42],
};

const TITLE_Y = 590.48;
const TITLE_BOX: Record<string, number> = { MR: 69, MRS: 107.35, MISS: 148.8, MS: 182.7 };

/** The right-hand column of tick boxes in sections 3 and 4. */
const TICK_X = 383.67;
const REASON_Y = { bought: 280.97, lost: 260.78, other: 240.5 };

/*
 * Beside the compiled code, where the build copies it (nest-cli.json,
 * `assets`) — and failing that in the source tree, which is where it is
 * for a watch-mode server started before that setting existed.
 */
const TEMPLATE_PATHS = [
  join(__dirname, 'assets', 'v62-form.jpg'),
  join(process.cwd(), 'src', 'modules', 'orders', 'assets', 'v62-form.jpg'),
];

let template: Promise<Buffer> | null = null;

/** Read once and kept: the scan is half a megabyte and never changes while the process runs. */
function loadTemplate(): Promise<Buffer> {
  template ??= readFile(TEMPLATE_PATHS[0]).catch(() => readFile(TEMPLATE_PATHS[1]));
  /* A failed read is not remembered, so a fixed deploy recovers without a restart. */
  template.catch(() => {
    template = null;
  });
  return template;
}

/**
 * What the form's typeface can draw, in the capitals the form asks for.
 *
 * The standard PDF fonts cover Latin-1 and throw on anything else, so
 * accents are folded to their base letter and what is left over is
 * dropped — a name DVLA's own boxes could not take either.
 */
function ink(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class Sheet {
  constructor(
    private readonly page: PDFPage,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {}

  /** One line of handwriting-style text, shrunk to fit the rule it sits on. */
  line(text: string, x: number, y: number, size: number, maxWidth: number): void {
    const value = ink(text);
    if (!value) {
      return;
    }
    let fitted = size;
    while (fitted > 6 && this.regular.widthOfTextAtSize(value, fitted) > maxWidth) {
      fitted -= 0.5;
    }
    this.page.drawText(value, { x, y, size: fitted, font: this.regular, color: INK });
  }

  /** One character, centred on `centre`. */
  private char(char: string, centre: number, y: number, size: number, font: PDFFont): void {
    const width = font.widthOfTextAtSize(char, size);
    this.page.drawText(char, { x: centre - width / 2, y, size, font, color: INK });
  }

  /** A value written one character to a box. `alignRight` fills from the last box backwards. */
  comb(text: string, comb: Comb, options: { bold?: boolean; alignRight?: boolean } = {}): void {
    const chars = [...ink(text).replace(/\s/g, '')].slice(0, comb.boxes);
    const offset = options.alignRight ? comb.boxes - chars.length : 0;
    chars.forEach((char, index) =>
      this.char(
        char,
        comb.first + (index + offset) * comb.step,
        comb.y,
        comb.size,
        options.bold ? this.bold : this.regular,
      ),
    );
  }

  /** "26/09/2018" or "28 / 08 / 2026" — only the eight digits are drawn. */
  date(value: string, at: { y: number; centres: number[] }): void {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (digits.length !== 8) {
      return;
    }
    [...digits].forEach((digit, index) =>
      this.char(digit, at.centres[index], at.y, 13, this.regular),
    );
  }

  tick(centre: number, y: number): void {
    this.char('X', centre, y, 14, this.regular);
  }
}

/**
 * "40 California Road" -> the house number DVLA wants in its own boxes,
 * and the rest. An address that does not open with a number — a named
 * house, a business — goes on the address line whole.
 */
export function splitHouseNumber(address: string): { houseNumber: string; rest: string } {
  const match = /^(\d{1,3}[A-Za-z]?|\d{4})[\s,]+(.+)$/.exec((address ?? '').trim());
  return match
    ? { houseNumber: match[1], rest: match[2] }
    : { houseNumber: '', rest: (address ?? '').trim() };
}

/** "Rebecca Jane Scott" -> first names and a surname, the last word being the surname. */
export function splitName(name: string): { firstNames: string; surname: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return { firstNames: parts.slice(0, -1).join(' '), surname: parts.at(-1) ?? '' };
}

/** "V62-DV65YWO-ORD-1042.pdf" — the name the download is saved under. */
export function v62FileName(registrationNumber: string, orderNumber: string): string {
  return (
    'V62-' +
    normaliseReg(registrationNumber) +
    '-' +
    orderNumber.replace(/[^A-Za-z0-9-]/g, '') +
    '.pdf'
  );
}

export async function renderV62Pdf(v62: V62Submission): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('V62 ' + v62.registrationNumber);
  const page = doc.addPage([PAGE.width, PAGE.height]);
  page.drawImage(await doc.embedJpg(await loadTemplate()), {
    x: 0,
    y: 0,
    width: PAGE.width,
    height: PAGE.height,
  });

  const sheet = new Sheet(
    page,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
  );

  /* 1. Vehicle details */
  sheet.comb(v62.registrationNumber, REG, { bold: true });
  sheet.line(v62.make, 61.85, 734.29, 11, 320);
  sheet.line(v62.model, 61.85, 719.44, 11, 320);
  sheet.line(v62.colour, 61.85, 704.59, 11, 320);
  sheet.line(v62.taxClass, 201.61, 676.15, 11, 185);
  /*
   * Most data licences return only the last five characters of a VIN.
   * Those go in the last five boxes, where they are true, rather than
   * the first five, where they would read as the start of the number.
   */
  const vin = ink(v62.vin).replace(/\s/g, '');
  sheet.comb(vin, VIN, { alignRight: vin.length <= 6 });

  /* 2. Keeper details */
  const title = ink(v62.keeperTitle);
  if (TITLE_BOX[title]) {
    sheet.tick(TITLE_BOX[title], TITLE_Y);
  } else {
    sheet.line(title, 238, 592.5, 9, 42);
  }
  const { firstNames, surname } = splitName(v62.keeperName);
  sheet.line(firstNames, 72.07, 555.05, 10, 300);
  sheet.line(surname, 62.63, 538.45, 10, 310);

  /* Orders placed before the address was taken in parts have it only as one line. */
  const { houseNumber, rest } = splitHouseNumber(v62.keeperAddress1 || v62.keeperAddress);
  sheet.comb(houseNumber, HOUSE_NUMBER);
  sheet.line([rest, v62.keeperAddress2].filter(Boolean).join(', '), 24.36, 463.69, 10, 352);
  sheet.line(v62.keeperCity, 66.01, 447.99, 10, 310);
  sheet.comb(v62.keeperPostcode, POSTCODE);
  sheet.comb(String(v62.keeperPhone ?? '').replace(/[^\d+]/g, ''), PHONE);
  sheet.line(v62.keeperEmail, 118.55, 387.71, 10, 265);

  /* "Have you had a V5C for this vehicle in your name?" — No, which is why there is a V62. */
  sheet.tick(375.21, 370.38);
  sheet.date(v62.dateAcquired, DATE_ACQUIRED);

  /* 3. Why there is no V5C */
  const reason = v62.reasonForNoV5C ?? '';
  if (/bought|not\s+received/i.test(reason)) {
    sheet.tick(TICK_X, REASON_Y.bought);
  } else if (!reason || /lost|stolen|damaged|destroyed/i.test(reason)) {
    sheet.tick(TICK_X, REASON_Y.lost);
  } else {
    sheet.tick(TICK_X, REASON_Y.other);
    sheet.line(reason, 38, 229.5, 10, 320);
  }

  /* 4. Fee — DVLA's £25 goes with the form; the rest of what was paid is our handling. */
  sheet.tick(TICK_X, 194.67);

  /* 5. Declaration — dated, and left for the keeper to sign. */
  sheet.date(v62.declarationDate, DATE_SIGNED);

  return doc.save();
}

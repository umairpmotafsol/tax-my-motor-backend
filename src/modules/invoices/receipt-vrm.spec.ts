import { checkReceipt, normaliseVrm, vrmsMatch } from './receipt-vrm';

/**
 * What Tesseract actually returned for a photographed DVLA receipt whose
 * registration is RJ63HXD. Note the 6 read as a B, and the stray marks on
 * the lines around it — this is the shape of text the matching has to cope
 * with, not a tidy fixture.
 */
const REAL_OCR = [
  'scneme: V5C/V3C-2 No COFTC sve: 4',
  'fereNag8RE35 00073 Erin',
  'Amount: 35.00 Debit / Credit Card',
  'Product No: 35885',
  'Cost Breakdown: |',
  'VED Paid: £35.00',
  'Total: £35.00 |',
  'Licence Start: 2026-09-01 |',
  'Licence Perjod: 12 Months |',
  'VRM: RJB3HXD |',
  'Documents retained and sent to DVLA: |',
].join('\n');

describe('normaliseVrm', () => {
  it('drops spaces and punctuation and upper-cases', () => {
    expect(normaliseVrm(' rj63 hxd. ')).toBe('RJ63HXD');
    expect(normaliseVrm('')).toBe('');
  });
});

describe('vrmsMatch', () => {
  it('matches the same plate however it is spaced or cased', () => {
    expect(vrmsMatch('RJ63 HXD', 'rj63hxd')).toBe(true);
  });

  it.each([
    ['RJ63HXD', 'RJB3HXD'], // 6 read as B — the real receipt
    ['AB12CDE', 'A812CDE'], // B as 8
    ['AB12CDE', 'AB1ZCDE'], // 2 as Z
    ['LM68RTV', 'LM6BRTV'], // 8 as B
    ['AB10CDE', 'ABIOCDE'], // 1 as I, 0 as O
    ['AB55SSS', 'AB5SSS5'], // 5 and S
  ])('treats look-alikes as the same: %s ~ %s', (expected, read) => {
    expect(vrmsMatch(expected, read)).toBe(true);
  });

  it.each([
    ['RJ63HXD', 'RJ63HXE'],
    ['RJ63HXD', 'AB12CDE'],
    ['RJ63HXD', 'RJ63HX'],
    ['RJ63HXD', ''],
  ])('does not match different plates: %s vs %s', (expected, read) => {
    expect(vrmsMatch(expected, read)).toBe(false);
  });
});

describe('checkReceipt', () => {
  it('matches the real receipt, in spite of 6 being read as B', () => {
    expect(checkReceipt(REAL_OCR, 'RJ63 HXD')).toEqual({ status: 'match', vrm: 'RJ63HXD' });
  });

  it('matches when the label is misread too', () => {
    expect(checkReceipt('Total: £35.00\nVRH: RJ63HXD\n', 'RJ63HXD').status).toBe('match');
  });

  it('ignores a stray mark after the plate', () => {
    expect(checkReceipt('VRM: RJ63HXD |\n', 'RJ63HXD').status).toBe('match');
    expect(checkReceipt('VRM: RJ63HXD1\n', 'RJ63HXD').status).toBe('match');
  });

  it("calls a receipt for another vehicle a mismatch and says what it read", () => {
    expect(checkReceipt(REAL_OCR, 'AB12 CDE')).toEqual({ status: 'mismatch', vrm: 'RJB3HXD' });
  });

  it('finds the plate with no label at all, if it is on the receipt', () => {
    expect(checkReceipt('Some receipt\nRJ63 HXD\nThanks', 'RJ63HXD').status).toBe('match');
  });

  it('does not mistake a reference number for the plate', () => {
    const text = 'Ref: 9826935100973\nProduct No: 35885\nAmount: 35.00';
    expect(checkReceipt(text, 'RJ63HXD')).toEqual({ status: 'unreadable' });
  });

  it.each([
    ['empty text', ''],
    ['no registration line', 'Total: £35.00\nLicence Period: 12 Months'],
    ['a label with nothing readable after it', 'VRM: |\n'],
    ['a label followed by too little', 'VRM: R\n'],
  ])('is unreadable for %s', (_name, text) => {
    expect(checkReceipt(text, 'RJ63HXD')).toEqual({ status: 'unreadable' });
  });
});

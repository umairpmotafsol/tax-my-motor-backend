import { BankField } from '../enums/bank.enum';
import { bankFieldValid, ibanValid, normaliseIban } from './bank.util';

describe('IBAN check', () => {
  it("accepts openiban.com's demo IBAN, with or without spaces", () => {
    expect(ibanValid('GB29NWBK60161331926819')).toBe(true);
    expect(ibanValid('gb29 nwbk 6016 1331 9268 19')).toBe(true);
    expect(bankFieldValid(BankField.Iban, 'GB29 NWBK 6016 1331 9268 19')).toBe(true);
  });

  it('rejects a typo, a wrong check digit and a malformed value', () => {
    expect(ibanValid('GB29NWBK60161331926818')).toBe(false);
    expect(ibanValid('GB28NWBK60161331926819')).toBe(false);
    expect(ibanValid('GB29')).toBe(false);
    expect(ibanValid('')).toBe(false);
    expect(ibanValid('12-34-56')).toBe(false);
  });

  it('is stored without spaces, in capitals', () => {
    expect(normaliseIban(' gb29 nwbk 6016 1331 9268 19 ')).toBe('GB29NWBK60161331926819');
  });
});

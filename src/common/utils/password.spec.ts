/**
 * The password an admin generates for a supplier is read off a screen
 * and typed into a phone — so what matters is that it cannot be
 * confused for something else, and that two suppliers never get the
 * same one.
 */
import { randomPassword } from './crypto.util';

describe('randomPassword', () => {
  it('is grouped, and long enough to be worth generating', () => {
    expect(randomPassword()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('never uses a character that can be misread down a phone', () => {
    /* O/0 and I/1 — the same pairs referral codes leave out. */
    const banned = /[O0I1]/;
    for (let i = 0; i < 400; i += 1) {
      expect(randomPassword()).not.toMatch(banned);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(randomPassword());
    }
    expect(seen.size).toBe(500);
  });
});

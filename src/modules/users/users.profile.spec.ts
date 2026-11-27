/**
 * The details step sends the whole form back on every continue, email
 * included, so that field reaches `updateProfile` on a normal, entirely
 * unchanged submission. Email is also the login identifier and carries
 * a unique index — these cover the three ways that combination can go
 * wrong.
 *
 * The password cases below cover the ways a password changes: an admin
 * generating one, and a customer changing their own — which needs the
 * current one.
 */
import { ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { UsersService } from './users.service';

const serviceWith = (model: Record<string, unknown>, rounds?: number) =>
  new UsersService(model as never, {} as never, { get: () => rounds } as never);

/** A stored user, as `findByIdWithPassword` hands one back. */
const storedUser = (passwordHash: string) => {
  const user = { passwordHash, save: jest.fn(async () => undefined) };
  return {
    user,
    model: { findById: () => ({ select: async () => user }) },
  };
};

/*
 * First and last name are stored apart, with `name` — the two joined —
 * kept beside them for everything that only shows or searches a name.
 */
describe('updateProfile names', () => {
  const modelFor = (stored: Record<string, string>) => ({
    exists: jest.fn(async () => null),
    findById: jest.fn(() => ({ select: () => ({ lean: async () => stored }) })),
    findByIdAndUpdate: jest.fn(async (..._a: unknown[]) => ({ id: 'u1' })),
  });

  it('stores both parts and the whole name together', async () => {
    const model = modelFor({ name: 'Old Name', firstName: 'Old', lastName: 'Name' });

    await serviceWith(model).updateProfile('u1', { firstName: 'Alex', lastName: 'Morgan' });

    expect(model.findByIdAndUpdate.mock.calls[0][1]).toEqual({
      firstName: 'Alex',
      lastName: 'Morgan',
      name: 'Alex Morgan',
    });
  });

  it('keeps the other part when only one changes', async () => {
    const model = modelFor({ name: 'Alex Morgan', firstName: 'Alex', lastName: 'Morgan' });

    await serviceWith(model).updateProfile('u1', { lastName: 'Smith' });

    expect(model.findByIdAndUpdate.mock.calls[0][1]).toEqual({
      firstName: 'Alex',
      lastName: 'Smith',
      name: 'Alex Smith',
    });
  });

  it('reads the parts of an account made before the split from its whole name', async () => {
    const model = modelFor({ name: 'Mary Ann Smith', firstName: '', lastName: '' });

    await serviceWith(model).updateProfile('u1', { firstName: 'Mary' });

    expect(model.findByIdAndUpdate.mock.calls[0][1]).toMatchObject({
      lastName: 'Ann Smith',
      name: 'Mary Ann Smith',
    });
  });

  it('splits one whole name from an older app build', async () => {
    const model = modelFor({});

    await serviceWith(model).updateProfile('u1', { name: 'Jo Bloggs' });

    expect(model.findByIdAndUpdate.mock.calls[0][1]).toEqual({
      name: 'Jo Bloggs',
      firstName: 'Jo',
      lastName: 'Bloggs',
    });
  });
});

describe('updateProfile', () => {
  it('saves a changed email once it has checked nobody else holds it', async () => {
    const model = {
      exists: jest.fn(async (..._a: unknown[]) => null),
      findByIdAndUpdate: jest.fn(async (..._a: unknown[]) => ({ id: 'u1' })),
    };

    await serviceWith(model).updateProfile('u1', { email: '  New@Example.COM ' });

    // Stored lowercased and trimmed, or the next sign-in would not match.
    expect(model.findByIdAndUpdate.mock.calls[0][1]).toEqual({ email: 'new@example.com' });
  });

  it('does not treat the account as a conflict with itself', async () => {
    const model = {
      exists: jest.fn(async (..._a: unknown[]) => null),
      findByIdAndUpdate: jest.fn(async (..._a: unknown[]) => ({ id: 'u1' })),
    };

    await serviceWith(model).updateProfile('u1', { email: 'same@example.com' });

    // Re-submitting the form unchanged must not collide with the row
    // that already holds this address — this account's own.
    expect(model.exists.mock.calls[0][0]).toEqual({
      email: 'same@example.com',
      _id: { $ne: 'u1' },
    });
  });

  it('refuses an address another account already uses', async () => {
    const model = {
      exists: jest.fn(async (..._a: unknown[]) => ({ _id: 'someone-else' })),
      findByIdAndUpdate: jest.fn(async (..._a: unknown[]) => ({ id: 'u1' })),
    };

    await expect(
      serviceWith(model).updateProfile('u1', { email: 'taken@example.com' }),
    ).rejects.toBeInstanceOf(ConflictException);
    // The unique index would have thrown E11000 and surfaced as a 500.
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('leaves the email alone when the patch does not mention it', async () => {
    const model = {
      exists: jest.fn(async (..._a: unknown[]) => null),
      findByIdAndUpdate: jest.fn(async (..._a: unknown[]) => ({ id: 'u1' })),
    };

    await serviceWith(model).updateProfile('u1', { phone: '07700900123' });

    expect(model.exists).not.toHaveBeenCalled();
    expect(model.findByIdAndUpdate.mock.calls[0][1]).toEqual({ phone: '07700900123' });
  });
});

describe('setting a password', () => {
  /* Cheap rounds: these assert the stored hash, not the hashing cost. */
  const ROUNDS = 4;

  it('stores the password the admin generated', async () => {
    const { user, model } = storedUser('old-hash');

    await serviceWith(model, ROUNDS).setPassword('u1', 'generated-for-them');

    expect(await bcrypt.compare('generated-for-them', user.passwordHash)).toBe(true);
    expect(user.save).toHaveBeenCalledTimes(1);
  });

  it('lets a customer change their own, given the current one', async () => {
    const { user, model } = storedUser(await bcrypt.hash('old-password', ROUNDS));

    await serviceWith(model, ROUNDS).changePassword('u1', 'old-password', 'new-password');

    expect(await bcrypt.compare('new-password', user.passwordHash)).toBe(true);
    expect(user.save).toHaveBeenCalledTimes(1);
  });

  it('refuses a wrong current password, and changes nothing', async () => {
    const { user, model } = storedUser(await bcrypt.hash('old-password', ROUNDS));
    const before = user.passwordHash;

    await expect(
      serviceWith(model, ROUNDS).changePassword('u1', 'not-it', 'new-password'),
    ).rejects.toThrow('Your current password is not correct.');
    expect(user.passwordHash).toBe(before);
    expect(user.save).not.toHaveBeenCalled();
  });
});

/**
 * The details step sends the whole form back on every continue, email
 * included, so that field reaches `updateProfile` on a normal, entirely
 * unchanged submission. Email is also the login identifier and carries
 * a unique index — these cover the three ways that combination can go
 * wrong.
 *
 * The password cases below cover the other half of an account somebody
 * else opened: who is known to hold the password, and when that stops
 * being true.
 */
import { ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { UsersService } from './users.service';

const serviceWith = (model: Record<string, unknown>, rounds?: number) =>
  new UsersService(model as never, {} as never, { get: () => rounds } as never);

/** A stored user, as `findByIdWithPassword` hands one back. */
const storedUser = (passwordHash: string, mustChangePassword: boolean) => {
  const user = { passwordHash, mustChangePassword, save: jest.fn(async () => undefined) };
  return {
    user,
    model: { findById: () => ({ select: async () => user }) },
  };
};

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

    await serviceWith(model).updateProfile('u1', { name: 'Jo' });

    expect(model.exists).not.toHaveBeenCalled();
    expect(model.findByIdAndUpdate.mock.calls[0][1]).toEqual({ name: 'Jo' });
  });
});

describe('who knows the password', () => {
  /* Cheap rounds: these assert the flag, not the hashing. */
  const ROUNDS = 4;

  it('stops asking once the holder has chosen their own', async () => {
    const { user, model } = storedUser(await bcrypt.hash('issued-by-admin', ROUNDS), true);

    await serviceWith(model, ROUNDS).changePassword('u1', 'issued-by-admin', 'mine-alone');

    expect(user.mustChangePassword).toBe(false);
    expect(await bcrypt.compare('mine-alone', user.passwordHash)).toBe(true);
  });

  it('refuses a change that cannot produce the current password', async () => {
    const { user, model } = storedUser(await bcrypt.hash('issued-by-admin', ROUNDS), true);

    await expect(
      serviceWith(model, ROUNDS).changePassword('u1', 'not-it', 'mine-alone'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(user.save).not.toHaveBeenCalled();
  });

  it('marks a password an admin set, because the admin now knows it', async () => {
    const { user, model } = storedUser('whatever', false);

    await serviceWith(model, ROUNDS).setPassword('u1', 'generated-for-them');

    expect(user.mustChangePassword).toBe(true);
  });
});

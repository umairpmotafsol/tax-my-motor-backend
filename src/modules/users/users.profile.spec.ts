/**
 * The details step sends the whole form back on every continue, email
 * included, so that field reaches `updateProfile` on a normal, entirely
 * unchanged submission. Email is also the login identifier and carries
 * a unique index — these cover the three ways that combination can go
 * wrong.
 */
import { ConflictException } from '@nestjs/common';

import { UsersService } from './users.service';

const serviceWith = (model: Record<string, unknown>) =>
  new UsersService(model as never, {} as never, { get: () => undefined } as never);

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

/**
 * A customer's own password: changing it from Settings, and "Forgot
 * password?" — a six-digit code emailed to them, good for fifteen
 * minutes and five tries, that lets them set a new one.
 */
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';

import { Role } from '../../common/enums/role.enum';
import { hashToken } from '../../common/utils/crypto.util';
import { AuthService, RESET_CODE_TTL_MS } from './auth.service';

type Row = {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  save: () => Promise<void>;
};

function customer(patch: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    name: 'Alex Morgan',
    email: 'alex@example.co.uk',
    role: Role.Customer,
    active: true,
    ...patch,
  };
}

function build(account: ReturnType<typeof customer> | null, mailSent = true) {
  /* The one reset row an account can have, as the unique index keeps it. */
  let row: Row | null = null;
  const resetModel = {
    findOneAndUpdate: jest.fn(
      async (_filter: unknown, update: { $set: Omit<Row, '_id' | 'user' | 'save'> }) => {
        row = {
          _id: new Types.ObjectId(),
          user: account!._id,
          ...update.$set,
          save: jest.fn(async () => undefined),
        };
        return row;
      },
    ),
    findOne: jest.fn(async () => row),
    deleteOne: jest.fn(async () => {
      row = null;
    }),
  };
  const sessionModel = { deleteMany: jest.fn(async (..._a: unknown[]) => undefined) };
  const users = {
    findByEmailWithPassword: jest.fn(async (email: string) =>
      account && account.email === email.trim().toLowerCase() ? account : null,
    ),
    setPassword: jest.fn(async (..._a: unknown[]) => account),
    changePassword: jest.fn(async (..._a: unknown[]) => undefined),
  };
  const mail = {
    sendPasswordResetCode: jest.fn(async (_m: { code: string; minutes: number; to: string }) =>
      mailSent ? { sent: true as const } : { sent: false as const, reason: 'down' },
    ),
  };
  const auth = new AuthService(
    users as never,
    {} as never,
    {} as never,
    sessionModel as never,
    resetModel as never,
    mail as never,
  );
  const emailedCode = () => mail.sendPasswordResetCode.mock.calls[0][0].code;
  return { auth, users, mail, sessionModel, resetModel, row: () => row, emailedCode };
}

describe('asking for a reset code', () => {
  it('emails a customer a six-digit code that lasts fifteen minutes', async () => {
    const account = customer();
    const { auth, mail, row, emailedCode } = build(account);

    const before = Date.now();
    await auth.requestPasswordReset('Alex@Example.co.uk ');

    expect(mail.sendPasswordResetCode).toHaveBeenCalledTimes(1);
    const sent = mail.sendPasswordResetCode.mock.calls[0][0];
    expect(sent.to).toBe('alex@example.co.uk');
    expect(sent.minutes).toBe(15);
    expect(emailedCode()).toMatch(/^\d{6}$/);

    /* Only a hash is kept, never the code. */
    expect(row()!.codeHash).not.toContain(emailedCode());
    expect(row()!.expiresAt.getTime() - before).toBeGreaterThanOrEqual(RESET_CODE_TTL_MS - 50);
    expect(row()!.expiresAt.getTime() - before).toBeLessThanOrEqual(RESET_CODE_TTL_MS + 1000);
  });

  it('says nothing about an address with no account', async () => {
    const { auth, mail } = build(customer());

    await expect(auth.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
    expect(mail.sendPasswordResetCode).not.toHaveBeenCalled();
  });

  it('sends nothing to a supplier or admin, whose passwords an admin issues', async () => {
    const { auth, mail } = build(customer({ role: Role.Supplier }));

    await auth.requestPasswordReset('alex@example.co.uk');
    expect(mail.sendPasswordResetCode).not.toHaveBeenCalled();
  });

  it('says so when the email could not be sent, and keeps no code', async () => {
    const { auth, row } = build(customer(), false);

    await expect(auth.requestPasswordReset('alex@example.co.uk')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(row()).toBeNull();
  });
});

describe('the code', () => {
  it('checks out, without being used up', async () => {
    const { auth, row, emailedCode } = build(customer());
    await auth.requestPasswordReset('alex@example.co.uk');

    await expect(auth.verifyResetCode('alex@example.co.uk', emailedCode())).resolves.toBeUndefined();
    expect(row()).not.toBeNull();
  });

  it('is refused when wrong, and counts the try', async () => {
    const { auth, row, emailedCode } = build(customer());
    await auth.requestPasswordReset('alex@example.co.uk');
    const wrong = emailedCode() === '000000' ? '111111' : '000000';

    await expect(auth.verifyResetCode('alex@example.co.uk', wrong)).rejects.toThrow(
      'That code is not right. Check the email and try again.',
    );
    expect(row()!.attempts).toBe(1);
  });

  it('is used up after five wrong tries', async () => {
    const { auth, row, emailedCode } = build(customer());
    await auth.requestPasswordReset('alex@example.co.uk');
    const right = emailedCode();
    const wrong = right === '000000' ? '111111' : '000000';

    for (let i = 0; i < 4; i += 1) {
      await expect(auth.verifyResetCode('alex@example.co.uk', wrong)).rejects.toThrow(
        BadRequestException,
      );
    }
    await expect(auth.verifyResetCode('alex@example.co.uk', wrong)).rejects.toThrow(
      'Too many wrong codes. Ask for a new one.',
    );
    expect(row()).toBeNull();
    /* Even the right code is no good now. */
    await expect(auth.verifyResetCode('alex@example.co.uk', right)).rejects.toThrow(
      'That code has expired. Ask for a new one.',
    );
  });

  it('expires after fifteen minutes', async () => {
    const { auth, row, emailedCode } = build(customer());
    await auth.requestPasswordReset('alex@example.co.uk');
    row()!.expiresAt = new Date(Date.now() - 1);

    await expect(auth.verifyResetCode('alex@example.co.uk', emailedCode())).rejects.toThrow(
      'That code has expired. Ask for a new one.',
    );
    expect(row()).toBeNull();
  });
});

describe('setting the new password with the code', () => {
  it('sets it, uses the code up, and signs every device out', async () => {
    const account = customer();
    const { auth, users, sessionModel, row, emailedCode } = build(account);
    await auth.requestPasswordReset('alex@example.co.uk');

    await auth.resetPassword('alex@example.co.uk', emailedCode(), 'a-new-password');

    expect(users.setPassword).toHaveBeenCalledWith(account._id, 'a-new-password');
    expect(row()).toBeNull();
    expect(sessionModel.deleteMany).toHaveBeenCalledWith({ user: account._id });
  });

  it('changes nothing with a wrong code', async () => {
    const { auth, users, emailedCode } = build(customer());
    await auth.requestPasswordReset('alex@example.co.uk');
    const wrong = emailedCode() === '000000' ? '111111' : '000000';

    await expect(auth.resetPassword('alex@example.co.uk', wrong, 'a-new-password')).rejects.toThrow(
      BadRequestException,
    );
    expect(users.setPassword).not.toHaveBeenCalled();
  });
});

describe('changing it from Settings', () => {
  it('signs out every other device, but not this one', async () => {
    const account = customer();
    const { auth, users, sessionModel } = build(account);

    await auth.changePassword(String(account._id), 'old-password', 'new-password', 'this-refresh');

    expect(users.changePassword).toHaveBeenCalledWith(
      String(account._id),
      'old-password',
      'new-password',
    );
    expect(sessionModel.deleteMany).toHaveBeenCalledWith({
      user: String(account._id),
      tokenHash: { $ne: hashToken('this-refresh') },
    });
  });
});

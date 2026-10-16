/**
 * The phones an account is pushed to.
 *
 * A token identifies an app install, not a person, and the supplier app
 * is shared ground — suppliers and admins both sign into it. So the
 * question these cover is ownership: a handset must only ever receive
 * the notifications of whoever is signed in on it now.
 */
import { Types } from 'mongoose';

import { UsersService } from './users.service';

const serviceWith = (model: Record<string, unknown>) =>
  new UsersService(model as never, {} as never, { get: () => undefined } as never);

describe('registerDevice', () => {
  it('takes the phone off whoever had it before attaching it here', async () => {
    const order: string[] = [];
    const model = {
      updateMany: jest.fn(async (...args: unknown[]) => {
        order.push('pull');
        return { modifiedCount: 1, args };
      }),
      updateOne: jest.fn(async (...args: unknown[]) => {
        order.push('push');
        return { modifiedCount: 1, args };
      }),
    };

    await serviceWith(model).registerDevice('user-2', 'phone-a', 'android');

    /*
     * The order is the whole point: attaching first and detaching after
     * would remove the row that was just written, and the phone would
     * go quiet for its new owner.
     */
    expect(order).toEqual(['pull', 'push']);
    expect(model.updateMany.mock.calls[0][0]).toEqual({ 'deviceTokens.token': 'phone-a' });
    expect(model.updateMany.mock.calls[0][1]).toEqual({
      $pull: { deviceTokens: { token: 'phone-a' } },
    });
    expect(model.updateOne.mock.calls[0][0]).toEqual({ _id: 'user-2' });
  });

  it('records the platform, which decides how the message is shaped', async () => {
    const model = {
      updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
      updateOne: jest.fn(async (..._a: unknown[]) => ({ modifiedCount: 1 })),
    };

    await serviceWith(model).registerDevice('user-1', 'phone-a', 'ios');

    const pushed = (model.updateOne.mock.calls[0][1] as {
      $push: { deviceTokens: { token: string; platform: string } };
    }).$push.deviceTokens;
    expect(pushed.token).toBe('phone-a');
    expect(pushed.platform).toBe('ios');
  });
});

describe('deviceTokensFor', () => {
  it('collects the tokens of everyone named, without repeating a shared phone', async () => {
    const ids = [new Types.ObjectId(), new Types.ObjectId()];
    const model = {
      find: jest.fn(() => ({
        select: async () => [
          { deviceTokens: [{ token: 'phone-a' }, { token: 'tablet' }] },
          /* The second account signed in on the same handset. */
          { deviceTokens: [{ token: 'phone-a' }] },
        ],
      })),
    };

    const tokens = await serviceWith(model).deviceTokensFor(ids);

    // One notification per phone, not one per account that holds it.
    expect(tokens).toEqual(['phone-a', 'tablet']);
  });

  it('asks nothing of the database for nobody', async () => {
    const model = { find: jest.fn() };

    expect(await serviceWith(model).deviceTokensFor([])).toEqual([]);
    expect(model.find).not.toHaveBeenCalled();
  });
});

describe('forgetDevices', () => {
  it('drops them all in one write', async () => {
    const model = { updateMany: jest.fn(async (..._a: unknown[]) => ({ modifiedCount: 2 })) };

    await serviceWith(model).forgetDevices(['dead-a', 'dead-b']);

    expect(model.updateMany.mock.calls[0][1]).toEqual({
      $pull: { deviceTokens: { token: { $in: ['dead-a', 'dead-b'] } } },
    });
  });

  it('does nothing when Firebase reported no dead tokens', async () => {
    const model = { updateMany: jest.fn() };

    await serviceWith(model).forgetDevices([]);

    expect(model.updateMany).not.toHaveBeenCalled();
  });
});

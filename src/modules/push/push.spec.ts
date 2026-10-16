/**
 * Who a push reaches, and what happens when it cannot be delivered.
 *
 * The rule the supplier app depends on is that an order notifies the
 * one company it was assigned to — a supplier who hears about somebody
 * else's order has been told something they cannot act on and should
 * not have seen. The rest is failure handling: a notification is a
 * courtesy on top of an order that is already placed, so nothing in
 * here may throw.
 */
import { Role } from '../../common/enums/role.enum';
import { PushService, PushMessage } from './push.service';

/** The one call PushService makes on Firebase, as the tests read it back. */
interface Multicast {
  tokens: string[];
  notification?: { title: string; body: string };
  data?: Record<string, string>;
  android?: { priority?: string; notification?: { channelId?: string } };
}

/** A `sendEachForMulticast` that reports every token as delivered. */
const deliversEverything = () =>
  jest.fn(async ({ tokens }: Multicast) => ({
    successCount: tokens.length,
    failureCount: 0,
    responses: tokens.map(() => ({ success: true })),
  }));

const usersWith = (overrides: Record<string, unknown> = {}) => ({
  listBySupplier: jest.fn(async () => []),
  listByRole: jest.fn(async () => []),
  deviceTokensFor: jest.fn(async () => [] as string[]),
  forgetDevices: jest.fn(async () => undefined),
  ...overrides,
});

const serviceWith = (sender: unknown, users: unknown) =>
  new PushService(sender as never, users as never);

const message: PushMessage = {
  title: 'New vehicle request',
  body: 'You have a new vehicle request. Tap to view.',
  data: { kind: 'order.assigned', orderId: 'order-1' },
};

describe('with no credentials', () => {
  it('is off, and costs nothing to call', async () => {
    const users = usersWith();
    const push = serviceWith(null, users);

    expect(push.enabled).toBe(false);
    expect(await push.toAdmins(message)).toBe(0);
    expect(await push.toSupplier('supplier-1', message)).toBe(0);

    /* Not even the lookups: off has to be free, or callers start guarding it. */
    expect(users.listByRole).not.toHaveBeenCalled();
    expect(users.listBySupplier).not.toHaveBeenCalled();
  });
});

describe('a new order', () => {
  it('goes to every sign-in of the supplier it was assigned to, and no other', async () => {
    const sender = { sendEachForMulticast: deliversEverything() };
    const users = usersWith({
      listBySupplier: jest.fn(async () => [{ _id: 'user-1' }, { _id: 'user-2' }]),
      deviceTokensFor: jest.fn(async () => ['phone-a', 'phone-b']),
    });

    const sent = await serviceWith(sender, users).toSupplier('supplier-1', message);

    expect(sent).toBe(2);
    expect(users.listBySupplier).toHaveBeenCalledWith('supplier-1');
    /* The tokens asked for are that company's users', nobody else's. */
    expect(users.deviceTokensFor).toHaveBeenCalledWith(['user-1', 'user-2']);
    expect(sender.sendEachForMulticast.mock.calls[0][0].tokens).toEqual(['phone-a', 'phone-b']);
  });

  it('sends the copy and the order behind it', async () => {
    const sender = { sendEachForMulticast: deliversEverything() };
    const users = usersWith({
      listBySupplier: jest.fn(async () => [{ _id: 'user-1' }]),
      deviceTokensFor: jest.fn(async () => ['phone-a']),
    });

    await serviceWith(sender, users).toSupplier('supplier-1', message);
    const payload = sender.sendEachForMulticast.mock.calls[0][0];

    expect(payload.notification).toEqual({
      title: 'New vehicle request',
      body: 'You have a new vehicle request. Tap to view.',
    });
    /* What the tap handler navigates on. */
    expect(payload.data).toEqual({ kind: 'order.assigned', orderId: 'order-1' });
    /* Seven minutes to answer it — not something to hold until the next doze window. */
    expect(payload.android?.priority).toBe('high');
    expect(payload.android?.notification?.channelId).toBe('orders');
  });

  it('says nothing when the supplier has never signed in on a phone', async () => {
    const sender = { sendEachForMulticast: deliversEverything() };
    const users = usersWith({
      listBySupplier: jest.fn(async () => [{ _id: 'user-1' }]),
      deviceTokensFor: jest.fn(async () => []),
    });

    expect(await serviceWith(sender, users).toSupplier('supplier-1', message)).toBe(0);
    expect(sender.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('has nobody to tell when the order went unassigned', async () => {
    const sender = { sendEachForMulticast: deliversEverything() };
    const users = usersWith();

    expect(await serviceWith(sender, users).toSupplier(null, message)).toBe(0);
    expect(users.listBySupplier).not.toHaveBeenCalled();
  });
});

describe('the expired window', () => {
  it('goes to the admins', async () => {
    const sender = { sendEachForMulticast: deliversEverything() };
    const users = usersWith({
      listByRole: jest.fn(async () => [{ _id: 'admin-1' }]),
      deviceTokensFor: jest.fn(async () => ['admin-phone']),
    });

    const sent = await serviceWith(sender, users).toAdmins({
      title: 'Invoice window expired',
      body: 'ORD-1025 · Northgate has not uploaded an invoice in time. Tap to call them.',
    });

    expect(sent).toBe(1);
    expect(users.listByRole).toHaveBeenCalledWith(Role.Admin);
  });
});

describe('tokens that no longer work', () => {
  it('drops the uninstalled ones and keeps the rest', async () => {
    const sender = {
      sendEachForMulticast: jest.fn(async () => ({
        successCount: 1,
        failureCount: 2,
        responses: [
          { success: true },
          { success: false, error: { code: 'messaging/registration-token-not-registered' } },
          /* A phone that is merely offline — the token is still good. */
          { success: false, error: { code: 'messaging/unavailable' } },
        ],
      })),
    };
    const users = usersWith({
      listByRole: jest.fn(async () => [{ _id: 'admin-1' }]),
      deviceTokensFor: jest.fn(async () => ['good', 'uninstalled', 'offline']),
    });

    await serviceWith(sender, users).toAdmins(message);

    expect(users.forgetDevices).toHaveBeenCalledWith(['uninstalled']);
  });

  it('keeps every token when the whole send succeeds', async () => {
    const sender = { sendEachForMulticast: deliversEverything() };
    const users = usersWith({
      listByRole: jest.fn(async () => [{ _id: 'admin-1' }]),
      deviceTokensFor: jest.fn(async () => ['good']),
    });

    await serviceWith(sender, users).toAdmins(message);

    expect(users.forgetDevices).not.toHaveBeenCalled();
  });
});

describe('when Firebase is having a bad day', () => {
  it('swallows the failure rather than failing the order that caused it', async () => {
    const sender = {
      sendEachForMulticast: jest.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    };
    const users = usersWith({
      listByRole: jest.fn(async () => [{ _id: 'admin-1' }]),
      deviceTokensFor: jest.fn(async () => ['admin-phone']),
    });

    await expect(serviceWith(sender, users).toAdmins(message)).resolves.toBe(0);
  });
});

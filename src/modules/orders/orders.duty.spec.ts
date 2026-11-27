/**
 * On duty and off duty.
 *
 * The rules pinned here are the ones the seven-minute window depends on:
 *
 *  - An order only ever lands on a supplier who is active and on duty,
 *    because its window starts the moment it lands. The holder of its
 *    type comes first; failing them, whoever came on duty first;
 *    failing that, it waits, with no clock.
 *  - Coming on duty hands the supplier every waiting order, oldest
 *    first, into Pending — with no window at all. The clock only runs
 *    on an order received while on duty; one that came in while nobody
 *    was on duty stays untimed wherever it goes, and never goes overdue.
 *  - Going off duty is refused while they still have an order to
 *    finish — not counting one waiting on the customer's bank details,
 *    or on an admin.
 *  - An order coming back to a supplier who has gone off duty goes back
 *    to waiting instead of starting a window against them.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

import { BankReviewStatus } from '../../common/enums/bank.enum';
import { NotificationType } from '../../common/enums/notification.enum';
import {
  InvoiceStatus,
  OrderStatus,
  OrderType,
  SupplierStatus,
} from '../../common/enums/order.enum';
import { SuppliersService } from '../suppliers/suppliers.service';
import { OrdersService } from './orders.service';
import { OrderDocument } from './schemas/order.schema';

const WINDOW_MS = 420_000;

type FakeSupplier = {
  _id: Types.ObjectId;
  name: string;
  status: SupplierStatus;
  onDuty: boolean;
  onDutySince: Date | null;
  orderTypes: OrderType[];
};

function supplier(name: string, patch: Partial<FakeSupplier> = {}): FakeSupplier {
  return {
    _id: new Types.ObjectId(),
    name,
    status: SupplierStatus.Active,
    onDuty: true,
    onDutySince: new Date('2026-11-27T08:00:00Z'),
    orderTypes: [],
    ...patch,
  };
}

/** Just enough of a Mongoose model for the routing lookups: equality and array membership. */
function supplierModelOf(rows: FakeSupplier[]) {
  const matches = (row: FakeSupplier, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, want]) => {
      const have = (row as Record<string, unknown>)[key];
      return Array.isArray(have) ? have.includes(want) : have === want;
    });
  return {
    findOne: (filter: Record<string, unknown>) => {
      const found = rows.filter(row => matches(row, filter));
      const query = {
        sort: () => {
          found.sort((a, b) => +(a.onDutySince ?? 0) - +(b.onDutySince ?? 0));
          return query;
        },
        then: (resolve: (value: FakeSupplier | null) => unknown) => resolve(found[0] ?? null),
      };
      return query;
    },
  };
}

function build(opts: { suppliers?: FakeSupplier[]; toFinish?: number; waiting?: unknown[] } = {}) {
  const rows = opts.suppliers ?? [];
  const routing = new SuppliersService(supplierModelOf(rows) as never);

  const suppliers = {
    findById: jest.fn(async (id: string) => {
      const row = rows.find(r => String(r._id) === String(id));
      if (!row) {
        throw new Error('no such supplier');
      }
      return row;
    }),
    routeOrder: jest.fn((type: OrderType) => routing.routeOrder(type)),
    setOnDuty: jest.fn(async (id: string, onDuty: boolean) => {
      const row = rows.find(r => String(r._id) === String(id))!;
      row.onDuty = onDuty;
      row.onDutySince = onDuty ? new Date() : null;
      return row;
    }),
  };

  /* The orders still waiting, by id; claiming one takes it out, as the conditional update would. */
  const waiting = new Map(
    (opts.waiting ?? []).map(order => [String((order as { _id: unknown })._id), order]),
  );
  const orderModel = {
    countDocuments: jest.fn(async (..._a: unknown[]) => opts.toFinish ?? 0),
    find: jest.fn(() => ({
      sort: () => ({ select: async () => [...waiting.values()] }),
    })),
    findOneAndUpdate: jest.fn(
      async (filter: { _id: unknown }, update: { $set: Record<string, unknown> }) => {
        const order = waiting.get(String(filter._id));
        if (!order) {
          return null;
        }
        waiting.delete(String(filter._id));
        return { ...(order as object), ...update.$set };
      },
    ),
  };

  const notifications = {
    raise: jest.fn(async (..._a: unknown[]) => undefined),
    resolve: jest.fn(async (..._a: unknown[]) => undefined),
  };
  const realtime = {
    orderAssigned: jest.fn(),
    orderChanged: jest.fn(),
    supplierDuty: jest.fn(),
  };
  const push = { enabled: true, toSupplier: jest.fn(async (..._a: unknown[]) => 1) };
  const config = { get: (key: string) => (key === 'responseTimeoutMs' ? WINDOW_MS : undefined) };

  const orders = new OrdersService(
    orderModel as never,
    {} as never,
    suppliers as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
    realtime as never,
    push as never,
    config as never,
    {} as never,
  );
  return { orders, routing, orderModel, notifications, realtime, push, suppliers };
}

function waitingOrder(placedAt: string) {
  return {
    _id: new Types.ObjectId(),
    orderNumber: 'ORD-' + placedAt,
    reg: 'RJ63 HXD',
    orderType: OrderType.Tax6,
    status: OrderStatus.Unassigned,
    invoiceStatus: InvoiceStatus.Pending,
    placedAt: new Date(placedAt),
  };
}

/** An order of `holder`'s, as a document the service can change and save. */
function heldOrder(holder: FakeSupplier, patch: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    orderNumber: 'ORD-1',
    reg: 'RJ63 HXD',
    orderType: OrderType.Tax6,
    supplier: holder._id,
    status: OrderStatus.AwaitingSupplier,
    invoiceStatus: InvoiceStatus.Pending,
    assignedAt: new Date(),
    dueAt: null as Date | null,
    turnStartedAt: null,
    flag: null,
    timeline: [] as unknown[],
    ...patch,
  } as unknown as OrderDocument;
}

describe('where a new order lands', () => {
  it('goes to the supplier holding its type while they are on duty', async () => {
    const holder = supplier('Northgate', { orderTypes: [OrderType.Tax6] });
    const other = supplier('Westfield', { onDutySince: new Date('2026-11-27T07:00:00Z') });
    const { routing } = build({ suppliers: [other, holder] });

    expect((await routing.routeOrder(OrderType.Tax6))?.name).toBe('Northgate');
  });

  it('goes to whoever came on duty first when its own supplier is off duty', async () => {
    const holder = supplier('Northgate', { orderTypes: [OrderType.Tax6], onDuty: false });
    const later = supplier('Westfield', { onDutySince: new Date('2026-11-27T09:00:00Z') });
    const first = supplier('Eastgate', { onDutySince: new Date('2026-11-27T07:30:00Z') });
    const { routing } = build({ suppliers: [holder, later, first] });

    expect((await routing.routeOrder(OrderType.Tax6))?.name).toBe('Eastgate');
  });

  it('waits for somebody when nobody is on duty', async () => {
    const { routing } = build({
      suppliers: [
        supplier('Northgate', { orderTypes: [OrderType.Tax6], onDuty: false }),
        supplier('Westfield', { onDuty: true, status: SupplierStatus.Holiday }),
      ],
    });

    expect(await routing.routeOrder(OrderType.Tax6)).toBeNull();
  });
});

describe('coming on duty', () => {
  it('hands over every waiting order, oldest first, with no clock running', async () => {
    const me = supplier('Northgate', { onDuty: false, onDutySince: null });
    const older = waitingOrder('2026-11-27T06:00:00Z');
    const newer = waitingOrder('2026-11-27T06:30:00Z');
    const { orders, orderModel, notifications, realtime, push } = build({
      suppliers: [me],
      waiting: [older, newer],
    });

    const result = await orders.setDuty(String(me._id), true);

    expect(result.onDuty).toBe(true);
    expect(result.claimed).toBe(2);
    expect(realtime.supplierDuty).toHaveBeenCalledTimes(1);

    const claims = orderModel.findOneAndUpdate.mock.calls;
    expect(claims.map(([filter]) => String(filter._id))).toEqual([
      String(older._id),
      String(newer._id),
    ]);
    for (const [filter, update] of claims) {
      /* Only while still waiting, so two suppliers cannot both get it. */
      expect(filter).toMatchObject({ status: OrderStatus.Unassigned });
      const set = (
        update as { $set: { supplier: unknown; status: string; dueAt: Date | null; untimed: boolean } }
      ).$set;
      expect(set.supplier).toBe(me._id);
      /* Pending, not overdue — and with no window, so it can never go overdue. */
      expect(set.status).toBe(OrderStatus.AwaitingSupplier);
      expect(set.dueAt).toBeNull();
      expect(set.untimed).toBe(true);
    }
    expect(notifications.resolve).toHaveBeenCalledWith(NotificationType.Unassigned, older._id);
    expect(push.toSupplier).toHaveBeenCalledTimes(2);
  });

  it('does not count an order somebody else got to first', async () => {
    const me = supplier('Northgate', { onDuty: false });
    const { orders, orderModel } = build({
      suppliers: [me],
      waiting: [waitingOrder('2026-11-27T06:00:00Z')],
    });
    orderModel.findOneAndUpdate.mockResolvedValueOnce(null as never);

    expect((await orders.setDuty(String(me._id), true)).claimed).toBe(0);
  });

  it('is refused on an account the admin has taken out of rotation', async () => {
    const me = supplier('Northgate', { onDuty: false, status: SupplierStatus.Inactive });
    const { orders } = build({ suppliers: [me] });

    await expect(orders.setDuty(String(me._id), true)).rejects.toBeInstanceOf(ConflictException);
    expect(me.onDuty).toBe(false);
  });
});

describe('going off duty', () => {
  it('is refused while they still have an order to finish', async () => {
    const me = supplier('Northgate');
    const { orders, realtime } = build({ suppliers: [me], toFinish: 2 });

    await expect(orders.setDuty(String(me._id), false)).rejects.toThrow(
      'You still have 2 orders to finish. Upload their invoices before going off duty.',
    );
    expect(me.onDuty).toBe(true);
    expect(realtime.supplierDuty).not.toHaveBeenCalled();
  });

  it('does not count orders waiting on the customer’s bank details, or on an admin', async () => {
    const me = supplier('Northgate');
    const { orders, orderModel } = build({ suppliers: [me] });

    await orders.setDuty(String(me._id), false);

    const [query] = orderModel.countDocuments.mock.calls[0] as [Record<string, unknown>];
    expect(query).toMatchObject({
      invoiceStatus: InvoiceStatus.Pending,
      'bankReview.status': { $ne: BankReviewStatus.ChangesRequested },
      $or: [{ flag: null }, { 'flag.resolvedAt': { $ne: null } }],
    });
  });

  it('takes them off duty, and tells the admins', async () => {
    const me = supplier('Northgate');
    const { orders, realtime } = build({ suppliers: [me] });

    const result = await orders.setDuty(String(me._id), false);

    expect(result.onDuty).toBe(false);
    expect(me.onDuty).toBe(false);
    expect(realtime.supplierDuty).toHaveBeenCalledWith(me);
  });
});

describe('an order coming back to its supplier', () => {
  it('restarts their window while they are on duty', async () => {
    const me = supplier('Northgate');
    const { orders } = build({ suppliers: [me] });
    const order = heldOrder(me);

    expect(await orders.restartOrRelease(order, new Date())).toBe(true);
    expect(order.dueAt).not.toBeNull();
    expect(order.status).toBe(OrderStatus.AwaitingSupplier);
  });

  it('goes back to waiting, with no clock, once they are off duty', async () => {
    const me = supplier('Northgate', { onDuty: false });
    const { orders } = build({ suppliers: [me] });
    const order = heldOrder(me);

    expect(await orders.restartOrRelease(order, new Date())).toBe(false);
    expect(order.status).toBe(OrderStatus.Unassigned);
    expect(order.supplier).toBeNull();
    expect(order.dueAt).toBeNull();
  });

  it('is handed to whoever is on duty instead', async () => {
    const gone = supplier('Northgate', { onDuty: false, orderTypes: [OrderType.Tax6] });
    const here = supplier('Westfield');
    const order = heldOrder(gone, { status: OrderStatus.Unassigned, supplier: null });
    const { orders, push } = build({ suppliers: [gone, here], waiting: [order] });

    const before = Date.now();
    const routed = await orders.routeWaiting(order);

    expect(String(routed.supplier)).toBe(String(here._id));
    expect(routed.status).toBe(OrderStatus.AwaitingSupplier);
    /* Received while they are on duty, so timed. */
    expect(+routed.dueAt! - before).toBeGreaterThanOrEqual(WINDOW_MS - 50);
    expect(push.toSupplier).toHaveBeenCalledTimes(1);
  });

  it('stays untimed if it came in while nobody was on duty', async () => {
    const me = supplier('Northgate');
    const { orders } = build({ suppliers: [me] });
    const order = heldOrder(me, { untimed: true, status: OrderStatus.AwaitingSupplier });

    expect(await orders.restartOrRelease(order, new Date())).toBe(true);
    expect(order.dueAt).toBeNull();
    expect(order.status).toBe(OrderStatus.AwaitingSupplier);
  });
});

describe('an admin reassigning an order', () => {
  it('is refused onto a supplier who is off duty', async () => {
    const from = supplier('Northgate');
    const to = supplier('Westfield', { onDuty: false });
    const { orders } = build({ suppliers: [from, to] });

    await expect(orders.reassign(heldOrder(from), String(to._id))).rejects.toThrow(
      new BadRequestException('Westfield is off duty. Orders can only go to a supplier who is on duty.'),
    );
  });

  it('starts a window on an order received while on duty', async () => {
    const from = supplier('Northgate');
    const to = supplier('Westfield');
    const { orders } = build({ suppliers: [from, to] });
    const order = heldOrder(from, { save: jest.fn() });

    const before = Date.now();
    await orders.reassign(order, String(to._id));

    expect(+order.dueAt! - before).toBeGreaterThanOrEqual(WINDOW_MS - 50);
  });

  it('keeps an untimed order untimed', async () => {
    const from = supplier('Northgate');
    const to = supplier('Westfield');
    const { orders } = build({ suppliers: [from, to] });
    const order = heldOrder(from, { untimed: true, save: jest.fn() });

    await orders.reassign(order, String(to._id));

    expect(String(order.supplier)).toBe(String(to._id));
    expect(order.status).toBe(OrderStatus.AwaitingSupplier);
    expect(order.dueAt).toBeNull();
  });
});

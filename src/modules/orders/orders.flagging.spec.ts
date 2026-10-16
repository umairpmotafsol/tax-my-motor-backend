/**
 * The Direct Debit review loop, and what happens when an order needs an
 * admin.
 *
 * Three rules are pinned here, because each is one the apps rely on
 * without being able to check it for themselves:
 *
 *  - The loop goes round as many times as it takes: supplier sends the
 *    mandate back, customer corrects it, and it lands back with the
 *    supplier — until somebody approves it.
 *  - More than BANK_ROUNDS_BEFORE_FLAG send-backs flags the order to
 *    the admins, once, without stopping the loop.
 *  - A supplier can flag any order of theirs that still needs its
 *    invoice, with or without a comment. The flag stops their clock,
 *    which starts afresh when an admin sends the order back, and never
 *    runs while the flag stands. Uploading the invoice simply
 *    completes the order: it clears a standing flag, and an order with
 *    its invoice uploaded cannot be flagged.
 *  - An admin answers a flag one of three ways: send the order back to
 *    the supplier with a comment, complete it, or cancel it. A cancelled
 *    order never moves again.
 *
 * The services are the real ones; only what they talk to is stubbed.
 */
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  BANK_ROUNDS_BEFORE_FLAG,
  BankField,
  BankReviewStatus,
} from '../../common/enums/bank.enum';
import { NotificationType } from '../../common/enums/notification.enum';
import {
  CommunicationMethod,
  InvoiceStatus,
  OrderFlagSource,
  OrderStatus,
  OrderType,
} from '../../common/enums/order.enum';
import { Role } from '../../common/enums/role.enum';
import { decryptField, encryptField, initEncryption } from '../../common/utils/crypto.util';
import { BankReviewService } from '../bank/bank-review.service';
import { OrdersService } from './orders.service';
import { toAdminOrder, toCustomerOrder, toSupplierOrder } from './orders.serializer';
import { OrderDocument } from './schemas/order.schema';

const WINDOW_MS = 420_000;

const supplierUser: AuthUser = {
  userId: String(new Types.ObjectId()),
  email: 'desk@supplier.test',
  role: Role.Supplier,
  supplierId: String(new Types.ObjectId()),
  name: 'Supplier Desk',
};

const adminUser: AuthUser = {
  userId: String(new Types.ObjectId()),
  email: 'admin@taxmymotor.test',
  role: Role.Admin,
  name: 'Admin',
};

const UPLOADED = 'The invoice for this order has been uploaded, so it cannot be flagged.';

const INVOICE_FILE = {
  fileName: 'invoice.jpg',
  storageKey: 'k',
  url: '',
  provider: 'local' as const,
  mimeType: 'image/jpeg',
  size: 1,
};

const GOOD_BANK = {
  accountHolder: 'Sarah Lee',
  accountNumber: '12345678',
  sortCode: '12-34-56',
  dateOfBirth: '04/07/1990',
};

function build() {
  const notifications = {
    raise: jest.fn(async (..._a: unknown[]) => undefined),
    resolve: jest.fn(async (..._a: unknown[]) => undefined),
    clearForOrder: jest.fn(async (..._a: unknown[]) => undefined),
  };
  const realtime = {
    orderChanged: jest.fn(),
    orderFlagged: jest.fn(),
    bankApproved: jest.fn(),
    bankChangesRequested: jest.fn(),
    bankResubmitted: jest.fn(),
  };
  const push = {
    enabled: true,
    toAdmins: jest.fn(async (..._a: unknown[]) => 1),
    toSupplier: jest.fn(async (..._a: unknown[]) => 1),
  };
  const suppliers = { findById: jest.fn(async () => ({ name: 'Northgate Motors' })) };
  const config = {
    get: (key: string) => (key === 'responseTimeoutMs' ? WINDOW_MS : undefined),
  };

  /* The mail server, stood in for: every email is accepted unless a test says otherwise. */
  const mail = {
    enabled: true,
    sendInvoice: jest.fn(
      async (..._a: unknown[]): Promise<{ sent: true } | { sent: false; reason: string }> => ({
        sent: true,
      }),
    ),
  };
  /*
   * Just the one write the email step makes. It answers with the order
   * as that update leaves it, which is what Mongoose's `{ new: true }`
   * does.
   */
  const orderModel = {
    findByIdAndUpdate: jest.fn(
      async (
        _id: unknown,
        update: { $set: Record<string, unknown>; $push: { timeline: unknown } },
      ) => (emailed ? { ...emailed, ...update.$set, timeline: [...emailed.timeline, update.$push.timeline] } : null),
    ),
  };
  /** Set by a test that wants the email's write applied to its order. */
  let emailed: OrderDocument | null = null;
  const trackEmail = (order: OrderDocument) => {
    emailed = order;
  };

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
    mail as never,
  );
  const bankReview = new BankReviewService(orders, notifications as never, realtime as never);

  return { orders, bankReview, notifications, realtime, push, mail, orderModel, trackEmail };
}

/** Lets the email step, which the upload does not wait for, run to its end. */
const settled = () => new Promise(done => setImmediate(done));

/** An order as it sits just after checkout, assigned and with its window running. */
function orderOf(type: OrderType, over: Record<string, unknown> = {}): OrderDocument {
  const now = new Date();
  const directDebit = type === OrderType.DirectDebit;
  return {
    _id: new Types.ObjectId(),
    orderNumber: 'ORD-1042',
    customer: new Types.ObjectId(),
    customerSnapshot: { name: 'Sarah Lee', email: 'sarah@example.com', phone: '07700900123' },
    supplier: new Types.ObjectId(supplierUser.supplierId),
    reg: 'AB12 CDE',
    vehicle: { make: 'Ford', variant: '', model: 'Ford Fiesta', colour: 'Blue', taxClass: 'Petrol' },
    orderType: type,
    plan: 'Direct Debit',
    items: [],
    pricing: {},
    total: 195,
    payment: null,
    status: OrderStatus.AwaitingSupplier,
    invoiceStatus: InvoiceStatus.Pending,
    invoice: null,
    communicationMethod: CommunicationMethod.Email,
    whatsappRequested: false,
    v62Requested: false,
    v62: null,
    bank: directDebit
      ? {
          accountHolder: 'Sarah Lee',
          accountNumber: encryptField('12345670'),
          sortCode: '12-34-56',
          dateOfBirth: encryptField('04/07/1990'),
        }
      : null,
    bankReview: directDebit ? { status: BankReviewStatus.Submitted, flagged: [], notes: [] } : null,
    flag: null,
    placedAt: now,
    assignedAt: now,
    turnStartedAt: null,
    dueAt: new Date(now.getTime() + WINDOW_MS),
    cancelledAt: null,
    timeline: [],
    save: jest.fn(async () => undefined),
    ...over,
  } as unknown as OrderDocument;
}

beforeAll(() => initEncryption('', 'test'));

describe('the Direct Debit loop', () => {
  it('goes supplier → customer → supplier with the correction, then clears for the invoice', async () => {
    const { orders, bankReview } = build();
    const order = orderOf(OrderType.DirectDebit);

    /* The supplier names what is wrong; the order is the customer's and the clock stops. */
    await bankReview.requestChanges(
      order,
      [BankField.AccountNumber],
      'The account number does not match the statement.',
    );
    expect(order.bankReview!.status).toBe(BankReviewStatus.ChangesRequested);
    expect(order.bankReview!.flagged).toEqual([BankField.AccountNumber]);
    expect(order.dueAt).toBeNull();
    expect(orders.bankCleared(order)).toBe(false);

    /* The customer sees their own mandate and the flag on it, and nothing about suppliers. */
    const asCustomer = toCustomerOrder(order);
    expect(asCustomer.bankReview!.flagged).toEqual([BankField.AccountNumber]);
    expect(asCustomer.bank!.accountNumber).toBe('12345670');

    /* The correction replaces what is stored, and the supplier's window starts again. */
    await bankReview.resubmit(order, GOOD_BANK);
    expect(order.bankReview!.status).toBe(BankReviewStatus.Submitted);
    expect(order.bankReview!.flagged).toEqual([]);
    expect(decryptField(order.bank!.accountNumber)).toBe('12345678');
    expect(order.dueAt).not.toBeNull();
    expect(toSupplierOrder(order).bank!.accountNumber).toBe('12345678');

    await bankReview.approve(order);
    expect(order.bankReview!.status).toBe(BankReviewStatus.Approved);
    expect(orders.bankCleared(order)).toBe(true);

    /* Every turn is kept, in order — the thread is the record of what was asked. */
    expect(order.bankReview!.notes.map(note => note.by)).toEqual([
      'supplier',
      'customer',
      'supplier',
    ]);
  });

  it("records what the customer changed, and tells the supplier's phone", async () => {
    const { bankReview, push } = build();
    const order = orderOf(OrderType.DirectDebit);
    await bankReview.requestChanges(order, [BankField.AccountNumber], 'Does not match.');

    /* They fixed the number that was asked for, and the sort code while they were there. */
    await bankReview.resubmit(order, { ...GOOD_BANK, sortCode: '65-43-21' });

    expect(order.bankReview!.notes.at(-1)).toMatchObject({
      by: 'customer',
      fields: [BankField.AccountNumber, BankField.SortCode],
    });
    expect(push.toSupplier.mock.calls.at(-1)![1]).toMatchObject({
      title: 'Bank details updated',
      data: { kind: 'order.returned' },
    });
  });

  it('lets the supplier simply upload the invoice when the details are right', async () => {
    const { orders, bankReview, notifications } = build();

    /* Straight off a new order: no approval tap first. */
    const fresh = orderOf(OrderType.DirectDebit);
    await orders.attachInvoice(fresh, INVOICE_FILE, supplierUser.userId);
    expect(fresh.bankReview!.status).toBe(BankReviewStatus.Approved);
    expect(fresh.status).toBe(OrderStatus.InvoiceSent);
    expect(notifications.raise).toHaveBeenCalledWith(
      NotificationType.BankApproved,
      fresh._id,
      Role.Customer,
      fresh.customer,
    );

    /* And the same on one the customer has corrected and sent back. */
    const returned = orderOf(OrderType.DirectDebit);
    await bankReview.requestChanges(returned, [BankField.SortCode], 'Sort code is short.');
    await bankReview.resubmit(returned, GOOD_BANK);
    await orders.attachInvoice(returned, INVOICE_FILE, supplierUser.userId);
    expect(returned.bankReview!.status).toBe(BankReviewStatus.Approved);
    expect(returned.status).toBe(OrderStatus.InvoiceSent);
    expect(returned.bankReview!.notes.map(note => note.by)).toEqual([
      'supplier',
      'customer',
      'supplier',
    ]);
  });

  it('refuses the invoice while the details are with the customer', async () => {
    const { orders, bankReview } = build();
    const order = orderOf(OrderType.DirectDebit);
    await bankReview.requestChanges(order, [BankField.SortCode], 'Sort code is short.');

    await expect(orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId)).rejects.toThrow(
      'The bank details on this order are back with the customer to correct.',
    );
    expect(order.invoiceStatus).toBe(InvoiceStatus.Pending);
  });

  it('says when the supplier finished, for the list of what they completed today', async () => {
    const { orders } = build();
    const order = orderOf(OrderType.Tax12);
    expect(toSupplierOrder(order).completedAt).toBeNull();

    await orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId);

    expect(toSupplierOrder(order).completedAt).toBe(order.invoiceUploadedAt!.toISOString());
  });

  it('only lets each side move on their own turn', async () => {
    const { bankReview } = build();
    const order = orderOf(OrderType.DirectDebit);

    await expect(bankReview.resubmit(order, GOOD_BANK)).rejects.toThrow(
      'These details are not waiting on you.',
    );

    await bankReview.requestChanges(order, [BankField.SortCode], 'Sort code is short.');
    await expect(bankReview.approve(order)).rejects.toThrow(
      'These details are back with the customer.',
    );
    await expect(
      bankReview.requestChanges(order, [BankField.SortCode], 'Still short.'),
    ).rejects.toThrow('These details are back with the customer.');
  });

  it('refuses a correction that is still wrong, and leaves the order with the customer', async () => {
    const { bankReview } = build();
    const order = orderOf(OrderType.DirectDebit);
    await bankReview.requestChanges(order, [BankField.SortCode], 'Sort code is short.');

    await expect(
      bankReview.resubmit(order, { ...GOOD_BANK, sortCode: '12-34-5' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(order.bankReview!.status).toBe(BankReviewStatus.ChangesRequested);
  });
});

describe('a mandate that keeps coming back', () => {
  /** One full round: sent back, corrected, with the supplier again. */
  const round = async (bankReview: BankReviewService, order: OrderDocument, n: number) => {
    await bankReview.requestChanges(order, [BankField.AccountNumber], 'Still wrong, round ' + n);
    await bankReview.resubmit(order, GOOD_BANK);
  };

  it('is left alone for the first three send-backs', async () => {
    const { bankReview, notifications, realtime } = build();
    const order = orderOf(OrderType.DirectDebit);

    for (let n = 1; n <= BANK_ROUNDS_BEFORE_FLAG; n += 1) {
      await round(bankReview, order, n);
    }

    expect(order.flag).toBeNull();
    expect(realtime.orderFlagged).not.toHaveBeenCalled();
    expect(notifications.raise).not.toHaveBeenCalledWith(
      NotificationType.OrderFlagged,
      expect.anything(),
    );
  });

  it('is flagged to the admins on the fourth, and still reaches the customer', async () => {
    const { bankReview, notifications, realtime, push } = build();
    const order = orderOf(OrderType.DirectDebit);
    for (let n = 1; n <= BANK_ROUNDS_BEFORE_FLAG; n += 1) {
      await round(bankReview, order, n);
    }

    await bankReview.requestChanges(order, [BankField.AccountNumber], 'Wrong a fourth time.');

    expect(order.flag).toMatchObject({
      source: OrderFlagSource.System,
      reason: 'Bank details sent back 4 times',
      by: null,
    });
    expect(notifications.raise).toHaveBeenCalledWith(NotificationType.OrderFlagged, order._id);
    expect(realtime.orderFlagged).toHaveBeenCalledTimes(1);
    expect(push.toAdmins.mock.calls[0][0]).toMatchObject({
      title: 'Order flagged',
      data: { kind: 'order.flagged', reg: 'AB12 CDE' },
    });

    /* The loop is not cut off: the customer can still correct it. */
    expect(order.bankReview!.status).toBe(BankReviewStatus.ChangesRequested);
    await bankReview.resubmit(order, GOOD_BANK);
    expect(order.bankReview!.status).toBe(BankReviewStatus.Submitted);
  });

  it('is flagged once, however many more times it goes round', async () => {
    const { bankReview, realtime } = build();
    const order = orderOf(OrderType.DirectDebit);

    for (let n = 1; n <= BANK_ROUNDS_BEFORE_FLAG + 3; n += 1) {
      await round(bankReview, order, n);
    }

    expect(realtime.orderFlagged).toHaveBeenCalledTimes(1);
    expect(order.flag!.reason).toBe('Bank details sent back 4 times');
  });

  it('is flagged again on the next send-back after an admin let it run', async () => {
    const { orders, bankReview, realtime } = build();
    const order = orderOf(OrderType.DirectDebit);
    for (let n = 1; n <= BANK_ROUNDS_BEFORE_FLAG + 1; n += 1) {
      await round(bankReview, order, n);
    }
    await orders.sendBack(order, adminUser, 'Give the customer one more go.');
    expect(orders.isFlagged(order)).toBe(false);

    await bankReview.requestChanges(order, [BankField.AccountNumber], 'Wrong a fifth time.');

    expect(orders.isFlagged(order)).toBe(true);
    expect(order.flag!.reason).toBe('Bank details sent back 5 times');
    expect(realtime.orderFlagged).toHaveBeenCalledTimes(2);
  });
});

describe('a supplier flagging an order', () => {
  it.each([OrderType.Tax6, OrderType.Tax12, OrderType.DirectDebit])(
    'works on a %s order, and stops its clock',
    async type => {
      const { orders, notifications, realtime } = build();
      const order = orderOf(type);

      await orders.flag(order, supplierUser, 'The plate does not match the vehicle.');

      expect(order.flag).toMatchObject({
        source: OrderFlagSource.Supplier,
        reason: 'The plate does not match the vehicle.',
      });
      expect(String(order.flag!.by)).toBe(supplierUser.userId);
      /* Still theirs, but waiting on an admin — so no window is running against them. */
      expect(order.status).toBe(OrderStatus.AwaitingSupplier);
      expect(order.dueAt).toBeNull();
      expect(toSupplierOrder(order).dueAt).toBeNull();
      expect(notifications.raise).toHaveBeenCalledWith(NotificationType.OrderFlagged, order._id);
      expect(realtime.orderFlagged).toHaveBeenCalledWith(order);
    },
  );

  it('shows on both the supplier and the admin view, with the reason', async () => {
    const { orders } = build();
    const order = orderOf(OrderType.Tax12);
    await orders.flag(order, supplierUser, 'Customer rang to say the car is sold.');

    for (const view of [toSupplierOrder(order), toAdminOrder(order)]) {
      expect(view.flagged).toBe(true);
      expect(view.flag).toMatchObject({
        source: 'supplier',
        reason: 'Customer rang to say the car is sold.',
      });
    }
    /* The customer is not told: it is not theirs to act on. */
    expect(toCustomerOrder(order)).not.toHaveProperty('flag');
  });

  it('takes an overdue order off overdue, and lets it go overdue afresh once sent back', async () => {
    const { orders, notifications } = build();
    const order = orderOf(OrderType.Tax12, { status: OrderStatus.Overdue });

    await orders.flag(order, supplierUser, 'Cannot read the V5.');

    /* Flagged is its own state: not pending, not overdue, and no clock. */
    expect(order.status).toBe(OrderStatus.AwaitingSupplier);
    expect(order.dueAt).toBeNull();
    expect(toSupplierOrder(order)).toMatchObject({ status: 'awaiting_invoice', flagged: true });
    expect(toAdminOrder(order)).toMatchObject({ status: 'awaiting_supplier', flagged: true });
    expect(notifications.resolve).toHaveBeenCalledWith(NotificationType.SupplierOverdue, order._id);

    /* Sent back, it is a live order with a deadline again — which the sweep reads. */
    await orders.sendBack(order, adminUser, 'Use the reference on the order.');
    expect(order.status).toBe(OrderStatus.AwaitingSupplier);
    expect(order.invoiceStatus).toBe(InvoiceStatus.Pending);
    expect(order.dueAt).toBeInstanceOf(Date);
  });

  it('keeps the clock stopped when the customer returns bank details meanwhile', async () => {
    const { orders, bankReview } = build();
    const order = orderOf(OrderType.DirectDebit);
    await bankReview.requestChanges(order, [BankField.SortCode], 'Sort code is short.');
    await orders.flag(order, supplierUser, 'Customer is not answering.');

    /* Back with the supplier to check, but the flag is still the admin's to answer. */
    await bankReview.resubmit(order, GOOD_BANK);
    expect(order.bankReview!.status).toBe(BankReviewStatus.Submitted);
    expect(order.dueAt).toBeNull();

    const before = Date.now();
    await orders.sendBack(order, adminUser, 'Details are in now. Carry on.');
    expect(order.dueAt!.getTime()).toBeGreaterThanOrEqual(before + WINDOW_MS);
  });

  it('needs no comment', async () => {
    const { orders, push } = build();
    const order = orderOf(OrderType.Tax6);

    await orders.flag(order, supplierUser);

    expect(order.flag).toMatchObject({ source: OrderFlagSource.Supplier, reason: '' });
    expect(order.timeline.at(-1)).toMatchObject({ title: 'Flagged to admin', detail: null });
    expect(toAdminOrder(order)).toMatchObject({ flagged: true, flag: { reason: '' } });
    /* The push still says something a person can read. */
    expect(push.toAdmins.mock.calls[0][0]).toMatchObject({
      body: 'AB12 CDE · Northgate Motors flagged this order.',
    });
  });

  it.each([
    ['sent to the customer', OrderStatus.InvoiceSent, InvoiceStatus.Sent, CommunicationMethod.Email],
    [
      'waiting on an admin to send it over WhatsApp',
      OrderStatus.InvoiceReady,
      InvoiceStatus.Ready,
      CommunicationMethod.WhatsApp,
    ],
  ])('is refused once the invoice is uploaded and %s', async (_name, status, invoiceStatus, channel) => {
    const { orders, notifications, realtime } = build();
    const order = orderOf(OrderType.Tax12, {
      status,
      invoiceStatus,
      communicationMethod: channel,
      dueAt: null,
    });

    await expect(orders.flag(order, supplierUser, 'Wrong invoice went out.')).rejects.toThrow(
      UPLOADED,
    );
    expect(order.flag).toBeNull();
    expect(order.save).not.toHaveBeenCalled();
    expect(realtime.orderFlagged).not.toHaveBeenCalled();
    expect(notifications.raise).not.toHaveBeenCalled();
  });

  it('cannot be done twice', async () => {
    const { orders, realtime } = build();
    const order = orderOf(OrderType.Tax6);
    await orders.flag(order, supplierUser, 'First reason.');

    await expect(orders.flag(order, supplierUser, 'Second reason.')).rejects.toThrow(
      'This order has already been flagged to an admin.',
    );
    expect(order.flag!.reason).toBe('First reason.');
    expect(realtime.orderFlagged).toHaveBeenCalledTimes(1);
  });
});

describe('a flagged order whose supplier uploads the invoice after all', () => {
  it('simply completes, and comes off the flagged list', async () => {
    const { orders, notifications } = build();
    const order = orderOf(OrderType.Tax12);
    await orders.flag(order, supplierUser, 'Cannot find the paperwork.');

    await orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId);

    expect(order.status).toBe(OrderStatus.InvoiceSent);
    expect(order.invoiceStatus).toBe(InvoiceStatus.Sent);
    expect(orders.isFlagged(order)).toBe(false);
    expect(order.flag).toMatchObject({ resolution: 'invoiced' });
    expect(notifications.resolve).toHaveBeenCalledWith(NotificationType.OrderFlagged, order._id);
    expect(toSupplierOrder(order)).toMatchObject({ status: 'completed', flagged: false });
    expect(toAdminOrder(order)).toMatchObject({ status: 'invoice_sent', flagged: false });

    /* Nothing left for an admin to answer, and no flagging it again. */
    await expect(orders.cancel(order, adminUser)).rejects.toThrow(
      'Only an order that has been flagged can be cancelled.',
    );
    await expect(orders.flag(order, supplierUser)).rejects.toThrow(UPLOADED);
  });

  it('comes off the flagged list on a WhatsApp order too, and waits on the send as usual', async () => {
    const { orders, notifications } = build();
    const order = orderOf(OrderType.Tax12, {
      communicationMethod: CommunicationMethod.WhatsApp,
    });
    await orders.flag(order, supplierUser);

    await orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId);

    expect(order.status).toBe(OrderStatus.InvoiceReady);
    expect(orders.isFlagged(order)).toBe(false);
    expect(notifications.raise).toHaveBeenCalledWith(
      NotificationType.WhatsappSendRequired,
      order._id,
    );
    await expect(orders.flag(order, supplierUser)).rejects.toThrow(UPLOADED);
  });

  it('touches no flag on an order that never had one', async () => {
    const { orders, notifications } = build();
    const order = orderOf(OrderType.Tax12);

    await orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId);

    expect(order.flag).toBeNull();
    expect(notifications.resolve).not.toHaveBeenCalled();
  });
});

describe('an admin sending a flagged order back', () => {
  it('hands it to the supplier with the comment and a fresh window', async () => {
    const { orders, notifications, realtime, push } = build();
    const order = orderOf(OrderType.Tax12, { status: OrderStatus.Overdue });
    await orders.flag(order, supplierUser, 'The plate does not match the vehicle.');

    const before = Date.now();
    await orders.sendBack(order, adminUser, 'Checked with the customer — the plate is right.');

    expect(order.flag).toMatchObject({
      resolution: 'sent_back',
      response: 'Checked with the customer — the plate is right.',
    });
    expect(order.flag!.resolvedAt).toBeInstanceOf(Date);
    /* Theirs again, so their clock starts again — and it is no longer overdue. */
    expect(order.status).toBe(OrderStatus.AwaitingSupplier);
    expect(order.dueAt!.getTime()).toBeGreaterThanOrEqual(before + WINDOW_MS);
    expect(notifications.resolve).toHaveBeenCalledWith(NotificationType.OrderFlagged, order._id);
    expect(notifications.resolve).toHaveBeenCalledWith(NotificationType.SupplierOverdue, order._id);
    expect(realtime.orderChanged).toHaveBeenCalledWith(order);
    expect(push.toSupplier.mock.calls[0][1]).toMatchObject({
      body: 'AB12 CDE · Admin: Checked with the customer — the plate is right.',
      data: { kind: 'order.sent_back' },
    });

    /* Off the admin's flagged list; the supplier can read what the admin said. */
    expect(toAdminOrder(order).flagged).toBe(false);
    expect(toSupplierOrder(order)).toMatchObject({
      status: 'awaiting_invoice',
      flagged: false,
      flag: {
        resolution: 'sent_back',
        response: 'Checked with the customer — the plate is right.',
      },
    });
  });

  it('leaves the clock paused when the mandate is with the customer', async () => {
    const { orders, bankReview } = build();
    const order = orderOf(OrderType.DirectDebit);
    await bankReview.requestChanges(order, [BankField.SortCode], 'Sort code is short.');
    await orders.flag(order, supplierUser, 'Customer is not answering.');

    await orders.sendBack(order, adminUser, 'They are abroad until Monday. Wait for them.');

    expect(order.dueAt).toBeNull();
    expect(order.bankReview!.status).toBe(BankReviewStatus.ChangesRequested);
  });

  it('lets the supplier flag it again afterwards', async () => {
    const { orders, realtime } = build();
    const order = orderOf(OrderType.Tax6);
    await orders.flag(order, supplierUser, 'First problem.');
    await orders.sendBack(order, adminUser, 'Try again.');

    await orders.flag(order, supplierUser, 'Still cannot do it.');

    expect(orders.isFlagged(order)).toBe(true);
    expect(order.flag).toMatchObject({ reason: 'Still cannot do it.', response: '' });
    expect(realtime.orderFlagged).toHaveBeenCalledTimes(2);
  });

  it('is refused on an order with no flag standing', async () => {
    const { orders } = build();
    const order = orderOf(OrderType.Tax6);
    const refused = 'Only an order that has been flagged can be sent back.';

    await expect(orders.sendBack(order, adminUser, 'Why?')).rejects.toThrow(refused);

    await orders.flag(order, supplierUser);
    await orders.sendBack(order, adminUser, 'Once.');
    await expect(orders.sendBack(order, adminUser, 'Twice.')).rejects.toThrow(refused);
  });
});

describe('an admin completing a flagged order', () => {
  it('closes it as done without an invoice, and clears what was standing against it', async () => {
    const { orders, notifications, realtime, push } = build();
    const order = orderOf(OrderType.Tax12);
    await orders.flag(order, supplierUser, 'Invoice went to the customer by post.');

    await orders.complete(order, adminUser);

    expect(order.status).toBe(OrderStatus.InvoiceSent);
    expect(order.invoiceStatus).toBe(InvoiceStatus.Sent);
    expect(order.invoiceSentAt).toBeInstanceOf(Date);
    expect(order.dueAt).toBeNull();
    expect(order.flag).toMatchObject({ resolution: 'completed' });
    expect(order.timeline.at(-1)).toMatchObject({
      actor: 'admin',
      title: 'Order completed by admin',
    });
    expect(notifications.clearForOrder).toHaveBeenCalledWith(order._id);
    expect(realtime.orderChanged).toHaveBeenCalledWith(order);
    expect(push.toSupplier.mock.calls[0][1]).toMatchObject({ data: { kind: 'order.completed' } });

    expect(toSupplierOrder(order)).toMatchObject({ status: 'completed', flagged: false });
    expect(toAdminOrder(order)).toMatchObject({ status: 'invoice_sent', flagged: false });
    expect(toCustomerOrder(order).status).toBe('invoice_sent');
  });

  it('ends the bank loop on a Direct Debit order nobody signed off', async () => {
    const { orders, bankReview } = build();
    const order = orderOf(OrderType.DirectDebit);
    await bankReview.requestChanges(order, [BankField.SortCode], 'Sort code is short.');
    await orders.flag(order, supplierUser, 'Mandate was set up over the phone.');

    await orders.complete(order, adminUser);

    const done = 'This order has already been completed.';
    await expect(bankReview.resubmit(order, GOOD_BANK)).rejects.toThrow(done);
    await expect(bankReview.approve(order)).rejects.toThrow(done);
    await expect(orders.flag(order, supplierUser)).rejects.toThrow(UPLOADED);
  });

  it('is refused on an order nobody flagged', async () => {
    const { orders } = build();
    const order = orderOf(OrderType.Tax12);

    await expect(orders.complete(order, adminUser)).rejects.toThrow(
      'Only an order that has been flagged can be completed this way.',
    );
    expect(order.status).toBe(OrderStatus.AwaitingSupplier);
  });
});

describe('an admin cancelling a flagged order', () => {
  it('ends the order, stops its clock and clears what was standing against it', async () => {
    const { orders, notifications, realtime, push } = build();
    const order = orderOf(OrderType.Tax12);
    await orders.flag(order, supplierUser, 'Customer rang to say the car is sold.');

    await orders.cancel(order, adminUser);

    expect(order.status).toBe(OrderStatus.Cancelled);
    expect(order.cancelledAt).toBeInstanceOf(Date);
    expect(order.dueAt).toBeNull();
    expect(notifications.clearForOrder).toHaveBeenCalledWith(order._id);
    expect(realtime.orderChanged).toHaveBeenCalledWith(order);
    expect(push.toSupplier.mock.calls[0][1]).toMatchObject({ data: { kind: 'order.cancelled' } });

    /* Out of the flagged queue, but the reason it was cancelled is kept. */
    expect(toSupplierOrder(order)).toMatchObject({ status: 'cancelled', flagged: false });
    expect(toAdminOrder(order)).toMatchObject({ status: 'cancelled', flagged: false });
    expect(toAdminOrder(order).flag!.reason).toBe('Customer rang to say the car is sold.');
    expect(toCustomerOrder(order).status).toBe('cancelled');
  });

  it('is refused on an order nobody flagged, or whose flag was already answered', async () => {
    const { orders } = build();
    const order = orderOf(OrderType.Tax12);
    const refused = 'Only an order that has been flagged can be cancelled.';

    await expect(orders.cancel(order, adminUser)).rejects.toThrow(refused);
    expect(order.status).toBe(OrderStatus.AwaitingSupplier);

    await orders.flag(order, supplierUser);
    await orders.sendBack(order, adminUser, 'Carry on.');
    await expect(orders.cancel(order, adminUser)).rejects.toThrow(refused);
    expect(order.status).toBe(OrderStatus.AwaitingSupplier);
  });

  it('works on a Direct Debit order the system flagged', async () => {
    const { orders, bankReview } = build();
    const order = orderOf(OrderType.DirectDebit);
    for (let n = 1; n <= BANK_ROUNDS_BEFORE_FLAG; n += 1) {
      await bankReview.requestChanges(order, [BankField.SortCode], 'Round ' + n);
      await bankReview.resubmit(order, GOOD_BANK);
    }
    await bankReview.requestChanges(order, [BankField.SortCode], 'Round 4');

    await orders.cancel(order, adminUser, 'Customer cannot provide a valid mandate.');

    expect(order.status).toBe(OrderStatus.Cancelled);
    expect(order.timeline.at(-1)).toMatchObject({
      actor: 'admin',
      title: 'Order cancelled',
      detail: 'Customer cannot provide a valid mandate.',
    });
  });

  it('leaves nothing that can still move the order', async () => {
    const { orders, bankReview } = build();
    const order = orderOf(OrderType.DirectDebit);
    await bankReview.requestChanges(order, [BankField.SortCode], 'Sort code is short.');
    await orders.flag(order, supplierUser, 'Customer is not answering.');
    await orders.cancel(order, adminUser);

    const cancelled = 'This order has been cancelled.';
    await expect(bankReview.resubmit(order, GOOD_BANK)).rejects.toThrow(cancelled);
    await expect(bankReview.approve(order)).rejects.toThrow(cancelled);
    await expect(orders.flag(order, supplierUser, 'Again.')).rejects.toThrow(cancelled);
    await expect(orders.cancel(order, adminUser)).rejects.toThrow(cancelled);
    await expect(orders.sendBack(order, adminUser, 'Back.')).rejects.toThrow(cancelled);
    await expect(orders.complete(order, adminUser)).rejects.toThrow(cancelled);
    await expect(orders.markSent(order, adminUser)).rejects.toThrow(cancelled);
    await expect(orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId)).rejects.toThrow(
      cancelled,
    );
  });
});

/**
 * The invoice email. Uploading used to write "Delivered via email" to
 * the order without anything being sent; these hold it to the truth.
 */
describe('emailing the invoice to the customer', () => {
  const titles = (order: OrderDocument) => order.timeline.map(event => event.title);

  it('sends it when the supplier uploads, and says so only once it has gone', async () => {
    const { orders, mail, orderModel, realtime, trackEmail } = build();
    const order = orderOf(OrderType.Tax12, { plan: '12-month tax' });
    trackEmail(order);

    await orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId);

    /* The upload itself claims nothing about an email. */
    expect(order.status).toBe(OrderStatus.InvoiceSent);
    expect(titles(order)).toEqual(['Invoice uploaded']);

    await settled();

    expect(mail.sendInvoice).toHaveBeenCalledTimes(1);
    expect(mail.sendInvoice.mock.calls[0][0]).toMatchObject({
      to: 'sarah@example.com',
      customerName: 'Sarah Lee',
      orderNumber: 'ORD-1042',
      reg: 'AB12 CDE',
      vehicle: 'Ford Fiesta',
      plan: '12-month tax',
      total: '£195.00',
      attachment: { fileName: 'invoice.jpg', mimeType: 'image/jpeg' },
      /* No hosted copy of this one, so nothing to link to. */
      link: null,
    });

    const [id, update] = orderModel.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe(order._id);
    expect(update.$set.invoiceEmail).toMatchObject({
      status: 'sent',
      to: 'sarah@example.com',
      reason: null,
    });
    expect(update.$push.timeline).toMatchObject({
      actor: 'system',
      title: 'Invoice emailed to customer',
      detail: 'Sent to sarah@example.com',
      tone: 'green',
    });
    /* Once for the upload, once more when the email was recorded. */
    expect(realtime.orderChanged).toHaveBeenCalledTimes(2);
  });

  it('attaches the hosted copy, and links to it, when there is one', async () => {
    const { orders, mail } = build();
    const order = orderOf(OrderType.Tax12);
    const hosted = { ...INVOICE_FILE, provider: 'cloudinary' as const, url: 'https://cdn.example/i.jpg' };

    await orders.attachInvoice(order, hosted, supplierUser.userId);
    await settled();

    expect(mail.sendInvoice.mock.calls[0][0]).toMatchObject({
      attachment: { path: 'https://cdn.example/i.jpg' },
      link: 'https://cdn.example/i.jpg',
    });
  });

  it('records a failed email as failed — the order is still done, but nothing says it was sent', async () => {
    const { orders, mail, orderModel, trackEmail } = build();
    mail.sendInvoice.mockResolvedValue({
      sent: false,
      reason: 'The mail server could not be reached.',
    });
    const order = orderOf(OrderType.Tax12);
    trackEmail(order);

    await orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId);
    await settled();

    /* The supplier did their part; a mail server does not undo that. */
    expect(order.status).toBe(OrderStatus.InvoiceSent);
    const update = orderModel.findByIdAndUpdate.mock.calls[0][1];
    expect(update.$set.invoiceEmail).toMatchObject({
      status: 'failed',
      reason: 'The mail server could not be reached.',
    });
    expect(update.$push.timeline).toMatchObject({
      title: 'Invoice email not sent',
      detail: 'The mail server could not be reached.',
      tone: 'red',
    });
  });

  it('sends no email on a WhatsApp order — an admin sends those', async () => {
    const { orders, mail, orderModel } = build();
    const order = orderOf(OrderType.Tax12, { communicationMethod: CommunicationMethod.WhatsApp });

    await orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId);
    await settled();

    expect(mail.sendInvoice).not.toHaveBeenCalled();
    expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('lets an admin send it again, and shows them how it went', async () => {
    const { orders, mail, trackEmail } = build();
    const order = orderOf(OrderType.Tax12);
    trackEmail(order);
    mail.sendInvoice.mockResolvedValueOnce({ sent: false, reason: 'The mail server could not be reached.' });
    await orders.attachInvoice(order, INVOICE_FILE, supplierUser.userId);
    await settled();

    const resent = await orders.resendInvoiceEmail(order);

    expect(mail.sendInvoice).toHaveBeenCalledTimes(2);
    expect(toAdminOrder(resent).invoiceEmail).toMatchObject({
      status: 'sent',
      to: 'sarah@example.com',
      reason: null,
    });
    expect(toAdminOrder(orderOf(OrderType.Tax12)).invoiceEmail).toBeNull();
  });

  it('refuses a resend where there is nothing to email', async () => {
    const { orders, mail } = build();

    await expect(orders.resendInvoiceEmail(orderOf(OrderType.Tax12))).rejects.toThrow(
      'There is no invoice on this order to email yet.',
    );
    await expect(
      orders.resendInvoiceEmail(
        orderOf(OrderType.Tax12, { communicationMethod: CommunicationMethod.WhatsApp }),
      ),
    ).rejects.toThrow('This invoice goes to the customer over WhatsApp, not by email.');
    expect(mail.sendInvoice).not.toHaveBeenCalled();
  });
});

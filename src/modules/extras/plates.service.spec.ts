/**
 * "Order Number Plates": the order is recorded only once the payment is
 * verified, the customer and the admins are emailed, and an admin moves
 * the status along afterwards. Nothing here reaches Stripe, the vehicle
 * data provider or a mail server.
 */
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { PlatesService, toAdminPlateOrder, toPlateOrder } from './plates.service';
import { PlateOrderStatus } from './schemas/plate-order.schema';

const VEHICLE = {
  reg: 'AB12 CDE',
  make: 'FORD',
  variant: 'FIESTA',
  model: 'FORD FIESTA',
  colour: 'BLUE',
  vin: 'WF0DXXGAKDLR48213',
  taxClass: 'PETROL',
  year: 2013,
  known: true,
};

const CUSTOMER = { _id: 'user-1', name: 'Alex Morgan', email: 'alex@example.co.uk' };
const ADMIN = { _id: 'admin-1', name: 'Sam Admin', email: 'admintesting890@yopmail.com' };

const DETAILS = {
  reg: 'AB12 CDE',
  name: 'Alex Morgan',
  phone: '7700 900123',
  email: 'alex@example.co.uk',
  address: '24 Maple Road, SW11 3AA',
};

function setup(vehicle: Partial<typeof VEHICLE> | Error = {}) {
  const saved: Array<Record<string, unknown>> = [];
  const orderModel = {
    findOne: jest.fn(
      async ({ paymentIntentId }: { paymentIntentId: string }) =>
        saved.find(row => row.paymentIntentId === paymentIntentId) ?? null,
    ),
    findById: jest.fn(async (id: string) => saved.find(row => row._id === id) ?? null),
    create: jest.fn(async (row: Record<string, unknown>) => {
      const doc = {
        _id: '64b000000000000000000001',
        ...row,
        history: [...(row.history as unknown[])],
        save: jest.fn(),
      };
      saved.push(doc);
      return doc;
    }),
  };
  const vehicles = {
    lookup: jest.fn(async () => {
      if (vehicle instanceof Error) {
        throw vehicle;
      }
      return { ...VEHICLE, ...vehicle };
    }),
  };
  const payments = {
    createFlatIntent: jest.fn(async (amount: number) => ({
      clientSecret: 'secret',
      publishableKey: 'pk',
      amount,
      currency: 'gbp',
    })),
    verifyPaid: jest.fn(async () => ({
      id: 'pi_1',
      metadata: { kind: 'plates', reg: 'AB12CDE', customerId: 'user-1' },
    })),
  };
  const users = {
    findById: jest.fn(async (id: string) => (id === ADMIN._id ? ADMIN : CUSTOMER)),
    listByRole: jest.fn(async () => [ADMIN]),
  };
  const mail = {
    sendPlateReceipt: jest.fn(async () => ({ sent: true })),
    sendPlateOrderAlert: jest.fn(async () => ({ sent: true })),
  };
  const config = { get: () => 20 };

  const service = new PlatesService(
    orderModel as never,
    vehicles as never,
    payments as never,
    users as never,
    mail as never,
    config as never,
  );
  return { service, orderModel, vehicles, payments, mail, saved };
}

describe('starting a number plates order', () => {
  it('gives the vehicle and the flat price', async () => {
    const { service } = setup();

    await expect(service.check('ab12cde')).resolves.toEqual({
      reg: 'AB12 CDE',
      make: 'FORD',
      model: 'FORD FIESTA',
      price: 20,
    });
  });

  it.each([
    ['a stand-in vehicle', { known: false }],
    ['a plate the register does not know', new NotFoundException()],
    ['a provider that could not answer', new ServiceUnavailableException()],
  ])('still sells plates for %s, without a make', async (_label, vehicle) => {
    const { service } = setup(vehicle);

    await expect(service.check('AB12CDE')).resolves.toEqual({
      reg: 'AB12 CDE',
      make: '',
      model: '',
      price: 20,
    });
  });

  it('refuses something that is not a registration', async () => {
    const { service, vehicles } = setup();

    await expect(service.check('NOT A PLATE!')).rejects.toBeInstanceOf(BadRequestException);
    expect(vehicles.lookup).not.toHaveBeenCalled();
  });

  it('raises the flat fee, marked as a plates payment for this plate', async () => {
    const { service, payments } = setup();

    await service.createIntent({ ...DETAILS, reg: 'ab12 cde' }, 'user-1');

    expect(payments.createFlatIntent).toHaveBeenCalledWith(20, 'user-1', {
      kind: 'plates',
      reg: 'AB12CDE',
    });
  });
});

describe('placing a paid order', () => {
  it('verifies £20, records the order as received and emails the customer and the admins', async () => {
    const { service, payments, mail } = setup();

    const order = await service.place(DETAILS, 'pi_1', 'user-1');

    expect(payments.verifyPaid).toHaveBeenCalledWith('pi_1', 2000, 'user-1');
    expect(toPlateOrder(order)).toMatchObject({
      reg: 'AB12 CDE',
      vehicleModel: 'FORD FIESTA',
      amount: 20,
      status: 'received',
      statusLabel: 'Received',
      address: '24 Maple Road, SW11 3AA',
    });
    expect(mail.sendPlateReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'alex@example.co.uk', total: '£20.00' }),
    );
    expect(mail.sendPlateOrderAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['admintesting890@yopmail.com'],
        reg: 'AB12 CDE',
        phone: '7700 900123',
        address: '24 Maple Road, SW11 3AA',
      }),
    );
    expect(toAdminPlateOrder(order)).toMatchObject({ receiptEmail: 'sent', adminEmail: 'sent' });
  });

  it('returns the order already placed when the same payment is sent twice', async () => {
    const { service, payments, orderModel } = setup();

    const first = await service.place(DETAILS, 'pi_1', 'user-1');
    const second = await service.place(DETAILS, 'pi_1', 'user-1');

    expect(second).toBe(first);
    expect(orderModel.create).toHaveBeenCalledTimes(1);
    expect(payments.verifyPaid).toHaveBeenCalledTimes(1);
  });

  it('will not hand another customer an order placed on somebody else’s payment', async () => {
    const { service } = setup();
    await service.place(DETAILS, 'pi_1', 'user-1');

    await expect(service.place(DETAILS, 'pi_1', 'user-2')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    ['a different registration', { kind: 'plates', reg: 'ZZ99ZZZ' }],
    ['a VIN', { kind: 'vin', reg: 'AB12CDE' }],
  ])('refuses a payment made for %s', async (_label, metadata) => {
    const { service, payments, orderModel } = setup();
    payments.verifyPaid.mockResolvedValue({ id: 'pi_1', metadata } as never);

    await expect(service.place(DETAILS, 'pi_1', 'user-1')).rejects.toThrow(
      'That payment was not made for this registration.',
    );
    expect(orderModel.create).not.toHaveBeenCalled();
  });

  it('keeps the order when neither email leaves', async () => {
    const { service, mail } = setup();
    mail.sendPlateReceipt.mockResolvedValue({ sent: false, reason: 'smtp down' } as never);
    mail.sendPlateOrderAlert.mockResolvedValue({ sent: false, reason: 'smtp down' } as never);

    const order = await service.place(DETAILS, 'pi_1', 'user-1');

    expect(toAdminPlateOrder(order)).toMatchObject({
      status: 'received',
      receiptEmail: 'failed',
      adminEmail: 'failed',
    });
  });
});

describe('an admin moving the order along', () => {
  it('changes the status and records who did it', async () => {
    const { service } = setup();
    const order = await service.place(DETAILS, 'pi_1', 'user-1');

    await service.setStatus(String(order._id), PlateOrderStatus.Dispatched, 'admin-1');

    const view = toAdminPlateOrder(order);
    expect(view.status).toBe('dispatched');
    expect(view.history.map(h => [h.status, h.by])).toEqual([
      ['received', ''],
      ['dispatched', 'Sam Admin'],
    ]);
  });

  it('records nothing when the status is unchanged', async () => {
    const { service } = setup();
    const order = await service.place(DETAILS, 'pi_1', 'user-1');

    await service.setStatus(String(order._id), PlateOrderStatus.Received, 'admin-1');

    expect(order.history).toHaveLength(1);
  });

  it('says so for an order that does not exist', async () => {
    const { service } = setup();

    await expect(service.findById('not-an-id')).rejects.toBeInstanceOf(NotFoundException);
  });
});

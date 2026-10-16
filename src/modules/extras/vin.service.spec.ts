/**
 * "Reg > VIN": the VIN is checked for before money moves, and handed
 * over only once the payment is verified. Nothing here reaches Stripe,
 * the vehicle data provider or a mail server.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { VinService, toVinPurchase } from './vin.service';

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

function setup(vehicle: Partial<typeof VEHICLE> = {}) {
  const saved: Array<Record<string, unknown>> = [];
  const purchaseModel = {
    findOne: jest.fn(
      async ({ paymentIntentId }: { paymentIntentId: string }) =>
        saved.find(row => row.paymentIntentId === paymentIntentId) ?? null,
    ),
    create: jest.fn(async (row: Record<string, unknown>) => {
      const doc = { _id: 'purchase-' + (saved.length + 1), ...row, save: jest.fn() };
      saved.push(doc);
      return doc;
    }),
  };
  const vehicles = { lookupForV62: jest.fn(async () => ({ ...VEHICLE, ...vehicle })) };
  const payments = {
    createFlatIntent: jest.fn(async (amount: number) => ({
      clientSecret: 'secret',
      publishableKey: 'pk',
      amount,
      currency: 'gbp',
    })),
    verifyPaid: jest.fn(async () => ({
      id: 'pi_1',
      metadata: { kind: 'vin', reg: 'AB12CDE', customerId: 'user-1' },
    })),
  };
  const users = { findById: jest.fn(async () => CUSTOMER) };
  const mail = { sendVinReceipt: jest.fn(async () => ({ sent: true })) };
  const config = { get: () => 0.99 };

  const service = new VinService(
    purchaseModel as never,
    vehicles as never,
    payments as never,
    users as never,
    mail as never,
    config as never,
  );
  return { service, purchaseModel, vehicles, payments, mail, saved };
}

describe('checking for a VIN before payment', () => {
  it('says which vehicle and what it costs, and never the VIN', async () => {
    const { service } = setup();

    const offer = await service.check('ab12cde');

    expect(offer).toEqual({ reg: 'AB12 CDE', make: 'FORD', model: 'FORD FIESTA', price: 0.99 });
    expect(JSON.stringify(offer)).not.toContain(VEHICLE.vin);
  });

  it.each([
    ['only the last five characters', { vin: '48213' }],
    ['no VIN at all', { vin: '' }],
    ['a stand-in vehicle', { known: false }],
    ['a VIN with a letter no VIN uses', { vin: 'WF0DXXGAKDLR4821O' }],
  ])('refuses a plate with %s', async (_label, vehicle) => {
    const { service } = setup(vehicle);

    await expect(service.check('AB12CDE')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('raises no payment for a plate with no VIN to sell', async () => {
    const { service, payments } = setup({ vin: '48213' });

    await expect(service.createIntent('AB12CDE', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(payments.createFlatIntent).not.toHaveBeenCalled();
  });

  it('raises the flat fee, marked as a VIN payment for this plate', async () => {
    const { service, payments } = setup();

    await service.createIntent('ab12 cde', 'user-1');

    expect(payments.createFlatIntent).toHaveBeenCalledWith(0.99, 'user-1', {
      kind: 'vin',
      reg: 'AB12CDE',
    });
  });
});

describe('completing a paid purchase', () => {
  it('verifies the payment for 99p, stores the sale and emails the receipt', async () => {
    const { service, payments, mail } = setup();

    const purchase = await service.purchase('AB12 CDE', 'pi_1', 'user-1');

    expect(payments.verifyPaid).toHaveBeenCalledWith('pi_1', 99, 'user-1');
    expect(toVinPurchase(purchase)).toMatchObject({
      reg: 'AB12 CDE',
      vehicleModel: 'FORD FIESTA',
      vin: 'WF0DXXGAKDLR48213',
      amount: 0.99,
      receiptEmailed: true,
    });
    expect(mail.sendVinReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alex@example.co.uk',
        vin: 'WF0DXXGAKDLR48213',
        total: '£0.99',
      }),
    );
  });

  it('returns the sale already made when the same payment is sent twice', async () => {
    const { service, payments, purchaseModel } = setup();

    const first = await service.purchase('AB12CDE', 'pi_1', 'user-1');
    const second = await service.purchase('AB12CDE', 'pi_1', 'user-1');

    expect(second).toBe(first);
    expect(purchaseModel.create).toHaveBeenCalledTimes(1);
    expect(payments.verifyPaid).toHaveBeenCalledTimes(1);
  });

  it('will not hand another customer a sale made on somebody else’s payment', async () => {
    const { service } = setup();
    await service.purchase('AB12CDE', 'pi_1', 'user-1');

    await expect(service.purchase('AB12CDE', 'pi_1', 'user-2')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    ['a different registration', { kind: 'vin', reg: 'ZZ99ZZZ' }],
    ['something that was not a VIN', { kind: 'plates', reg: 'AB12CDE' }],
  ])('refuses a payment made for %s', async (_label, metadata) => {
    const { service, payments, purchaseModel } = setup();
    payments.verifyPaid.mockResolvedValue({ id: 'pi_1', metadata } as never);

    await expect(service.purchase('AB12CDE', 'pi_1', 'user-1')).rejects.toThrow(
      'That payment was not made for this registration.',
    );
    expect(purchaseModel.create).not.toHaveBeenCalled();
  });

  it('keeps the sale when the receipt email does not leave', async () => {
    const { service, mail } = setup();
    mail.sendVinReceipt.mockResolvedValue({ sent: false, reason: 'smtp down' } as never);

    const purchase = await service.purchase('AB12CDE', 'pi_1', 'user-1');

    expect(toVinPurchase(purchase)).toMatchObject({
      vin: 'WF0DXXGAKDLR48213',
      receiptEmailed: false,
    });
  });
});

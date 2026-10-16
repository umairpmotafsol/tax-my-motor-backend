import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { gbp, normaliseReg } from '../../common/utils/format.util';
import { MailService } from '../mail/mail.service';
import { PaymentIntentResult, PaymentsService } from '../payments/payments.service';
import { UsersService } from '../users/users.service';
import { VehicleLookup, VehiclesService } from '../vehicles/vehicles.service';
import { VinPurchase, VinPurchaseDocument } from './schemas/vin-purchase.schema';

/** A full VIN: seventeen characters, and never I, O or Q. */
const FULL_VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

/** What the customer may know before paying: which vehicle, and what it costs. Never the VIN. */
export interface VinOffer {
  reg: string;
  make: string;
  model: string;
  price: number;
}

/**
 * "Reg > VIN": a registration in, the vehicle's VIN out, for a flat fee.
 *
 * The order of things is the product. The VIN is looked up *before* any
 * money moves, so nobody is charged for a number we do not have — and it
 * is not sent to the app until the payment has been verified here, so
 * nobody reads it without paying either.
 */
@Injectable()
export class VinService {
  private readonly logger = new Logger(VinService.name);

  constructor(
    @InjectModel(VinPurchase.name) private readonly purchaseModel: Model<VinPurchaseDocument>,
    private readonly vehicles: VehiclesService,
    private readonly payments: PaymentsService,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  get price(): number {
    return this.config.get<number>('vinFee') ?? 0.99;
  }

  /**
   * The vehicle, with a VIN that can honestly be sold.
   *
   * Two things are refused. A stand-in vehicle — the development
   * fallback for a plate nobody has on record — carries an invented VIN.
   * And some data licences return only the last five characters, which
   * is not what "your 17-character VIN" promises.
   */
  private async find(reg: string): Promise<VehicleLookup> {
    /* The lookup that also asks the identity package, which is where a VIN comes from. */
    const vehicle = await this.vehicles.lookupForV62(reg);
    if (!vehicle.known || !FULL_VIN.test(vehicle.vin.toUpperCase())) {
      throw new NotFoundException('We could not find a VIN for that registration.');
    }
    return vehicle;
  }

  /** Step 1: is there a VIN to sell for this plate? */
  async check(reg: string): Promise<VinOffer> {
    const vehicle = await this.find(reg);
    return { reg: vehicle.reg, make: vehicle.make, model: vehicle.model, price: this.price };
  }

  /** Step 2: the card payment — raised only for a plate whose VIN is known to exist. */
  async createIntent(reg: string, customerId: string): Promise<PaymentIntentResult> {
    const vehicle = await this.find(reg);
    return this.payments.createFlatIntent(this.price, customerId, {
      kind: 'vin',
      reg: normaliseReg(vehicle.reg),
    });
  }

  /**
   * Step 3: the payment is checked, and the VIN handed over.
   *
   * Safe to call twice with the same payment: a customer whose
   * connection dropped after paying gets the sale they already made,
   * not a second charge and not an error.
   */
  async purchase(
    reg: string,
    paymentIntentId: string,
    customerId: string,
  ): Promise<VinPurchaseDocument> {
    const existing = await this.purchaseModel.findOne({ paymentIntentId });
    if (existing) {
      if (String(existing.customer) !== customerId) {
        throw new BadRequestException('That payment does not belong to this account.');
      }
      return existing;
    }

    const intent = await this.payments.verifyPaid(
      paymentIntentId,
      Math.round(this.price * 100),
      customerId,
    );
    /* A payment made for one thing must not be spent on another. */
    if (intent.metadata?.kind !== 'vin' || intent.metadata?.reg !== normaliseReg(reg)) {
      throw new BadRequestException('That payment was not made for this registration.');
    }

    const vehicle = await this.find(reg);
    const customer = await this.users.findById(customerId);

    let purchase: VinPurchaseDocument;
    try {
      purchase = await this.purchaseModel.create({
        customer: customer._id,
        reg: vehicle.reg,
        make: vehicle.make,
        vehicleModel: vehicle.model,
        vin: vehicle.vin.toUpperCase(),
        amount: this.price,
        paymentIntentId,
        purchasedAt: new Date(),
      });
    } catch (err) {
      /* Two requests raced on one payment; the unique index let one through. */
      if ((err as { code?: number }).code === 11000) {
        return (await this.purchaseModel.findOne({ paymentIntentId }))!;
      }
      throw err;
    }

    /* The sale stands whether or not the receipt leaves — the result is recorded, never thrown. */
    const receipt = await this.mail.sendVinReceipt({
      to: customer.email,
      customerName: customer.name,
      reg: purchase.reg,
      vehicle: purchase.vehicleModel,
      vin: purchase.vin,
      total: gbp(purchase.amount),
    });
    purchase.receiptEmail = receipt.sent ? 'sent' : 'failed';
    await purchase.save();
    if (!receipt.sent) {
      this.logger.warn('VIN receipt for ' + purchase.reg + ' was not sent: ' + receipt.reason);
    }
    return purchase;
  }

  /** The customer's own purchases, newest first — what their Orders tab lists. */
  listForCustomer(customerId: string): Promise<VinPurchaseDocument[]> {
    return this.purchaseModel.find({ customer: customerId }).sort({ purchasedAt: -1 }).limit(100);
  }
}

/** The customer's view of a sale. It is theirs, so the VIN is on it. */
export function toVinPurchase(purchase: VinPurchaseDocument) {
  return {
    id: String(purchase._id),
    reg: purchase.reg,
    make: purchase.make,
    vehicleModel: purchase.vehicleModel,
    vin: purchase.vin,
    amount: purchase.amount,
    purchasedAt: new Date(purchase.purchasedAt).toISOString(),
    receiptEmailed: purchase.receiptEmail === 'sent',
  };
}

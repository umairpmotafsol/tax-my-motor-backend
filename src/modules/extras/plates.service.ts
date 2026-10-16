import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import { Paginated, paginate } from '../../common/dto/pagination.dto';
import { Role } from '../../common/enums/role.enum';
import { formatReg, gbp, isValidReg, normaliseReg } from '../../common/utils/format.util';
import { MailService } from '../mail/mail.service';
import { PaymentIntentResult, PaymentsService } from '../payments/payments.service';
import { UsersService } from '../users/users.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ListPlateOrdersDto, PlatesDetailsDto } from './dto/extras.dto';
import {
  PLATE_STATUS_LABELS,
  PlateOrder,
  PlateOrderDocument,
  PlateOrderStatus,
} from './schemas/plate-order.schema';

/** What step 1 hands back: the plate, the vehicle if it is known, and the price. */
export interface PlatesOffer {
  reg: string;
  make: string;
  model: string;
  price: number;
}

/**
 * "Order Number Plates": a pair of plates for one registration, for a
 * flat fee, made and posted by the TaxMyMotor team.
 *
 * Nothing about it touches the order book or the suppliers. The order is
 * paid for, the admins are emailed, and from then on an admin moves its
 * status along by hand from the admin portal.
 */
@Injectable()
export class PlatesService {
  private readonly logger = new Logger(PlatesService.name);

  constructor(
    @InjectModel(PlateOrder.name) private readonly orderModel: Model<PlateOrderDocument>,
    private readonly vehicles: VehiclesService,
    private readonly payments: PaymentsService,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  get price(): number {
    return this.config.get<number>('platesFee') ?? 20;
  }

  /**
   * The vehicle, for the payment screen's card.
   *
   * Plates are made from the registration alone, so a vehicle the
   * register does not know — or a lookup that failed — does not stop the
   * order; the card just shows the plate without a make. A stand-in
   * vehicle is never shown, since it is not this car.
   */
  async check(reg: string): Promise<PlatesOffer> {
    if (!isValidReg(reg)) {
      throw new BadRequestException('That does not look like a UK registration.');
    }
    let make = '';
    let model = '';
    try {
      const vehicle = await this.vehicles.lookup(reg);
      if (vehicle.known) {
        make = vehicle.make;
        model = vehicle.model;
      }
    } catch (err) {
      this.logger.warn(
        'Plates lookup for ' + normaliseReg(reg) + ' gave no vehicle: ' + (err as Error).message,
      );
    }
    return { reg: formatReg(reg), make, model, price: this.price };
  }

  /** Step 3: the card payment. The details are checked here, before any money moves. */
  async createIntent(dto: PlatesDetailsDto, customerId: string): Promise<PaymentIntentResult> {
    if (!isValidReg(dto.reg)) {
      throw new BadRequestException('That does not look like a UK registration.');
    }
    return this.payments.createFlatIntent(this.price, customerId, {
      kind: 'plates',
      reg: normaliseReg(dto.reg),
    });
  }

  /**
   * The payment is checked and the order recorded, then the customer and
   * the admins are emailed.
   *
   * Safe to call twice with the same payment: a customer whose
   * connection dropped after paying gets the order they already placed,
   * not a second charge and not an error.
   */
  async place(
    dto: PlatesDetailsDto,
    paymentIntentId: string,
    customerId: string,
  ): Promise<PlateOrderDocument> {
    const existing = await this.orderModel.findOne({ paymentIntentId });
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
    if (intent.metadata?.kind !== 'plates' || intent.metadata?.reg !== normaliseReg(dto.reg)) {
      throw new BadRequestException('That payment was not made for this registration.');
    }

    const offer = await this.check(dto.reg);
    const customer = await this.users.findById(customerId);
    const now = new Date();

    let order: PlateOrderDocument;
    try {
      order = await this.orderModel.create({
        customer: customer._id,
        reg: offer.reg,
        make: offer.make,
        vehicleModel: offer.model,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        address: dto.address,
        amount: this.price,
        paymentIntentId,
        status: PlateOrderStatus.Received,
        history: [{ status: PlateOrderStatus.Received, at: now, by: '' }],
        placedAt: now,
      });
    } catch (err) {
      /* Two requests raced on one payment; the unique index let one through. */
      if ((err as { code?: number }).code === 11000) {
        return (await this.orderModel.findOne({ paymentIntentId }))!;
      }
      throw err;
    }

    await this.notify(order);
    return order;
  }

  /**
   * The receipt and the admins' alert. The order stands whether or not
   * either leaves — the result is recorded on it, never thrown.
   */
  private async notify(order: PlateOrderDocument): Promise<void> {
    const admins = await this.users.listByRole(Role.Admin);
    const [receipt, alert] = await Promise.all([
      this.mail.sendPlateReceipt({
        to: order.email,
        customerName: order.name,
        reg: order.reg,
        vehicle: order.vehicleModel,
        address: order.address,
        total: gbp(order.amount),
      }),
      this.mail.sendPlateOrderAlert({
        to: admins.map(admin => admin.email),
        reg: order.reg,
        vehicle: order.vehicleModel,
        customerName: order.name,
        phone: order.phone,
        email: order.email,
        address: order.address,
        total: gbp(order.amount),
      }),
    ]);
    order.receiptEmail = receipt.sent ? 'sent' : 'failed';
    order.adminEmail = alert.sent ? 'sent' : 'failed';
    await order.save();
    if (!receipt.sent) {
      this.logger.warn('Plates receipt for ' + order.reg + ' was not sent: ' + receipt.reason);
    }
    if (!alert.sent) {
      this.logger.warn('Plates alert for ' + order.reg + ' was not sent: ' + alert.reason);
    }
  }

  /** The customer's own orders, newest first — what their Orders tab lists. */
  listForCustomer(customerId: string): Promise<PlateOrderDocument[]> {
    return this.orderModel.find({ customer: customerId }).sort({ placedAt: -1 }).limit(100);
  }

  /* --------------------------------- admin --------------------------------- */

  /** Every order, newest first, filtered by status and searched by plate, name or email. */
  async listForAdmin(query: ListPlateOrdersDto): Promise<Paginated<PlateOrderDocument>> {
    const filter: FilterQuery<PlateOrderDocument> = {};
    if (query.status) {
      filter.status = query.status;
    }
    const search = query.search?.trim();
    if (search) {
      const loose = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      /* "ab12cde" finds "AB12 CDE": the plate is matched without its space. */
      const plate = normaliseReg(search);
      filter.$or = [
        { reg: loose },
        ...(plate ? [{ reg: new RegExp(plate.split('').join('\\s?'), 'i') }] : []),
        { name: loose },
        { email: loose },
      ];
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const [items, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ placedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      this.orderModel.countDocuments(filter),
    ]);
    return paginate(items, total, page, limit);
  }

  /** How many orders stand at each status — the tabs' counts. */
  async countsByStatus(): Promise<Record<PlateOrderStatus, number>> {
    const rows = await this.orderModel.aggregate<{ _id: PlateOrderStatus; n: number }>([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    const counts = Object.fromEntries(
      Object.values(PlateOrderStatus).map(status => [status, 0]),
    ) as Record<PlateOrderStatus, number>;
    for (const row of rows) {
      counts[row._id] = row.n;
    }
    return counts;
  }

  async findById(id: string): Promise<PlateOrderDocument> {
    const order = Types.ObjectId.isValid(id) ? await this.orderModel.findById(id) : null;
    if (!order) {
      throw new NotFoundException('That number plates order does not exist.');
    }
    return order;
  }

  /**
   * An admin moves the order along. Any status may follow any other — an
   * admin who picked the wrong one puts it right the same way — and each
   * change is kept in the order's history. Cancelling refunds nothing:
   * refunds are made outside the platform.
   */
  async setStatus(id: string, status: PlateOrderStatus, adminId: string): Promise<PlateOrderDocument> {
    const order = await this.findById(id);
    if (order.status === status) {
      return order;
    }
    const admin = await this.users.findById(adminId);
    order.status = status;
    order.history.push({ status, at: new Date(), by: admin.name });
    await order.save();
    this.logger.log(
      'Plates order ' + order.reg + ' set to ' + PLATE_STATUS_LABELS[status] + ' by ' + admin.name + '.',
    );
    return order;
  }
}

/** The customer's view of an order. */
export function toPlateOrder(order: PlateOrderDocument) {
  return {
    id: String(order._id),
    reg: order.reg,
    make: order.make,
    vehicleModel: order.vehicleModel,
    amount: order.amount,
    status: order.status,
    statusLabel: PLATE_STATUS_LABELS[order.status],
    name: order.name,
    phone: order.phone,
    email: order.email,
    address: order.address,
    placedAt: new Date(order.placedAt).toISOString(),
  };
}

/** The admin's view: the customer's, plus who the account is, the history and the emails. */
export function toAdminPlateOrder(order: PlateOrderDocument) {
  return {
    ...toPlateOrder(order),
    customerId: String(order.customer),
    paymentIntentId: order.paymentIntentId,
    history: order.history.map(change => ({
      status: change.status,
      statusLabel: PLATE_STATUS_LABELS[change.status],
      at: new Date(change.at).toISOString(),
      by: change.by,
    })),
    receiptEmail: order.receiptEmail,
    adminEmail: order.adminEmail,
  };
}

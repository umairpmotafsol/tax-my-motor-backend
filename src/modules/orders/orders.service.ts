import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import { AuthUser } from '../../common/decorators/current-user.decorator';
import { Paginated, paginate } from '../../common/dto/pagination.dto';
import { BankReviewStatus } from '../../common/enums/bank.enum';
import { NotificationType } from '../../common/enums/notification.enum';
import {
  CommunicationMethod,
  InvoiceStatus,
  OPEN_STATUSES,
  OrderStatus,
  OrderType,
} from '../../common/enums/order.enum';
import { Role } from '../../common/enums/role.enum';
import { bankProblems } from '../../common/utils/bank.util';
import { encryptField } from '../../common/utils/crypto.util';
import {
  formatReg,
  formatV62Date,
  gbp,
  normaliseReg,
  startOfDay,
} from '../../common/utils/format.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { PricingService } from '../pricing/pricing.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SuppliersService } from '../suppliers/suppliers.service';
import { UsersService } from '../users/users.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ListOrdersDto, PlaceOrderDto } from './dto/order.dto';
import { Counter, CounterDocument } from './schemas/counter.schema';
import { Order, OrderDocument } from './schemas/order.schema';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Counter.name) private readonly counterModel: Model<CounterDocument>,
    /* Suppliers and orders reference each other; see OrdersModule. */
    @Inject(forwardRef(() => SuppliersService))
    private readonly suppliers: SuppliersService,
    private readonly vehicles: VehiclesService,
    private readonly pricing: PricingService,
    private readonly payments: PaymentsService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService,
  ) {}

  private get responseTimeoutMs(): number {
    return this.config.get<number>('responseTimeoutMs') ?? 420_000;
  }

  /* ------------------------------ order numbers ----------------------------- */

  /**
   * One atomic increment. Counting existing orders instead would hand
   * two customers checking out at the same moment the same number, and
   * ORD-1042 has to mean one order.
   */
  private async nextOrderNumber(): Promise<string> {
    const counter = await this.counterModel.findOneAndUpdate(
      { key: 'orderNumber' },
      { $inc: { value: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return 'ORD-' + (1024 + counter.value);
  }

  /* -------------------------------- placement ------------------------------- */

  /**
   * A customer checks out.
   *
   * Order Type -> Supplier Eligibility -> Active Supplier -> Assign.
   * An order type nobody active handles lands unassigned and raises an
   * alert, rather than going to a supplier who cannot process it.
   */
  async placeOrder(customerId: string, dto: PlaceOrderDto): Promise<OrderDocument> {
    const customer = await this.users.findById(customerId);
    const withV62 = dto.v62 === true;

    const vehicle = await this.vehicles.lookup(dto.reg);
    const orderType = this.pricing.orderTypeFor(dto.option);
    /*
     * Priced against this vehicle's own VED, not a table — and priced
     * here rather than trusted from the app, so the total on the order
     * is the one the server stands behind.
     */
    const taxInfo = await this.vehicles.vedFor(dto.reg);
    const pricing = this.pricing.price(dto.option, withV62, {
      sixMonth: taxInfo.ved?.sixMonth ?? null,
      twelveMonth: taxInfo.ved?.twelveMonth ?? null,
    });

    /*
     * The mandate is validated here, not only in the app. A sort code
     * with five digits is a typo, and sending it round the supplier's
     * review loop wastes everybody's turn.
     */
    if (orderType === OrderType.DirectDebit) {
      if (!dto.bank) {
        throw new BadRequestException('Direct Debit needs your bank details.');
      }
      const problems = bankProblems(dto.bank);
      if (problems.length > 0) {
        throw new BadRequestException(
          'Please check these details: ' + problems.join(', ') + '.',
        );
      }
    }

    if (withV62 && !dto.v62Data) {
      throw new BadRequestException('Please complete the V62 application.');
    }

    /*
     * Direct Debit is collected by DVLA, not charged here — everything
     * else has to arrive with a PaymentIntent that has actually
     * succeeded, for this exact amount, on this customer's own account.
     */
    let payment: OrderDocument['payment'] = null;
    if (orderType !== OrderType.DirectDebit) {
      if (!dto.paymentIntentId) {
        throw new BadRequestException('Payment is required for this order.');
      }
      const intent = await this.payments.verifyPaid(
        dto.paymentIntentId,
        Math.round(pricing.dueNow * 100),
        customerId,
      );
      payment = {
        provider: 'stripe',
        intentId: intent.id,
        amount: pricing.dueNow,
        currency: intent.currency,
        paidAt: new Date(),
      };
    }

    const supplier = await this.suppliers.routeOrder(orderType);
    const now = new Date();
    const orderNumber = await this.nextOrderNumber();

    const order = await this.orderModel.create({
      orderNumber,
      customer: customer._id,
      customerSnapshot: {
        name: customer.name,
        email: dto.email || customer.email,
        phone: dto.whatsapp || customer.phone,
      },
      supplier: supplier?._id ?? null,
      reg: formatReg(dto.reg),
      vehicle: {
        make: vehicle.make,
        variant: vehicle.variant,
        model: vehicle.model,
        colour: vehicle.colour,
        vin: vehicle.vin,
        taxClass: vehicle.taxClass,
      },
      orderType,
      plan: this.pricing.orderPlanLabel(dto.option, withV62),
      items: this.pricing.itemsFor(dto.option, withV62),
      pricing,
      total: pricing.total,
      deliveryAddress: dto.deliveryAddress || customer.address,
      payment,
      status: supplier ? OrderStatus.AwaitingSupplier : OrderStatus.Unassigned,
      invoiceStatus: InvoiceStatus.Pending,
      communicationMethod: dto.channel,
      whatsappRequested: dto.channel === CommunicationMethod.WhatsApp,
      v62Requested: withV62,
      v62: withV62 ? this.buildV62(dto, vehicle, customer) : null,
      bank:
        orderType === OrderType.DirectDebit && dto.bank
          ? {
              accountHolder: dto.bank.accountHolder,
              /* Encrypted at rest — the supplier has to read these back. */
              accountNumber: encryptField(dto.bank.accountNumber),
              sortCode: dto.bank.sortCode,
              dateOfBirth: encryptField(dto.bank.dateOfBirth),
            }
          : null,
      bankReview:
        orderType === OrderType.DirectDebit
          ? { status: BankReviewStatus.Submitted, flagged: [], notes: [] }
          : null,
      placedAt: now,
      assignedAt: supplier ? now : null,
      dueAt: supplier ? new Date(now.getTime() + this.responseTimeoutMs) : null,
      timeline: [
        {
          at: now,
          actor: 'customer',
          title: 'Order placed',
          detail: this.pricing.orderPlanLabel(dto.option, withV62) + ' · ' + gbp(pricing.total),
          tone: null,
        },
        supplier
          ? {
              at: now,
              actor: 'system',
              title: 'Auto-assigned to ' + supplier.name,
              detail: 'Invoice window started',
              tone: null,
            }
          : {
              at: now,
              actor: 'system',
              title: 'Could not be assigned',
              detail: 'No active supplier handles this order type',
              tone: 'red',
            },
      ],
    });

    /* Anything an admin has to look at is raised now. */
    if (!supplier) {
      await this.notifications.raise(NotificationType.Unassigned, order._id);
    }
    if (withV62) {
      await this.notifications.raise(NotificationType.V62Submitted, order._id);
    }
    if (dto.channel === CommunicationMethod.WhatsApp) {
      await this.notifications.raise(NotificationType.WhatsappRequested, order._id);
    }

    this.realtime.orderPlaced(order);
    return order;
  }

  /** The customer's V62Data merged with the lookup into the printed form. */
  private buildV62(
    dto: PlaceOrderDto,
    vehicle: Awaited<ReturnType<VehiclesService['lookup']>>,
    customer: Awaited<ReturnType<UsersService['findById']>>,
  ) {
    const data = dto.v62Data!;
    const sameAsTaxDetails = data.sameAsTaxDetails !== false;
    return {
      registrationNumber: formatReg(dto.reg),
      make: vehicle.make.toUpperCase(),
      model: vehicle.model,
      colour: vehicle.colour,
      vin: vehicle.vin,
      taxClass: vehicle.taxClass,
      reasonForNoV5C: data.reasonForNoV5C ?? 'Lost, stolen, damaged or destroyed',
      fee: this.pricing.v62Fee,
      keeperTitle: sameAsTaxDetails ? '' : (data.applicantTitle ?? ''),
      keeperName: sameAsTaxDetails ? customer.name : (data.applicantName ?? ''),
      keeperAddress: sameAsTaxDetails ? customer.address : (data.applicantAddress ?? ''),
      keeperPostcode: sameAsTaxDetails ? customer.postcode : (data.applicantPostcode ?? ''),
      keeperPhone: sameAsTaxDetails ? customer.phone : (data.applicantPhone ?? ''),
      keeperEmail: sameAsTaxDetails ? customer.email : (data.applicantEmail ?? ''),
      declarationDate: formatV62Date(new Date()),
      submittedAt: new Date(),
    };
  }

  /* ---------------------------------- reads --------------------------------- */

  async findById(id: string): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('That order reference is not valid.');
    }
    const order = await this.orderModel.findById(id);
    if (!order) {
      throw new NotFoundException('That order does not exist.');
    }
    return order;
  }

  /**
   * The order, if this caller is entitled to it. Every handler goes
   * through here rather than trusting the route prefix, so a supplier
   * cannot read another supplier's order by guessing an id.
   */
  async findScoped(id: string, user: AuthUser): Promise<OrderDocument> {
    const order = await this.findById(id);

    if (user.role === Role.Admin) {
      return order;
    }
    if (user.role === Role.Customer) {
      if (String(order.customer) !== user.userId) {
        throw new NotFoundException('That order does not exist.');
      }
      return order;
    }
    if (!user.supplierId || String(order.supplier ?? '') !== user.supplierId) {
      throw new NotFoundException('That order does not exist.');
    }
    return order;
  }

  async listForCustomer(customerId: string, page: number, limit: number) {
    const filter: FilterQuery<OrderDocument> = { customer: customerId };
    return this.runList(filter, page, limit);
  }

  async listForSupplier(supplierId: string, query: ListOrdersDto) {
    const filter: FilterQuery<OrderDocument> = { supplier: supplierId };
    this.applyFilters(filter, query);
    return this.runList(filter, query.page, query.limit);
  }

  async listForAdmin(query: ListOrdersDto) {
    const filter: FilterQuery<OrderDocument> = {};
    if (query.supplierId) {
      filter.supplier = query.supplierId;
    }
    this.applyFilters(filter, query);
    return this.runList(filter, query.page, query.limit);
  }

  private applyFilters(filter: FilterQuery<OrderDocument>, query: ListOrdersDto) {
    if (query.status) {
      filter.status = query.status;
    }
    if (query.orderType) {
      filter.orderType = query.orderType;
    }
    if (query.bucket === 'open') {
      filter.status = { $in: OPEN_STATUSES };
    } else if (query.bucket === 'closed') {
      filter.status = OrderStatus.InvoiceSent;
    }
    if (query.today) {
      filter.placedAt = { $gte: startOfDay() };
    }
    if (query.search) {
      const rx = new RegExp(escapeRegExp(query.search), 'i');
      filter.$or = [
        { orderNumber: rx },
        { reg: rx },
        { 'vehicle.model': rx },
        { 'customerSnapshot.name': rx },
      ];
    }
  }

  private async runList(
    filter: FilterQuery<OrderDocument>,
    page: number,
    limit: number,
  ): Promise<Paginated<OrderDocument>> {
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

  /* -------------------------------- invoices -------------------------------- */

  /**
   * The supplier's whole job: photograph the invoice and upload it.
   * Upload always stops the timer. What happens next depends on the
   * channel — an email order is finished, a WhatsApp one passes to an
   * admin to send.
   */
  async attachInvoice(
    order: OrderDocument,
    /* Whatever InvoicesService stored — see its `StoredFile`. Spread
     * as-is, so a new field on the store does not need a change here. */
    file: {
      fileName: string;
      storageKey: string;
      url: string;
      provider: 'local' | 'cloudinary';
      mimeType: string;
      size: number;
    },
    uploadedBy: string,
  ): Promise<OrderDocument> {
    if (order.invoiceStatus !== InvoiceStatus.Pending) {
      throw new BadRequestException('An invoice has already been uploaded for this order.');
    }
    /*
     * You cannot raise an invoice against a mandate nobody has agreed
     * to yet. Guarded here as well as in the app, because this is the
     * thing the whole review loop exists to prevent.
     */
    if (!this.bankCleared(order)) {
      throw new BadRequestException(
        'The bank details on this order have not been approved yet.',
      );
    }

    const at = new Date();
    const viaAdmin = order.communicationMethod === CommunicationMethod.WhatsApp;

    order.invoice = {
      ...file,
      capturedAt: at,
      uploadedBy: new Types.ObjectId(uploadedBy),
    };
    order.invoiceUploadedAt = at;
    order.invoiceReadyAt = at;
    /* The window is over either way — the supplier has done their part. */
    order.dueAt = null;

    if (viaAdmin) {
      order.invoiceStatus = InvoiceStatus.Ready;
      order.status = OrderStatus.InvoiceReady;
    } else {
      order.invoiceStatus = InvoiceStatus.Sent;
      order.status = OrderStatus.InvoiceSent;
      order.invoiceSentAt = at;
    }

    order.timeline.push({
      at,
      actor: 'supplier',
      title: 'Invoice uploaded',
      detail: 'Invoice window closed',
      tone: null,
    });
    if (!viaAdmin) {
      order.timeline.push({
        at,
        actor: 'supplier',
        title: 'Invoice sent to customer',
        detail: 'Delivered via email',
        tone: 'green',
      });
    }

    await order.save();

    if (viaAdmin) {
      await this.notifications.raise(NotificationType.WhatsappSendRequired, order._id);
    }
    this.realtime.orderChanged(order);
    return order;
  }

  /**
   * The admin's last step on a WhatsApp order. Email invoices are the
   * supplier's to send — the admin never touches them.
   */
  async markSent(order: OrderDocument, actor: AuthUser): Promise<OrderDocument> {
    if (order.communicationMethod !== CommunicationMethod.WhatsApp) {
      throw new BadRequestException(
        'This invoice goes out by email from the supplier. There is nothing to send.',
      );
    }
    if (order.invoiceStatus !== InvoiceStatus.Ready) {
      throw new BadRequestException('This order is not ready to send yet.');
    }

    const at = new Date();
    order.invoiceStatus = InvoiceStatus.Sent;
    order.status = OrderStatus.InvoiceSent;
    order.invoiceSentAt = at;
    order.deliveredAt = at;
    order.timeline.push({
      at,
      actor: actor.role,
      title: 'Invoice sent to customer',
      detail: 'Delivered via WhatsApp',
      tone: 'green',
    });
    await order.save();

    await this.notifications.resolve(NotificationType.WhatsappSendRequired, order._id);
    this.realtime.orderChanged(order);
    return order;
  }

  /* ------------------------------- reassignment ----------------------------- */

  /** Moves an order to another supplier and starts a fresh window. */
  async reassign(order: OrderDocument, supplierId: string): Promise<OrderDocument> {
    const target = await this.suppliers.findById(supplierId);
    if (order.invoiceStatus !== InvoiceStatus.Pending) {
      throw new BadRequestException(
        'This order already has an invoice, so there is nothing to reassign.',
      );
    }
    if (String(order.supplier ?? '') === String(target._id)) {
      throw new BadRequestException('That order is already with this supplier.');
    }

    const at = new Date();
    order.reassignedFrom = order.supplier;
    order.supplier = target._id;
    order.assignedAt = at;
    order.turnStartedAt = null;
    order.dueAt = new Date(at.getTime() + this.responseTimeoutMs);
    order.status = OrderStatus.AwaitingSupplier;
    order.timeline.push({
      at,
      actor: 'admin',
      title: 'Reassigned to ' + target.name,
      detail: 'A new invoice window started',
      tone: null,
    });
    await order.save();

    /* The old alerts describe a situation that no longer holds. */
    await this.notifications.resolve(NotificationType.SupplierOverdue, order._id);
    await this.notifications.resolve(NotificationType.Unassigned, order._id);
    this.realtime.orderAssigned(order);
    return order;
  }

  /* ----------------------------------- V62 ---------------------------------- */

  async markV62Printed(order: OrderDocument): Promise<OrderDocument> {
    if (!order.v62Requested || !order.v62) {
      throw new BadRequestException('There is no V62 on this order.');
    }
    const at = new Date();
    order.v62PrintedAt = at;
    order.timeline.push({
      at,
      actor: 'admin',
      title: 'V62 printed by admin',
      detail: null,
      tone: null,
    });
    await order.save();
    await this.notifications.resolve(NotificationType.V62Submitted, order._id);
    this.realtime.orderChanged(order);
    return order;
  }

  /* ------------------------------ the bank loop ----------------------------- */

  /**
   * Cleared to proceed — either signed off, or an order that never
   * needed a mandate in the first place.
   */
  bankCleared(order: OrderDocument): boolean {
    if (order.orderType !== OrderType.DirectDebit || !order.bankReview) {
      return true;
    }
    return order.bankReview.status === BankReviewStatus.Approved;
  }

  /** Restarts the supplier's window — used when an order comes back to them. */
  restartWindow(order: OrderDocument, at: Date): void {
    order.turnStartedAt = at;
    order.dueAt = new Date(at.getTime() + this.responseTimeoutMs);
    if (order.status === OrderStatus.Overdue) {
      order.status = OrderStatus.AwaitingSupplier;
    }
  }

  /** Pauses it — the ball is in the customer's court and the clock should not run. */
  pauseWindow(order: OrderDocument): void {
    order.dueAt = null;
  }

  /* --------------------------------- sweeps --------------------------------- */

  /**
   * Marks orders whose window has closed. Indexed on {status, dueAt},
   * so this is a lookup over the few that are actually due rather than
   * a scan of the order book.
   */
  async sweepOverdue(): Promise<OrderDocument[]> {
    const now = new Date();
    const due = await this.orderModel.find({
      status: OrderStatus.AwaitingSupplier,
      invoiceStatus: InvoiceStatus.Pending,
      dueAt: { $ne: null, $lte: now },
    });
    if (due.length === 0) {
      return [];
    }

    await this.orderModel.updateMany(
      { _id: { $in: due.map(o => o._id) } },
      {
        $set: { status: OrderStatus.Overdue },
        $push: {
          timeline: {
            at: now,
            actor: 'system',
            title: 'Invoice window expired',
            detail: 'No invoice was uploaded in time',
            tone: 'red',
          },
        },
      },
    );

    for (const order of due) {
      await this.notifications.raise(NotificationType.SupplierOverdue, order._id);
      this.realtime.orderOverdue(order);
    }
    this.logger.warn(due.length + ' order(s) went overdue.');
    return due;
  }

  /* ------------------------------- statistics ------------------------------- */

  /** The admin dashboard's tiles. One aggregation rather than six counts. */
  async adminStats() {
    const [byStatus, today, totals, uncovered] = await Promise.all([
      this.orderModel.aggregate<{ _id: OrderStatus; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.orderModel.countDocuments({ placedAt: { $gte: startOfDay() } }),
      this.orderModel.aggregate<{ _id: null; revenue: number; count: number }>([
        { $match: { status: OrderStatus.InvoiceSent } },
        { $group: { _id: null, revenue: { $sum: '$total' }, count: { $sum: 1 } } },
      ]),
      this.suppliers.uncoveredOrderTypes(),
    ]);

    const counts = Object.fromEntries(byStatus.map(row => [row._id, row.count])) as Record<
      OrderStatus,
      number
    >;
    const open = OPEN_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      today,
      open,
      completed: counts[OrderStatus.InvoiceSent] ?? 0,
      overdue: counts[OrderStatus.Overdue] ?? 0,
      unassigned: counts[OrderStatus.Unassigned] ?? 0,
      awaitingSupplier: counts[OrderStatus.AwaitingSupplier] ?? 0,
      awaitingAdminSend: counts[OrderStatus.InvoiceReady] ?? 0,
      revenue: totals[0]?.revenue ?? 0,
      byStatus: counts,
      routingGaps: uncovered,
    };
  }

  /** The supplier dashboard's tiles, scoped to one supplier. */
  async supplierStats(supplierId: string) {
    const supplier = new Types.ObjectId(supplierId);
    const since = startOfDay();

    const [pending, overdue, todayDone, allDone, awaitingSend, bankQueue] = await Promise.all([
      this.orderModel.countDocuments({
        supplier,
        invoiceStatus: InvoiceStatus.Pending,
        status: OrderStatus.AwaitingSupplier,
      }),
      this.orderModel.countDocuments({ supplier, status: OrderStatus.Overdue }),
      this.orderModel.countDocuments({ supplier, invoiceUploadedAt: { $gte: since } }),
      this.orderModel.countDocuments({
        supplier,
        invoiceStatus: { $in: [InvoiceStatus.Uploaded, InvoiceStatus.Ready, InvoiceStatus.Sent] },
      }),
      this.orderModel.countDocuments({
        supplier,
        invoiceStatus: InvoiceStatus.Ready,
        communicationMethod: CommunicationMethod.WhatsApp,
      }),
      this.orderModel.countDocuments({
        supplier,
        'bankReview.status': BankReviewStatus.Submitted,
      }),
    ]);

    return {
      awaitingInvoice: pending,
      overdue,
      uploadedToday: todayDone,
      completed: allDone,
      awaitingWhatsappSend: awaitingSend,
      bankDetailsToReview: bankQueue,
    };
  }

  /** Open orders held by one supplier — checked before a supplier is deleted. */
  async countOpenForSupplier(supplierId: string): Promise<number> {
    return this.orderModel.countDocuments({
      supplier: supplierId,
      status: { $in: OPEN_STATUSES },
    });
  }

  async countAll(): Promise<number> {
    return this.orderModel.countDocuments();
  }

  /** Used by the seeder, which builds orders directly rather than through checkout. */
  get model(): Model<OrderDocument> {
    return this.orderModel;
  }

  async assertCustomerOwns(order: OrderDocument, customerId: string): Promise<void> {
    if (String(order.customer) !== customerId) {
      throw new ForbiddenException('That order is not yours.');
    }
  }

  /** Used when re-seeding the register from an order's stored plate. */
  regKey(reg: string): string {
    return normaliseReg(reg);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

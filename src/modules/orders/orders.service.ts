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
import { resolve } from 'node:path';

import { AuthUser } from '../../common/decorators/current-user.decorator';
import { Paginated, paginate } from '../../common/dto/pagination.dto';
import { BankReviewActor, BankReviewStatus } from '../../common/enums/bank.enum';
import { NotificationType } from '../../common/enums/notification.enum';
import {
  CLOSED_STATUSES,
  CommunicationMethod,
  InvoiceStatus,
  OPEN_STATUSES,
  OrderFlagResolution,
  OrderFlagSource,
  OrderStatus,
  OrderType,
} from '../../common/enums/order.enum';
import { Role } from '../../common/enums/role.enum';
import { bankProblems } from '../../common/utils/bank.util';
import { encryptField } from '../../common/utils/crypto.util';
import { formatReg, gbp, normaliseReg, startOfDay } from '../../common/utils/format.util';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../push/push.service';
import { PaymentsService } from '../payments/payments.service';
import { PricingService, vedRatesOf } from '../pricing/pricing.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SuppliersService } from '../suppliers/suppliers.service';
import { UsersService } from '../users/users.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ListOrdersDto, PlaceOrderDto } from './dto/order.dto';
import { Counter, CounterDocument } from './schemas/counter.schema';
import { Order, OrderDocument, V62Submission } from './schemas/order.schema';
import { buildV62Submission } from './v62.builder';

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
    private readonly push: PushService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
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

    let vehicle = await this.vehicles.lookup(dto.reg);
    const orderType = this.pricing.orderTypeFor(dto.option);
    /*
     * Priced against this vehicle's own VED, not a table — and priced
     * here rather than trusted from the app, so the total on the order
     * is the one the server stands behind.
     */
    const taxInfo = await this.vehicles.vedFor(dto.reg);
    const pricing = this.pricing.price(dto.option, withV62, vedRatesOf(taxInfo.ved));

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

    let v62: V62Submission | null = null;
    if (withV62) {
      if (!dto.v62Data) {
        throw new BadRequestException('Please complete the V62 application.');
      }
      const form = { reg: dto.reg, data: dto.v62Data, customer, fee: this.pricing.v62Fee };
      /*
       * Built once to find out whether the customer's half is complete,
       * and only then is the vehicle's half paid for: a form with no
       * address on it is turned away before it costs a lookup.
       */
      v62 = buildV62Submission({ ...form, vehicle });
      vehicle = await this.vehicles.lookupForV62(dto.reg);
      v62 = buildV62Submission({ ...form, vehicle });
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
      v62,
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
    await this.pushNewOrder(order);
    /* Not awaited: a slow mail server is no reason to hold the customer's checkout open. */
    void this.emailAdminsNewOrder(order, supplier?.name ?? null);
    return order;
  }

  /**
   * "New order ORD-1042" to every active admin's inbox. Never throws —
   * the order is placed and paid for whatever the mail server says.
   */
  private async emailAdminsNewOrder(
    order: OrderDocument,
    supplierName: string | null,
  ): Promise<void> {
    try {
      const admins = await this.users.listByRole(Role.Admin);
      const result = await this.mail.sendNewOrderAlert({
        to: admins.map(admin => admin.email),
        orderNumber: order.orderNumber,
        reg: order.reg,
        vehicle: order.vehicle.model,
        plan: order.plan,
        customerName: order.customerSnapshot.name,
        phone: order.customerSnapshot.phone,
        email: order.customerSnapshot.email,
        supplier: supplierName,
        total: gbp(order.total),
      });
      if (!result.sent) {
        this.logger.warn('Admin email for ' + order.orderNumber + ' not sent: ' + result.reason);
      }
    } catch (error) {
      this.logger.error('Could not email the admins about ' + order.orderNumber, error as Error);
    }
  }

  /**
   * "You have a new vehicle request." — to the supplier it was assigned
   * to and nobody else.
   *
   * Sent beside the socket push, not instead of it: the socket is what
   * the app reacts to while somebody is holding it, and this is what
   * reaches the phone in a pocket. They do not double up, because
   * Firebase shows nothing while the app is in the foreground.
   */
  private async pushNewOrder(order: OrderDocument): Promise<void> {
    if (!order.supplier) {
      return;
    }
    await this.push.toSupplier(order.supplier, {
      title: 'New vehicle request',
      body: 'You have a new vehicle request. Tap to view.',
      data: {
        kind: 'order.assigned',
        orderId: String(order._id),
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        reg: order.reg,
      },
    });
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
      filter.status = { $in: CLOSED_STATUSES };
    }
    if (query.flagged) {
      /* Both: `resolvedAt: null` alone also matches an order with no flag at all. */
      filter.flag = { $ne: null };
      filter['flag.resolvedAt'] = null;
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
   * channel — an email order is finished and the invoice is emailed to
   * the customer from here, a WhatsApp one passes to an admin to send.
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
    this.assertLive(order);
    if (order.invoiceStatus !== InvoiceStatus.Pending) {
      throw new BadRequestException('An invoice has already been uploaded for this order.');
    }
    /*
     * You cannot raise an invoice against a mandate that is back with
     * the customer for correction — that is the thing the review loop
     * exists to prevent. One still with the supplier is different: the
     * supplier has the details in front of them, and raising the invoice
     * is how they say the details are right. So the upload signs the
     * mandate off in the same step, rather than asking for an approval
     * tap first.
     */
    const review = order.orderType === OrderType.DirectDebit ? order.bankReview : null;
    if (review?.status === BankReviewStatus.ChangesRequested) {
      throw new BadRequestException(
        'The bank details on this order are back with the customer to correct.',
      );
    }

    const at = new Date();
    const signedOff = review?.status === BankReviewStatus.Submitted;
    if (signedOff) {
      this.signOffMandate(order, at);
    }
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
    /*
     * And so is any flag they raised on the way: the invoice is the
     * thing they said they could not get to, and here it is. The order
     * simply completes, and comes off the admin's flagged list.
     */
    const unflagged = this.isFlagged(order);
    if (unflagged) {
      this.resolveFlag(order, OrderFlagResolution.Invoiced, at);
    }

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

    await order.save();

    if (unflagged) {
      await this.notifications.resolve(NotificationType.OrderFlagged, order._id);
    }
    if (signedOff) {
      await this.notifications.raise(
        NotificationType.BankApproved,
        order._id,
        Role.Customer,
        order.customer,
      );
    }
    if (viaAdmin) {
      await this.notifications.raise(NotificationType.WhatsappSendRequired, order._id);
    }
    this.realtime.orderChanged(order);
    if (!viaAdmin) {
      /*
       * Not awaited. The supplier's part ended with the upload, and a
       * slow mail server is no reason to keep their request open — or
       * to have them retry an upload that already landed. What became
       * of the email is written to the order when it is known.
       */
      void this.emailInvoice(order);
    }
    return order;
  }

  /**
   * Emails the customer their invoice, and records on the order whether
   * it went.
   *
   * The record is the point. Uploading an invoice used to write
   * "Delivered via email" to the timeline without anything being sent;
   * now that line is written only once the mail server has accepted the
   * message, and a failure is written down as a failure, with the reason.
   *
   * The write is a single atomic update rather than a save of the
   * document in hand: this runs after the request that triggered it has
   * returned, so the order may well have been loaded and saved by
   * someone else in the meantime.
   *
   * Never throws — see `MailService`.
   */
  async emailInvoice(order: OrderDocument): Promise<OrderDocument> {
    try {
      const invoice = order.invoice;
      const to = order.customerSnapshot.email;
      const result = invoice
        ? await this.mail.sendInvoice({
            to,
            customerName: order.customerSnapshot.name,
            orderNumber: order.orderNumber,
            reg: formatReg(order.reg),
            vehicle: order.vehicle.model,
            plan: order.plan,
            total: gbp(order.total),
            attachment: {
              fileName: invoice.fileName,
              /* The hosted copy where there is one; otherwise the file on this disk. */
              path:
                invoice.url ||
                resolve(this.config.get<string>('uploadDir') ?? './uploads', invoice.storageKey),
              mimeType: invoice.mimeType,
            },
            link: invoice.url || null,
          })
        : ({ sent: false, reason: 'There is no invoice on this order yet.' } as const);

      const at = new Date();
      const updated = await this.orderModel.findByIdAndUpdate(
        order._id,
        {
          $set: {
            invoiceEmail: {
              status: result.sent ? 'sent' : 'failed',
              to,
              at,
              reason: result.sent ? null : result.reason,
            },
          },
          $push: {
            timeline: result.sent
              ? {
                  at,
                  actor: 'system',
                  title: 'Invoice emailed to customer',
                  detail: 'Sent to ' + to,
                  tone: 'green',
                }
              : {
                  at,
                  actor: 'system',
                  title: 'Invoice email not sent',
                  detail: result.reason,
                  tone: 'red',
                },
          },
        },
        { new: true },
      );
      if (updated) {
        this.realtime.orderChanged(updated);
        return updated;
      }
    } catch (error) {
      this.logger.error(
        'Could not record the invoice email for ' + order.orderNumber,
        error as Error,
      );
    }
    return order;
  }

  /** An admin sending the invoice email again — after a failure, or a customer who lost it. */
  async resendInvoiceEmail(order: OrderDocument): Promise<OrderDocument> {
    if (order.communicationMethod !== CommunicationMethod.Email) {
      throw new BadRequestException('This invoice goes to the customer over WhatsApp, not by email.');
    }
    if (!order.invoice) {
      throw new BadRequestException('There is no invoice on this order to email yet.');
    }
    return this.emailInvoice(order);
  }

  /**
   * The admin's last step on a WhatsApp order. Email invoices are sent
   * by the server on upload — the admin never touches them.
   */
  async markSent(order: OrderDocument, actor: AuthUser): Promise<OrderDocument> {
    this.assertLive(order);
    if (order.communicationMethod !== CommunicationMethod.WhatsApp) {
      throw new BadRequestException(
        'This invoice is emailed to the customer automatically. There is nothing to send here.',
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
    this.assertLive(order);
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
    /* A fresh window on a new phone — the same news as a new order. */
    await this.pushNewOrder(order);
    return order;
  }

  /* -------------------------------- flagging -------------------------------- */

  /**
   * Nothing moves on a cancelled order. Every action that would change
   * one comes through here first, so "cancelled" means the same thing
   * to the supplier's upload, the bank loop and the admin's own buttons.
   */
  assertLive(order: OrderDocument): void {
    if (order.status === OrderStatus.Cancelled) {
      throw new BadRequestException('This order has been cancelled.');
    }
  }

  /**
   * Puts the flag on, without saving — the caller is usually part-way
   * through a change of its own (see BankReviewService) and saves once.
   * Follow the save with `announceFlag`.
   *
   * A flag an admin has already answered does not block a new one: an
   * order sent back to its supplier can be flagged again, and the new
   * flag replaces the old (the timeline keeps both).
   *
   * The flag also stops the supplier's clock. The order is waiting on an
   * admin now, and the window measures how quickly the *supplier*
   * responds — left running, it would go overdue against them for time
   * the admin spent. For the same reason an order that was already
   * overdue stops being so: flagged is its own state, counted as neither
   * pending nor overdue. The window starts afresh when the admin sends
   * the order back (see `sendBack`), and from there it can go overdue
   * like any new order.
   *
   * @returns false when a flag is already standing, so the caller knows
   *   not to announce the same flag twice.
   */
  applyFlag(order: OrderDocument, source: OrderFlagSource, reason: string, by?: string): boolean {
    if (this.isFlagged(order)) {
      return false;
    }
    const at = new Date();
    order.flag = {
      at,
      source,
      reason,
      by: by ? new Types.ObjectId(by) : null,
      resolvedAt: null,
      resolution: null,
      response: '',
    };
    this.pauseWindow(order);
    if (order.status === OrderStatus.Overdue) {
      order.status = OrderStatus.AwaitingSupplier;
    }
    order.timeline.push({
      at,
      actor: source,
      title: 'Flagged to admin',
      detail: reason || null,
      tone: 'red',
    });
    return true;
  }

  /** Flagged, and no admin has answered it yet. */
  isFlagged(order: OrderDocument): boolean {
    return Boolean(order.flag) && !order.flag!.resolvedAt;
  }

  /** The three admin answers all start here: there has to be a flag to answer. */
  private assertFlagged(order: OrderDocument, message: string): void {
    this.assertLive(order);
    if (!this.isFlagged(order)) {
      throw new BadRequestException(message);
    }
  }

  private resolveFlag(
    order: OrderDocument,
    resolution: OrderFlagResolution,
    at: Date,
    response = '',
  ): void {
    order.flag!.resolvedAt = at;
    order.flag!.resolution = resolution;
    order.flag!.response = response;
  }

  /** Tells the admins, on every channel they watch, that a flag went up. */
  async announceFlag(order: OrderDocument): Promise<void> {
    await this.notifications.raise(NotificationType.OrderFlagged, order._id);
    /* If it was overdue it no longer is, so that alert has nothing left to say. */
    await this.notifications.resolve(NotificationType.SupplierOverdue, order._id);
    this.realtime.orderFlagged(order);

    if (!this.push.enabled) {
      return;
    }
    const supplier = order.supplier
      ? await this.suppliers.findById(String(order.supplier)).catch(() => null)
      : null;
    await this.push.toAdmins({
      title: 'Order flagged',
      body:
        order.reg +
        ' · ' +
        (supplier?.name ?? 'A supplier') +
        (order.flag?.reason ? ': ' + order.flag.reason : ' flagged this order.'),
      data: {
        kind: 'order.flagged',
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        reg: order.reg,
        supplierName: supplier?.name ?? '',
      },
    });
  }

  /**
   * The supplier's hand up, on any order of theirs that still needs its
   * invoice — whatever its type. Not once the invoice is uploaded: the
   * supplier's part is finished then, whether the order is already with
   * the customer or waiting on an admin to send it over WhatsApp. The
   * order stays theirs, but it is the admin's to answer: its clock stops
   * (see `applyFlag`) until the admin sends it back.
   *
   * Together with the upload clearing a standing flag (see
   * `attachInvoice`), this is what makes "flagged" always mean "still
   * waiting on its invoice".
   */
  async flag(order: OrderDocument, actor: AuthUser, reason = ''): Promise<OrderDocument> {
    this.assertLive(order);
    if (order.invoiceStatus !== InvoiceStatus.Pending) {
      throw new BadRequestException(
        'The invoice for this order has been uploaded, so it cannot be flagged.',
      );
    }
    if (!this.applyFlag(order, OrderFlagSource.Supplier, reason, actor.userId)) {
      throw new BadRequestException('This order has already been flagged to an admin.');
    }
    await order.save();
    await this.announceFlag(order);
    return order;
  }

  /*
   * An admin has three answers to a flag — send the order back, complete
   * it, or cancel it — and each needs a flag still standing: the flag is
   * what puts an order in front of an admin as a candidate for any of
   * them, and an order nobody has raised a problem with is not theirs
   * to end.
   */

  /**
   * Back to the supplier, with the admin's comment on what to do. The
   * order is in the supplier's court again, so their window starts
   * afresh — unless the mandate is with the customer, where the clock is
   * paused for a different reason.
   */
  async sendBack(order: OrderDocument, actor: AuthUser, comment: string): Promise<OrderDocument> {
    this.assertFlagged(order, 'Only an order that has been flagged can be sent back.');

    const at = new Date();
    this.resolveFlag(order, OrderFlagResolution.SentBack, at, comment);
    order.timeline.push({
      at,
      actor: actor.role,
      title: 'Sent back to supplier',
      detail: comment,
      tone: null,
    });

    const restarted = order.bankReview?.status !== BankReviewStatus.ChangesRequested;
    if (restarted) {
      this.restartWindow(order, at);
    }
    await order.save();

    await this.notifications.resolve(NotificationType.OrderFlagged, order._id);
    if (restarted) {
      await this.notifications.resolve(NotificationType.SupplierOverdue, order._id);
    }
    this.realtime.orderChanged(order);
    if (order.supplier) {
      await this.push.toSupplier(order.supplier, {
        title: 'Order sent back to you',
        body: order.reg + ' · Admin: ' + comment,
        data: {
          kind: 'order.sent_back',
          orderId: String(order._id),
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          reg: order.reg,
        },
      });
    }
    return order;
  }

  /**
   * The admin closes a flagged order as done, without the invoice it
   * was still waiting on — and, on a Direct Debit order, whether or not
   * the mandate was signed off. It is their override: the supplier said
   * they could not finish it, and the admin has settled it some other
   * way.
   */
  async complete(order: OrderDocument, actor: AuthUser): Promise<OrderDocument> {
    this.assertFlagged(order, 'Only an order that has been flagged can be completed this way.');

    const at = new Date();
    this.resolveFlag(order, OrderFlagResolution.Completed, at);
    order.invoiceStatus = InvoiceStatus.Sent;
    order.status = OrderStatus.InvoiceSent;
    order.invoiceSentAt = at;
    order.dueAt = null;
    order.timeline.push({
      at,
      actor: actor.role,
      title: 'Order completed by admin',
      detail: null,
      tone: 'green',
    });
    await order.save();

    /* Every standing alert described an order somebody still had to act on. */
    await this.notifications.clearForOrder(order._id);
    this.realtime.orderChanged(order);
    if (order.supplier) {
      await this.push.toSupplier(order.supplier, {
        title: 'Order completed',
        body: order.reg + ' was completed by an admin. Nothing more is needed from you.',
        data: {
          kind: 'order.completed',
          orderId: String(order._id),
          orderType: order.orderType,
          orderNumber: order.orderNumber,
          reg: order.reg,
        },
      });
    }
    return order;
  }

  /**
   * An admin calls a flagged order off.
   *
   * No money moves here. A 6 or 12 month order was charged at checkout,
   * and refunding that is done in Stripe, by a person.
   */
  async cancel(order: OrderDocument, actor: AuthUser, reason?: string): Promise<OrderDocument> {
    this.assertFlagged(order, 'Only an order that has been flagged can be cancelled.');

    const at = new Date();
    this.resolveFlag(order, OrderFlagResolution.Cancelled, at);
    order.status = OrderStatus.Cancelled;
    order.cancelledAt = at;
    /* No window left to run, and the overdue sweep must not pick it up. */
    order.dueAt = null;
    order.timeline.push({
      at,
      actor: actor.role,
      title: 'Order cancelled',
      detail: reason || null,
      tone: 'red',
    });
    await order.save();

    /* Every standing alert described an order somebody still had to act on. */
    await this.notifications.clearForOrder(order._id);
    this.realtime.orderChanged(order);
    if (order.supplier) {
      await this.push.toSupplier(order.supplier, {
        title: 'Order cancelled',
        body: order.reg + ' was cancelled by an admin. Nothing more is needed from you.',
        data: {
          kind: 'order.cancelled',
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          reg: order.reg,
        },
      });
    }
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

  /**
   * Marks the mandate as agreed, without saving. Reached two ways: the
   * supplier approving it outright (BankReviewService), or uploading the
   * invoice against it, which says the same thing.
   */
  signOffMandate(order: OrderDocument, at: Date): void {
    order.bankReview!.status = BankReviewStatus.Approved;
    order.bankReview!.flagged = [];
    order.bankReview!.notes.push({
      at,
      by: BankReviewActor.Supplier,
      fields: [],
      message: 'Approved — mandate set up.',
    });
    order.timeline.push({
      at,
      actor: 'supplier',
      title: 'Bank details approved',
      detail: 'Mandate set up',
      tone: 'green',
    });
  }

  /**
   * "The customer has sent their bank details back." — to the supplier
   * holding the order. Their window has just restarted, so it is the
   * same news as a new order and reaches the phone the same way.
   */
  async pushBankReturned(order: OrderDocument): Promise<void> {
    if (!order.supplier) {
      return;
    }
    await this.push.toSupplier(order.supplier, {
      title: 'Bank details updated',
      body: order.reg + ' · The customer has sent corrected bank details. Tap to check them.',
      data: {
        kind: 'order.returned',
        orderId: String(order._id),
        orderType: order.orderType,
        orderNumber: order.orderNumber,
        reg: order.reg,
      },
    });
  }

  /**
   * Restarts the supplier's window — used when an order comes back to
   * them. Not while a flag stands: the order is with an admin, whoever
   * else has just handed it on (a customer returning bank details, say),
   * and the admin sending it back is what starts the clock again.
   */
  restartWindow(order: OrderDocument, at: Date): void {
    if (this.isFlagged(order)) {
      return;
    }
    order.turnStartedAt = at;
    order.dueAt = new Date(at.getTime() + this.responseTimeoutMs);
    if (order.status === OrderStatus.Overdue) {
      order.status = OrderStatus.AwaitingSupplier;
    }
  }

  /** Pauses it — the ball is in the customer's court, or an admin's, and the clock should not run. */
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
      await this.pushOverdue(order);
    }
    this.logger.warn(due.length + ' order(s) went overdue.');
    return due;
  }

  /**
   * The seven minutes are up — told to the admins, who are the ones who
   * can do anything about it. The next step is a phone call to the
   * supplier, so the message names them; an alert that says only "an
   * order is late" means opening the app to find out who to ring.
   *
   * Sent once per order by construction: the sweep only picks up orders
   * still awaiting a supplier and flips them to Overdue in the same
   * pass, so the thirty-second cron cannot find the same one twice.
   */
  private async pushOverdue(order: OrderDocument): Promise<void> {
    if (!this.push.enabled) {
      return;
    }
    const supplier = order.supplier
      ? await this.suppliers.findById(String(order.supplier)).catch(() => null)
      : null;

    await this.push.toAdmins({
      title: 'Invoice window expired',
      body:
        order.reg +
        ' · ' +
        (supplier?.name ?? 'The supplier') +
        ' has not uploaded an invoice in time. Tap to call them.',
      data: {
        kind: 'order.overdue',
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        reg: order.reg,
        supplierName: supplier?.name ?? '',
        supplierPhone: supplier?.phone ?? '',
      },
    });
  }

  /* ------------------------------- statistics ------------------------------- */

  /** The admin dashboard's tiles. One aggregation rather than six counts. */
  async adminStats() {
    const [byStatus, today, totals, uncovered, flagged] = await Promise.all([
      this.orderModel.aggregate<{ _id: OrderStatus; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.orderModel.countDocuments({ placedAt: { $gte: startOfDay() } }),
      this.orderModel.aggregate<{ _id: null; revenue: number; count: number }>([
        { $match: { status: OrderStatus.InvoiceSent } },
        { $group: { _id: null, revenue: { $sum: '$total' }, count: { $sum: 1 } } },
      ]),
      this.suppliers.uncoveredOrderTypes(),
      this.orderModel.countDocuments({ flag: { $ne: null }, 'flag.resolvedAt': null }),
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
      flagged,
      cancelled: counts[OrderStatus.Cancelled] ?? 0,
      revenue: totals[0]?.revenue ?? 0,
      byStatus: counts,
      routingGaps: uncovered,
    };
  }

  /** The supplier dashboard's tiles, scoped to one supplier. */
  async supplierStats(supplierId: string) {
    const supplier = new Types.ObjectId(supplierId);
    const since = startOfDay();
    /* A cancelled order is neither done nor waiting on anybody. */
    const live = { $ne: OrderStatus.Cancelled };
    /* One with a flag standing is waiting on an admin: neither pending nor overdue. */
    const unflagged = { $or: [{ flag: null }, { 'flag.resolvedAt': { $ne: null } }] };

    const [pending, overdue, todayDone, allDone, awaitingSend, bankQueue] = await Promise.all([
      this.orderModel.countDocuments({
        supplier,
        invoiceStatus: InvoiceStatus.Pending,
        status: OrderStatus.AwaitingSupplier,
        ...unflagged,
      }),
      this.orderModel.countDocuments({ supplier, status: OrderStatus.Overdue, ...unflagged }),
      this.orderModel.countDocuments({ supplier, invoiceUploadedAt: { $gte: since } }),
      this.orderModel.countDocuments({
        supplier,
        status: live,
        invoiceStatus: { $in: [InvoiceStatus.Uploaded, InvoiceStatus.Ready, InvoiceStatus.Sent] },
      }),
      this.orderModel.countDocuments({
        supplier,
        status: live,
        invoiceStatus: InvoiceStatus.Ready,
        communicationMethod: CommunicationMethod.WhatsApp,
      }),
      this.orderModel.countDocuments({
        supplier,
        status: live,
        /* An admin can complete a flagged order over an unchecked mandate. */
        invoiceStatus: InvoiceStatus.Pending,
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

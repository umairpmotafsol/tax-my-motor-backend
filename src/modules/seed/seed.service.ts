import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { BankReviewStatus } from '../../common/enums/bank.enum';
import {
  CommunicationMethod,
  InvoiceStatus,
  OrderStatus,
  OrderType,
  SupplierStatus,
} from '../../common/enums/order.enum';
import { Role } from '../../common/enums/role.enum';
import { encryptField } from '../../common/utils/crypto.util';
import { formatReg, gbp } from '../../common/utils/format.util';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { PricingService } from '../pricing/pricing.service';
import { Supplier, SupplierDocument } from '../suppliers/schemas/supplier.schema';
import { UsersService } from '../users/users.service';
import { VehiclesService } from '../vehicles/vehicles.service';

/**
 * Seeds the reference data the three apps already assume: the two
 * active suppliers and the order types they hold, the admin login, and
 * a vehicle register with the plates the prototypes use by name.
 *
 * Everything is idempotent — it checks before it writes — so running it
 * twice changes nothing, and it is safe to leave on in development.
 */
/**
 * Rates for the seeded demo orders.
 *
 * Fixed on purpose: seeding runs on boot, and pricing a demo order
 * against the real lookup would spend money on plates nobody asked
 * about. These are the sample vehicle's standard rates.
 */
const DEMO_VED = { sixMonth: 217.25, twelveMonth: 395 };

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectModel(Supplier.name) private readonly supplierModel: Model<SupplierDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly users: UsersService,
    private readonly vehicles: VehiclesService,
    private readonly pricing: PricingService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get<boolean>('seedOnBoot')) {
      return;
    }
    await this.run(this.config.get<boolean>('seedDemoOrders') ?? false);
  }

  async run(withDemoOrders = false): Promise<void> {
    this.logger.log('Seeding reference data...');
    await this.seedVehicles();
    const suppliers = await this.seedSuppliers();
    await this.seedAccounts(suppliers);
    if (withDemoOrders) {
      await this.seedOrders(suppliers);
    }
    this.logger.log('Seeding complete.');
  }

  /* -------------------------------- vehicles -------------------------------- */

  /** The plates the prototypes refer to by name, so demos resolve properly. */
  private async seedVehicles(): Promise<void> {
    const register = [
      { reg: 'AB12CDE', make: 'Ford Fiesta', variant: '1.0 EcoBoost', colour: 'Blue', vin: 'WF0FXXWPCFEA12345', fuelType: 'Petrol' },
      { reg: 'YK19PXM', make: 'Volkswagen Golf', variant: '1.5 TSI', colour: 'Grey', vin: 'WVWZZZ1KZAW123456', fuelType: 'Petrol' },
      { reg: 'LM68RTV', make: 'Vauxhall Corsa', variant: '1.2 Turbo', colour: 'Red', vin: 'W0LPF6ED9FG127064', fuelType: 'Petrol' },
      { reg: 'DV65YWO', make: 'Vauxhall Astra', variant: '1.4i Design', colour: 'Silver', vin: 'W0LPF6ED9FG127064', fuelType: 'Petrol' },
      { reg: 'MK17OPD', make: 'Honda Civic', variant: '1.6 i-DTEC SR', colour: 'Blue', vin: 'SHHFK2760HU204418', fuelType: 'Diesel' },
      { reg: 'BD21KLN', make: 'Toyota Yaris', variant: '1.5 Hybrid', colour: 'Green', vin: 'SB1KW56Y10E145678', fuelType: 'Hybrid' },
      { reg: 'EF70WQP', make: 'Nissan Qashqai', variant: '1.3 DIG-T', colour: 'White', vin: 'SJNFAAJ11U1234567', fuelType: 'Petrol' },
    ];
    for (const entry of register) {
      await this.vehicles.upsert(entry);
    }
    this.logger.log('Vehicle register: ' + (await this.vehicles.count()) + ' entries.');
  }

  /* -------------------------------- suppliers ------------------------------- */

  /**
   * Two active suppliers covering different order types, and one
   * inactive holding none — which is what makes the "no active supplier
   * handles this type" path reachable in a demo.
   */
  private async seedSuppliers(): Promise<Map<string, SupplierDocument>> {
    const wanted = [
      {
        name: 'Supplier A',
        company: 'Northgate Motor Services',
        contact: 'Ian Brooks',
        email: 'ian@northgate-motors.co.uk',
        phone: '0161 496 0113',
        region: 'North West',
        status: SupplierStatus.Active,
        orderTypes: [OrderType.Tax6, OrderType.DirectDebit],
      },
      {
        name: 'Supplier B',
        company: 'Crownway Vehicle Admin',
        contact: 'Denise Okafor',
        email: 'denise@crownway.co.uk',
        phone: '0121 496 0788',
        region: 'Midlands',
        status: SupplierStatus.Active,
        orderTypes: [OrderType.Tax12],
      },
      {
        name: 'Supplier C',
        company: 'Harbour Tax Bureau',
        contact: 'Marcus Hale',
        email: 'marcus@harbourtax.co.uk',
        phone: '0117 496 0244',
        region: 'South West',
        status: SupplierStatus.Inactive,
        orderTypes: [],
      },
    ];

    const result = new Map<string, SupplierDocument>();
    for (const entry of wanted) {
      const supplier = await this.supplierModel.findOneAndUpdate(
        { name: entry.name },
        { $setOnInsert: { ...entry, since: new Date() } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      result.set(entry.name, supplier);
    }
    return result;
  }

  /* -------------------------------- accounts -------------------------------- */

  /**
   * One admin, one login per active supplier, one demo customer.
   *
   * The passwords are development conveniences and are logged once on
   * creation so a demo can get in; they are not created at all if the
   * account already exists, so a changed password is never reset.
   */
  private async seedAccounts(suppliers: Map<string, SupplierDocument>): Promise<void> {
    const accounts: Array<{
      name: string;
      email: string;
      password: string;
      role: Role;
      supplier?: Types.ObjectId;
      phone?: string;
      address?: string;
      city?: string;
      postcode?: string;
    }> = [
      {
        name: 'Alex Morgan',
        email: 'admin@taxmymotor.co.uk',
        password: 'admin123',
        role: Role.Admin,
      },
      {
        name: 'Ian Brooks',
        email: 'supplier.a@partners.co.uk',
        password: 'supplier123',
        role: Role.Supplier,
        supplier: suppliers.get('Supplier A')?._id,
      },
      {
        name: 'Denise Okafor',
        email: 'supplier.b@partners.co.uk',
        password: 'supplier123',
        role: Role.Supplier,
        supplier: suppliers.get('Supplier B')?._id,
      },
      {
        name: 'Alex Morgan',
        email: 'alex@example.co.uk',
        password: 'customer123',
        role: Role.Customer,
        phone: '07700 900123',
        address: '24 Maple Road',
        city: 'London',
        postcode: 'SW11 3AA',
      },
    ];

    for (const account of accounts) {
      const existing = await this.users.findByEmailWithPassword(account.email);
      if (existing) {
        continue;
      }
      await this.users.create({
        name: account.name,
        email: account.email,
        password: account.password,
        role: account.role,
        phone: account.phone,
        address: account.address,
        city: account.city,
        postcode: account.postcode,
        supplier: account.supplier ?? null,
      });
      this.logger.warn(
        'Seeded ' + account.role + ' account ' + account.email + ' with the development password.',
      );
    }
  }

  /* ------------------------------- demo orders ------------------------------ */

  /**
   * A handful of orders covering the states the flows exercise: one
   * waiting on an invoice, one overdue, one Direct Debit awaiting a
   * mandate check, one waiting on an admin to send over WhatsApp, and
   * one completed. Only written when the order book is empty, so this
   * can never bury real data.
   */
  private async seedOrders(suppliers: Map<string, SupplierDocument>): Promise<void> {
    if ((await this.orderModel.countDocuments()) > 0) {
      this.logger.log('Orders already exist — skipping demo orders.');
      return;
    }

    const customer = await this.users.findByEmailWithPassword('alex@example.co.uk');
    if (!customer) {
      return;
    }
    const supplierA = suppliers.get('Supplier A');
    const supplierB = suppliers.get('Supplier B');
    const timeout = this.config.get<number>('responseTimeoutMs') ?? 420_000;
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

    const snapshot = {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    };

    const specs = [
      {
        n: 1025,
        reg: 'LM68 RTV',
        option: 'dd' as const,
        supplier: supplierA,
        assigned: minutesAgo(1),
        status: OrderStatus.AwaitingSupplier,
        channel: CommunicationMethod.Email,
        bank: {
          accountHolder: 'Alex Morgan',
          accountNumber: '61220945',
          sortCode: '30-96-12',
          dateOfBirth: '02/11/1988',
        },
        bankStatus: BankReviewStatus.Submitted,
      },
      {
        n: 1024,
        reg: 'AB12 CDE',
        option: '12m' as const,
        supplier: supplierB,
        assigned: minutesAgo(5.5),
        status: OrderStatus.AwaitingSupplier,
        channel: CommunicationMethod.WhatsApp,
      },
      {
        n: 1020,
        reg: 'EF70 WQP',
        option: '6m' as const,
        supplier: supplierA,
        assigned: minutesAgo(12),
        status: OrderStatus.Overdue,
        channel: CommunicationMethod.Email,
      },
      {
        n: 1019,
        reg: 'MK17 OPD',
        option: '12m' as const,
        supplier: supplierB,
        assigned: minutesAgo(9),
        status: OrderStatus.InvoiceReady,
        channel: CommunicationMethod.WhatsApp,
        uploaded: minutesAgo(5),
      },
      {
        n: 1022,
        reg: 'BD21 KLN',
        option: '12m' as const,
        supplier: supplierB,
        assigned: minutesAgo(130),
        status: OrderStatus.InvoiceSent,
        channel: CommunicationMethod.Email,
        uploaded: minutesAgo(126),
      },
    ];

    for (const spec of specs) {
      const lookup = await this.vehicles.lookup(spec.reg);
      /* Demo orders: fixed rates, so seeding never calls the metered lookup. */
      const pricing = this.pricing.price(spec.option, false, DEMO_VED);
      const overdue = spec.status === OrderStatus.Overdue;
      const done = spec.status === OrderStatus.InvoiceSent;
      const ready = spec.status === OrderStatus.InvoiceReady;

      await this.orderModel.create({
        orderNumber: 'ORD-' + spec.n,
        customer: customer._id,
        customerSnapshot: snapshot,
        supplier: spec.supplier?._id ?? null,
        reg: formatReg(spec.reg),
        vehicle: {
          make: lookup.make,
          variant: lookup.variant,
          model: lookup.model,
          colour: lookup.colour,
          vin: lookup.vin,
          taxClass: lookup.taxClass,
        },
        orderType: this.pricing.orderTypeFor(spec.option),
        plan: this.pricing.orderPlanLabel(spec.option, false),
        items: this.pricing.itemsFor(spec.option, false),
        pricing,
        total: pricing.total,
        deliveryAddress: customer.address + ', ' + customer.city + ', ' + customer.postcode,
        status: spec.status,
        invoiceStatus: done
          ? InvoiceStatus.Sent
          : ready
            ? InvoiceStatus.Ready
            : InvoiceStatus.Pending,
        communicationMethod: spec.channel,
        whatsappRequested: spec.channel === CommunicationMethod.WhatsApp,
        v62Requested: false,
        bank: spec.bank
          ? {
              accountHolder: spec.bank.accountHolder,
              accountNumber: encryptField(spec.bank.accountNumber),
              sortCode: spec.bank.sortCode,
              dateOfBirth: encryptField(spec.bank.dateOfBirth),
            }
          : null,
        bankReview: spec.bank ? { status: spec.bankStatus, flagged: [], notes: [] } : null,
        placedAt: spec.assigned,
        assignedAt: spec.assigned,
        /* Only an order still waiting on an invoice has a live window. */
        dueAt:
          done || ready || overdue ? null : new Date(spec.assigned.getTime() + timeout),
        invoiceUploadedAt: spec.uploaded ?? null,
        invoiceReadyAt: spec.uploaded ?? null,
        invoiceSentAt: done ? spec.uploaded : null,
        timeline: [
          {
            at: spec.assigned,
            actor: 'customer',
            title: 'Order placed',
            detail: this.pricing.orderPlanLabel(spec.option, false) + ' · ' + gbp(pricing.total),
            tone: null,
          },
        ],
      });
    }

    this.logger.log('Seeded ' + specs.length + ' demo orders.');
  }
}

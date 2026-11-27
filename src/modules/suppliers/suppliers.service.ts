import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { ORDER_TYPES, OrderType, SupplierStatus } from '../../common/enums/order.enum';
import { CreateSupplierDto, UpdateSupplierDto } from './dto/supplier.dto';
import { Supplier, SupplierDocument } from './schemas/supplier.schema';

@Injectable()
export class SuppliersService {
  constructor(
    @InjectModel(Supplier.name) private readonly supplierModel: Model<SupplierDocument>,
  ) {}

  /* --------------------------------- reads --------------------------------- */

  async findAll(): Promise<SupplierDocument[]> {
    return this.supplierModel.find().sort({ name: 1 });
  }

  async findActive(): Promise<SupplierDocument[]> {
    return this.supplierModel.find({ status: SupplierStatus.Active }).sort({ name: 1 });
  }

  async findById(id: string | Types.ObjectId): Promise<SupplierDocument> {
    const supplier = await this.supplierModel.findById(id);
    if (!supplier) {
      throw new NotFoundException('That supplier does not exist.');
    }
    return supplier;
  }

  /** Cheap name lookup for serializing a list of orders in one pass. */
  async nameMap(): Promise<Map<string, { name: string }>> {
    const suppliers = await this.supplierModel.find().select('name');
    return new Map(suppliers.map(s => [String(s._id), { name: s.name }]));
  }

  /* -------------------------------- routing -------------------------------- */

  /**
   * The one supplier holding this order type, active or not.
   *
   * An order type belongs to exactly one supplier — if Supplier A
   * caters 6 Months, nobody else does — so routing is a lookup rather
   * than a search, and there is never a question of which of several
   * eligible suppliers an order happened to go to.
   */
  async holderOf(orderType: OrderType): Promise<SupplierDocument | null> {
    return this.supplierModel.findOne({ orderTypes: orderType });
  }

  /**
   * Where an order of this type actually lands: only ever with somebody
   * who is active and on duty, because the seven-minute window starts
   * the moment it lands.
   *
   * The supplier who holds the type comes first. When they are off duty
   * the order goes to whoever else is on duty, the one who came on
   * first — an order waiting for its own supplier to clock in is a
   * customer waiting for no reason. Null when nobody is on duty: the
   * order waits, unassigned and with no clock running, and goes to the
   * first supplier who comes on duty (see OrdersService.claimWaiting).
   */
  async routeOrder(orderType: OrderType): Promise<SupplierDocument | null> {
    const working = { status: SupplierStatus.Active, onDuty: true };
    const holder = await this.supplierModel.findOne({ ...working, orderTypes: orderType });
    if (holder) {
      return holder;
    }
    return this.supplierModel.findOne(working).sort({ onDutySince: 1, _id: 1 });
  }

  /** Suppliers taking orders right now. */
  async findOnDuty(): Promise<SupplierDocument[]> {
    return this.supplierModel
      .find({ status: SupplierStatus.Active, onDuty: true })
      .sort({ onDutySince: 1 });
  }

  /**
   * On or off duty, as the supplier switched it. Whether they are
   * allowed to is OrdersService's call (`setDuty`), since it turns on
   * what they still hold; this is only the write.
   */
  async setOnDuty(id: string | Types.ObjectId, onDuty: boolean): Promise<SupplierDocument> {
    const supplier = await this.supplierModel.findByIdAndUpdate(
      id,
      { onDuty, onDutySince: onDuty ? new Date() : null },
      { new: true },
    );
    if (!supplier) {
      throw new NotFoundException('That supplier does not exist.');
    }
    return supplier;
  }

  /** Order types no active supplier currently covers. */
  async uncoveredOrderTypes(): Promise<OrderType[]> {
    const active = await this.findActive();
    const covered = new Set(active.flatMap(s => s.orderTypes));
    return ORDER_TYPES.filter(type => !covered.has(type));
  }

  /* -------------------------------- writes --------------------------------- */

  async create(dto: CreateSupplierDto): Promise<SupplierDocument> {
    const supplier = await this.supplierModel.create({
      name: dto.name,
      email: dto.email ?? '',
      phone: dto.phone ?? '',
      status: dto.status ?? SupplierStatus.Active,
      orderTypes: [],
      since: new Date(),
    });

    /* Any types requested are handed over through the exclusive path. */
    for (const type of dto.orderTypes ?? []) {
      await this.assignOrderType(String(supplier._id), type);
    }
    return this.findById(supplier._id);
  }

  async update(id: string, dto: UpdateSupplierDto): Promise<SupplierDocument> {
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([key, value]) => value !== undefined && key !== 'orderTypes'),
    );
    const supplier = await this.supplierModel.findByIdAndUpdate(id, patch, { new: true });
    if (!supplier) {
      throw new NotFoundException('That supplier does not exist.');
    }
    return supplier;
  }

  /**
   * A supplier taken out of rotation is taken off duty with it, so
   * making them active again does not quietly start routing to somebody
   * who is not there: they go back on duty from the app themselves.
   */
  async setStatus(id: string, status: SupplierStatus): Promise<SupplierDocument> {
    const patch =
      status === SupplierStatus.Active ? { status } : { status, onDuty: false, onDutySince: null };
    const supplier = await this.supplierModel.findByIdAndUpdate(id, patch, { new: true });
    if (!supplier) {
      throw new NotFoundException('That supplier does not exist.');
    }
    return supplier;
  }

  /**
   * Hand an order type to a supplier, taking it off whoever held it.
   * Two writes rather than one, because the rule being enforced is that
   * no two suppliers hold the same type — so the release has to happen
   * whether or not the new holder already had it.
   */
  async assignOrderType(supplierId: string, orderType: OrderType): Promise<SupplierDocument> {
    const supplier = await this.findById(supplierId);

    await this.supplierModel.updateMany(
      { _id: { $ne: supplier._id }, orderTypes: orderType },
      { $pull: { orderTypes: orderType } },
    );
    await this.supplierModel.updateOne(
      { _id: supplier._id },
      { $addToSet: { orderTypes: orderType } },
    );

    return this.findById(supplierId);
  }

  /** Leaves the type unheld — new orders of it will arrive unassigned. */
  async releaseOrderType(supplierId: string, orderType: OrderType): Promise<SupplierDocument> {
    await this.findById(supplierId);
    await this.supplierModel.updateOne(
      { _id: supplierId },
      { $pull: { orderTypes: orderType } },
    );
    return this.findById(supplierId);
  }

  /**
   * Deleting a supplier who still holds work would orphan those orders,
   * so it is refused; deactivating is the way to take one out of
   * rotation while their history stays readable.
   */
  async remove(id: string, openOrderCount: number): Promise<void> {
    const supplier = await this.findById(id);
    if (openOrderCount > 0) {
      throw new ConflictException(
        'This supplier still has open orders. Reassign them, or deactivate the supplier instead.',
      );
    }
    await this.supplierModel.deleteOne({ _id: supplier._id });
  }
}

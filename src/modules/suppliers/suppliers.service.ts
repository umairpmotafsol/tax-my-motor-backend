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
  async nameMap(): Promise<Map<string, { name: string; company: string }>> {
    const suppliers = await this.supplierModel.find().select('name company');
    return new Map(
      suppliers.map(s => [String(s._id), { name: s.name, company: s.company }]),
    );
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
   * Where an order of this type actually lands.
   *
   * Null when nobody holds the type, and also when the supplier who
   * holds it is not active: exclusivity means there is no second
   * supplier to fall through to, so the order arrives unassigned and
   * the admin is told, rather than going to somebody who cannot
   * process it.
   */
  async routeOrder(orderType: OrderType): Promise<SupplierDocument | null> {
    return this.supplierModel.findOne({ orderTypes: orderType, status: SupplierStatus.Active });
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
      company: dto.company,
      contact: dto.contact ?? '',
      email: dto.email ?? '',
      phone: dto.phone ?? '',
      region: dto.region ?? '',
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

  async setStatus(id: string, status: SupplierStatus): Promise<SupplierDocument> {
    const supplier = await this.supplierModel.findByIdAndUpdate(id, { status }, { new: true });
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

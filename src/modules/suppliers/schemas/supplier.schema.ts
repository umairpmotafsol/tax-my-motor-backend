import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { OrderType, SupplierStatus } from '../../../common/enums/order.enum';

export type SupplierDocument = HydratedDocument<Supplier>;

/**
 * A supplier and the order types they are eligible for.
 *
 * An order type belongs to exactly one supplier — if Supplier A caters
 * 6 Months, nobody else does. That exclusivity is enforced in
 * SuppliersService, not here, because it is a rule about the collection
 * rather than about one document.
 */
@Schema({ timestamps: true, collection: 'suppliers' })
export class Supplier {
  /** The short label the apps show: "Supplier A". */
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ lowercase: true, trim: true, default: '' })
  email!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({
    type: String,
    enum: Object.values(SupplierStatus),
    default: SupplierStatus.Active,
    index: true,
  })
  status!: SupplierStatus;

  /**
   * Whether the supplier is taking orders right now: switched on and off
   * from the supplier app, and nowhere else. Separate from `status`,
   * which is the admin's say over whether they may work at all. Only a
   * supplier who is both active and on duty is routed an order, and
   * their seven-minute window only ever runs while they are on duty.
   *
   * Off by default: a supplier's day starts when they tap On duty.
   */
  @Prop({ type: Boolean, default: false, index: true })
  onDuty!: boolean;

  /** When they last went on duty — first in is first served (see SuppliersService). */
  @Prop({ type: Date, default: null })
  onDutySince!: Date | null;

  /** The order types this supplier is configured to handle. */
  @Prop({ type: [String], enum: Object.values(OrderType), default: [], index: true })
  orderTypes!: OrderType[];

  @Prop({ type: Date, default: () => new Date() })
  since!: Date;
}

export const SupplierSchema = SchemaFactory.createForClass(Supplier);

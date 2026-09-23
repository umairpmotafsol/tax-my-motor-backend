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

  @Prop({ required: true, trim: true })
  company!: string;

  /** The person at the supplier, not an account — that is a User. */
  @Prop({ trim: true, default: '' })
  contact!: string;

  @Prop({ lowercase: true, trim: true, default: '' })
  email!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, default: '' })
  region!: string;

  @Prop({
    type: String,
    enum: Object.values(SupplierStatus),
    default: SupplierStatus.Active,
    index: true,
  })
  status!: SupplierStatus;

  /** The order types this supplier is configured to handle. */
  @Prop({ type: [String], enum: Object.values(OrderType), default: [], index: true })
  orderTypes!: OrderType[];

  @Prop({ type: Date, default: () => new Date() })
  since!: Date;
}

export const SupplierSchema = SchemaFactory.createForClass(Supplier);

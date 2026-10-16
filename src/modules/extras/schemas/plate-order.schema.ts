import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type PlateOrderDocument = HydratedDocument<PlateOrder>;

/** Where a number plates order is. Set by an admin, by hand, as the job moves on. */
export enum PlateOrderStatus {
  Received = 'received',
  InProduction = 'in_production',
  Dispatched = 'dispatched',
  Delivered = 'delivered',
  /** Called off by an admin. Any refund is made outside the platform. */
  Cancelled = 'cancelled',
}

/** How each status reads, to a customer and to an admin alike. */
export const PLATE_STATUS_LABELS: Record<PlateOrderStatus, string> = {
  [PlateOrderStatus.Received]: 'Received',
  [PlateOrderStatus.InProduction]: 'In production',
  [PlateOrderStatus.Dispatched]: 'Dispatched',
  [PlateOrderStatus.Delivered]: 'Delivered',
  [PlateOrderStatus.Cancelled]: 'Cancelled',
};

/** One step in an order's life: what it became, when, and which admin did it. */
@Schema({ _id: false })
export class PlateStatusChange {
  @Prop({ type: String, enum: Object.values(PlateOrderStatus), required: true })
  status!: PlateOrderStatus;

  @Prop({ type: Date, required: true })
  at!: Date;

  /** The admin's name; empty for the order being placed. */
  @Prop({ default: '' })
  by!: string;
}

export const PlateStatusChangeSchema = SchemaFactory.createForClass(PlateStatusChange);

/**
 * One "Order Number Plates" sale: a pair of plates for one registration,
 * paid for up front, made and posted by the TaxMyMotor team.
 *
 * Kept out of the order book, like a VIN purchase. It is never routed to
 * a supplier and has no upload window; an admin moves it along by hand.
 * The registration is what identifies it, to the customer and to the
 * admin — there is no order number.
 *
 * The contact details are a copy taken when the order was placed, so a
 * customer who later moves house does not move the delivery address of
 * plates already posted.
 */
@Schema({ timestamps: true, collection: 'plate_orders' })
export class PlateOrder {
  /* MongooseSchema.Types.ObjectId, never Types.ObjectId — see order.schema.ts. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  customer!: Types.ObjectId;

  /** "AB12 CDE". */
  @Prop({ required: true, uppercase: true, trim: true, index: true })
  reg!: string;

  @Prop({ default: '' })
  make!: string;

  /** "Ford Fiesta 1.0 EcoBoost" — as the lookup gave it. */
  @Prop({ default: '' })
  vehicleModel!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, trim: true })
  phone!: string;

  @Prop({ required: true, trim: true, lowercase: true })
  email!: string;

  /** Where the plates are posted, as one line: "24 Maple Road, SW11 3AA". */
  @Prop({ required: true, trim: true })
  address!: string;

  /** What was charged, in pounds — kept, because the price may change later. */
  @Prop({ required: true, min: 0 })
  amount!: number;

  /** The Stripe PaymentIntent that paid for it. Unique: one payment, one order. */
  @Prop({ required: true, unique: true, index: true })
  paymentIntentId!: string;

  @Prop({
    type: String,
    enum: Object.values(PlateOrderStatus),
    default: PlateOrderStatus.Received,
    index: true,
  })
  status!: PlateOrderStatus;

  @Prop({ type: [PlateStatusChangeSchema], default: [] })
  history!: PlateStatusChange[];

  @Prop({ type: Date, required: true, default: () => new Date() })
  placedAt!: Date;

  /** Whether the customer's receipt left. Null when none was attempted. */
  @Prop({ type: String, enum: ['sent', 'failed', null], default: null })
  receiptEmail!: 'sent' | 'failed' | null;

  /** Whether the admins were told by email. Null when none was attempted. */
  @Prop({ type: String, enum: ['sent', 'failed', null], default: null })
  adminEmail!: 'sent' | 'failed' | null;
}

export const PlateOrderSchema = SchemaFactory.createForClass(PlateOrder);

PlateOrderSchema.index({ customer: 1, placedAt: -1 });
PlateOrderSchema.index({ status: 1, placedAt: -1 });

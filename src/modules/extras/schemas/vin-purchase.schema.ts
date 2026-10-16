import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type VinPurchaseDocument = HydratedDocument<VinPurchase>;

/**
 * One "Reg > VIN" sale: a customer paid to be shown a vehicle's VIN.
 *
 * Kept apart from the order book on purpose. An order is a job somebody
 * has to do — it is routed to a supplier, timed, invoiced — and none of
 * that applies to something delivered the moment it is paid for.
 *
 * The VIN is stored, so the customer can read it again from their
 * Orders tab without the plate being looked up, and paid for, twice.
 */
@Schema({ timestamps: true, collection: 'vin_purchases' })
export class VinPurchase {
  /* MongooseSchema.Types.ObjectId, never Types.ObjectId — see order.schema.ts. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  customer!: Types.ObjectId;

  /** "AB12 CDE". */
  @Prop({ required: true, uppercase: true, trim: true })
  reg!: string;

  @Prop({ default: '' })
  make!: string;

  /** "Ford Fiesta 1.0 EcoBoost" — as the lookup gave it. */
  @Prop({ default: '' })
  vehicleModel!: string;

  @Prop({ required: true })
  vin!: string;

  /** What was charged, in pounds — kept, because the price may change later. */
  @Prop({ required: true, min: 0 })
  amount!: number;

  /**
   * The Stripe PaymentIntent that paid for it. Unique: one payment buys
   * one VIN, and a retried request finds the sale it already made.
   */
  @Prop({ required: true, unique: true, index: true })
  paymentIntentId!: string;

  @Prop({ type: Date, required: true, default: () => new Date() })
  purchasedAt!: Date;

  /** Whether the receipt email left. Null when none was attempted. */
  @Prop({ type: String, enum: ['sent', 'failed', null], default: null })
  receiptEmail!: 'sent' | 'failed' | null;
}

export const VinPurchaseSchema = SchemaFactory.createForClass(VinPurchase);

VinPurchaseSchema.index({ customer: 1, purchasedAt: -1 });

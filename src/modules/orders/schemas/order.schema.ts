import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { BankField, BankReviewActor, BankReviewStatus } from '../../../common/enums/bank.enum';
import {
  CommunicationMethod,
  InvoiceStatus,
  OrderStatus,
  OrderType,
} from '../../../common/enums/order.enum';

export type OrderDocument = HydratedDocument<Order>;

/* -------------------------------- sub-documents ------------------------------ */

@Schema({ _id: false })
export class OrderItem {
  @Prop({ required: true })
  name!: string;

  @Prop({ required: true, min: 1, default: 1 })
  qty!: number;
}
const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

/**
 * What the customer was charged, broken down. Kept on the order rather
 * than recomputed, because a later change to the service fee must not
 * rewrite the price of an order somebody already paid.
 */
@Schema({ _id: false })
export class Pricing {
  @Prop({ required: true, min: 0 })
  tax!: number;

  @Prop({ required: true, min: 0 })
  serviceFee!: number;

  @Prop({ required: true, min: 0, default: 0 })
  v62Fee!: number;

  @Prop({ required: true, min: 0 })
  total!: number;

  /** What was taken today — one instalment on Direct Debit, else the total. */
  @Prop({ required: true, min: 0 })
  dueNow!: number;

  /** Null unless the order is paid in instalments. */
  @Prop({ type: Number, default: null })
  monthly!: number | null;

  @Prop({ required: true, min: 1, default: 1 })
  instalments!: number;
}
const PricingSchema = SchemaFactory.createForClass(Pricing);

/** The vehicle as the lookup returned it, frozen at the time of order. */
@Schema({ _id: false })
export class OrderVehicle {
  @Prop({ required: true })
  make!: string;

  @Prop({ default: '' })
  variant!: string;

  /** "Ford Fiesta 1.0 EcoBoost" — what every list row shows. */
  @Prop({ required: true })
  model!: string;

  @Prop({ default: '' })
  colour!: string;

  @Prop({ default: '' })
  vin!: string;

  /** Doubles as the DVLA taxation class on the V62. */
  @Prop({ default: '' })
  taxClass!: string;
}
const OrderVehicleSchema = SchemaFactory.createForClass(OrderVehicle);

/**
 * The customer as they were when the order was placed. Denormalised on
 * purpose: an invoice raised against "Sarah Lee" should still say so
 * after she changes her name in her profile.
 */
@Schema({ _id: false })
export class CustomerSnapshot {
  @Prop({ required: true })
  name!: string;

  @Prop({ default: '' })
  email!: string;

  @Prop({ default: '' })
  phone!: string;
}
const CustomerSnapshotSchema = SchemaFactory.createForClass(CustomerSnapshot);

/** The photographed invoice. The file itself lives in the upload store. */
@Schema({ _id: false })
export class InvoiceFile {
  @Prop({ required: true })
  fileName!: string;

  /**
   * What the store calls this file. A Cloudinary public_id, or a
   * filename on disk. Never a path the client supplied.
   */
  @Prop({ required: true })
  storageKey!: string;

  /**
   * The hosted copy, when there is one.
   *
   * An invoice has to reach the customer through WhatsApp, and WhatsApp
   * fetches a link with no bearer token and no cookie — so a customer's
   * copy cannot be an authenticated API route. Cloudinary serves that
   * copy; this is its URL, and it is empty for a file kept on the local
   * disk, which is reachable only through `GET /invoices/:id/file`.
   */
  @Prop({ default: '' })
  url!: string;

  /** Which store holds it — so a book with both is still readable. */
  @Prop({ type: String, enum: ['local', 'cloudinary'], default: 'local' })
  provider!: 'local' | 'cloudinary';

  @Prop({ default: 'image/jpeg' })
  mimeType!: string;

  @Prop({ default: 0 })
  size!: number;

  @Prop({ type: Date, default: () => new Date() })
  capturedAt!: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  uploadedBy!: Types.ObjectId | null;
}
const InvoiceFileSchema = SchemaFactory.createForClass(InvoiceFile);

/**
 * The DVLA V62 application, shaped to match the printed form. Built
 * when the customer submits it, so the admin prints exactly what was
 * declared rather than a re-derivation that may since have drifted.
 */
@Schema({ _id: false })
export class V62Submission {
  @Prop({ required: true })
  registrationNumber!: string;

  @Prop({ default: '' })
  make!: string;

  @Prop({ default: '' })
  model!: string;

  @Prop({ default: '' })
  colour!: string;

  @Prop({ default: '' })
  vin!: string;

  @Prop({ default: '' })
  taxClass!: string;

  @Prop({ default: '' })
  reasonForNoV5C!: string;

  @Prop({ default: 0 })
  fee!: number;

  @Prop({ default: '' })
  keeperTitle!: string;

  @Prop({ default: '' })
  keeperName!: string;

  @Prop({ default: '' })
  keeperAddress!: string;

  @Prop({ default: '' })
  keeperPostcode!: string;

  @Prop({ default: '' })
  keeperPhone!: string;

  @Prop({ default: '' })
  keeperEmail!: string;

  @Prop({ default: '' })
  declarationDate!: string;

  @Prop({ type: Date, default: () => new Date() })
  submittedAt!: Date;
}
const V62SubmissionSchema = SchemaFactory.createForClass(V62Submission);

/**
 * The mandate. `accountNumber` and `dateOfBirth` are stored encrypted
 * (see crypto.util) and decrypted only for the supplier reviewing them
 * and the customer they belong to.
 */
@Schema({ _id: false })
export class BankDetails {
  @Prop({ required: true })
  accountHolder!: string;

  @Prop({ required: true })
  accountNumber!: string;

  @Prop({ required: true })
  sortCode!: string;

  @Prop({ required: true })
  dateOfBirth!: string;
}
const BankDetailsSchema = SchemaFactory.createForClass(BankDetails);

/** One turn in the supplier/customer back-and-forth. */
@Schema({ _id: false })
export class BankReviewNote {
  @Prop({ type: Date, default: () => new Date() })
  at!: Date;

  @Prop({ type: String, enum: Object.values(BankReviewActor), required: true })
  by!: BankReviewActor;

  /** What the supplier flagged. Empty on the customer's reply. */
  @Prop({ type: [String], enum: Object.values(BankField), default: [] })
  fields!: BankField[];

  @Prop({ required: true })
  message!: string;
}
const BankReviewNoteSchema = SchemaFactory.createForClass(BankReviewNote);

@Schema({ _id: false })
export class BankReview {
  @Prop({
    type: String,
    enum: Object.values(BankReviewStatus),
    default: BankReviewStatus.Submitted,
  })
  status!: BankReviewStatus;

  /** The fields still to fix. Empty once approved. */
  @Prop({ type: [String], enum: Object.values(BankField), default: [] })
  flagged!: BankField[];

  /** Oldest first, so the thread reads top to bottom. */
  @Prop({ type: [BankReviewNoteSchema], default: [] })
  notes!: BankReviewNote[];
}
const BankReviewSchema = SchemaFactory.createForClass(BankReview);

/**
 * The audit trail. Appended as things happen rather than derived at
 * read time, so an event keeps the wording it had when it was recorded.
 */
@Schema({ _id: false })
export class TimelineEvent {
  @Prop({ type: Date, default: () => new Date() })
  at!: Date;

  @Prop({ required: true })
  actor!: string;

  @Prop({ required: true })
  title!: string;

  @Prop({ type: String, default: null })
  detail!: string | null;

  @Prop({ type: String, default: null })
  tone!: string | null;
}
const TimelineEventSchema = SchemaFactory.createForClass(TimelineEvent);

/** The Stripe charge behind a 6 or 12 month order. Null on Direct Debit — DVLA collects those. */
@Schema({ _id: false })
export class PaymentInfo {
  @Prop({ default: 'stripe' })
  provider!: string;

  @Prop({ required: true })
  intentId!: string;

  @Prop({ required: true, min: 0 })
  amount!: number;

  @Prop({ default: 'gbp' })
  currency!: string;

  @Prop({ type: Date, default: () => new Date() })
  paidAt!: Date;
}
const PaymentInfoSchema = SchemaFactory.createForClass(PaymentInfo);

/* ----------------------------------- order ----------------------------------- */

@Schema({ timestamps: true, collection: 'orders' })
export class Order {
  @Prop({ required: true, unique: true, index: true })
  orderNumber!: string;

  /*
   * MongooseSchema.Types.ObjectId, not Types.ObjectId, on every
   * reference below.
   *
   * They read the same, but `Types.ObjectId` is the BSON value class —
   * @Prop does not recognise it as a schema type, treats it as a nested
   * class to inspect, finds no @Prop metadata on it and settles on
   * Mixed. A Mixed path is never cast, so `find({ customer: '<id>' })`
   * compares a string against a stored ObjectId and matches nothing,
   * and `ref` is dropped so populate() quietly returns the raw id. Both
   * fail silently: no error, just an empty list.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  customer!: Types.ObjectId;

  @Prop({ type: CustomerSnapshotSchema, required: true })
  customerSnapshot!: CustomerSnapshot;

  /** Null when no active supplier holds this order type. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Supplier', default: null, index: true })
  supplier!: Types.ObjectId | null;

  @Prop({ required: true, uppercase: true, trim: true, index: true })
  reg!: string;

  @Prop({ type: OrderVehicleSchema, required: true })
  vehicle!: OrderVehicle;

  @Prop({ type: String, enum: Object.values(OrderType), required: true, index: true })
  orderType!: OrderType;

  /** The human label: "12-month tax + V62". */
  @Prop({ required: true })
  plan!: string;

  @Prop({ type: [OrderItemSchema], default: [] })
  items!: OrderItem[];

  @Prop({ type: PricingSchema, required: true })
  pricing!: Pricing;

  @Prop({ required: true, min: 0 })
  total!: number;

  @Prop({ default: '' })
  deliveryAddress!: string;

  /** Null on Direct Debit orders, which are never charged here. */
  @Prop({ type: PaymentInfoSchema, default: null })
  payment!: PaymentInfo | null;

  /* --- lifecycle -------------------------------------------------------- */

  @Prop({
    type: String,
    enum: Object.values(OrderStatus),
    default: OrderStatus.AwaitingSupplier,
    index: true,
  })
  status!: OrderStatus;

  @Prop({
    type: String,
    enum: Object.values(InvoiceStatus),
    default: InvoiceStatus.Pending,
    index: true,
  })
  invoiceStatus!: InvoiceStatus;

  @Prop({ type: InvoiceFileSchema, default: null })
  invoice!: InvoiceFile | null;

  @Prop({
    type: String,
    enum: Object.values(CommunicationMethod),
    default: CommunicationMethod.Email,
  })
  communicationMethod!: CommunicationMethod;

  @Prop({ type: Boolean, default: false })
  whatsappRequested!: boolean;

  /* --- V62 -------------------------------------------------------------- */

  @Prop({ type: Boolean, default: false, index: true })
  v62Requested!: boolean;

  @Prop({ type: V62SubmissionSchema, default: null })
  v62!: V62Submission | null;

  @Prop({ type: Date, default: null })
  v62PrintedAt!: Date | null;

  /* --- Direct Debit mandate --------------------------------------------- */

  @Prop({ type: BankDetailsSchema, default: null })
  bank!: BankDetails | null;

  @Prop({ type: BankReviewSchema, default: null })
  bankReview!: BankReview | null;

  /* --- timestamps, one per lifecycle step ------------------------------- */

  @Prop({ type: Date, required: true, default: () => new Date(), index: true })
  placedAt!: Date;

  @Prop({ type: Date, default: null })
  assignedAt!: Date | null;

  /**
   * When the supplier's current window started. Unset on almost every
   * order, where it is simply the assignment; set when a Direct Debit
   * order comes back from the customer, because the window then starts
   * again from the moment it landed back in the supplier's court.
   */
  @Prop({ type: Date, default: null })
  turnStartedAt!: Date | null;

  /**
   * When the window closes. Stored rather than computed, so the overdue
   * sweep is an indexed query instead of a scan over every open order.
   */
  @Prop({ type: Date, default: null, index: true })
  dueAt!: Date | null;

  @Prop({ type: Date, default: null })
  invoiceUploadedAt!: Date | null;

  @Prop({ type: Date, default: null })
  invoiceReadyAt!: Date | null;

  @Prop({ type: Date, default: null })
  invoiceSentAt!: Date | null;

  /** Set when an admin sent it over WhatsApp. Never set on email orders. */
  @Prop({ type: Date, default: null })
  deliveredAt!: Date | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Supplier', default: null })
  reassignedFrom!: Types.ObjectId | null;

  @Prop({ type: [TimelineEventSchema], default: [] })
  timeline!: TimelineEvent[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);

/* The three queries the apps actually make, each backed by an index. */
OrderSchema.index({ supplier: 1, status: 1, placedAt: -1 });
OrderSchema.index({ customer: 1, placedAt: -1 });
OrderSchema.index({ status: 1, dueAt: 1 });
OrderSchema.index({ orderNumber: 'text', reg: 'text' });

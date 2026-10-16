import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { Role } from '../../../common/enums/role.enum';

export type UserDocument = HydratedDocument<User>;

/**
 * One phone this account can be pushed to.
 *
 * Kept on the user rather than in a collection of its own: a token is
 * only ever read by way of the account it belongs to, and one account
 * has a handful of them at most — a phone, a spare, a reinstall that
 * has not expired yet. Firebase hands back the dead ones on every send
 * and `PushService` prunes them, so the list does not grow forever.
 */
@Schema({ _id: false })
export class DeviceToken {
  @Prop({ required: true, index: true })
  token!: string;

  @Prop({ type: String, enum: ['ios', 'android'], required: true })
  platform!: 'ios' | 'android';

  @Prop({ type: Date, default: () => new Date() })
  registeredAt!: Date;
}

export const DeviceTokenSchema = SchemaFactory.createForClass(DeviceToken);

/**
 * One account collection for all three apps. The role decides which
 * order book the holder sees; a supplier additionally carries the
 * supplier they work for, which is what scopes their queries.
 *
 * The password hash is `select: false`, so it is never loaded unless a
 * query asks for it by name — which only the sign-in path does.
 */
@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true, index: true })
  email!: string;

  @Prop({ required: true, select: false })
  passwordHash!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ type: String, enum: Object.values(Role), required: true, index: true })
  role!: Role;

  /* MongooseSchema.Types.ObjectId, never Types.ObjectId — see order.schema.ts. */
  /** Suppliers only. Null for customers and admins. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Supplier', default: null, index: true })
  supplier!: Types.ObjectId | null;

  /* --- customer profile, reused on every order -------------------------- */

  @Prop({ trim: true, default: '' })
  address!: string;

  @Prop({ trim: true, default: '' })
  city!: string;

  @Prop({ trim: true, default: '' })
  postcode!: string;

  /* --- referrals -------------------------------------------------------- */

  @Prop({ unique: true, sparse: true, uppercase: true, trim: true })
  referralCode?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  referredBy!: Types.ObjectId | null;

  /** Earned by referring; spent on the next order placed. */
  @Prop({ type: Number, default: 0, min: 0 })
  freeOrders!: number;

  @Prop({ type: Date, default: null })
  freeOrderEarnedOn!: Date | null;

  /* --- account state ---------------------------------------------------- */

  @Prop({ type: Boolean, default: true })
  active!: boolean;

  /**
   * True while the account is still on a password somebody else chose.
   * Supplier sign-ins are opened by an admin, who generates the first
   * password and sends it over — so until the holder replaces it, the
   * admin knows it too. The supplier app asks for a replacement on the
   * next sign-in; `changePassword` clears this.
   */
  @Prop({ type: Boolean, default: false })
  mustChangePassword!: boolean;

  @Prop({ type: Date, default: null })
  lastLoginAt!: Date | null;

  /* --- push ------------------------------------------------------------- */

  /**
   * The phones to notify. Empty for anyone who has never signed in on
   * one, or who declined the permission — which is a silent no-op, not
   * an error: push is a convenience on top of the app, never the only
   * way to learn something.
   */
  @Prop({ type: [DeviceTokenSchema], default: [] })
  deviceTokens!: DeviceToken[];
}

export const UserSchema = SchemaFactory.createForClass(User);

/** Names are searched from the admin portal's customer list. */
UserSchema.index({ name: 'text', email: 'text' });

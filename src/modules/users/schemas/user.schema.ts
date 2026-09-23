import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { Role } from '../../../common/enums/role.enum';

export type UserDocument = HydratedDocument<User>;

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

  @Prop({ type: Date, default: null })
  lastLoginAt!: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);

/** Names are searched from the admin portal's customer list. */
UserSchema.index({ name: 'text', email: 'text' });

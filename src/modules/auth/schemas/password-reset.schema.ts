import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type PasswordResetDocument = HydratedDocument<PasswordReset>;

/**
 * A "forgot password" code, emailed to the customer and good for fifteen
 * minutes.
 *
 * One per account: asking again replaces it, so only the latest email's
 * code works. The code itself is never stored, only a hash of it bound
 * to the account, and a few wrong guesses use it up — six digits is a
 * million possibilities, which is plenty for fifteen minutes and five
 * tries, and nothing like enough for unlimited ones.
 */
@Schema({ timestamps: true, collection: 'password_resets' })
export class PasswordReset {
  /* MongooseSchema.Types.ObjectId, never Types.ObjectId — see order.schema.ts. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, unique: true })
  user!: Types.ObjectId;

  @Prop({ required: true })
  codeHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  /** Wrong codes tried against this one. */
  @Prop({ type: Number, default: 0 })
  attempts!: number;
}

export const PasswordResetSchema = SchemaFactory.createForClass(PasswordReset);

/** Mongo removes the row once it expires; nothing has to sweep it. */
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

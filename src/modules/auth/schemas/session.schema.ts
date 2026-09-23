import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type SessionDocument = HydratedDocument<Session>;

/**
 * A live refresh token. The token itself is never stored — only its
 * SHA-256 — so a database dump is not a set of usable sessions.
 *
 * Rows expire on their own via a TTL index, and are deleted outright on
 * sign-out, which is what makes a refresh token revocable at all.
 */
@Schema({ timestamps: true, collection: 'sessions' })
export class Session {
  /* MongooseSchema.Types.ObjectId, never Types.ObjectId — see order.schema.ts. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  user!: Types.ObjectId;

  @Prop({ required: true, unique: true, index: true })
  tokenHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  /** Recorded for the "signed in on a new device" case. */
  @Prop({ default: '' })
  userAgent!: string;

  @Prop({ default: '' })
  ip!: string;
}

export const SessionSchema = SchemaFactory.createForClass(Session);

/** Mongo removes the row once it expires; nothing has to sweep it. */
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

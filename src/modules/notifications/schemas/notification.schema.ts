import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { NotificationType } from '../../../common/enums/notification.enum';
import { Role } from '../../../common/enums/role.enum';

export type NotificationDocument = HydratedDocument<Notification>;

/**
 * A thing somebody needs to look at. Most are for the admin — the
 * portal's bell — but the audience is explicit so the customer's
 * "your details were sent back" can live in the same collection.
 */
@Schema({ timestamps: true, collection: 'notifications' })
export class Notification {
  @Prop({ type: String, enum: Object.values(NotificationType), required: true, index: true })
  type!: NotificationType;

  /* MongooseSchema.Types.ObjectId, never Types.ObjectId — see order.schema.ts. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true, index: true })
  order!: Types.ObjectId;

  /** Who should see it. Admin notifications have no specific recipient. */
  @Prop({ type: String, enum: Object.values(Role), default: Role.Admin, index: true })
  audience!: Role;

  /** Set when the notification belongs to one person rather than a role. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null, index: true })
  recipient!: Types.ObjectId | null;

  @Prop({ type: Boolean, default: false, index: true })
  read!: boolean;

  @Prop({ type: Date, default: () => new Date(), index: true })
  createdAt!: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

/**
 * One live notification per type per order. The overdue sweep runs
 * every thirty seconds and would otherwise raise the same alert over
 * and over for an order nobody has dealt with yet.
 */
NotificationSchema.index({ order: 1, type: 1 }, { unique: true });

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { NOTIFICATION_META, NotificationType } from '../../common/enums/notification.enum';
import { Role } from '../../common/enums/role.enum';
import { Notification, NotificationDocument } from './schemas/notification.schema';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
  ) {}

  /**
   * Raise one, unless it is already standing.
   *
   * The upsert is what makes this safe to call from the overdue sweep,
   * which runs every thirty seconds and would otherwise raise the same
   * alert over and over for an order nobody has dealt with yet.
   */
  async raise(
    type: NotificationType,
    orderId: Types.ObjectId,
    audience: Role = Role.Admin,
    recipient?: Types.ObjectId,
  ): Promise<NotificationDocument> {
    return this.notificationModel.findOneAndUpdate(
      { order: orderId, type },
      {
        $setOnInsert: {
          type,
          order: orderId,
          audience,
          recipient: recipient ?? null,
          read: false,
          createdAt: new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  }

  /**
   * The situation the alert described is over. Deleted rather than
   * marked read: a reassigned order is not an overdue order somebody
   * has since looked at, it is no longer overdue at all.
   */
  async resolve(type: NotificationType, orderId: Types.ObjectId): Promise<void> {
    await this.notificationModel.deleteOne({ order: orderId, type });
  }

  async listForAdmin(limit = 50) {
    const items = await this.notificationModel
      .find({ audience: Role.Admin })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('order', 'orderNumber reg vehicle.model customerSnapshot.name total plan');
    return items.map(item => this.shape(item));
  }

  async listForUser(userId: string, limit = 50) {
    const items = await this.notificationModel
      .find({ recipient: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('order', 'orderNumber reg vehicle.model total plan');
    return items.map(item => this.shape(item));
  }

  async unreadCount(audience: Role = Role.Admin): Promise<number> {
    return this.notificationModel.countDocuments({ audience, read: false });
  }

  async markRead(id: string): Promise<void> {
    await this.notificationModel.updateOne({ _id: id }, { $set: { read: true } });
  }

  async markAllRead(audience: Role = Role.Admin): Promise<void> {
    await this.notificationModel.updateMany({ audience, read: false }, { $set: { read: true } });
  }

  /** Clears everything raised against an order — used when one is deleted. */
  async clearForOrder(orderId: Types.ObjectId): Promise<void> {
    await this.notificationModel.deleteMany({ order: orderId });
  }

  private shape(item: NotificationDocument) {
    const meta = NOTIFICATION_META[item.type];
    const order = item.order as unknown as {
      _id: Types.ObjectId;
      orderNumber?: string;
      reg?: string;
      total?: number;
      plan?: string;
      vehicle?: { model?: string };
      customerSnapshot?: { name?: string };
    } | null;

    return {
      id: String(item._id),
      type: item.type,
      label: meta.label,
      tone: meta.tone,
      icon: meta.icon,
      read: item.read,
      createdAt: new Date(item.createdAt).toISOString(),
      orderId: order?._id ? String(order._id) : String(item.order),
      order: order?.orderNumber
        ? {
            orderNumber: order.orderNumber,
            reg: order.reg ?? '',
            vehicleModel: order.vehicle?.model ?? '',
            customerName: order.customerSnapshot?.name ?? '',
            plan: order.plan ?? '',
            total: order.total ?? 0,
          }
        : null,
    };
  }
}

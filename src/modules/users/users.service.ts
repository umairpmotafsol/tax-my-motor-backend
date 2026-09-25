import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { FilterQuery, Model, Types } from 'mongoose';

import { Paginated, paginate } from '../../common/dto/pagination.dto';
import { InvoiceStatus, OPEN_STATUSES } from '../../common/enums/order.enum';
import { Role } from '../../common/enums/role.enum';
import { initials } from '../../common/utils/format.util';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { User, UserDocument } from './schemas/user.schema';

/** One customer's order history, summarised for the admin directory. */
export interface CustomerOrderStats {
  ordersCount: number;
  openOrders: number;
  lifetimeSpend: number;
  prefersWhatsapp: boolean;
  everRequestedV62: boolean;
  latestOrder: { id: string; orderNumber: string; status: string; placedAt: string } | null;
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role: Role;
  phone?: string;
  address?: string;
  city?: string;
  postcode?: string;
  supplier?: Types.ObjectId | string | null;
  referredByCode?: string;
  /** Set when the password is one an admin generated rather than one the holder chose. */
  mustChangePassword?: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly config: ConfigService,
  ) {}

  /* ------------------------------- creation -------------------------------- */

  async create(input: CreateUserInput): Promise<UserDocument> {
    const email = input.email.trim().toLowerCase();
    if (await this.userModel.exists({ email })) {
      throw new ConflictException('An account with that email address already exists.');
    }

    const referrer = input.referredByCode
      ? await this.userModel.findOne({ referralCode: input.referredByCode.trim().toUpperCase() })
      : null;

    const user = await this.userModel.create({
      name: input.name.trim(),
      email,
      passwordHash: await this.hashPassword(input.password),
      role: input.role,
      phone: input.phone ?? '',
      address: input.address ?? '',
      city: input.city ?? '',
      postcode: input.postcode ?? '',
      supplier: input.supplier ? new Types.ObjectId(input.supplier) : null,
      referralCode: input.role === Role.Customer ? await this.mintReferralCode(input.name) : undefined,
      referredBy: referrer?._id ?? null,
      mustChangePassword: input.mustChangePassword ?? false,
    });

    return user;
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.config.get<number>('bcryptRounds') ?? 12);
  }

  /* -------------------------------- lookups -------------------------------- */

  /** Includes the password hash — the sign-in path only. */
  async findByEmailWithPassword(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash');
  }

  async findById(id: string | Types.ObjectId): Promise<UserDocument> {
    const user = await this.userModel.findById(id);
    if (!user) {
      throw new NotFoundException('That account no longer exists.');
    }
    return user;
  }

  async findByIdWithPassword(id: string | Types.ObjectId): Promise<UserDocument> {
    const user = await this.userModel.findById(id).select('+passwordHash');
    if (!user) {
      throw new NotFoundException('That account no longer exists.');
    }
    return user;
  }

  async findByReferralCode(code: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ referralCode: code.trim().toUpperCase() });
  }

  /**
   * The sign-ins that belong to one supplier. Usually one, but a
   * company with two people on the phones is not a special case worth
   * forbidding, so this is a list.
   */
  async listBySupplier(supplierId: string | Types.ObjectId): Promise<UserDocument[]> {
    return this.userModel
      .find({ role: Role.Supplier, supplier: new Types.ObjectId(supplierId) })
      .sort({ createdAt: 1 });
  }

  /**
   * Every supplier sign-in, grouped by the supplier it belongs to — so
   * the admin portal's supplier list arrives complete in one request
   * rather than one per card.
   */
  async listSupplierLoginsByOwner(): Promise<Map<string, UserDocument[]>> {
    const users = await this.userModel
      .find({ role: Role.Supplier, supplier: { $ne: null } })
      .sort({ createdAt: 1 });

    const grouped = new Map<string, UserDocument[]>();
    for (const user of users) {
      const key = String(user.supplier);
      const existing = grouped.get(key);
      if (existing) {
        existing.push(user);
      } else {
        grouped.set(key, [user]);
      }
    }
    return grouped;
  }

  /* ------------------------------- customers ------------------------------- */

  /** The admin portal's customer list. */
  async listCustomers(page: number, limit: number, search?: string): Promise<Paginated<UserDocument>> {
    const filter: FilterQuery<UserDocument> = { role: Role.Customer };
    if (search) {
      const rx = new RegExp(escapeRegExp(search), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { city: rx }];
    }

    const [items, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      this.userModel.countDocuments(filter),
    ]);

    return paginate(items, total, page, limit);
  }

  /**
   * Order-book summaries for a page of customers — order count, open
   * count, lifetime spend, whether they've ever asked for WhatsApp or a
   * V62, and their latest order. One aggregation over just this page's
   * ids, rather than a query per row.
   */
  async customerOrderStats(customerIds: (string | Types.ObjectId)[]): Promise<Map<string, CustomerOrderStats>> {
    if (customerIds.length === 0) {
      return new Map();
    }
    const ids = customerIds.map(id => new Types.ObjectId(id));

    const rows = await this.orderModel.aggregate<{
      _id: Types.ObjectId;
      ordersCount: number;
      openOrders: number;
      lifetimeSpend: number;
      prefersWhatsapp: boolean;
      everRequestedV62: boolean;
      latestOrder: { id: Types.ObjectId; orderNumber: string; status: string; placedAt: Date };
    }>([
      { $match: { customer: { $in: ids } } },
      /* Sorted before grouping so $first below picks up each customer's newest order. */
      { $sort: { placedAt: -1 } },
      {
        $group: {
          _id: '$customer',
          ordersCount: { $sum: 1 },
          openOrders: { $sum: { $cond: [{ $in: ['$status', OPEN_STATUSES] }, 1, 0] } },
          lifetimeSpend: {
            $sum: { $cond: [{ $eq: ['$invoiceStatus', InvoiceStatus.Sent] }, '$total', 0] },
          },
          prefersWhatsapp: { $max: '$whatsappRequested' },
          everRequestedV62: { $max: '$v62Requested' },
          latestOrder: {
            $first: { id: '$_id', orderNumber: '$orderNumber', status: '$status', placedAt: '$placedAt' },
          },
        },
      },
    ]);

    return new Map(
      rows.map(row => [
        String(row._id),
        {
          ordersCount: row.ordersCount,
          openOrders: row.openOrders,
          lifetimeSpend: row.lifetimeSpend,
          prefersWhatsapp: row.prefersWhatsapp,
          everRequestedV62: row.everRequestedV62,
          latestOrder: {
            id: String(row.latestOrder.id),
            orderNumber: row.latestOrder.orderNumber,
            status: row.latestOrder.status,
            placedAt: new Date(row.latestOrder.placedAt).toISOString(),
          },
        },
      ]),
    );
  }

  /* -------------------------------- updates -------------------------------- */

  async updateProfile(
    id: string | Types.ObjectId,
    patch: Partial<Pick<User, 'name' | 'email' | 'phone' | 'address' | 'city' | 'postcode'>>,
  ): Promise<UserDocument> {
    const next = { ...patch };

    if (next.email !== undefined) {
      // Email is the login identifier and carries a unique index, so a
      // collision here would otherwise surface as a raw E11000 and a
      // 500. Checked against everyone except this account, so saving
      // the form unchanged is not a conflict with itself.
      const email = next.email.trim().toLowerCase();
      const taken = await this.userModel.exists({ email, _id: { $ne: id } });
      if (taken) {
        throw new ConflictException('An account with that email address already exists.');
      }
      next.email = email;
    }

    const user = await this.userModel.findByIdAndUpdate(id, cleanPatch(next), { new: true });
    if (!user) {
      throw new NotFoundException('That account no longer exists.');
    }
    return user;
  }

  async changePassword(id: string | Types.ObjectId, current: string, next: string): Promise<void> {
    const user = await this.findByIdWithPassword(id);
    const matches = await bcrypt.compare(current, user.passwordHash);
    if (!matches) {
      throw new ConflictException('Your current password is not correct.');
    }
    user.passwordHash = await this.hashPassword(next);
    /* Chosen by the holder, so nobody else is holding a copy of it. */
    user.mustChangePassword = false;
    await user.save();
  }

  /**
   * Sets a password without knowing the old one — the admin resetting a
   * supplier's sign-in, who by definition cannot supply it. Kept apart
   * from `changePassword` so the path that skips the current-password
   * check is one an admin-only controller has to ask for by name.
   *
   * A password set this way is known to whoever set it, so it is marked
   * for replacement by default; pass `false` only where that is not
   * true.
   */
  async setPassword(
    id: string | Types.ObjectId,
    next: string,
    mustChangePassword = true,
  ): Promise<UserDocument> {
    const user = await this.findByIdWithPassword(id);
    user.passwordHash = await this.hashPassword(next);
    user.mustChangePassword = mustChangePassword;
    await user.save();
    return user;
  }

  async recordLogin(id: string | Types.ObjectId): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } });
  }

  /* ------------------------------- referrals ------------------------------- */

  /** Everyone who signed up on this user's code. */
  async listInvitees(referrerId: string | Types.ObjectId): Promise<UserDocument[]> {
    return this.userModel.find({ referredBy: referrerId }).sort({ createdAt: -1 });
  }

  async grantFreeOrder(id: string | Types.ObjectId): Promise<void> {
    await this.userModel.updateOne(
      { _id: id },
      { $inc: { freeOrders: 1 }, $set: { freeOrderEarnedOn: new Date() } },
    );
  }

  /** Spends one, and reports whether there was one to spend. */
  async consumeFreeOrder(id: string | Types.ObjectId): Promise<boolean> {
    const result = await this.userModel.updateOne(
      { _id: id, freeOrders: { $gt: 0 } },
      { $inc: { freeOrders: -1 } },
    );
    return result.modifiedCount > 0;
  }

  /**
   * "AM-4K9P" — the holder's initials and four random characters,
   * retried on the vanishingly rare collision rather than assumed
   * unique, because the field carries a unique index.
   */
  private async mintReferralCode(name: string): Promise<string> {
    const stem = (initials(name) || 'TMM').padEnd(2, 'X');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let suffix = '';
      for (let i = 0; i < 4; i += 1) {
        suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      const code = stem + '-' + suffix;
      if (!(await this.userModel.exists({ referralCode: code }))) {
        return code;
      }
    }
    return stem + '-' + Date.now().toString(36).toUpperCase().slice(-4);
  }
}

function cleanPatch<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

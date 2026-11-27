import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { FilterQuery, Model, Types } from 'mongoose';

import { Paginated, paginate } from '../../common/dto/pagination.dto';
import { InvoiceStatus, OPEN_STATUSES } from '../../common/enums/order.enum';
import { Role } from '../../common/enums/role.enum';
import { initials } from '../../common/utils/format.util';
import { joinName, nameParts, splitName } from '../../common/utils/name.util';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { User, UserDocument } from './schemas/user.schema';

/** One customer's order history, summarised for the admin directory. */
export interface CustomerOrderStats {
  ordersCount: number;
  openOrders: number;
  lifetimeSpend: number;
  prefersWhatsapp: boolean;
  everRequestedV62: boolean;
  latestOrder: { id: string; orderNumber: string; reg: string; status: string; placedAt: string } | null;
}

export interface CreateUserInput {
  /** Give a first and last name, or one whole name to be split. */
  firstName?: string;
  lastName?: string;
  name?: string;
  email: string;
  password: string;
  role: Role;
  phone?: string;
  address?: string;
  city?: string;
  postcode?: string;
  supplier?: Types.ObjectId | string | null;
  referredByCode?: string;
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

    const parts =
      input.firstName || input.lastName
        ? { firstName: (input.firstName ?? '').trim(), lastName: (input.lastName ?? '').trim() }
        : splitName(input.name);
    const name = joinName(parts.firstName, parts.lastName);
    if (!name) {
      throw new BadRequestException('Please tell us your name.');
    }

    const user = await this.userModel.create({
      name,
      firstName: parts.firstName,
      lastName: parts.lastName,
      email,
      passwordHash: await this.hashPassword(input.password),
      role: input.role,
      phone: input.phone ?? '',
      address: input.address ?? '',
      city: input.city ?? '',
      postcode: input.postcode ?? '',
      supplier: input.supplier ? new Types.ObjectId(input.supplier) : null,
      referralCode: input.role === Role.Customer ? await this.mintReferralCode(name) : undefined,
      referredBy: referrer?._id ?? null,
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
      latestOrder: { id: Types.ObjectId; orderNumber: string; reg: string; status: string; placedAt: Date };
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
            $first: {
              id: '$_id',
              orderNumber: '$orderNumber',
              reg: '$reg',
              status: '$status',
              placedAt: '$placedAt',
            },
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
            reg: row.latestOrder.reg,
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
    patch: Partial<
      Pick<User, 'name' | 'firstName' | 'lastName' | 'email' | 'phone' | 'address' | 'city' | 'postcode'>
    >,
  ): Promise<UserDocument> {
    const next = { ...patch };

    /*
     * The parts and the whole name always move together. Changing one
     * part keeps the other as it was; an older app build that still
     * sends one whole name has it split.
     */
    if (next.firstName !== undefined || next.lastName !== undefined) {
      const current = await this.userModel.findById(id).select('name firstName lastName').lean();
      if (!current) {
        throw new NotFoundException('That account no longer exists.');
      }
      const parts = nameParts(current);
      next.firstName = next.firstName ?? parts.firstName;
      next.lastName = next.lastName ?? parts.lastName;
      next.name = joinName(next.firstName, next.lastName);
    } else if (next.name !== undefined) {
      Object.assign(next, splitName(next.name));
      next.name = joinName(next.firstName, next.lastName);
    }
    if (next.name !== undefined && !next.name) {
      throw new BadRequestException('Please tell us your name.');
    }

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

  /**
   * A customer changing their own password, from Settings. The current
   * one has to be right: a phone left unlocked is not enough to take
   * the account over.
   */
  async changePassword(id: string | Types.ObjectId, current: string, next: string): Promise<void> {
    const user = await this.findByIdWithPassword(id);
    if (!(await bcrypt.compare(current, user.passwordHash))) {
      throw new BadRequestException('Your current password is not correct.');
    }
    if (await bcrypt.compare(next, user.passwordHash)) {
      throw new BadRequestException('Your new password must be different from your current one.');
    }
    user.passwordHash = await this.hashPassword(next);
    await user.save();
  }

  /**
   * Sets a password without knowing the old one: the admin generating a
   * new one for a supplier's sign-in, or a customer who has proved who
   * they are with an emailed code (AuthService.resetPassword). Suppliers
   * cannot change their own; a supplier who loses theirs asks the admin
   * for a new one.
   */
  async setPassword(id: string | Types.ObjectId, next: string): Promise<UserDocument> {
    const user = await this.findByIdWithPassword(id);
    user.passwordHash = await this.hashPassword(next);
    await user.save();
    return user;
  }

  async recordLogin(id: string | Types.ObjectId): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } });
  }

  /** Every account holding a role — the admins, for a push to all of them. */
  async listByRole(role: Role): Promise<UserDocument[]> {
    return this.userModel.find({ role, active: true }).sort({ createdAt: 1 });
  }

  /* --------------------------------- devices -------------------------------- */

  /**
   * Remembers a phone to push to.
   *
   * Taken off whoever held it first: a token identifies an app install,
   * not a person, and the supplier app is shared ground — an admin who
   * signs in on a supplier's handset must not keep receiving that
   * supplier's orders afterwards, nor the other way round. Whoever
   * signed in last owns it.
   */
  async registerDevice(
    id: string | Types.ObjectId,
    token: string,
    platform: 'ios' | 'android',
  ): Promise<void> {
    await this.userModel.updateMany(
      { 'deviceTokens.token': token },
      { $pull: { deviceTokens: { token } } },
    );
    await this.userModel.updateOne(
      { _id: id },
      { $push: { deviceTokens: { token, platform, registeredAt: new Date() } } },
    );
  }

  /** Signing out, or a token Firebase has told us is dead. */
  async forgetDevices(tokens: string[]): Promise<void> {
    if (tokens.length === 0) {
      return;
    }
    await this.userModel.updateMany(
      { 'deviceTokens.token': { $in: tokens } },
      { $pull: { deviceTokens: { token: { $in: tokens } } } },
    );
  }

  /** The tokens to send to, de-duplicated — two accounts can share a phone. */
  async deviceTokensFor(ids: (string | Types.ObjectId)[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const users = await this.userModel
      .find({ _id: { $in: ids.map(id => new Types.ObjectId(id)) } })
      .select('deviceTokens');
    return [...new Set(users.flatMap(user => user.deviceTokens.map(device => device.token)))];
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

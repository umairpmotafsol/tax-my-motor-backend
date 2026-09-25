import { UserDocument } from './schemas/user.schema';
import { CustomerOrderStats } from './users.service';

/**
 * What a user looks like over the wire. Built by hand rather than by
 * stripping fields off the document, so a field added to the schema is
 * private until somebody decides to publish it.
 */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  supplierId: string | null;
  address: string;
  city: string;
  postcode: string;
  referralCode: string | null;
  freeOrders: number;
  /** Still on an admin-issued password — the app asks them to replace it. */
  mustChangePassword: boolean;
  createdAt: string | null;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    supplierId: user.supplier ? String(user.supplier) : null,
    address: user.address,
    city: user.city,
    postcode: user.postcode,
    referralCode: user.referralCode ?? null,
    freeOrders: user.freeOrders,
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: toIso((user as unknown as { createdAt?: Date }).createdAt),
  };
}

/**
 * The customer as the admin portal lists them: who they are, plus the
 * order-book summary the directory card shows (order count, spend,
 * channel preference, latest order) — no referral balance or account
 * state, which belong to the customer's own account view.
 */
export interface AdminCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  joinedOn: string | null;
  ordersCount: number;
  openOrders: number;
  lifetimeSpend: number;
  prefersWhatsapp: boolean;
  everRequestedV62: boolean;
  latestOrder: { id: string; orderNumber: string; status: string; placedAt: string } | null;
}

const EMPTY_STATS: CustomerOrderStats = {
  ordersCount: 0,
  openOrders: 0,
  lifetimeSpend: 0,
  prefersWhatsapp: false,
  everRequestedV62: false,
  latestOrder: null,
};

export function toAdminCustomer(user: UserDocument, stats?: CustomerOrderStats): AdminCustomer {
  const summary = stats ?? EMPTY_STATS;
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    city: user.city,
    joinedOn: toIso((user as unknown as { createdAt?: Date }).createdAt),
    ...summary,
  };
}

function toIso(date?: Date | null): string | null {
  return date ? new Date(date).toISOString() : null;
}

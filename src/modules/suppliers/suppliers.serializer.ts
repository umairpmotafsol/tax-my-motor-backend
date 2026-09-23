import { ORDER_TYPE_LABEL } from '../../common/enums/order.enum';
import { formatOrderDate } from '../../common/utils/format.util';
import { UserDocument } from '../users/schemas/user.schema';
import { SupplierDocument } from './schemas/supplier.schema';

export function toSupplier(supplier: SupplierDocument) {
  return {
    id: String(supplier._id),
    name: supplier.name,
    company: supplier.company,
    contact: supplier.contact,
    email: supplier.email,
    phone: supplier.phone,
    region: supplier.region,
    status: supplier.status,
    orderTypes: supplier.orderTypes,
    orderTypeLabels: supplier.orderTypes.map(type => ORDER_TYPE_LABEL[type]),
    since: formatOrderDate(new Date(supplier.since)),
    sinceAt: new Date(supplier.since).toISOString(),
  };
}

/** The short form the supplier app shows for the signed-in supplier. */
export function toSupplierProfile(supplier: SupplierDocument) {
  return {
    id: String(supplier._id),
    name: supplier.name,
    company: supplier.company,
    status: supplier.status,
    orderTypes: supplier.orderTypes,
  };
}

/**
 * A supplier's sign-in as the admin portal lists it: who it belongs to,
 * and whether it has ever been used. Never the password hash — the only
 * time a password is readable at all is the moment it is generated, in
 * the response to the request that generated it.
 */
export function toSupplierLogin(user: UserDocument) {
  const createdAt = (user as unknown as { createdAt?: Date }).createdAt ?? null;
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    supplierId: user.supplier ? String(user.supplier) : null,
    lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
    /** Never signed in: the first password is still the one the admin handed over. */
    hasSignedIn: Boolean(user.lastLoginAt),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
  };
}

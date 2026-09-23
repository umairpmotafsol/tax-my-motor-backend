import { BankReviewStatus } from '../../common/enums/bank.enum';
import {
  CommunicationMethod,
  InvoiceStatus,
  ORDER_TYPE_LABEL,
  OrderStatus,
} from '../../common/enums/order.enum';
import { decryptField, maskAccountNumber } from '../../common/utils/crypto.util';
import { OrderDocument } from './schemas/order.schema';

/**
 * Three views of one order.
 *
 * Who may see what is decided here rather than in each app, because a
 * field left off a screen is still on the wire — and the mandate
 * details in particular are worth more than the screen they appear on.
 *
 *   customer  their own order, their own mandate.
 *   supplier  the job: order number, plate, vehicle, and on a Direct
 *             Debit order the mandate they have to check. Not the
 *             customer's name or home address — a supplier raises an
 *             invoice against an order number, and who owns the car
 *             tells them nothing they act on.
 *   admin     everything, because the admin is the one who has to
 *             contact the customer.
 */

export interface SupplierRef {
  id: string;
  name: string;
  company: string;
}

type SupplierLookup = Map<string, { name: string; company: string }>;

/* ------------------------------ shared pieces ------------------------------ */

function iso(date?: Date | null): string | null {
  return date ? new Date(date).toISOString() : null;
}

/**
 * Where to fetch the invoice photo.
 *
 * A hosted copy wins, because it is the only one that works everywhere
 * it has to: an `<Image>` in the app with no auth header, and — once an
 * admin sends it — WhatsApp, which follows the link as nobody at all.
 * Without Cloudinary configured there is no such copy, and this falls
 * back to the authenticated API route, which the apps can still read
 * with their bearer token and the customer still cannot.
 */
function invoiceHref(order: OrderDocument): string | null {
  if (!order.invoice) {
    return null;
  }
  return order.invoice.url || '/api/invoices/' + String(order._id) + '/file';
}

function supplierRef(order: OrderDocument, lookup?: SupplierLookup): SupplierRef | null {
  if (!order.supplier) {
    return null;
  }
  const id = String(order.supplier);
  const found = lookup?.get(id);
  return { id, name: found?.name ?? 'Unknown supplier', company: found?.company ?? '' };
}

function baseOrder(order: OrderDocument) {
  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    reg: order.reg,
    vehicleModel: order.vehicle.model,
    vehicle: {
      make: order.vehicle.make,
      variant: order.vehicle.variant,
      model: order.vehicle.model,
      colour: order.vehicle.colour,
      taxClass: order.vehicle.taxClass,
    },
    orderType: order.orderType,
    orderTypeLabel: ORDER_TYPE_LABEL[order.orderType],
    plan: order.plan,
    items: order.items.map(item => ({ name: item.name, qty: item.qty })),
    total: order.total,
    status: order.status,
    invoiceStatus: order.invoiceStatus,
    communicationMethod: order.communicationMethod,
    whatsappRequested: order.whatsappRequested,
    v62Requested: order.v62Requested,
    placedAt: iso(order.placedAt),
    orderDate: iso(order.placedAt),
  };
}

/** The mandate, decrypted. Only ever reached through a view that may show it. */
function bankDetails(order: OrderDocument, full: boolean) {
  if (!order.bank) {
    return null;
  }
  return {
    accountHolder: order.bank.accountHolder,
    accountNumber: full
      ? decryptField(order.bank.accountNumber)
      : maskAccountNumber(decryptField(order.bank.accountNumber)),
    sortCode: order.bank.sortCode,
    dateOfBirth: full ? decryptField(order.bank.dateOfBirth) : '••/••/••••',
  };
}

/** Never the Stripe intent id — that's an internal reference, not customer-facing. */
function paymentSummary(order: OrderDocument) {
  if (!order.payment) {
    return null;
  }
  return {
    provider: order.payment.provider,
    amount: order.payment.amount,
    currency: order.payment.currency,
    paidAt: iso(order.payment.paidAt),
  };
}

function bankReview(order: OrderDocument) {
  if (!order.bankReview) {
    return null;
  }
  return {
    status: order.bankReview.status,
    flagged: order.bankReview.flagged,
    notes: order.bankReview.notes.map(note => ({
      at: iso(note.at),
      by: note.by,
      fields: note.fields,
      message: note.message,
    })),
  };
}

/* --------------------------------- customer -------------------------------- */

export function toCustomerOrder(order: OrderDocument) {
  return {
    ...baseOrder(order),
    pricing: order.pricing,
    payment: paymentSummary(order),
    /*
     * The customer's own mandate, in full — they typed it, and they are
     * the one who has to correct whatever the supplier flagged.
     */
    bank: bankDetails(order, true),
    bankReview: bankReview(order),
    v62: order.v62 ?? null,
    /* Which supplier is handling it is not the customer's concern. */
    invoiceAvailable: order.invoiceStatus === InvoiceStatus.Sent,
    /*
     * The customer's own copy, once it has been sent. Withheld before
     * that: an invoice the supplier has uploaded but nobody has sent is
     * not yet the customer's to read.
     */
    invoiceUrl: order.invoiceStatus === InvoiceStatus.Sent ? invoiceHref(order) : null,
    invoiceSentAt: iso(order.invoiceSentAt),
    deliveredAt: iso(order.deliveredAt),
    timeline: order.timeline.map(e => ({ at: iso(e.at), title: e.title, detail: e.detail })),
  };
}

/* --------------------------------- supplier -------------------------------- */

/**
 * The supplier app's own status vocabulary. It has no acceptance step
 * and no separate "ready" state: an order is waiting on an invoice,
 * overdue, waiting on an admin to send it, or done.
 */
export type SupplierOrderStatus =
  | 'awaiting_invoice'
  | 'overdue'
  | 'awaiting_whatsapp'
  | 'completed';

export function toSupplierStatus(order: OrderDocument): SupplierOrderStatus {
  if (order.invoiceStatus === InvoiceStatus.Sent || order.deliveredAt) {
    return 'completed';
  }
  if (order.invoiceStatus === InvoiceStatus.Uploaded || order.invoiceStatus === InvoiceStatus.Ready) {
    /*
     * An email order is finished the moment the invoice is uploaded —
     * the supplier's own system sends it. Only a WhatsApp order waits
     * on an admin.
     */
    return order.communicationMethod === CommunicationMethod.WhatsApp
      ? 'awaiting_whatsapp'
      : 'completed';
  }
  return order.status === OrderStatus.Overdue ? 'overdue' : 'awaiting_invoice';
}

export function toSupplierOrder(order: OrderDocument) {
  const base = baseOrder(order);
  return {
    ...base,
    status: toSupplierStatus(order),
    /* The supplier app tracks upload, not the admin's send-and-review states. */
    invoiceStatus:
      order.invoiceStatus === InvoiceStatus.Pending ? InvoiceStatus.Pending : InvoiceStatus.Uploaded,
    assignedAt: iso(order.assignedAt),
    turnStartedAt: iso(order.turnStartedAt),
    /** When this order goes overdue. The countdown reads from here. */
    dueAt: iso(order.dueAt),
    invoiceUploadedAt: iso(order.invoiceUploadedAt),
    deliveredAt: iso(order.deliveredAt),
    invoicePhoto: order.invoice
      ? { uri: invoiceHref(order), capturedAt: iso(order.invoice.capturedAt) }
      : null,
    /*
     * The mandate is the one personal thing a supplier does see: they
     * cannot check an account holder's name without being shown it.
     */
    bank: bankDetails(order, true),
    bankReview: bankReview(order),
    /*
     * The V62 without its keeper block. The vehicle is what a supplier
     * needs; the keeper's name and address belong to the admin who
     * files the form.
     */
    v62: order.v62
      ? {
          registrationNumber: order.v62.registrationNumber,
          makeModel: [order.v62.make, order.v62.model].filter(Boolean).join(' '),
          colour: order.v62.colour,
          taxationClass: order.v62.taxClass,
        }
      : null,
  };
}

/* ---------------------------------- admin ---------------------------------- */

export function toAdminOrder(order: OrderDocument, suppliers?: SupplierLookup) {
  return {
    ...baseOrder(order),
    customer: {
      id: String(order.customer),
      name: order.customerSnapshot.name,
      email: order.customerSnapshot.email,
      phone: order.customerSnapshot.phone,
    },
    supplier: supplierRef(order, suppliers),
    deliveryAddress: order.deliveryAddress,
    pricing: order.pricing,
    payment: paymentSummary(order),
    invoiceFileName: order.invoice?.fileName ?? null,
    invoiceUrl: invoiceHref(order),
    /*
     * True when the URL above is one the customer's phone can open on
     * its own. The admin's Send button needs to know: an invoice with
     * no hosted copy cannot be attached to a WhatsApp message, and
     * saying so beats sending a link that answers 401.
     */
    invoiceShareable: order.invoice?.provider === 'cloudinary',
    /*
     * Masked in the admin view. An admin coordinates the order; the
     * supplier is the one who checks the mandate against a statement,
     * so the full number has an audience of one.
     */
    bank: bankDetails(order, false),
    bankReview: bankReview(order),
    v62: order.v62 ?? null,
    v62PrintedAt: iso(order.v62PrintedAt),
    assignedAt: iso(order.assignedAt),
    turnStartedAt: iso(order.turnStartedAt),
    dueAt: iso(order.dueAt),
    invoiceUploadedAt: iso(order.invoiceUploadedAt),
    invoiceReadyAt: iso(order.invoiceReadyAt),
    invoiceSentAt: iso(order.invoiceSentAt),
    deliveredAt: iso(order.deliveredAt),
    reassignedFrom: order.reassignedFrom ? String(order.reassignedFrom) : null,
    timeline: order.timeline.map(e => ({
      at: iso(e.at),
      actor: e.actor,
      title: e.title,
      detail: e.detail,
      tone: e.tone,
    })),
  };
}

/** The mandate in full, for the supplier's review screen only. */
export function toBankReviewView(order: OrderDocument) {
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    reg: order.reg,
    vehicleModel: order.vehicle.model,
    bank: bankDetails(order, true),
    bankReview: bankReview(order),
    awaitingReview: order.bankReview?.status === BankReviewStatus.Submitted,
  };
}

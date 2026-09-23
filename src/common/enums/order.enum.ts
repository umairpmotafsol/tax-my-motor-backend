/**
 * The order vocabulary, shared by the three front ends.
 *
 * The status is DERIVED from the lifecycle timestamps and the invoice
 * status rather than stored as an independent field, so a record can
 * never contradict its own history. `OrdersService.deriveStatus` is the
 * one place that mapping lives.
 */
export enum OrderStatus {
  /** No active supplier holds this order type, so nobody was assigned. */
  Unassigned = 'unassigned',
  /** Assigned; the supplier's upload window is running. */
  AwaitingSupplier = 'awaiting_supplier',
  /** The window closed without an invoice. */
  Overdue = 'overdue',
  /** The supplier photographed and uploaded the invoice. */
  InvoiceUploaded = 'invoice_uploaded',
  /** Reviewed and cleared to go out. WhatsApp orders wait here for an admin. */
  InvoiceReady = 'invoice_ready',
  /** Delivered to the customer. Terminal. */
  InvoiceSent = 'invoice_sent',
}

/** Statuses that still need somebody to act. */
export const OPEN_STATUSES: OrderStatus[] = [
  OrderStatus.Unassigned,
  OrderStatus.AwaitingSupplier,
  OrderStatus.Overdue,
  OrderStatus.InvoiceUploaded,
  OrderStatus.InvoiceReady,
];

export enum InvoiceStatus {
  Pending = 'pending',
  Uploaded = 'uploaded',
  Ready = 'ready',
  Sent = 'sent',
}

/**
 * What the customer bought. This is what the routing rules match on, so
 * it has to stay a small closed set: a plan maps onto exactly one type.
 */
export enum OrderType {
  Tax6 = 'tax6',
  Tax12 = 'tax12',
  DirectDebit = 'dd',
}

export const ORDER_TYPES: OrderType[] = [OrderType.Tax6, OrderType.Tax12, OrderType.DirectDebit];

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  [OrderType.Tax6]: '6 Months',
  [OrderType.Tax12]: '12 Months',
  [OrderType.DirectDebit]: 'Direct Debit',
};

/**
 * How the invoice reaches the customer. Email leaves the supplier's own
 * system on upload; WhatsApp is handed to an admin to send.
 */
export enum CommunicationMethod {
  WhatsApp = 'whatsapp',
  Email = 'email',
}

export enum SupplierStatus {
  Active = 'active',
  /** Temporarily out of rotation — same routing effect as Inactive, but says why. */
  Holiday = 'holiday',
  Inactive = 'inactive',
}

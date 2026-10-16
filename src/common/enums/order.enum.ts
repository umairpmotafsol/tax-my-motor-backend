/**
 * The order vocabulary, shared by the three front ends.
 *
 * The status is moved only by OrdersService, alongside the lifecycle
 * timestamp for the same step, so a record never contradicts its own
 * history.
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
  /** Called off by an admin after it was flagged. Terminal. */
  Cancelled = 'cancelled',
}

/** Statuses that still need somebody to act. */
export const OPEN_STATUSES: OrderStatus[] = [
  OrderStatus.Unassigned,
  OrderStatus.AwaitingSupplier,
  OrderStatus.Overdue,
  OrderStatus.InvoiceUploaded,
  OrderStatus.InvoiceReady,
];

/** Statuses nobody will act on again. */
export const CLOSED_STATUSES: OrderStatus[] = [OrderStatus.InvoiceSent, OrderStatus.Cancelled];

/**
 * Who put the flag on an order. A supplier raises one by hand, on any
 * order they cannot get through on their own; the system raises one for
 * them when a Direct Debit mandate has gone round the review loop too
 * many times (see BANK_ROUNDS_BEFORE_FLAG).
 */
export enum OrderFlagSource {
  Supplier = 'supplier',
  System = 'system',
}

/**
 * How a flag ended. Three are an admin's answer — sent back: the order
 * is the supplier's again, with the admin's comment; completed: the
 * admin closed it as done; cancelled: the admin called it off. The
 * fourth is the supplier's own: they uploaded the invoice after all,
 * which finishes their part and leaves nothing for an admin to decide.
 */
export enum OrderFlagResolution {
  SentBack = 'sent_back',
  Completed = 'completed',
  Cancelled = 'cancelled',
  Invoiced = 'invoiced',
}

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

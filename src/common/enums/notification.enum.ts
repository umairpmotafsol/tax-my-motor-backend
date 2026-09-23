/**
 * Admin notifications. The type decides the icon, tone and copy in the
 * portal, and mirrors the moments in the flows where the spec says
 * "admin sees ...".
 */
export enum NotificationType {
  SupplierOverdue = 'supplier_overdue',
  V62Submitted = 'v62_submitted',
  WhatsappSendRequired = 'whatsapp_send_required',
  WhatsappRequested = 'whatsapp_requested',
  Unassigned = 'unassigned',
  BankChangesRequested = 'bank_changes_requested',
  BankApproved = 'bank_approved',
}

export const NOTIFICATION_META: Record<
  NotificationType,
  { label: string; tone: string; icon: string }
> = {
  [NotificationType.SupplierOverdue]: { label: 'Invoice Overdue', tone: 'red', icon: 'alert' },
  [NotificationType.V62Submitted]: {
    label: 'V62 Submitted for Printing',
    tone: 'orange',
    icon: 'file',
  },
  [NotificationType.WhatsappSendRequired]: {
    label: 'Ready to Send via WhatsApp',
    tone: 'green',
    icon: 'whatsapp',
  },
  [NotificationType.WhatsappRequested]: {
    label: 'WhatsApp Delivery Requested',
    tone: 'green',
    icon: 'whatsapp',
  },
  [NotificationType.Unassigned]: {
    label: 'Order Could Not Be Assigned',
    tone: 'red',
    icon: 'alert',
  },
  [NotificationType.BankChangesRequested]: {
    label: 'Bank Details Sent Back',
    tone: 'orange',
    icon: 'alert',
  },
  [NotificationType.BankApproved]: { label: 'Mandate Approved', tone: 'green', icon: 'file' },
};

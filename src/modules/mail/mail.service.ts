import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MAIL_TRANSPORT, MailSender } from './mail.provider';

/** Everything the invoice email says, already formatted for a person to read. */
export interface InvoiceEmail {
  to: string;
  customerName: string;
  orderNumber: string;
  /** "AB12 CDE". */
  reg: string;
  /** "Ford Fiesta 1.0 EcoBoost" — may be empty. */
  vehicle: string;
  /** "12-month tax + V62". */
  plan: string;
  /** "£240.00". */
  total: string;
  /** The invoice photo: a hosted URL or a path on the local disk. */
  attachment: { fileName: string; path: string; mimeType: string };
  /** The hosted copy, offered as a link beside the attachment. Null when there is none. */
  link: string | null;
}

/** The receipt for a "Reg > VIN" purchase. */
export interface VinReceiptEmail {
  to: string;
  customerName: string;
  /** "AB12 CDE". */
  reg: string;
  /** "Ford Fiesta 1.0 EcoBoost" — may be empty. */
  vehicle: string;
  vin: string;
  /** "£0.99". */
  total: string;
}

/** The receipt for a number plates order. */
export interface PlateReceiptEmail {
  to: string;
  customerName: string;
  /** "AB12 CDE". */
  reg: string;
  /** "Ford Fiesta 1.0 EcoBoost" — may be empty. */
  vehicle: string;
  /** Where the plates are going, as one line. */
  address: string;
  /** "£20.00". */
  total: string;
}

/** The note to the admins that a number plates order is waiting for them. */
export interface PlateOrderAlertEmail {
  to: string[];
  reg: string;
  vehicle: string;
  customerName: string;
  phone: string;
  email: string;
  address: string;
  total: string;
}

/** The note to the admins that a customer has placed a tax order. */
export interface NewOrderAlertEmail {
  to: string[];
  orderNumber: string;
  reg: string;
  vehicle: string;
  /** "12-month tax + V62". */
  plan: string;
  customerName: string;
  phone: string;
  email: string;
  /** The supplier it went to, or null when nobody could take it. */
  supplier: string | null;
  /** "£240.00". */
  total: string;
}

/** Whether it went, and if not, a sentence an admin can act on. */
export type MailResult = { sent: true } | { sent: false; reason: string };

/**
 * Outgoing email, over SMTP.
 *
 * One rule holds throughout: **nothing thrown.** An email is sent on the
 * back of something that has already happened — an invoice uploaded, an
 * order completed — and a mail server being unreachable must not undo
 * it. Every path returns a result instead, and the caller records it,
 * because the other half of the rule is that a failure is never
 * reported as a success.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailSender | null,
    private readonly config: ConfigService,
  ) {}

  /** False when there are no SMTP settings. */
  get enabled(): boolean {
    return this.transport !== null;
  }

  /** The customer's invoice, attached, with the order it belongs to. */
  async sendInvoice(mail: InvoiceEmail): Promise<MailResult> {
    if (!this.transport) {
      return { sent: false, reason: 'Email is not set up on the server.' };
    }
    if (!mail.to) {
      return { sent: false, reason: 'There is no email address on this order.' };
    }

    const greeting = mail.customerName ? 'Hi ' + mail.customerName.split(' ')[0] + ',' : 'Hello,';
    const rows: Array<[string, string]> = [
      ['Order', mail.orderNumber],
      ['Vehicle', [mail.reg, mail.vehicle].filter(Boolean).join(' — ')],
      ['Cover', mail.plan],
      ['Total', mail.total],
    ];

    const text = [
      greeting,
      '',
      'Your vehicle tax for ' + mail.reg + ' is sorted. Your invoice is attached.',
      '',
      ...rows.map(([label, value]) => label + ': ' + value),
      '',
      ...(mail.link ? ['You can also open your invoice here: ' + mail.link, ''] : []),
      'Keep it for your records.',
      '',
      'TaxMyMotor',
    ].join('\n');

    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#12171e;max-width:520px">' +
      '<p>' + escapeHtml(greeting) + '</p>' +
      '<p>Your vehicle tax for <strong>' + escapeHtml(mail.reg) + '</strong> is sorted. ' +
      'Your invoice is attached.</p>' +
      '<table style="border-collapse:collapse;margin:16px 0">' +
      rows
        .map(
          ([label, value]) =>
            '<tr><td style="padding:4px 18px 4px 0;color:#5b6572">' +
            escapeHtml(label) +
            '</td><td style="padding:4px 0"><strong>' +
            escapeHtml(value) +
            '</strong></td></tr>',
        )
        .join('') +
      '</table>' +
      (mail.link
        ? '<p><a href="' + escapeHtml(mail.link) + '">Open your invoice</a></p>'
        : '') +
      '<p>Keep it for your records.</p>' +
      '<p>TaxMyMotor</p>' +
      '</div>';

    try {
      await this.transport.sendMail({
        from: this.config.get<string>('mail.from'),
        to: mail.to,
        subject: 'Your vehicle tax invoice — ' + mail.reg,
        text,
        html,
        attachments: [
          {
            filename: mail.attachment.fileName,
            path: mail.attachment.path,
            contentType: mail.attachment.mimeType,
          },
        ],
      });
      return { sent: true };
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      this.logger.error('Invoice email for ' + mail.orderNumber + ' was not sent: ' + said);
      return { sent: false, reason: describeFailure(error) };
    }
  }

  /** The customer's receipt for a VIN they bought, with the VIN on it. */
  async sendVinReceipt(mail: VinReceiptEmail): Promise<MailResult> {
    if (!this.transport) {
      return { sent: false, reason: 'Email is not set up on the server.' };
    }
    if (!mail.to) {
      return { sent: false, reason: 'There is no email address on this account.' };
    }

    const greeting = mail.customerName ? 'Hi ' + mail.customerName.split(' ')[0] + ',' : 'Hello,';
    const rows: Array<[string, string]> = [
      ['Vehicle', [mail.reg, mail.vehicle].filter(Boolean).join(' — ')],
      ['VIN', mail.vin],
      ['Paid', mail.total],
    ];

    const text = [
      greeting,
      '',
      'Thanks for your payment. Here is the VIN for ' + mail.reg + '.',
      '',
      ...rows.map(([label, value]) => label + ': ' + value),
      '',
      'It is also saved in the Orders tab of the app.',
      '',
      'TaxMyMotor',
    ].join('\n');

    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#12171e;max-width:520px">' +
      '<p>' + escapeHtml(greeting) + '</p>' +
      '<p>Thanks for your payment. Here is the VIN for <strong>' + escapeHtml(mail.reg) + '</strong>.</p>' +
      '<table style="border-collapse:collapse;margin:16px 0">' +
      rows
        .map(
          ([label, value]) =>
            '<tr><td style="padding:4px 18px 4px 0;color:#5b6572">' +
            escapeHtml(label) +
            '</td><td style="padding:4px 0"><strong>' +
            escapeHtml(value) +
            '</strong></td></tr>',
        )
        .join('') +
      '</table>' +
      '<p>It is also saved in the Orders tab of the app.</p>' +
      '<p>TaxMyMotor</p>' +
      '</div>';

    try {
      await this.transport.sendMail({
        from: this.config.get<string>('mail.from'),
        to: mail.to,
        subject: 'Your VIN receipt — ' + mail.reg,
        text,
        html,
      });
      return { sent: true };
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      this.logger.error('VIN receipt for ' + mail.reg + ' was not sent: ' + said);
      return { sent: false, reason: describeFailure(error) };
    }
  }

  /** The customer's receipt for the number plates they ordered. */
  async sendPlateReceipt(mail: PlateReceiptEmail): Promise<MailResult> {
    const greeting = mail.customerName ? 'Hi ' + mail.customerName.split(' ')[0] + ',' : 'Hello,';
    const rows: Array<[string, string]> = [
      ['Vehicle', [mail.reg, mail.vehicle].filter(Boolean).join(' — ')],
      ['Delivery to', mail.address],
      ['Paid', mail.total],
    ];
    return this.deliver({
      to: mail.to,
      noAddress: 'There is no email address on this order.',
      subject: 'Your number plates order — ' + mail.reg,
      greeting,
      lead: 'Thanks for your order. We have got your number plates order for ' + mail.reg + '.',
      rows,
      close: 'You can follow its progress in the Orders tab of the app.',
      what: 'Number plates receipt for ' + mail.reg,
    });
  }

  /** Tells the admins a number plates order is waiting to be made. */
  async sendPlateOrderAlert(mail: PlateOrderAlertEmail): Promise<MailResult> {
    const rows: Array<[string, string]> = [
      ['Registration', mail.reg],
      ['Vehicle', mail.vehicle || '—'],
      ['Customer', mail.customerName],
      ['Mobile', mail.phone],
      ['Email', mail.email],
      ['Deliver to', mail.address],
      ['Paid', mail.total],
    ];
    return this.deliver({
      to: mail.to.filter(Boolean).join(', '),
      noAddress: 'There is no admin email address to send to.',
      subject: 'New number plates order — ' + mail.reg,
      greeting: 'Hello,',
      lead: 'A new number plates order has been placed and paid for.',
      rows,
      close: 'It is waiting under Number Plates in the admin portal.',
      what: 'Number plates alert for ' + mail.reg,
    });
  }

  /** Tells the admins a customer has placed a tax order, and where it went. */
  async sendNewOrderAlert(mail: NewOrderAlertEmail): Promise<MailResult> {
    const rows: Array<[string, string]> = [
      ['Order', mail.orderNumber],
      ['Registration', mail.reg],
      ['Vehicle', mail.vehicle || '—'],
      ['Cover', mail.plan],
      ['Customer', mail.customerName],
      ['Mobile', mail.phone || '—'],
      ['Email', mail.email || '—'],
      ['Supplier', mail.supplier ?? 'Not assigned'],
      ['Total', mail.total],
    ];
    return this.deliver({
      to: mail.to.filter(Boolean).join(', '),
      noAddress: 'There is no admin email address to send to.',
      subject: 'New order ' + mail.orderNumber + ' — ' + mail.reg,
      greeting: 'Hello,',
      lead: mail.supplier
        ? 'A new order has been placed and sent to ' + mail.supplier + '.'
        : 'A new order has been placed, but no active supplier could take it. It needs assigning.',
      rows,
      close: 'You can follow it under Orders in the admin portal.',
      what: 'New order alert for ' + mail.orderNumber,
    });
  }

  /** A plain receipt-style message: a lead line, a table of rows, a closing line. */
  private async deliver(mail: {
    to: string;
    noAddress: string;
    subject: string;
    greeting: string;
    lead: string;
    rows: Array<[string, string]>;
    close: string;
    /** What the log calls it if it fails. */
    what: string;
  }): Promise<MailResult> {
    if (!this.transport) {
      return { sent: false, reason: 'Email is not set up on the server.' };
    }
    if (!mail.to) {
      return { sent: false, reason: mail.noAddress };
    }

    const text = [
      mail.greeting,
      '',
      mail.lead,
      '',
      ...mail.rows.map(([label, value]) => label + ': ' + value),
      '',
      mail.close,
      '',
      'TaxMyMotor',
    ].join('\n');

    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#12171e;max-width:520px">' +
      '<p>' + escapeHtml(mail.greeting) + '</p>' +
      '<p>' + escapeHtml(mail.lead) + '</p>' +
      '<table style="border-collapse:collapse;margin:16px 0">' +
      mail.rows
        .map(
          ([label, value]) =>
            '<tr><td style="padding:4px 18px 4px 0;color:#5b6572;vertical-align:top">' +
            escapeHtml(label) +
            '</td><td style="padding:4px 0"><strong>' +
            escapeHtml(value) +
            '</strong></td></tr>',
        )
        .join('') +
      '</table>' +
      '<p>' + escapeHtml(mail.close) + '</p>' +
      '<p>TaxMyMotor</p>' +
      '</div>';

    try {
      await this.transport.sendMail({
        from: this.config.get<string>('mail.from'),
        to: mail.to,
        subject: mail.subject,
        text,
        html,
      });
      return { sent: true };
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      this.logger.error(mail.what + ' was not sent: ' + said);
      return { sent: false, reason: describeFailure(error) };
    }
  }
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * One sentence for the order's timeline. The raw SMTP error stays in the
 * log: it can carry a server's banner or an address, and an admin
 * reading an order needs to know what to do, not what the socket said.
 */
function describeFailure(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? '';
  const status = (error as { responseCode?: number } | null)?.responseCode ?? 0;
  if (code === 'EAUTH') {
    return 'The mail server rejected our sign-in.';
  }
  if (code === 'EENVELOPE' || (status >= 550 && status <= 553)) {
    return 'The mail server rejected the customer’s email address.';
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(code)) {
    return 'The mail server could not be reached.';
  }
  if (code === 'ENOENT' || code === 'ESTREAM') {
    return 'The invoice file could not be attached.';
  }
  return 'The mail server did not accept the message.';
}

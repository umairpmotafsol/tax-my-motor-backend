/**
 * The invoice email, without a mail server: the transport is stood in
 * for, so what is checked is what would have been sent and — the part
 * that matters — that a send which failed is never reported as one
 * that went.
 */
import { InvoiceEmail, MailService } from './mail.service';

const config = { get: (key: string) => (key === 'mail.from' ? 'TaxMyMotor <billing@example.co.uk>' : undefined) };

const INVOICE: InvoiceEmail = {
  to: 'sarah@example.com',
  customerName: 'Sarah Lee',
  orderNumber: 'ORD-1042',
  reg: 'AB12 CDE',
  vehicle: 'Ford Fiesta',
  plan: '12-month tax',
  total: '£240.00',
  attachment: {
    fileName: 'invoice-ORD-1042.jpg',
    path: 'https://res.cloudinary.com/demo/invoice.jpg',
    mimeType: 'image/jpeg',
  },
  link: 'https://res.cloudinary.com/demo/invoice.jpg',
};

const serviceWith = (transport: unknown) => new MailService(transport as never, config as never);

describe('the invoice email', () => {
  it('goes to the customer with the invoice attached', async () => {
    const transport = { sendMail: jest.fn(async (..._a: unknown[]) => ({ messageId: 'm1' })) };

    const result = await serviceWith(transport).sendInvoice(INVOICE);

    expect(result).toEqual({ sent: true });
    const message = transport.sendMail.mock.calls[0][0] as {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
      attachments: Array<{ filename: string; path: string; contentType: string }>;
    };
    expect(message.from).toBe('TaxMyMotor <billing@example.co.uk>');
    expect(message.to).toBe('sarah@example.com');
    expect(message.subject).toBe('Your vehicle tax invoice — AB12 CDE');
    expect(message.text).toContain('Hi Sarah,');
    expect(message.text).toContain('Order: ORD-1042');
    expect(message.text).toContain('Total: £240.00');
    expect(message.html).toContain('Open your invoice');
    expect(message.attachments).toEqual([
      {
        filename: 'invoice-ORD-1042.jpg',
        path: 'https://res.cloudinary.com/demo/invoice.jpg',
        contentType: 'image/jpeg',
      },
    ]);
  });

  it('offers no link when the invoice has no hosted copy', async () => {
    const transport = { sendMail: jest.fn(async (..._a: unknown[]) => ({})) };

    await serviceWith(transport).sendInvoice({ ...INVOICE, link: null });

    const message = transport.sendMail.mock.calls[0][0] as { text: string; html: string };
    expect(message.text).not.toContain('open your invoice here');
    expect(message.html).not.toContain('<a ');
  });

  it('keeps a customer’s name from being read as markup', async () => {
    const transport = { sendMail: jest.fn(async (..._a: unknown[]) => ({})) };

    await serviceWith(transport).sendInvoice({ ...INVOICE, vehicle: '<b>Fiesta</b> & co' });

    const message = transport.sendMail.mock.calls[0][0] as { html: string };
    expect(message.html).toContain('&lt;b&gt;Fiesta&lt;/b&gt; &amp; co');
  });
});

describe('an invoice email that does not go', () => {
  it('says email is off when there are no SMTP settings', async () => {
    const service = serviceWith(null);

    expect(service.enabled).toBe(false);
    expect(await service.sendInvoice(INVOICE)).toEqual({
      sent: false,
      reason: 'Email is not set up on the server.',
    });
  });

  it('says so when the order has no address to send to', async () => {
    const transport = { sendMail: jest.fn() };

    expect(await serviceWith(transport).sendInvoice({ ...INVOICE, to: '' })).toEqual({
      sent: false,
      reason: 'There is no email address on this order.',
    });
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it.each([
    ['EAUTH', undefined, 'The mail server rejected our sign-in.'],
    ['ETIMEDOUT', undefined, 'The mail server could not be reached.'],
    ['EENVELOPE', 550, 'The mail server rejected the customer’s email address.'],
    ['ENOENT', undefined, 'The invoice file could not be attached.'],
    ['EMESSAGE', 451, 'The mail server did not accept the message.'],
  ])('reports a %s failure as a failure, and does not throw', async (code, responseCode, reason) => {
    const transport = {
      sendMail: jest.fn(async () => {
        throw Object.assign(new Error('smtp said no'), { code, responseCode });
      }),
    };

    expect(await serviceWith(transport).sendInvoice(INVOICE)).toEqual({ sent: false, reason });
  });
});

describe('the new order email to the admins', () => {
  const ALERT = {
    to: ['admintesting890@yopmail.com', 'ops@example.co.uk'],
    orderNumber: 'ORD-1042',
    reg: 'AB12 CDE',
    vehicle: 'Ford Fiesta',
    plan: '12-month tax',
    customerName: 'Sarah Lee',
    phone: '07700 900123',
    email: 'sarah@example.com',
    supplier: 'Supplier A',
    total: '£240.00',
  };

  it('goes to every admin with the order and where it went', async () => {
    const transport = { sendMail: jest.fn(async (..._a: unknown[]) => ({})) };

    expect(await serviceWith(transport).sendNewOrderAlert(ALERT)).toEqual({ sent: true });

    const message = transport.sendMail.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(message.to).toBe('admintesting890@yopmail.com, ops@example.co.uk');
    expect(message.subject).toBe('New order ORD-1042 — AB12 CDE');
    expect(message.text).toContain('sent to Supplier A');
    expect(message.text).toContain('Customer: Sarah Lee');
    expect(message.text).toContain('Total: £240.00');
  });

  it('says an order nobody could take needs assigning', async () => {
    const transport = { sendMail: jest.fn(async (..._a: unknown[]) => ({})) };

    await serviceWith(transport).sendNewOrderAlert({ ...ALERT, supplier: null });

    const message = transport.sendMail.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('It needs assigning.');
    expect(message.text).toContain('Supplier: Not assigned');
  });

  it('sends nothing when there is no admin to send to', async () => {
    const transport = { sendMail: jest.fn() };

    expect(await serviceWith(transport).sendNewOrderAlert({ ...ALERT, to: [] })).toEqual({
      sent: false,
      reason: 'There is no admin email address to send to.',
    });
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
});

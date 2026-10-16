/**
 * The download route, over real HTTP: that `/v62.pdf` reaches its own
 * handler rather than the JSON one beside it, that the bytes arrive as a
 * PDF and not wrapped in the `{ success, data }` envelope, and that an
 * order with no V62 is refused rather than answered with an empty form.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { SuppliersService } from '../suppliers/suppliers.service';
import { AdminOrdersController } from './admin-orders.controller';
import { OrdersService } from './orders.service';
import { buildV62Submission } from './v62.builder';

const v62 = buildV62Submission({
  reg: 'DV65YWO',
  data: {
    sameAsTaxDetails: true,
    dateAcquired: '26/09/2018',
    applicantTitle: 'Miss',
    applicantAddress1: '40 California Road',
    applicantCity: 'Carlisle',
    applicantPostcode: 'CA3 0BY',
  },
  vehicle: {
    make: 'Vauxhall',
    variant: '',
    colour: 'Silver',
    vin: 'W0LPF6ED9FG127064',
    taxClass: 'Petrol',
    year: 2015,
  },
  customer: { name: 'Rebecca Scott', phone: '07715816586', email: 'becky@example.co.uk' },
  fee: 40,
});

const orders = {
  findScoped: jest.fn(),
};

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminOrdersController],
    providers: [
      { provide: OrdersService, useValue: orders },
      { provide: SuppliersService, useValue: { nameMap: async () => new Map() } },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.init();
});

afterAll(() => app.close());

describe('GET /admin/orders/:id/v62.pdf', () => {
  it('sends the filled-in form as a PDF to save', async () => {
    orders.findScoped.mockResolvedValue({
      _id: 'order-1',
      orderNumber: 'ORD-1042',
      v62Requested: true,
      v62,
      v62PrintedAt: null,
    });

    const res = await request(app.getHttpServer())
      .get('/admin/orders/order-1/v62.pdf')
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="V62-DV65YWO-ORD-1042.pdf"',
    );
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((res.body as Buffer).length).toBeGreaterThan(100_000);
    expect(orders.findScoped).toHaveBeenCalledWith('order-1', undefined);
  });

  it('still answers the JSON view at the path without the extension', async () => {
    orders.findScoped.mockResolvedValue({
      _id: 'order-1',
      orderNumber: 'ORD-1042',
      v62Requested: true,
      v62,
      v62PrintedAt: null,
    });

    const res = await request(app.getHttpServer()).get('/admin/orders/order-1/v62');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { orderNumber: 'ORD-1042', v62: { keeperName: 'Rebecca Scott' } },
    });
  });

  it('refuses an order that has no V62', async () => {
    orders.findScoped.mockResolvedValue({
      _id: 'order-2',
      orderNumber: 'ORD-1043',
      v62Requested: false,
      v62: null,
    });

    const res = await request(app.getHttpServer()).get('/admin/orders/order-2/v62.pdf');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('There is no V62 on this order.');
  });
});

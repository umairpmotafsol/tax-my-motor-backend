import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { PricingService, TaxOptionId } from '../pricing/pricing.service';
import { VehiclesService } from '../vehicles/vehicles.service';

export interface PaymentIntentResult {
  clientSecret: string;
  publishableKey: string;
  amount: number;
  currency: string;
}

/**
 * Card payments for the one-off tax options (6 and 12 months). Direct
 * Debit orders never come through here — DVLA collects those, and this
 * platform's part of that order is the mandate review loop, not a card
 * charge.
 *
 * `client` is null until STRIPE_SECRET_KEY is set, and every method
 * fails clearly rather than pretending a charge happened.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly client: Stripe | null;

  constructor(
    private readonly config: ConfigService,
    private readonly pricing: PricingService,
    private readonly vehicles: VehiclesService,
  ) {
    const secretKey = this.config.get<string>('stripe.secretKey');
    this.client = secretKey ? new Stripe(secretKey) : null;
  }

  get publishableKey(): string {
    return this.config.get<string>('stripe.publishableKey') ?? '';
  }

  private requireClient(): Stripe {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Card payments are not configured yet — set STRIPE_SECRET_KEY.',
      );
    }
    return this.client;
  }

  /** Raises a PaymentIntent for exactly what the quote screen priced. */
  async createIntent(
    option: TaxOptionId,
    withV62: boolean,
    customerId: string,
    reg: string,
  ): Promise<PaymentIntentResult> {
    const client = this.requireClient();
    const taxInfo = await this.vehicles.vedFor(reg);
    const pricing = this.pricing.price(option, withV62, {
      sixMonth: taxInfo.ved?.sixMonth ?? null,
      twelveMonth: taxInfo.ved?.twelveMonth ?? null,
    });
    const amount = Math.round(pricing.dueNow * 100);

    const intent = await client.paymentIntents.create({
      amount,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: { customerId, option, reg, v62: String(withV62) },
    });

    if (!intent.client_secret) {
      /* Stripe always returns one on create; this is a defensive guard, not an expected path. */
      throw new ServiceUnavailableException('Could not start a payment. Please try again.');
    }

    return {
      clientSecret: intent.client_secret,
      publishableKey: this.publishableKey,
      amount: pricing.dueNow,
      currency: 'gbp',
    };
  }

  /**
   * Checked at order placement, not trusted from the client: the intent
   * has to have actually succeeded, for the exact amount quoted, and it
   * has to be this customer's own intent — otherwise anyone could place
   * an order against somebody else's successful charge.
   */
  async verifyPaid(
    paymentIntentId: string,
    expectedPence: number,
    customerId: string,
  ): Promise<Stripe.PaymentIntent> {
    const client = this.requireClient();
    let intent: Stripe.PaymentIntent;
    try {
      intent = await client.paymentIntents.retrieve(paymentIntentId);
    } catch {
      throw new BadRequestException('That payment could not be found.');
    }

    if (intent.metadata?.customerId !== customerId) {
      throw new BadRequestException('That payment does not belong to this account.');
    }
    if (intent.status !== 'succeeded') {
      throw new BadRequestException('Payment has not completed yet.');
    }
    if (intent.currency !== 'gbp' || intent.amount_received !== expectedPence) {
      throw new BadRequestException('The amount paid does not match this order.');
    }
    return intent;
  }

  /** Verifies the signature and decodes the event — never trust an unsigned webhook body. */
  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    const client = this.requireClient();
    const secret = this.config.get<string>('stripe.webhookSecret');
    if (!secret) {
      throw new ServiceUnavailableException('The webhook signing secret is not configured yet.');
    }
    try {
      return client.webhooks.constructEvent(payload, signature, secret);
    } catch (err) {
      this.logger.warn('Rejected a Stripe webhook with a bad signature: ' + (err as Error).message);
      throw new BadRequestException('Invalid webhook signature.');
    }
  }
}

import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OrderType } from '../../common/enums/order.enum';
import { toPence } from '../../common/utils/format.util';

/** What the customer picks on the tax-option screen. */
export type TaxOptionId = '6m' | '12m' | 'dd';

export interface TaxOption {
  id: TaxOptionId;
  title: string;
  /** The vehicle tax element, before the service fee. */
  tax: number;
  /** Number of payments. 1 means paid up front. */
  instalments: number;
  orderType: OrderType;
}

export interface PriceBreakdown {
  tax: number;
  serviceFee: number;
  v62Fee: number;
  total: number;
  /** What the customer is charged today. */
  dueNow: number;
  monthly: number | null;
  instalments: number;
}

/**
 * The DVLA rates for one vehicle, as the tax lookup reports them.
 *
 * Six months is not half of twelve: DVLA adds a surcharge for paying in
 * parts, and the provider returns the surcharged figure directly, so it
 * is used as given rather than derived.
 */
export interface VedRates {
  sixMonth: number | null;
  twelveMonth: number | null;
}

/**
 * DVLA's surcharge for paying twelve months by Direct Debit. The
 * provider returns no Direct Debit rate, so this is the one number here
 * that is still a rule rather than a lookup.
 */
const DIRECT_DEBIT_SURCHARGE = 1.05;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Pricing lives here rather than in each app, so the figure on the
 * quote screen, the figure on the order and the figure on the invoice
 * are the same number computed once.
 */
@Injectable()
export class PricingService {
  /**
   * The terms on offer. What each costs is not here — that depends on
   * the vehicle and comes from the tax lookup, which is the whole point:
   * a flat price is right for no car in particular.
   */
  private readonly terms: Array<Omit<TaxOption, 'tax'>> = [
    { id: '6m', title: '6 months', instalments: 1, orderType: OrderType.Tax6 },
    { id: '12m', title: '12 months', instalments: 1, orderType: OrderType.Tax12 },
    { id: 'dd', title: 'Direct Debit', instalments: 12, orderType: OrderType.DirectDebit },
  ];

  constructor(private readonly config: ConfigService) {}

  get serviceFee(): number {
    return this.config.get<number>('serviceFee') ?? 40;
  }

  get v62Fee(): number {
    return this.config.get<number>('v62Fee') ?? 40;
  }

  /** Every term, priced for this vehicle. */
  listOptions(ved: VedRates): TaxOption[] {
    return this.terms.map(term => ({ ...term, tax: this.taxFor(term.id, ved) }));
  }

  getOption(id: TaxOptionId, ved: VedRates): TaxOption {
    const term = this.terms.find(o => o.id === id);
    if (!term) {
      throw new BadRequestException('That is not a tax option we offer.');
    }
    return { ...term, tax: this.taxFor(id, ved) };
  }

  /**
   * The DVLA tax element for one term.
   *
   * A missing rate is refused rather than defaulted. The alternative is
   * quoting a number we made up and then paying the real one — and the
   * vehicles that have no rate (an unrecognised plate, a lookup that
   * failed) are exactly the ones where a guess would be furthest out.
   */
  private taxFor(id: TaxOptionId, ved: VedRates): number {
    const annual = ved.twelveMonth;
    const rate =
      id === '6m'
        ? ved.sixMonth
        : id === 'dd'
          ? annual === null
            ? null
            : round2(annual * DIRECT_DEBIT_SURCHARGE)
          : annual;

    if (rate === null || !Number.isFinite(rate) || rate < 0) {
      throw new UnprocessableEntityException(
        'We could not get a tax rate for this vehicle, so we cannot price it yet.',
      );
    }
    return rate;
  }

  /** The order type a chosen option maps onto — what routing matches. */
  orderTypeFor(id: TaxOptionId): OrderType {
    const term = this.terms.find(o => o.id === id);
    if (!term) {
      throw new BadRequestException('That is not a tax option we offer.');
    }
    return term.orderType;
  }

  price(id: TaxOptionId, withV62: boolean, ved: VedRates): PriceBreakdown {
    const option = this.getOption(id, ved);
    const v62Fee = withV62 ? this.v62Fee : 0;
    const total = toPence(option.tax + this.serviceFee + v62Fee);
    const monthly = option.instalments > 1 ? toPence(total / option.instalments) : null;
    return {
      tax: option.tax,
      serviceFee: this.serviceFee,
      v62Fee,
      total,
      dueNow: monthly ?? total,
      monthly,
      instalments: option.instalments,
    };
  }

  /** Term only, for the labels — they read the same whatever it costs. */
  private term(id: TaxOptionId): Omit<TaxOption, 'tax'> {
    const found = this.terms.find(o => o.id === id);
    if (!found) {
      throw new BadRequestException('That is not a tax option we offer.');
    }
    return found;
  }

  /** "12 months + V62" — the label shown on the order. */
  planLabel(id: TaxOptionId, withV62: boolean): string {
    const base = this.term(id).title;
    return withV62 ? base + ' + V62' : base;
  }

  /** "12-month tax + V62" — the longer form the order book uses. */
  orderPlanLabel(id: TaxOptionId, withV62: boolean): string {
    const option = this.term(id);
    const base =
      option.id === 'dd' ? 'Direct Debit' : option.title.replace(' months', '-month tax');
    return withV62 ? base + ' + V62' : base;
  }

  /** The line items that make up the total. */
  itemsFor(id: TaxOptionId, withV62: boolean): Array<{ name: string; qty: number }> {
    const option = this.term(id);
    const label =
      option.id === 'dd' ? 'Vehicle tax (Direct Debit)' : 'Vehicle tax (' + option.title + ')';
    const items = [{ name: label, qty: 1 }];
    if (withV62) {
      items.push({ name: 'V62 registration certificate', qty: 1 });
    }
    return items;
  }
}

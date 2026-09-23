/**
 * Pricing used to be three constants — £95, £180, £180 — charged to
 * every vehicle alike. It now comes from the vehicle's own DVLA rates,
 * so these cover the arithmetic that replaced them, and the refusal
 * that has to happen when there is no rate to work from.
 */
import { UnprocessableEntityException } from '@nestjs/common';

import { PricingService } from './pricing.service';

/** The sample vehicle: £395 a year, £217.25 for six months. */
const VW = { sixMonth: 217.25, twelveMonth: 395 };

const service = () =>
  new PricingService({
    get: (key: string) => (key === 'serviceFee' ? 40 : 40),
  } as never);

describe('pricing from the vehicle', () => {
  it('charges the vehicle’s own annual rate plus the service fee', () => {
    const price = service().price('12m', false, VW);

    expect(price.tax).toBe(395);
    expect(price.serviceFee).toBe(40);
    expect(price.total).toBe(435);
    // Not the old flat £220, which would have lost £175 on this car.
    expect(price.total).not.toBe(220);
  });

  it('takes the six-month rate as given rather than halving the annual one', () => {
    const price = service().price('6m', false, VW);

    // 395 / 2 would be 197.50; DVLA's six-month rate is higher, and the
    // provider already returns the surcharged figure.
    expect(price.tax).toBe(217.25);
    expect(price.total).toBe(257.25);
  });

  it('adds the Direct Debit surcharge, and spreads it over twelve payments', () => {
    const price = service().price('dd', false, VW);

    expect(price.tax).toBe(414.75); // 395 + 5%
    expect(price.total).toBe(454.75);
    expect(price.instalments).toBe(12);
    expect(price.monthly).toBe(37.9);
    // The customer pays one instalment today, not the whole year.
    expect(price.dueNow).toBe(37.9);
  });

  it('keeps the V62 as a separate line on top', () => {
    const price = service().price('12m', true, VW);

    expect(price.v62Fee).toBe(40);
    expect(price.total).toBe(475);
  });

  it('prices every term for the same vehicle', () => {
    const options = service().listOptions(VW);

    expect(options.map(o => [o.id, o.tax])).toEqual([
      ['6m', 217.25],
      ['12m', 395],
      ['dd', 414.75],
    ]);
  });

  it('refuses to price a vehicle it has no rate for', () => {
    // An unrecognised plate, or a lookup that could not be made. A
    // default here would be quoted to the customer and then paid for
    // real at whatever it actually costs.
    expect(() => service().price('12m', false, {sixMonth: null, twelveMonth: null})).toThrow(
      UnprocessableEntityException,
    );
  });

  it('refuses the six-month term when only the annual rate came back', () => {
    expect(() => service().price('6m', false, {sixMonth: null, twelveMonth: 395})).toThrow(
      UnprocessableEntityException,
    );
    // The annual term is still priceable from the same response.
    expect(service().price('12m', false, {sixMonth: null, twelveMonth: 395}).tax).toBe(395);
  });

  it('prices a zero-rated vehicle at the service fee alone', () => {
    // An electric or historic vehicle genuinely costs nothing to tax;
    // that is a real £0, not a missing rate, and must still sell.
    const price = service().price('12m', false, {sixMonth: 0, twelveMonth: 0});

    expect(price.tax).toBe(0);
    expect(price.total).toBe(40);
  });
});

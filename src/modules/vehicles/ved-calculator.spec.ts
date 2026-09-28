/**
 * DVLA's tables, checked against the leaflets they were copied from —
 * V149 (April 2026) and V149/1 (July 2026) — and against the two real
 * vehicles the provider could not price. Pure functions, so nothing
 * here can reach the paid endpoint.
 */
import {
  RE23YRU_DETAILS,
  RE23YRU_VALUATION,
  YD23OGM_DETAILS,
} from './fixtures/vehicle-details.samples';
import {
  VehicleFacts,
  calculateVed,
  classify,
  needsListPrice,
  readVehicleFacts,
} from './ved-calculator';
import { ratesOn } from './ved-rates';

/** The day the two plates were looked up; every test prices "as of" it. */
const ON = new Date('2026-09-28T12:00:00Z');

const facts = (over: Partial<VehicleFacts>): VehicleFacts => ({
  kind: 'car',
  firstRegistered: '2020-01-01',
  yearOfManufacture: 2020,
  zeroEmission: false,
  diesel: false,
  co2: 120,
  engineCc: 1500,
  seats: 5,
  grossWeightKg: null,
  massInServiceKg: null,
  euroStatus: null,
  listPrice: null,
  ...over,
});

const price = (over: Partial<VehicleFacts>) => calculateVed(facts(over), ON).ved;

describe('the two plates the provider could not price', () => {
  it('reads the Corolla as a 2023 hybrid car', () => {
    expect(readVehicleFacts(null, YD23OGM_DETAILS as never)).toMatchObject({
      kind: 'car',
      firstRegistered: '2023-06-06',
      zeroEmission: false,
      co2: 101,
      engineCc: 1798,
      euroStatus: 6,
      listPrice: null,
    });
  });

  it('reads the Land Rover, with its list price when new from the valuation', () => {
    expect(
      readVehicleFacts(null, RE23YRU_DETAILS as never, RE23YRU_VALUATION as never),
    ).toMatchObject({
      kind: 'car',
      firstRegistered: '2023-06-19',
      co2: 212,
      listPrice: 47_805,
    });
  });

  it('asks for the list price for both — each is inside its supplement years', () => {
    expect(needsListPrice(readVehicleFacts(null, YD23OGM_DETAILS as never), ON)).toBe(true);
    expect(needsListPrice(readVehicleFacts(null, RE23YRU_DETAILS as never), ON)).toBe(true);
  });

  it('prices the Land Rover at the standard rate plus the expensive car supplement', () => {
    const { ved } = calculateVed(
      readVehicleFacts(null, RE23YRU_DETAILS as never, RE23YRU_VALUATION as never),
      ON,
    );
    expect(ved).toMatchObject({ twelveMonth: 640, sixMonth: 352, directDebit: 672 });
    expect(ved?.basis).toContain('£47,805');
  });

  it('prices the Corolla at the standard rate', () => {
    const corolla = { ...readVehicleFacts(null, YD23OGM_DETAILS as never), listPrice: 29_000 };
    expect(calculateVed(corolla, ON).ved).toMatchObject({
      twelveMonth: 200,
      sixMonth: 110,
      directDebit: 210,
    });
  });

  /* Without the valuation there is no way to know; the standard rate says so. */
  it('falls back to the standard rate, and says why, when the list price is unknown', () => {
    const { ved } = calculateVed(readVehicleFacts(null, RE23YRU_DETAILS as never), ON);
    expect(ved?.twelveMonth).toBe(200);
    expect(ved?.basis).toContain('list price unknown');
  });
});

describe('cars (V149)', () => {
  it('only charges the supplement for five years from the second licence', () => {
    // Registered 2019-01-01: second licence 2020, supplement ends 2025.
    expect(price({ firstRegistered: '2019-01-01', listPrice: 60_000 })?.twelveMonth).toBe(200);
    expect(needsListPrice(facts({ firstRegistered: '2019-01-01' }), ON)).toBe(false);
    expect(price({ firstRegistered: '2021-01-01', listPrice: 60_000 })?.twelveMonth).toBe(640);
  });

  it('does not charge it at exactly £40,000', () => {
    expect(price({ firstRegistered: '2022-05-01', listPrice: 40_000 })?.twelveMonth).toBe(200);
  });

  it('uses £50,000 for zero emission cars registered from 1 April 2025', () => {
    const ev = { zeroEmission: true, co2: 0, listPrice: 45_000 };
    expect(price({ ...ev, firstRegistered: '2025-06-01' })?.twelveMonth).toBe(200);
    expect(price({ ...ev, firstRegistered: '2022-06-01' })?.twelveMonth).toBe(640);
  });

  it('prices 2001–2017 cars by CO2 band', () => {
    expect(price({ firstRegistered: '2010-05-01', co2: 192 })).toMatchObject({
      twelveMonth: 410,
      sixMonth: 225.5,
      directDebit: 430.5,
    });
    expect(price({ firstRegistered: '2010-05-01', co2: 99 })).toMatchObject({
      twelveMonth: 20,
      sixMonth: null,
      directDebit: 21,
    });
  });

  it('keeps a car over 225g/km registered before 23 March 2006 in band K', () => {
    expect(price({ firstRegistered: '2005-01-01', co2: 240 })?.twelveMonth).toBe(445);
    expect(price({ firstRegistered: '2007-01-01', co2: 240 })?.twelveMonth).toBe(760);
  });

  it('prices pre-2001 cars by engine size', () => {
    expect(price({ firstRegistered: '1998-01-01', engineCc: 1400 })?.twelveMonth).toBe(230);
    expect(price({ firstRegistered: '1998-01-01', engineCc: 1998 })).toMatchObject({
      twelveMonth: 375,
      sixMonth: 206.25,
      directDebit: 393.75,
    });
  });

  it('refuses a car old enough to be historic rather than charge it', () => {
    expect(price({ firstRegistered: '1980-01-01', yearOfManufacture: 1980 })).toBeNull();
  });

  it('refuses a car with no registration date', () => {
    expect(price({ firstRegistered: null })).toBeNull();
  });
});

describe('vans, motorcycles and tricycles (V149)', () => {
  it('prices a light goods vehicle at £360', () => {
    expect(price({ kind: 'light-goods', firstRegistered: '2020-01-01' })).toMatchObject({
      twelveMonth: 360,
      sixMonth: 198,
      directDebit: 378,
    });
  });

  it('gives Euro 4 and Euro 5 vans in their windows the £140 rate', () => {
    expect(
      price({ kind: 'light-goods', firstRegistered: '2005-06-01', euroStatus: 4 })?.twelveMonth,
    ).toBe(140);
    expect(
      price({ kind: 'light-goods', firstRegistered: '2010-06-01', euroStatus: 5 })?.twelveMonth,
    ).toBe(140);
    expect(
      price({ kind: 'light-goods', firstRegistered: '2012-06-01', euroStatus: 5 })?.twelveMonth,
    ).toBe(360);
  });

  it('prices motorcycles by engine size', () => {
    expect(price({ kind: 'motorcycle', engineCc: 125 })).toMatchObject({
      twelveMonth: 27,
      sixMonth: null,
    });
    expect(price({ kind: 'motorcycle', engineCc: 300 })?.twelveMonth).toBe(59);
    expect(price({ kind: 'motorcycle', engineCc: 500 })?.twelveMonth).toBe(90);
    expect(price({ kind: 'motorcycle', engineCc: 1200 })).toMatchObject({
      twelveMonth: 125,
      sixMonth: 68.75,
      directDebit: 131.25,
    });
    expect(price({ kind: 'motorcycle', zeroEmission: true, engineCc: null })?.twelveMonth).toBe(27);
  });

  it('taxes a motorcycle over 450kg as private/light goods', () => {
    expect(price({ kind: 'motorcycle', engineCc: 1800, massInServiceKg: 500 })?.twelveMonth).toBe(
      375,
    );
  });

  it('prices tricycles', () => {
    expect(price({ kind: 'tricycle', engineCc: 125 })?.twelveMonth).toBe(27);
    expect(price({ kind: 'tricycle', engineCc: 900 })?.twelveMonth).toBe(125);
  });
});

/*
 * The leaflet's worked examples are for rigid HGVs pulling trailers,
 * priced on the combined weight — which is the same levy table the
 * vehicle alone is priced on, so they check it directly.
 */
describe('HGVs (V149/1)', () => {
  const hgv = (grossWeightKg: number, euroStatus: number) =>
    price({ kind: 'hgv', grossWeightKg, euroStatus });

  it.each([
    [27_000, 6, 162],
    [30_000, 5, 210],
    [40_000, 5, 805],
    [35_000, 5, 504],
    [38_000, 6, 388],
  ])('%skg, Euro %s: £%s a year, as in the leaflet', (weight, euro, total) => {
    expect(hgv(weight, euro)?.twelveMonth).toBe(total);
  });

  it('adds the six-month VED and levy together', () => {
    expect(hgv(27_000, 6)?.sixMonth).toBe(97.1);
    expect(hgv(40_000, 5)?.sixMonth).toBe(482.9);
  });

  it('offers no Direct Debit, as the leaflet shows none', () => {
    expect(hgv(27_000, 6)?.directDebit).toBeNull();
  });

  it('charges only the £1 VED under 12,000kg', () => {
    expect(hgv(7_500, 6)).toMatchObject({ twelveMonth: 1, sixMonth: 0.55, directDebit: null });
  });

  it('prices over 44,000kg at the top levy', () => {
    expect(hgv(46_000, 6)?.twelveMonth).toBe(620);
  });

  it('takes an HGV with no Euro status as Euro VI only if registered from 2014', () => {
    const at = (firstRegistered: string) =>
      price({ kind: 'hgv', grossWeightKg: 20_000, euroStatus: null, firstRegistered })?.twelveMonth;
    expect(at('2016-01-01')).toBe(162);
    expect(at('2012-01-01')).toBe(210);
  });

  it('refuses an HGV with no weight', () => {
    expect(price({ kind: 'hgv', grossWeightKg: null })).toBeNull();
  });
});

describe('buses and other heavy classes (V149/1)', () => {
  it('prices buses by seats', () => {
    expect(price({ kind: 'bus', seats: 16 })?.twelveMonth).toBe(177);
    expect(price({ kind: 'bus', seats: 30 })?.twelveMonth).toBe(240);
    expect(price({ kind: 'bus', seats: 49 })).toMatchObject({
      twelveMonth: 350,
      sixMonth: 192.5,
      directDebit: 367.5,
    });
    expect(price({ kind: 'bus', seats: 70 })?.twelveMonth).toBe(530);
  });

  it('prices recovery vehicles by weight', () => {
    expect(price({ kind: 'recovery', grossWeightKg: 18_000 })?.twelveMonth).toBe(177);
    expect(price({ kind: 'recovery', grossWeightKg: 32_000 })?.twelveMonth).toBe(440);
  });

  it('prices the flat-rate classes', () => {
    expect(price({ kind: 'private-hgv' })?.twelveMonth).toBe(177);
    expect(price({ kind: 'special-vehicle' })?.twelveMonth).toBe(177);
    expect(price({ kind: 'general-haulage' })).toMatchObject({
      twelveMonth: 380,
      directDebit: 399,
    });
    expect(price({ kind: 'small-island' })).toMatchObject({ twelveMonth: 1, sixMonth: 0.55 });
    expect(price({ kind: 'special-types', euroStatus: 6 })?.twelveMonth).toBe(620);
    expect(price({ kind: 'combined-transport', euroStatus: 5 })?.twelveMonth).toBe(805);
  });
});

describe('telling vehicles apart', () => {
  const kind = (over: Partial<Parameters<typeof classify>[0]>) =>
    classify({
      category: null,
      taxationClass: null,
      vehicleClass: null,
      bodyType: null,
      wheelPlan: null,
      grossWeightKg: null,
      ...over,
    });

  it('goes by type approval category', () => {
    expect(kind({ category: 'M1' })).toBe('car');
    expect(kind({ category: 'M1', bodyType: 'MOTOR CARAVAN' })).toBe('motor-caravan');
    expect(kind({ category: 'N1' })).toBe('light-goods');
    expect(kind({ category: 'N3' })).toBe('hgv');
    expect(kind({ category: 'M3' })).toBe('bus');
    expect(kind({ category: 'L3e' })).toBe('motorcycle');
    expect(kind({ category: 'L5e' })).toBe('tricycle');
  });

  it('lets the plated weight decide between a van and an HGV', () => {
    expect(kind({ category: 'N1', grossWeightKg: 3_500 })).toBe('light-goods');
    expect(kind({ category: 'N2', grossWeightKg: 3_500 })).toBe('light-goods');
    expect(kind({ category: 'N2', grossWeightKg: 7_500 })).toBe('hgv');
  });

  it('honours a taxation class that is the keeper’s choice', () => {
    expect(kind({ category: 'N3', taxationClass: 'Recovery Vehicle' })).toBe('recovery');
    expect(kind({ category: 'N3', taxationClass: 'Private HGV' })).toBe('private-hgv');
  });

  it('falls back to the wording when there is no category', () => {
    expect(kind({ vehicleClass: 'Car' })).toBe('car');
    expect(kind({ wheelPlan: '2 WHEEL' })).toBe('motorcycle');
    expect(kind({ vehicleClass: 'LCV' })).toBe('light-goods');
  });

  it('refuses to price what it cannot place', () => {
    expect(kind({})).toBeNull();
    expect(calculateVed(facts({ kind: null }), ON).ved).toBeNull();
  });
});

describe('picking the rates in force', () => {
  const list = [
    { effectiveFrom: '2026-04-01', label: 'this year' },
    { effectiveFrom: '2027-04-01', label: 'next year' },
  ];

  it('uses a new block from the day it starts, and not before', () => {
    expect(ratesOn(list, '2027-03-31').label).toBe('this year');
    expect(ratesOn(list, '2027-04-01').label).toBe('next year');
  });

  it('uses the earliest block for a day before any of them', () => {
    expect(ratesOn(list, '2020-01-01').label).toBe('this year');
  });
});

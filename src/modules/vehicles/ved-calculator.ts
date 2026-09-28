/**
 * Vehicle tax from DVLA's own tables, for a vehicle the provider could
 * not price.
 *
 * Vehicle Data Global answers most plates with a rate, but for some it
 * returns every `VedRate` table empty — two 2023 cars, a Land Rover and
 * a Toyota, were the case that prompted this. Those vehicles still have
 * a price: it is in DVLA's V149 and V149/1 leaflets (`ved-rates.ts`),
 * and everything needed to look it up — what kind of vehicle it is,
 * when it was registered, its CO2, engine size, weight, seats and Euro
 * status — comes back in the VehicleDetails package. The one thing that
 * package lacks is the list price the expensive car supplement turns
 * on; that comes from ValuationDetails, and only for the cars it could
 * change.
 *
 * Pure functions, no I/O: the service decides what to fetch and passes
 * the responses in.
 */
import {
  HEAVY_VEHICLE_RATES,
  HeavyVehicleRates,
  LIGHT_VEHICLE_RATES,
  LightVehicleRates,
  VedRate,
  ratesOn,
} from './ved-rates';

export type VehicleKind =
  | 'car'
  | 'motor-caravan'
  | 'light-goods'
  | 'hgv'
  | 'bus'
  | 'motorcycle'
  | 'tricycle'
  | 'private-hgv'
  | 'special-vehicle'
  | 'recovery'
  | 'special-types'
  | 'combined-transport'
  | 'general-haulage'
  | 'small-island';

/** What the tables need to know about a vehicle. Null is "the provider did not say". */
export interface VehicleFacts {
  kind: VehicleKind | null;
  /** "2023-06-19". */
  firstRegistered: string | null;
  yearOfManufacture: number | null;
  zeroEmission: boolean;
  diesel: boolean;
  co2: number | null;
  engineCc: number | null;
  /** Including the driver's. */
  seats: number | null;
  /** Revenue (plated) weight — what the HGV, recovery and light goods rules are written against. */
  grossWeightKg: number | null;
  massInServiceKg: number | null;
  /** 4, 5, 6… — "6d-TEMP" and "Euro VI" both read as 6. */
  euroStatus: number | null;
  /** On-the-road price when new, from ValuationDetails. */
  listPrice: number | null;
}

/** A price from the tables, in the same terms the provider's rates are given in. */
export interface TableVed {
  twelveMonth: number;
  sixMonth: number | null;
  /** Null where the leaflet shows no Direct Debit figure. */
  directDebit: number | null;
  /** Which leaflet and row — so support can check a quote against gov.uk. */
  basis: string;
}

export type VedCalculation = { ved: TableVed; reason?: undefined } | { ved: null; reason: string };

/**
 * No leaflet says which HGVs are Euro VI, and not every response carries
 * a Euro status. Euro VI became mandatory for every new HGV registered
 * from 31 December 2013, so a vehicle registered after that is taken to
 * be Euro VI and anything older Euro V — the dearer levy, which errs on
 * the side of never under-quoting.
 */
const EURO_VI_REGISTERED_FROM = '2014-01-01';

/* --------------------------------------------------------------------------- */
/* reading the provider's responses                                             */
/* --------------------------------------------------------------------------- */

/**
 * Collects the facts from whatever responses are to hand.
 *
 * `tax` is the Tax package, `details` the VehicleDetails package (its
 * VehicleDetails and ModelDetails blocks), `valuation` ValuationDetails.
 * Any of them may be null, and every field falls back to null rather
 * than to a guess.
 */
export function readVehicleFacts(
  tax: Record<string, unknown> | null,
  details: Record<string, unknown> | null,
  valuation: Record<string, unknown> | null = null,
): VehicleFacts {
  const taxBlock = obj(obj(tax?.Results)?.VehicleTaxDetails) ?? {};
  const detailResults = obj(details?.Results) ?? {};
  const vehicle = obj(detailResults.VehicleDetails) ?? {};
  const identity = obj(vehicle.VehicleIdentification) ?? {};
  const status = obj(vehicle.VehicleStatus) ?? {};
  const duty = obj(status.VehicleExciseDutyDetails) ?? {};
  const technical = obj(vehicle.DvlaTechnicalDetails) ?? {};
  const model = obj(detailResults.ModelDetails) ?? {};
  const classification = obj(model.ModelClassification) ?? {};
  const weights = obj(model.Weights) ?? {};
  const powertrain = obj(model.Powertrain) ?? {};
  const emissions = obj(model.Emissions) ?? {};
  const figures = obj(obj(obj(valuation?.Results)?.ValuationDetails)?.ValuationFigures) ?? {};

  const fuel = (str(identity.DvlaFuelType) ?? str(powertrain.FuelType) ?? '').toLowerCase();
  const powertrainType = (str(powertrain.PowertrainType) ?? '').toUpperCase();
  const grossWeightKg = num(technical.GrossWeightKg) ?? num(weights.GrossVehicleWeightKg);

  return {
    kind: classify({
      category: str(classification.TypeApprovalCategory),
      taxationClass: str(classification.TaxationClass),
      vehicleClass: str(classification.VehicleClass),
      bodyType: str(identity.DvlaBodyType),
      wheelPlan: str(identity.DvlaWheelPlan),
      grossWeightKg,
    }),
    firstRegistered: day(identity.DateFirstRegistered) ?? day(identity.DateFirstRegisteredInUk),
    yearOfManufacture: num(identity.YearOfManufacture) ?? num(taxBlock.YearOfManufacture),
    zeroEmission: fuel === 'electricity' || fuel === 'electric' || powertrainType === 'BEV',
    diesel: fuel.includes('diesel'),
    co2:
      num(duty.DvlaCo2) ??
      num(obj(taxBlock.VehicleExciseDutyDetails)?.DvlaCo2) ??
      num(taxBlock.Co2Emissions),
    engineCc: num(technical.EngineCapacityCc) ?? num(obj(powertrain.IceDetails)?.EngineCapacityCc),
    seats: num(technical.NumberOfSeats) ?? num(obj(model.BodyDetails)?.NumberOfSeats),
    grossWeightKg,
    massInServiceKg: num(technical.MassInServiceKg) ?? num(weights.KerbWeightKg),
    euroStatus: euroStatus(str(emissions.EuroStatus)),
    listPrice: num(figures.OnTheRoad),
  };
}

interface ClassifyInput {
  category: string | null;
  taxationClass: string | null;
  vehicleClass: string | null;
  bodyType: string | null;
  wheelPlan: string | null;
  grossWeightKg: number | null;
}

/**
 * Which set of rules applies.
 *
 * The provider's taxation class is read first for the classes that are
 * a keeper's choice rather than a kind of vehicle — a recovery truck
 * and a haulage truck can be the same lorry. After that the EU type
 * approval category settles it (M1 car, N1 van, N2/N3 HGV, M2/M3 bus,
 * L motorcycle), with the wording of the class fields as a fallback
 * for a response that has no category.
 */
export function classify(input: ClassifyInput): VehicleKind | null {
  const taxation = (input.taxationClass ?? '').toLowerCase();
  const special: Array<[RegExp, VehicleKind]> = [
    [/private\s*(hgv|heavy)/, 'private-hgv'],
    [/recovery/, 'recovery'],
    [/special\s*types?/, 'special-types'],
    [/combined/, 'combined-transport'],
    [/haulage/, 'general-haulage'],
    [/island/, 'small-island'],
    [/special|showman|works truck|digging|road roller|crane/, 'special-vehicle'],
  ];
  for (const [pattern, kind] of special) {
    if (pattern.test(taxation)) {
      return kind;
    }
  }

  const body = (input.bodyType ?? '').toLowerCase();
  const heavy = input.grossWeightKg !== null && input.grossWeightKg > 3_500;
  const category = (input.category ?? '').toUpperCase().replace(/\s+/g, '');

  if (/^L[1-7]/.test(category)) {
    // L2e and L5e are three-wheelers; L6e/L7e quadricycles are taxed with them.
    return /^L[2567]/.test(category) ? 'tricycle' : 'motorcycle';
  }
  if (category === 'M1') {
    return body.includes('caravan') ? 'motor-caravan' : 'car';
  }
  if (category === 'M2' || category === 'M3') {
    return 'bus';
  }
  if (/^N[123]/.test(category)) {
    // The plated weight decides, whatever the category says.
    if (input.grossWeightKg !== null) {
      return heavy ? 'hgv' : 'light-goods';
    }
    return category.startsWith('N1') ? 'light-goods' : 'hgv';
  }

  const words = [taxation, input.vehicleClass ?? '', body].join(' ').toLowerCase();
  const wheels = (input.wheelPlan ?? '').toLowerCase();
  if (/tricycle|trike|quad/.test(words) || wheels.startsWith('3 wheel')) {
    return 'tricycle';
  }
  if (/motorcycle|motor cycle|moped|scooter/.test(words) || wheels.startsWith('2 wheel')) {
    return 'motorcycle';
  }
  if (/caravan/.test(words)) {
    return 'motor-caravan';
  }
  if (/\bbus\b|coach/.test(words)) {
    return 'bus';
  }
  if (/hgv|heavy goods|truck|lorry|tractor unit/.test(words)) {
    return 'hgv';
  }
  if (/\blcv\b|light commercial|light goods|\bvan\b|pick-?up/.test(words)) {
    return heavy ? 'hgv' : 'light-goods';
  }
  if (/\bcar\b|estate|saloon|hatchback|coupe|convertible|mpv|suv/.test(words)) {
    return 'car';
  }
  return null;
}

/* --------------------------------------------------------------------------- */
/* the expensive car supplement                                                 */
/* --------------------------------------------------------------------------- */

/**
 * Whether the car's list price could change what it owes — so whether
 * the ValuationDetails lookup, which is not cheap, is worth making.
 *
 * Only a car first registered on or after 1 April 2017, and only in the
 * five years the supplement runs: from the start of its second licence,
 * a year after registration, to six years after. Before the second
 * licence the car is already taxed by its dealer; after the sixth year
 * it pays the standard rate whatever it cost.
 */
export function needsListPrice(facts: VehicleFacts, on: Date = new Date()): boolean {
  const rates = ratesOn(LIGHT_VEHICLE_RATES, isoDay(on));
  return facts.kind === 'car' && inPremiumWindow(facts, rates, isoDay(on));
}

function inPremiumWindow(facts: VehicleFacts, rates: LightVehicleRates, today: string): boolean {
  const registered = facts.firstRegistered;
  return (
    registered !== null &&
    registered >= rates.post2017.from &&
    today < addYears(registered, 1 + rates.post2017.premiumYears)
  );
}

/* --------------------------------------------------------------------------- */
/* the calculation                                                              */
/* --------------------------------------------------------------------------- */

/**
 * The DVLA rate for these facts on `on`, or why there is none.
 *
 * Refuses rather than guesses whenever a fact the tables turn on is
 * missing: an unpriced vehicle shows "we could not get a DVLA rate", a
 * wrongly priced one is paid for by the business when DVLA charges the
 * real figure.
 */
export function calculateVed(facts: VehicleFacts, on: Date = new Date()): VedCalculation {
  const today = isoDay(on);
  const light = ratesOn(LIGHT_VEHICLE_RATES, today);
  const heavy = ratesOn(HEAVY_VEHICLE_RATES, today);

  if (!facts.kind) {
    return unpriced('The vehicle type could not be determined.');
  }
  if (facts.yearOfManufacture !== null && facts.yearOfManufacture < light.historicBuiltBefore) {
    return unpriced(
      'Built before ' + light.historicBuiltBefore + ', so it may be exempt as a historic vehicle.',
    );
  }

  switch (facts.kind) {
    case 'car':
      return car(facts, light, today);
    case 'motor-caravan':
      return privateLightGoods(facts, light, 'motor caravan');
    case 'light-goods':
      return lightGoods(facts, light);
    case 'motorcycle':
    case 'tricycle':
      return twoOrThreeWheeler(facts, light);
    case 'hgv':
      return hgv(facts, heavy);
    case 'bus':
      return bus(facts, heavy);
    case 'recovery':
      return recovery(facts, heavy);
    case 'private-hgv':
      return priced(heavy.privateHgv, heavy.source, 'private HGV');
    case 'special-vehicle':
      return priced(heavy.specialVehicle, heavy.source, 'special vehicle');
    case 'small-island':
      return priced(heavy.smallIsland, heavy.source, 'small island vehicle');
    case 'general-haulage':
      return priced(heavy.generalHaulage, heavy.source, 'general haulage vehicle');
    case 'special-types':
      return byEuroStatus(facts, heavy.specialTypes, heavy.source, 'special types vehicle');
    case 'combined-transport':
      return byEuroStatus(facts, heavy.combinedTransport, heavy.source, 'combined transport');
  }
}

function car(facts: VehicleFacts, rates: LightVehicleRates, today: string): VedCalculation {
  const registered = facts.firstRegistered;
  if (!registered) {
    return unpriced('The date of first registration is missing.');
  }

  const post2017 = rates.post2017;
  if (registered >= post2017.from) {
    const threshold =
      facts.zeroEmission && registered >= post2017.zeroEmissionThresholdFrom
        ? post2017.zeroEmissionListPriceThreshold
        : post2017.listPriceThreshold;
    const inWindow = inPremiumWindow(facts, rates, today);

    if (inWindow && facts.listPrice !== null && facts.listPrice > threshold) {
      return priced(
        post2017.premium,
        rates.source,
        'car registered on or after 1 April 2017, list price £' +
          facts.listPrice.toLocaleString('en-GB') +
          ' (over £' +
          threshold.toLocaleString('en-GB') +
          ') — standard rate plus expensive car supplement',
      );
    }
    return priced(
      post2017.standard,
      rates.source,
      'car registered on or after 1 April 2017 — standard rate' +
        (inWindow && facts.listPrice === null
          ? ' (list price unknown; the supplement may apply)'
          : ''),
    );
  }

  if (registered >= rates.co2Bands.from && facts.co2 !== null) {
    const capAtK = facts.co2 > 225 && registered < rates.co2Bands.bandKCapBefore;
    const band = capAtK
      ? rates.co2Bands.bands.find(b => b.band === 'K')!
      : rates.co2Bands.bands.find(b => facts.co2! <= b.co2Max)!;
    return priced(
      band.rate,
      rates.source,
      'car registered 1 March 2001 to 31 March 2017, ' + facts.co2 + 'g/km — band ' + band.band,
    );
  }

  // Before March 2001, or a later car DVLA holds no CO2 figure for: engine size.
  return privateLightGoods(facts, rates, 'car');
}

function privateLightGoods(
  facts: VehicleFacts,
  rates: LightVehicleRates,
  what: string,
): VedCalculation {
  if (facts.engineCc === null) {
    return unpriced('The engine size is missing.');
  }
  const plg = rates.privateLightGoods;
  const small = facts.engineCc <= plg.smallEngineMaxCc;
  return priced(
    small ? plg.smallEngine : plg.largeEngine,
    rates.source,
    what +
      ' taxed as private/light goods, ' +
      facts.engineCc +
      'cc (' +
      (small ? 'not over ' : 'over ') +
      plg.smallEngineMaxCc +
      'cc)',
  );
}

function lightGoods(facts: VehicleFacts, rates: LightVehicleRates): VedCalculation {
  const registered = facts.firstRegistered;
  if (!registered) {
    return unpriced('The date of first registration is missing.');
  }
  const lgv = rates.lightGoods;
  if (registered < lgv.from) {
    return privateLightGoods(facts, rates, 'light goods vehicle registered before 1 March 2001');
  }
  const euro4 = facts.euroStatus === 4 || facts.zeroEmission;
  const euro5 = facts.euroStatus === 5 || facts.zeroEmission;
  if (euro4 && registered >= lgv.euro4.from && registered <= lgv.euro4.to) {
    return priced(lgv.euro4.rate, rates.source, 'Euro 4 light goods vehicle');
  }
  if (euro5 && registered >= lgv.euro5.from && registered <= lgv.euro5.to) {
    return priced(lgv.euro5.rate, rates.source, 'Euro 5 light goods vehicle');
  }
  return priced(
    lgv.standard,
    rates.source,
    'light goods vehicle registered on or after 1 March 2001',
  );
}

function twoOrThreeWheeler(facts: VehicleFacts, rates: LightVehicleRates): VedCalculation {
  const table = rates.twoAndThreeWheelers;
  const what = facts.kind === 'tricycle' ? 'tricycle' : 'motorcycle';
  if (facts.massInServiceKg !== null && facts.massInServiceKg > table.maxWeightKg) {
    return privateLightGoods(facts, rates, what + ' over ' + table.maxWeightKg + 'kg');
  }
  if (facts.kind === 'tricycle') {
    const trikes = table.tricycles;
    if (facts.zeroEmission) {
      return priced(trikes.zeroEmission, rates.source, 'zero emission tricycle');
    }
    if (facts.engineCc === null) {
      return unpriced('The engine size is missing.');
    }
    return facts.engineCc <= trikes.smallEngineMaxCc
      ? priced(
          trikes.smallEngine,
          rates.source,
          'tricycle not over ' + trikes.smallEngineMaxCc + 'cc',
        )
      : priced(trikes.other, rates.source, 'tricycle over ' + trikes.smallEngineMaxCc + 'cc');
  }
  const bikes = table.motorcycles;
  if (facts.zeroEmission) {
    return priced(bikes.zeroEmission, rates.source, 'zero emission motorcycle');
  }
  if (facts.engineCc === null) {
    return unpriced('The engine size is missing.');
  }
  const band = bikes.bands.find(b => facts.engineCc! <= b.ccMax)!;
  return priced(band.rate, rates.source, 'motorcycle, ' + facts.engineCc + 'cc');
}

/**
 * HGV, tax class 01: £1 of VED plus the levy for the revenue weight and
 * Euro status. Axles, bands and rigid-or-articulated decide the VED
 * band, but every band from A1 to G is the same £1 — so none of them
 * change the price, and none of them are needed.
 *
 * A rigid HGV pulling a trailer over 4,000kg (tax class 02) is priced
 * on the combined weight instead. Nothing in the provider's response
 * says whether a trailer is pulled, so this prices the vehicle alone.
 */
function hgv(facts: VehicleFacts, rates: HeavyVehicleRates): VedCalculation {
  const weight = facts.grossWeightKg;
  if (weight === null) {
    return unpriced('The revenue weight is missing.');
  }
  const table = rates.hgv;
  if (weight < table.levyFromKg) {
    return priced(
      table.underLevyWeight,
      rates.source,
      'HGV ' +
        weight.toLocaleString('en-GB') +
        'kg, under ' +
        table.levyFromKg.toLocaleString('en-GB') +
        'kg — no levy',
    );
  }
  const band = table.levy.find(b => weight <= b.maxKg)!;
  const euroVI = isEuroVI(facts);
  const levy = euroVI ? band.euroVIOrLater : band.euroVOrEarlier;
  return priced(
    {
      twelveMonths: round2(table.ved.twelveMonths + levy.twelveMonths),
      sixMonths: round2(table.ved.sixMonths + levy.sixMonths),
      directDebitTotal: null,
    },
    rates.source,
    'HGV ' +
      weight.toLocaleString('en-GB') +
      'kg, ' +
      (euroVI ? 'Euro VI or later' : 'Euro V or earlier') +
      ' — £' +
      table.ved.twelveMonths +
      ' VED plus £' +
      levy.twelveMonths +
      ' levy',
  );
}

function bus(facts: VehicleFacts, rates: HeavyVehicleRates): VedCalculation {
  const seats = facts.seats;
  if (seats === null || seats < rates.buses.minSeats) {
    return unpriced('The number of seats is missing or below ' + rates.buses.minSeats + '.');
  }
  const band = rates.buses.bands.find(b => seats <= b.seatsMax)!;
  return priced(band.rate, rates.source, 'bus, ' + seats + ' seats');
}

function recovery(facts: VehicleFacts, rates: HeavyVehicleRates): VedCalculation {
  const weight = facts.grossWeightKg;
  if (weight === null) {
    return unpriced('The revenue weight is missing.');
  }
  const band = rates.recovery.find(b => weight <= b.maxKg)!;
  return priced(
    band.rate,
    rates.source,
    'recovery vehicle, ' + weight.toLocaleString('en-GB') + 'kg',
  );
}

function byEuroStatus(
  facts: VehicleFacts,
  table: { euroVIOrLater: VedRate; euroVOrEarlier: VedRate },
  source: string,
  what: string,
): VedCalculation {
  const euroVI = isEuroVI(facts);
  return priced(
    euroVI ? table.euroVIOrLater : table.euroVOrEarlier,
    source,
    what + ', ' + (euroVI ? 'Euro VI or later' : 'Euro V or earlier'),
  );
}

function isEuroVI(facts: VehicleFacts): boolean {
  if (facts.euroStatus !== null) {
    return facts.euroStatus >= 6;
  }
  return facts.firstRegistered !== null && facts.firstRegistered >= EURO_VI_REGISTERED_FROM;
}

/* --------------------------------------------------------------------------- */
/* helpers                                                                      */
/* --------------------------------------------------------------------------- */

const priced = (row: VedRate, source: string, what: string): VedCalculation => ({
  ved: {
    twelveMonth: row.twelveMonths,
    sixMonth: row.sixMonths,
    directDebit: row.directDebitTotal,
    basis: source + ': ' + what,
  },
});

const unpriced = (reason: string): VedCalculation => ({ ved: null, reason });

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** "2026-09-28" for the calendar day in the UK, which is the day DVLA counts in. */
export const isoDay = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date);

/** "2023-06-19" + 6 -> "2029-06-19". Compared as strings, so 29 February needs no care. */
const addYears = (isoDate: string, years: number): string =>
  String(Number(isoDate.slice(0, 4)) + years).padStart(4, '0') + isoDate.slice(4);

/** "2023-06-19T00:00:00Z" -> "2023-06-19", read off the string for the same reason `asDate` is. */
function day(value: unknown): string | null {
  const text = str(value);
  const match = text ? /^(\d{4}-\d{2}-\d{2})/.exec(text) : null;
  return match ? match[1] : null;
}

/** "6d", "6d-TEMP", "EURO 6", "Euro VI", "V" -> the number. */
function euroStatus(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const text = value.toUpperCase().replace(/EURO/g, '').trim();
  const digit = /(\d)/.exec(text);
  if (digit) {
    return Number(digit[1]);
  }
  const roman = /^(VI|V|IV|III|II|I)\b/.exec(text);
  return roman ? { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }[roman[1]]! : null;
}

const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

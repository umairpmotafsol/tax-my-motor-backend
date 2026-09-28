/**
 * DVLA's published vehicle tax rates, as tables.
 *
 * Used only when Vehicle Data Global returns no rate for a vehicle —
 * see `ved-calculator.ts`. The provider's figure always wins when it
 * has one.
 *
 * Copied from the leaflets, not derived: every figure below is one a
 * customer could find on gov.uk, including the Direct Debit totals,
 * which are 5% over the annual rate but are printed rather than
 * computed here so a rounding rule can never drift from DVLA's.
 *
 * DVLA republishes these every April (and the heavy vehicle leaflet
 * each summer). When it does, add a new block to the front of the
 * matching list with its `effectiveFrom` date and leave the old one in
 * place — the calculator picks whichever block had started on the day
 * it is asked, so the switch happens on the right date by itself.
 */

/** One row of a leaflet. `null` is DVLA's "–": the term is not sold. */
export interface VedRate {
  twelveMonths: number;
  sixMonths: number | null;
  /** "Total payable by 12 monthly instalments" — the Direct Debit column. */
  directDebitTotal: number | null;
}

const rate = (
  twelveMonths: number,
  sixMonths: number | null,
  directDebitTotal: number | null,
): VedRate => ({ twelveMonths, sixMonths, directDebitTotal });

/** The HGV levy for one weight band, by Euro status. No Direct Debit is offered. */
export interface LevyBand {
  /** Revenue weight, inclusive. The top band is `Infinity`. */
  maxKg: number;
  euroVIOrLater: { twelveMonths: number; sixMonths: number };
  euroVOrEarlier: { twelveMonths: number; sixMonths: number };
}

/* ------------------------------------------------------------------------ */
/* V149 — cars, motorcycles, light goods and private light goods vehicles    */
/* ------------------------------------------------------------------------ */

export interface LightVehicleRates {
  effectiveFrom: string;
  source: string;

  /**
   * Vehicles built before 1 January of this year are historic and
   * exempt — but only once the keeper has moved them into that class,
   * which is not something this app can do for them. Not on the V149;
   * DVLA's rolling 40-year rule, as it stands on `effectiveFrom`.
   */
  historicBuiltBefore: number;

  /**
   * A new car's first licence, by CO2. Twelve months only.
   *
   * Kept for completeness and deliberately unused: the first licence is
   * bought by whoever registers the car, so any renewal this app sells
   * is a second licence or later and pays the standard rate below.
   */
  firstLicence: Array<{
    /** Inclusive. The top band is `Infinity`. */
    co2Max: number;
    /** Petrol, alternative fuel, zero emission, and diesel tested to RDE2. */
    standard: number;
    /** Diesel tested to RDE (not RDE2). */
    dieselNotRde2: number;
  }>;

  /** Cars first registered on or after 1 April 2017. */
  post2017: {
    from: string;
    standard: VedRate;
    /** Standard plus the £440 expensive car supplement. */
    premium: VedRate;
    /** The supplement applies above this list price… */
    listPriceThreshold: number;
    /** …or above this one, for zero emission cars registered on or after `zeroEmissionThresholdFrom`. */
    zeroEmissionListPriceThreshold: number;
    zeroEmissionThresholdFrom: string;
    /** How long the supplement lasts, counted from the start of the second licence. */
    premiumYears: number;
  };

  /** Cars first registered between 1 March 2001 and 31 March 2017, by CO2. */
  co2Bands: {
    from: string;
    /** Cars over 225g/km registered before this date stay in band K. */
    bandKCapBefore: string;
    bands: Array<{ band: string; co2Max: number; rate: VedRate }>;
  };

  /** Private/light goods — cars and vans from before March 2001, and motor caravans. */
  privateLightGoods: {
    smallEngineMaxCc: number;
    smallEngine: VedRate;
    largeEngine: VedRate;
  };

  /** Light goods vehicles, 3,500kg and under. */
  lightGoods: {
    from: string;
    standard: VedRate;
    euro4: { from: string; to: string; rate: VedRate };
    euro5: { from: string; to: string; rate: VedRate };
  };

  /** Motorcycles and tricycles weighing 450kg or less; heavier ones are private/light goods. */
  twoAndThreeWheelers: {
    maxWeightKg: number;
    motorcycles: {
      zeroEmission: VedRate;
      bands: Array<{ ccMax: number; rate: VedRate }>;
    };
    tricycles: {
      zeroEmission: VedRate;
      smallEngineMaxCc: number;
      smallEngine: VedRate;
      other: VedRate;
    };
  };
}

export const LIGHT_VEHICLE_RATES: LightVehicleRates[] = [
  {
    effectiveFrom: '2026-04-01',
    source: 'V149 (April 2026)',
    historicBuiltBefore: 1986,

    firstLicence: [
      { co2Max: 0, standard: 10, dieselNotRde2: 10 },
      { co2Max: 50, standard: 115, dieselNotRde2: 135 },
      { co2Max: 75, standard: 135, dieselNotRde2: 280 },
      { co2Max: 90, standard: 280, dieselNotRde2: 365 },
      { co2Max: 100, standard: 365, dieselNotRde2: 405 },
      { co2Max: 110, standard: 405, dieselNotRde2: 455 },
      { co2Max: 130, standard: 455, dieselNotRde2: 560 },
      { co2Max: 150, standard: 560, dieselNotRde2: 1410 },
      { co2Max: 170, standard: 1410, dieselNotRde2: 2270 },
      { co2Max: 190, standard: 2270, dieselNotRde2: 3420 },
      { co2Max: 225, standard: 3420, dieselNotRde2: 4850 },
      { co2Max: 255, standard: 4850, dieselNotRde2: 5690 },
      { co2Max: Infinity, standard: 5690, dieselNotRde2: 5690 },
    ],

    post2017: {
      from: '2017-04-01',
      standard: rate(200, 110, 210),
      premium: rate(640, 352, 672),
      listPriceThreshold: 40_000,
      zeroEmissionListPriceThreshold: 50_000,
      zeroEmissionThresholdFrom: '2025-04-01',
      premiumYears: 5,
    },

    co2Bands: {
      from: '2001-03-01',
      bandKCapBefore: '2006-03-23',
      bands: [
        { band: 'A', co2Max: 100, rate: rate(20, null, 21) },
        { band: 'B', co2Max: 110, rate: rate(20, null, 21) },
        { band: 'C', co2Max: 120, rate: rate(35, null, 36.75) },
        { band: 'D', co2Max: 130, rate: rate(170, 93.5, 178.5) },
        { band: 'E', co2Max: 140, rate: rate(200, 110, 210) },
        { band: 'F', co2Max: 150, rate: rate(225, 123.75, 236.25) },
        { band: 'G', co2Max: 165, rate: rate(275, 151.25, 288.75) },
        { band: 'H', co2Max: 175, rate: rate(325, 178.75, 341.25) },
        { band: 'I', co2Max: 185, rate: rate(360, 198, 378) },
        { band: 'J', co2Max: 200, rate: rate(410, 225.5, 430.5) },
        { band: 'K', co2Max: 225, rate: rate(445, 244.75, 467.25) },
        { band: 'L', co2Max: 255, rate: rate(760, 418, 798) },
        { band: 'M', co2Max: Infinity, rate: rate(790, 434.5, 829.5) },
      ],
    },

    privateLightGoods: {
      smallEngineMaxCc: 1549,
      smallEngine: rate(230, 126.5, 241.5),
      largeEngine: rate(375, 206.25, 393.75),
    },

    lightGoods: {
      from: '2001-03-01',
      standard: rate(360, 198, 378),
      euro4: { from: '2003-03-01', to: '2006-12-31', rate: rate(140, 77, 147) },
      euro5: { from: '2009-01-01', to: '2010-12-31', rate: rate(140, 77, 147) },
    },

    twoAndThreeWheelers: {
      maxWeightKg: 450,
      motorcycles: {
        zeroEmission: rate(27, null, 28.35),
        bands: [
          { ccMax: 150, rate: rate(27, null, 28.35) },
          { ccMax: 400, rate: rate(59, 32.45, 61.95) },
          { ccMax: 600, rate: rate(90, 49.5, 94.5) },
          { ccMax: Infinity, rate: rate(125, 68.75, 131.25) },
        ],
      },
      tricycles: {
        zeroEmission: rate(27, null, 28.35),
        smallEngineMaxCc: 150,
        smallEngine: rate(27, null, 28.35),
        other: rate(125, 68.75, 131.25),
      },
    },
  },
];

/* ------------------------------------------------------------------------ */
/* V149/1 — HGVs, buses, special and other heavy vehicles                    */
/* ------------------------------------------------------------------------ */

export interface HeavyVehicleRates {
  effectiveFrom: string;
  source: string;

  /** Tax class 01. */
  hgv: {
    /** The levy starts here; below it (bands A0/B0) there is VED only. */
    levyFromKg: number;
    underLevyWeight: VedRate;
    /** The VED part at 12,000kg and over — the same £1 whatever the band. */
    ved: { twelveMonths: number; sixMonths: number };
    levy: LevyBand[];
  };

  /** Tax class 10. */
  privateHgv: VedRate;
  /** Tax class 14 — showman's, works trucks, digging machines, road rollers, mobile cranes, pumps. */
  specialVehicle: VedRate;
  /** Tax class 16. */
  smallIsland: VedRate;
  /** Tax class 34, by seats including the driver's. */
  buses: { minSeats: number; bands: Array<{ seatsMax: number; rate: VedRate }> };
  /** Tax class 47, by revenue weight. */
  recovery: Array<{ maxKg: number; rate: VedRate }>;
  /** Tax class 57 — VED and levy together. */
  specialTypes: { euroVIOrLater: VedRate; euroVOrEarlier: VedRate };
  /** Tax class 23 — VED and levy together. */
  combinedTransport: { euroVIOrLater: VedRate; euroVOrEarlier: VedRate };
  /** Tax class 55. */
  generalHaulage: VedRate;
}

export const HEAVY_VEHICLE_RATES: HeavyVehicleRates[] = [
  {
    effectiveFrom: '2026-07-01',
    source: 'V149/1 (July 2026)',

    hgv: {
      levyFromKg: 12_000,
      underLevyWeight: rate(1, 0.55, null),
      ved: { twelveMonths: 1, sixMonths: 0.5 },
      levy: [
        {
          maxKg: 31_000,
          euroVIOrLater: { twelveMonths: 161, sixMonths: 96.6 },
          euroVOrEarlier: { twelveMonths: 209, sixMonths: 125.4 },
        },
        {
          maxKg: 38_000,
          euroVIOrLater: { twelveMonths: 387, sixMonths: 232.2 },
          euroVOrEarlier: { twelveMonths: 503, sixMonths: 301.8 },
        },
        {
          // Also covers anything over 44,000kg, which the leaflet prices the same.
          maxKg: Infinity,
          euroVIOrLater: { twelveMonths: 619, sixMonths: 371.4 },
          // Printed £484.40 on page 3 of the leaflet; £482.40 on pages 1, 2 and 4.
          euroVOrEarlier: { twelveMonths: 804, sixMonths: 482.4 },
        },
      ],
    },

    privateHgv: rate(177, 97.35, 185.85),
    specialVehicle: rate(177, 97.35, 185.85),
    smallIsland: rate(1, 0.55, null),

    buses: {
      minSeats: 10,
      bands: [
        { seatsMax: 17, rate: rate(177, 97.35, 185.85) },
        { seatsMax: 36, rate: rate(240, 132, 252) },
        { seatsMax: 61, rate: rate(350, 192.5, 367.5) },
        { seatsMax: Infinity, rate: rate(530, 291.5, 556.5) },
      ],
    },

    recovery: [
      { maxKg: 25_000, rate: rate(177, 97.35, 185.85) },
      { maxKg: Infinity, rate: rate(440, 242, 462) },
    ],

    specialTypes: {
      euroVIOrLater: rate(620, 371.9, null),
      euroVOrEarlier: rate(805, 482.9, null),
    },
    combinedTransport: {
      euroVIOrLater: rate(620, 371.9, null),
      euroVOrEarlier: rate(805, 482.9, null),
    },

    generalHaulage: rate(380, 209, 399),
  },
];

/**
 * The block in force on `day` ("2026-09-28"): the latest one that has
 * started. Before the earliest block, the earliest — it is the closest
 * thing on file, and these lists only ever hold current rates or newer.
 */
export function ratesOn<T extends { effectiveFrom: string }>(list: T[], day: string): T {
  const started = list
    .filter(block => block.effectiveFrom <= day)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return started[0] ?? [...list].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
}

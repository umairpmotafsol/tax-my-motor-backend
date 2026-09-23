import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AppConfig } from '../../config/configuration';
import { formatReg, isValidReg, normaliseReg } from '../../common/utils/format.util';
import { Vehicle, VehicleDocument } from './schemas/vehicle.schema';
import {
  VehicleTaxLookup,
  VehicleTaxLookupDocument,
} from './schemas/vehicle-tax-lookup.schema';
import { VehicleDataClient, VehicleDataError } from './vehicle-data.client';

export interface VehicleLookup {
  reg: string;
  make: string;
  variant: string;
  /** "Ford Fiesta 1.0 EcoBoost" — make and variant, as every list row shows it. */
  model: string;
  colour: string;
  vin: string;
  /** Doubles as the DVLA taxation class on the V62. */
  taxClass: string;
  /** False when this came from the fallback rather than the register. */
  known: boolean;
}

/** Which of the provider's rate tables a quote was taken from. */
export type VedBand = 'first-year' | 'premium' | 'standard';

/**
 * The tax picture the apps are allowed to see.
 *
 * Vehicle Data Global's Tax package returns a good deal more than this
 * — document versions, billing, the rate tables that do not apply to
 * this car. None of it means anything on a screen that asks "is this
 * car taxed, and what would six or twelve months cost", so none of it
 * is served. The full response is kept in the lookup cache instead,
 * where support can read it without paying for the plate a second time.
 */
export interface VehicleTaxInfo {
  reg: string;
  make: string | null;
  yearOfManufacture: number | null;
  /** "Taxed", "Untaxed", "SORN" — the DVLA wording, shown as-is. */
  taxStatus: string | null;
  isTaxed: boolean | null;
  /** "2026-03-01". Date only: the provider's time component is always midnight. */
  taxDueDate: string | null;
  daysRemaining: number | null;
  motStatus: string | null;
  co2Emissions: number | null;
  co2Band: string | null;
  /**
   * What this car actually costs to tax, for the terms the app sells.
   *
   * `band` says which of the provider's rate tables it came from, so a
   * quote can be explained: a car in its first year and a car over
   * £40,000 both pay more than the standard rate, and the provider
   * returns those as separate tables with the inapplicable ones null.
   */
  ved: { sixMonth: number | null; twelveMonth: number | null; band: VedBand } | null;
  /** When the provider was actually called, not when this request was served. */
  checkedAt: string;
  /** Where the answer came from, so the apps can say "as of ..." honestly. */
  source: 'live' | 'cache' | 'sample';
  /** True when the cache was past its TTL and no fresh call could be made. */
  stale: boolean;
}

/** The mapped part that is worth storing — the rest is decided per request. */
type CachedTax = Omit<VehicleTaxInfo, 'source' | 'stale'>;

/**
 * Bump this whenever `mapTaxResponse` or `mapVehicleResponse` changes
 * what it reads out of a provider response.
 *
 * Cached rows store the mapped view, not just the raw one, so without
 * a version a mapping fix reaches only the plates nobody has looked up
 * yet. Raising it makes every older row rebuild itself from its stored
 * response on next read — no second call to the provider, and no
 * waiting for a day-long TTL to expire.
 *
 * 2: the VED table is chosen by the vehicle's age. Before this, tables
 *    were read in a fixed order and a five-year-old car was priced at
 *    its first-year rate.
 */
const MAPPING_VERSION = 2;

/**
 * The identity half of a lookup.
 *
 * The Tax package carries only `Make`; model, colour, VIN and fuel type
 * come from the optional identity package and stay null without it.
 * Null rather than a guess: these go onto the order and the V62, where
 * a plausible invention is worse than a blank.
 */
interface CachedVehicle {
  make: string | null;
  variant: string | null;
  colour: string | null;
  vin: string | null;
  fuelType: string | null;
  yearOfManufacture: number | null;
}

/** One resolved plate, whatever it took to get it. */
interface ResolvedVehicle {
  details: CachedTax;
  vehicle: CachedVehicle | null;
  source: 'live' | 'cache' | 'sample';
  stale: boolean;
}

/**
 * Anything not in the register resolves to one of these. Deterministic
 * rather than random, so a plate looked up twice gives the same car —
 * a quote the customer comes back to must not have become a different
 * vehicle in the meantime.
 */
const FALLBACK_VEHICLES = [
  { make: 'Ford Focus', variant: '1.5 EcoBlue', colour: 'Black', vin: 'WF0DXXGCHDES23456', fuelType: 'Diesel' },
  { make: 'Nissan Qashqai', variant: '1.3 DIG-T', colour: 'White', vin: 'SJNFAAJ11U1234567', fuelType: 'Petrol' },
  { make: 'BMW 3 Series', variant: '320d M Sport', colour: 'Silver', vin: 'WBA8E9106J5K34567', fuelType: 'Diesel' },
  { make: 'Toyota Yaris', variant: '1.5 Hybrid', colour: 'Green', vin: 'SB1KW56Y10E145678', fuelType: 'Hybrid' },
  { make: 'Mini Cooper', variant: '1.5 Classic', colour: 'British Racing Green', vin: 'WMWXM3103F2C56789', fuelType: 'Petrol' },
];

@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);
  private readonly cacheTtlMs: number;
  private readonly isProduction: boolean;

  constructor(
    @InjectModel(Vehicle.name) private readonly vehicleModel: Model<VehicleDocument>,
    @InjectModel(VehicleTaxLookup.name)
    private readonly taxCacheModel: Model<VehicleTaxLookupDocument>,
    private readonly vehicleData: VehicleDataClient,
    private readonly config: ConfigService,
  ) {
    this.cacheTtlMs = this.config.get<AppConfig['vehicleData']>('vehicleData')!.cacheTtlMs;
    this.isProduction = this.config.get<string>('env') === 'production';
  }

  /**
   * Resolve a registration against Vehicle Data Global.
   *
   * The provider is asked first, through the same cached, budgeted path
   * the tax check uses — so entering a plate and pricing it cost one
   * call between them, not one each. The local register is consulted
   * only when the provider cannot answer, and the deterministic
   * fallback only in development, where there is no key to answer with.
   *
   * `known` is the honest part: true only when the answer came from the
   * provider or a curated register entry, false when it is a stand-in.
   */
  async lookup(reg: string): Promise<VehicleLookup> {
    if (!isValidReg(reg)) {
      throw new BadRequestException('That does not look like a UK registration.');
    }
    const bare = normaliseReg(reg);

    try {
      const resolved = await this.resolve(bare);
      const identity = resolved.vehicle;
      if (identity?.make) {
        return this.shape(
          bare,
          identity.make,
          identity.variant ?? '',
          identity.colour ?? '',
          identity.vin ?? '',
          identity.fuelType ?? '',
          true,
        );
      }
    } catch (err) {
      if (!(err instanceof VehicleDataError)) {
        throw err;
      }
      this.logger.warn('Lookup for ' + bare + ' fell back (' + err.reason + ').');
    }

    const found = await this.vehicleModel.findOne({ reg: bare });
    if (found) {
      return this.shape(bare, found.make, found.variant, found.colour, found.vin, found.fuelType, true);
    }

    // No provider answer and nothing on file. In production that is a
    // real failure and saying so beats inventing a car the customer
    // would then be quoted and taxed against.
    if (this.isProduction) {
      throw new NotFoundException('We could not find a vehicle with that registration.');
    }

    const seed = [...bare].reduce((total, char) => total + char.charCodeAt(0), 0);
    const fallback = FALLBACK_VEHICLES[seed % FALLBACK_VEHICLES.length];
    return this.shape(
      bare,
      fallback.make,
      fallback.variant,
      fallback.colour,
      fallback.vin,
      fallback.fuelType,
      false,
    );
  }

  /** Adds or refreshes a register entry. */
  async upsert(entry: {
    reg: string;
    make: string;
    variant?: string;
    colour?: string;
    vin?: string;
    fuelType?: string;
  }): Promise<VehicleDocument> {
    const bare = normaliseReg(entry.reg);
    return this.vehicleModel.findOneAndUpdate(
      { reg: bare },
      {
        $set: {
          reg: bare,
          make: entry.make,
          variant: entry.variant ?? '',
          colour: entry.colour ?? '',
          vin: entry.vin ?? '',
          fuelType: entry.fuelType ?? 'Petrol',
          lastCheckedAt: new Date(),
        },
      },
      { new: true, upsert: true },
    );
  }

  async count(): Promise<number> {
    return this.vehicleModel.countDocuments();
  }

  /* ------------------------------- live tax check ----------------------------- */

  /**
   * The DVLA tax status for a plate, via Vehicle Data Global's Tax
   * package.
   *
   * Separate from `lookup()`, which every order and V62 depends on and
   * must keep resolving with no key at all. This one is billed per
   * answer, so it is cache-first: a plate looked up twice inside the
   * TTL is paid for once, and when the provider cannot be reached a
   * stale answer is served in preference to an error.
   */
  async checkTax(reg: string): Promise<VehicleTaxInfo> {
    if (!isValidReg(reg)) {
      throw new BadRequestException('That does not look like a UK registration.');
    }
    const bare = normaliseReg(reg);

    try {
      const resolved = await this.resolve(bare);
      return { ...resolved.details, source: resolved.source, stale: resolved.stale };
    } catch (err) {
      throw err instanceof VehicleDataError ? this.toHttp(err) : err;
    }
  }

  /**
   * One plate, one bill.
   *
   * Both the registration screen and the tax check come through here,
   * so a customer who enters a plate and is then quoted for it is paid
   * for once. A cache row inside its TTL answers without a call; past
   * it, the provider is asked and the row replaced; and when the
   * provider cannot be reached the expired row is served rather than
   * paying again or failing outright.
   *
   * Throws `VehicleDataError` — the callers decide what that means for
   * their screen.
   */
  private async resolve(bare: string): Promise<ResolvedVehicle> {
    let cached = await this.taxCacheModel.findOne({ reg: bare }).lean();

    if (cached && (cached.mappingVersion ?? 0) < MAPPING_VERSION && cached.raw) {
      cached = await this.remap(bare, cached);
    }

    const readCache = (stale: boolean): ResolvedVehicle => ({
      details: cached!.details as unknown as CachedTax,
      vehicle: (cached!.vehicle as unknown as CachedVehicle | null) ?? null,
      source: cached!.source === 'sample' ? 'sample' : 'cache',
      stale,
    });

    if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < this.cacheTtlMs) {
      return readCache(false);
    }

    try {
      const { payload, source } = await this.vehicleData.fetchTax(bare);
      // Only worth a second billed call once the first has succeeded.
      const identity = await this.vehicleData.fetchDetails(bare);
      const details = this.mapTaxResponse(bare, payload);
      const vehicle = this.mapVehicleResponse(payload, identity?.payload ?? null);

      await this.taxCacheModel.updateOne(
        { reg: bare },
        {
          $set: {
            reg: bare,
            raw: payload,
            detailsRaw: identity?.payload ?? null,
            details,
            vehicle,
            source,
            fetchedAt: new Date(),
            mappingVersion: MAPPING_VERSION,
          },
        },
        { upsert: true },
      );
      return { details, vehicle, source, stale: false };
    } catch (err) {
      if (!(err instanceof VehicleDataError)) {
        throw err;
      }
      // An expired answer still beats no answer — a tax due date does
      // not move, and the alternative is a dead screen or another bill.
      if (cached && err.reason !== 'not-found') {
        this.logger.warn('Serving a stale lookup for ' + bare + ' (' + err.reason + ').');
        return readCache(true);
      }
      throw err;
    }
  }

  /**
   * The rates pricing needs, for one plate.
   *
   * Goes through `checkTax`, so it shares the cache and the daily
   * ceiling with everything else — pricing a quote does not buy a
   * second lookup of a plate the customer has already entered.
   */
  async vedFor(reg: string): Promise<VehicleTaxInfo> {
    return this.checkTax(reg);
  }

  /**
   * Rebuild a cached row's mapped view from the response already stored
   * against it.
   *
   * This is what `raw` is kept for. When the mapper changes, every row
   * cached before it still serves the old reading — and the old reading
   * here was a five-year-old car priced at its first-year rate, £1,410
   * against a true £200. The alternatives were both bad: wait out the
   * TTL and keep quoting the wrong figure for a day, or drop the rows
   * and buy every plate a second time.
   *
   * `checkedAt` is carried over deliberately. The provider was called
   * when it was called; re-reading its answer is not a fresh lookup,
   * and saying otherwise would make a stale row look current.
   */
  private async remap(
    bare: string,
    cached: NonNullable<Awaited<ReturnType<VehiclesService['findCached']>>>,
  ): Promise<typeof cached> {
    const raw = cached.raw as Record<string, unknown>;
    const previous = cached.details as unknown as Partial<CachedTax> | null;
    const details: CachedTax = {
      ...this.mapTaxResponse(bare, raw),
      checkedAt: previous?.checkedAt ?? new Date(cached.fetchedAt).toISOString(),
    };
    const vehicle = this.mapVehicleResponse(
      raw,
      (cached.detailsRaw as Record<string, unknown> | null) ?? null,
    );

    await this.taxCacheModel.updateOne(
      { reg: bare },
      { $set: { details, vehicle, mappingVersion: MAPPING_VERSION } },
    );
    this.logger.log(
      'Re-read the stored response for ' + bare + ' at mapping v' + MAPPING_VERSION + '.',
    );

    /* The lean row types these as loose records; they are read back
     * through the same casts `readCache` uses. */
    return {
      ...cached,
      details: details as unknown as typeof cached.details,
      vehicle: vehicle as unknown as typeof cached.vehicle,
      mappingVersion: MAPPING_VERSION,
    };
  }

  /** Narrow helper, so `remap` can name the lean row's type. */
  private findCached(reg: string) {
    return this.taxCacheModel.findOne({ reg }).lean();
  }

  private toHttp(err: VehicleDataError): Error {
    switch (err.reason) {
      case 'not-found':
        return new NotFoundException('We could not find a tax record for that registration.');
      case 'not-configured':
        return new ServiceUnavailableException(
          'Vehicle tax lookup is not configured yet — set VEHICLE_DATA_API_KEY and VEHICLE_DATA_LIVE=true.',
        );
      case 'budget-spent':
        return new ServiceUnavailableException(
          'Tax lookups are temporarily unavailable. Please try again later.',
        );
      default:
        return new ServiceUnavailableException(
          'The tax lookup service did not respond. Please try again.',
        );
    }
  }

  /**
   * Reads `Results.VehicleTaxDetails` — the shape documented at
   * vehicledataglobal.com/DataSources/VehicleTaxDetails and mirrored in
   * `fixtures/vehicle-tax.sample.ts`, which is what this is written
   * against. Anything missing comes back null rather than guessed.
   */
  private mapTaxResponse(bare: string, payload: Record<string, unknown>): CachedTax {
    const results = asObject(payload.Results) ?? payload;
    const tax = asObject(results.VehicleTaxDetails) ?? {};
    const duty = asObject(tax.VehicleExciseDutyDetails) ?? {};
    const rates = asObject(duty.VedRate) ?? {};

    /*
     * Which rate table this car actually pays from.
     *
     * The provider returns the whole post-2017 schedule at once, not
     * the one line that applies: a 2021 car comes back with a
     * first-year rate, a premium rate and a standard rate all
     * populated, and only a pre-2017 car has the inapplicable ones
     * nulled. So the table has to be chosen here, by the car's age,
     * and reading them in a fixed order is how a five-year-old car
     * gets quoted its first-year rate — £1,410 against a true £200.
     *
     * The first-year rate is paid once, on a car's first licence, so it
     * is only considered for a car built this year. That is a year
     * coarser than the real rule, which runs twelve months from first
     * registration, and it is deliberately the cautious side of it:
     * the provider sends no registration date, and of the two ways to
     * be wrong, quoting the standard rate to a brand-new car loses a
     * few pounds, while quoting the first-year rate to an old one
     * overcharges by an order of magnitude.
     *
     * Standard is then preferred over premium because the £40,000
     * supplement turns on list price, which is in no field here — the
     * premium figures come back identical for every post-2017 car, so
     * they are the generic supplement rather than a judgement about
     * this one. Premium is kept last as a fallback so a car that
     * somehow has only that table is still priced rather than refused.
     */
    const builtYear = asNumber(tax.YearOfManufacture);
    const builtThisYear = builtYear !== null && builtYear >= new Date().getFullYear();

    const bands: Array<[VedBand, unknown]> = builtThisYear
      ? [
          ['first-year', rates.FirstYear],
          ['standard', rates.Standard],
          ['premium', rates.PremiumVehicle],
        ]
      : [
          ['standard', rates.Standard],
          ['first-year', rates.FirstYear],
          ['premium', rates.PremiumVehicle],
        ];
    const applicable = bands
      .map(([band, table]) => ({ band, table: asObject(table) }))
      .find(entry => entry.table && (asNumber(entry.table.SixMonths) !== null || asNumber(entry.table.TwelveMonths) !== null));

    return {
      reg: formatReg(bare),
      make: asString(tax.Make),
      yearOfManufacture: asNumber(tax.YearOfManufacture),
      taxStatus: asString(tax.TaxStatus),
      isTaxed: typeof tax.TaxIsCurrentlyValid === 'boolean' ? tax.TaxIsCurrentlyValid : null,
      taxDueDate: asDate(tax.TaxDueDate),
      daysRemaining: asNumber(tax.TaxDaysRemaining),
      motStatus: asString(tax.MotStatus),
      co2Emissions: asNumber(tax.Co2Emissions) ?? asNumber(duty.DvlaCo2),
      co2Band: asString(duty.DvlaCo2Band) ?? asString(duty.DvlaBand),
      ved: applicable?.table
        ? {
            sixMonth: asNumber(applicable.table.SixMonths),
            twelveMonth: asNumber(applicable.table.TwelveMonths),
            band: applicable.band,
          }
        : null,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * The identity fields, from whichever package supplied them.
   *
   * The Tax package gives `Make` and the year and nothing else, so with
   * no identity package configured that is all this returns and the
   * rest stays null. The identity packages name their fields with a
   * `Dvla` prefix and wrap them under their own Results block, so both
   * spellings are read and the first that answers wins.
   */
  private mapVehicleResponse(
    taxPayload: Record<string, unknown>,
    identityPayload: Record<string, unknown> | null,
  ): CachedVehicle {
    const taxBlock =
      asObject(asObject(taxPayload.Results)?.VehicleTaxDetails) ?? {};
    const identity = identityPayload ? firstResultBlock(identityPayload) : {};

    return {
      make: asString(identity.DvlaMake) ?? asString(identity.Make) ?? asString(taxBlock.Make),
      variant: asString(identity.DvlaModel) ?? asString(identity.Model),
      colour: asString(identity.CurrentColour) ?? asString(identity.Colour),
      // Most licences return the last five digits only; a restricted
      // field arrives as the literal "LICENSE_RESTRICTED", which is not
      // a VIN and must not be written onto a V62.
      vin: asVin(identity.Vin) ?? asVin(identity.VinLast5),
      fuelType: asString(identity.DvlaFuelType) ?? asString(identity.FuelType),
      yearOfManufacture:
        asNumber(identity.YearOfManufacture) ?? asNumber(taxBlock.YearOfManufacture),
    };
  }

  private shape(
    bare: string,
    make: string,
    variant: string,
    colour: string,
    vin: string,
    fuelType: string,
    known: boolean,
  ): VehicleLookup {
    return {
      reg: formatReg(bare),
      make,
      variant,
      model: [make, variant].filter(Boolean).join(' '),
      colour,
      vin,
      taxClass: fuelType,
      known,
    };
  }
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Licence-restricted fields come back as a marker, not a value. */
const asVin = (value: unknown): string | null => {
  const text = asString(value);
  return text && !/^LICEN[SC]E_RESTRICTED$/i.test(text) ? text : null;
};

/**
 * The package's own block under `Results`, whatever it calls itself —
 * VehicleDetails, KeyVehicleDetails, and so on. Packages name their
 * block after themselves, and there is exactly one per response.
 */
const firstResultBlock = (payload: Record<string, unknown>): Record<string, unknown> => {
  const results = asObject(payload.Results) ?? payload;
  for (const value of Object.values(results)) {
    const block = asObject(value);
    if (block) {
      return block;
    }
  }
  return {};
};

/**
 * "2026-03-01T00:00:00" -> "2026-03-01".
 *
 * Read off the front of the string rather than parsed. The provider
 * sends a date-only value dressed as a timestamp with no zone, which
 * `Date` reads as local midnight — so east of Greenwich, converting it
 * back to an ISO string lands on the previous day and the customer is
 * told their tax runs out twenty-four hours early.
 */
const asDate = (value: unknown): string | null => {
  const text = asString(value);
  if (!text) {
    return null;
  }
  const leading = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (leading) {
    return leading[1];
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

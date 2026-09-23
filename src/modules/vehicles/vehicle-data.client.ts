import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AppConfig } from '../../config/configuration';
import { VEHICLE_TAX_SAMPLE } from './fixtures/vehicle-tax.sample';
import {
  VehicleDataUsage,
  VehicleDataUsageDocument,
} from './schemas/vehicle-data-usage.schema';

/** Why a lookup produced nothing, so the caller can answer sensibly. */
export type VehicleDataFailure =
  | 'not-configured' // no key, or live calls switched off
  | 'budget-spent' // the day's ceiling is reached
  | 'not-found' // the provider has no record of this plate
  | 'upstream'; // it refused, errored, or did not answer in time

export class VehicleDataError extends Error {
  constructor(
    readonly reason: VehicleDataFailure,
    message: string,
  ) {
    super(message);
    this.name = 'VehicleDataError';
  }
}

export interface VehicleDataResult {
  payload: Record<string, unknown>;
  source: 'live' | 'sample';
}

/**
 * The one place that talks to Vehicle Data Global.
 *
 * Every lookup is billed, so this is written as a spend gate first and
 * an HTTP client second. Nothing leaves the process unless live calls
 * are switched on and a key is present; concurrent requests for the
 * same plate are collapsed into one call; calls are spaced to the
 * provider's 1-per-second limit; and the day's calls are counted in the
 * database against a hard ceiling before the request is made, not
 * after.
 */
@Injectable()
export class VehicleDataClient {
  private readonly logger = new Logger(VehicleDataClient.name);
  private readonly settings: AppConfig['vehicleData'];
  private readonly isProduction: boolean;

  /** One in-flight call per package and registration — the rest wait on its promise. */
  private readonly inFlight = new Map<string, Promise<VehicleDataResult>>();

  /** Tail of the send queue, so calls leave at most one per interval. */
  private nextSlot = 0;

  constructor(
    @InjectModel(VehicleDataUsage.name)
    private readonly usageModel: Model<VehicleDataUsageDocument>,
    config: ConfigService,
  ) {
    this.settings = config.get<AppConfig['vehicleData']>('vehicleData')!;
    this.isProduction = config.get<string>('env') === 'production';
  }

  /** True when a live call is possible at all — the routes use it to explain themselves. */
  get enabled(): boolean {
    return Boolean(this.settings.live && this.settings.apiKey && this.settings.baseUrl);
  }

  /** How many calls are left today, for the health and admin views. */
  async remainingToday(): Promise<number> {
    const row = await this.usageModel.findOne({ day: utcDay() }).lean();
    return Math.max(0, this.settings.dailyCallLimit - (row?.calls ?? 0));
  }

  /**
   * Fetch the tax package for one registration.
   *
   * `bare` must already be normalised ("AB12CDE"). Throws
   * `VehicleDataError` rather than an HTTP exception, so the service
   * above can choose between answering from a stale cache and failing.
   */
  async fetchTax(bare: string): Promise<VehicleDataResult> {
    return this.fetchPackage(bare, this.settings.packageName);
  }

  /**
   * The identity package — model, colour, VIN, fuel type — or null when
   * none is configured. Null rather than an error: a registration
   * resolves on the Tax package alone, just with less on it, and a
   * missing optional package must not fail the screen.
   */
  async fetchDetails(bare: string): Promise<VehicleDataResult | null> {
    const pkg = this.settings.detailsPackage;
    if (!pkg) {
      return null;
    }
    try {
      return await this.fetchPackage(bare, pkg);
    } catch (err) {
      this.logger.warn(
        'Identity package "' + pkg + '" did not answer for ' + bare + ': ' + (err as Error).message,
      );
      return null;
    }
  }

  private async fetchPackage(bare: string, packageName: string): Promise<VehicleDataResult> {
    if (!this.enabled) {
      // Development gets the provider's own documented sample, so the
      // tax screens can be built and demoed without a penny spent. In
      // production a missing key is an outage, never invented tax.
      // The sample is a Tax-package response, so it only stands in for
      // that package. Anything else reports itself unconfigured rather
      // than pretending a package it has never seen returned nothing.
      if (!this.isProduction && packageName === this.settings.packageName) {
        this.logger.warn(
          'Vehicle Data Global is not live - serving the documented sample for ' + bare + '.',
        );
        return {
          payload: structuredClone(VEHICLE_TAX_SAMPLE) as unknown as Record<string, unknown>,
          source: 'sample',
        };
      }
      throw new VehicleDataError('not-configured', 'Vehicle tax lookup is not switched on.');
    }

    const key = packageName + ':' + bare;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const call = this.spend(bare, packageName).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, call);
    return call;
  }

  /* ----------------------------- the paid path ----------------------------- */

  private async spend(bare: string, packageName: string): Promise<VehicleDataResult> {
    await this.claimBudget();

    let payload: Record<string, unknown>;
    try {
      payload = await this.request(bare, packageName);
    } catch (err) {
      if (err instanceof VehicleDataError && err.reason === 'upstream') {
        // Nothing came back, so nothing was billed - hand the slot back
        // rather than let a flaky connection eat the day's budget.
        await this.releaseBudget();
      }
      throw err;
    }

    const status = readStatus(payload);
    if (status.code !== null && status.code !== 0) {
      // The provider charges only for a successful return, so a "no
      // record" answer costs nothing and should not cost budget either.
      await this.releaseBudget();
      throw new VehicleDataError(
        'not-found',
        status.message ?? 'No tax record was found for that registration.',
      );
    }

    return { payload, source: 'live' };
  }

  private async request(bare: string, packageName: string): Promise<Record<string, unknown>> {
    await this.waitForSlot();

    const url = new URL('/r2/lookup', trailingSlash(this.settings.baseUrl));
    url.searchParams.set('ApiKey', this.settings.apiKey);
    url.searchParams.set('PackageName', packageName);
    url.searchParams.set('Vrm', bare);

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
      });
      if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      // Never let the URL near a log line - the key is in the query string.
      this.logger.error(
        'Vehicle Data Global lookup failed for ' + bare + ': ' + (err as Error).message,
      );
      throw new VehicleDataError('upstream', 'The tax lookup service did not respond.');
    }
  }

  /* ------------------------------ spend guards ----------------------------- */

  /**
   * Take one call off today's budget, or refuse. The conditional
   * upsert is the whole point: two instances racing cannot both see
   * the last call as available, because only one update can match, and
   * the loser is rejected by the unique index on `day`.
   */
  private async claimBudget(): Promise<void> {
    const day = utcDay();
    const limit = this.settings.dailyCallLimit;
    if (limit <= 0) {
      throw new VehicleDataError('budget-spent', 'Vehicle tax lookups are capped at zero per day.');
    }
    try {
      await this.usageModel.findOneAndUpdate(
        { day, calls: { $lt: limit } },
        { $inc: { calls: 1 }, $setOnInsert: { day } },
        { new: true, upsert: true },
      );
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        this.logger.warn('Vehicle Data Global daily limit of ' + limit + ' reached.');
        throw new VehicleDataError(
          'budget-spent',
          'The daily vehicle tax lookup limit has been reached.',
        );
      }
      throw err;
    }
  }

  private async releaseBudget(): Promise<void> {
    await this.usageModel
      .updateOne({ day: utcDay(), calls: { $gt: 0 } }, { $inc: { calls: -1 } })
      .catch(() => undefined);
  }

  /** Holds the caller until this request's turn in the 1-per-second queue. */
  private async waitForSlot(): Promise<void> {
    const interval = this.settings.minCallIntervalMs;
    if (interval <= 0) {
      return;
    }
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + interval;
    if (slot > now) {
      await new Promise(resolve => setTimeout(resolve, slot - now));
    }
  }
}

const trailingSlash = (url: string): string => url.replace(/\/+$/, '') + '/';

/** "2026-09-18" in UTC - the budget resets on that boundary, not the server's local one. */
function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The provider reports status twice: once for the request as a whole
 * and once inside the package. Either being non-zero means there is no
 * usable data, so read whichever is present and non-zero first.
 */
function readStatus(payload: Record<string, unknown>): {
  code: number | null;
  message: string | null;
} {
  const envelope = (payload.ResponseInformation ?? payload.ResponseInfo ?? {}) as Record<
    string,
    unknown
  >;
  const results = (payload.Results ?? {}) as Record<string, unknown>;
  // Each package names its own block under Results — VehicleTaxDetails,
  // VehicleDetails, KeyVehicleDetails — so read whichever is there
  // rather than only the one the tax package uses.
  const blocks = Object.values(results).filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value),
  );
  const pkg = blocks[0] ?? {};

  for (const source of [envelope, ...blocks]) {
    const code = source.StatusCode;
    if (typeof code === 'number' && code !== 0) {
      return {
        code,
        message: typeof source.StatusMessage === 'string' ? source.StatusMessage : null,
      };
    }
  }
  const code =
    typeof envelope.StatusCode === 'number'
      ? envelope.StatusCode
      : typeof pkg.StatusCode === 'number'
        ? pkg.StatusCode
        : null;
  return { code, message: null };
}

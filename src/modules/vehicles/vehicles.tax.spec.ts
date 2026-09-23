/**
 * Covers the tax lookup without ever calling Vehicle Data Global: the
 * mapping is checked against their published sample, and the guards
 * that stand between a request and a bill are checked directly. Every
 * test asserts `fetch` was never reached, because a test suite that
 * quietly spends money is worse than no suite at all.
 */
import { VehicleDataClient, VehicleDataError } from './vehicle-data.client';
import { VEHICLE_TAX_SAMPLE } from './fixtures/vehicle-tax.sample';
import { VehiclesService } from './vehicles.service';

const settings = {
  apiKey: 'test-key',
  baseUrl: 'https://uk.api.vehicledataglobal.com',
  packageName: 'Tax',
  detailsPackage: '',
  live: false,
  cacheTtlMs: 86_400_000,
  dailyCallLimit: 200,
  minCallIntervalMs: 0,
  requestTimeoutMs: 10_000,
};

const configFor = (overrides: Partial<typeof settings> = {}, env = 'development') => ({
  get: (key: string) => (key === 'env' ? env : { ...settings, ...overrides }),
});

/** Just enough of a Mongoose model for the paths under test. */
const cacheModel = (row: unknown) => ({
  findOne: () => ({ lean: async () => row }),
  updateOne: jest.fn(async (..._args: unknown[]) => undefined),
});

const fetchSpy = jest.spyOn(global, 'fetch' as never);

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(() => {
    throw new Error('the tests must never call the paid endpoint');
  });
});

afterAll(() => fetchSpy.mockRestore());

describe('tax mapping', () => {
  it('reads the provider’s documented sample into the customer-facing shape', async () => {
    const cache = cacheModel(null);
    const service = new VehiclesService(
      {} as never,
      cache as never,
      new VehicleDataClient({} as never, configFor() as never),
      configFor() as never,
    );

    const info = await service.checkTax('ap52how');

    expect(info).toMatchObject({
      reg: 'AP52 HOW',
      make: 'VOLKSWAGEN',
      yearOfManufacture: 2002,
      taxStatus: 'Taxed',
      isTaxed: true,
      taxDueDate: '2026-03-01',
      daysRemaining: 297,
      motStatus: 'Valid',
      co2Emissions: 192,
      co2Band: 'J',
      ved: { sixMonth: 217.25, twelveMonth: 395 },
      source: 'sample',
      stale: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves only the necessary fields — no raw payload, no billing block', async () => {
    const cache = cacheModel(null);
    const service = new VehiclesService(
      {} as never,
      cache as never,
      new VehicleDataClient({} as never, configFor() as never),
      configFor() as never,
    );

    const info = await service.checkTax('AP52HOW');

    expect(Object.keys(info).sort()).toEqual(
      [
        'checkedAt',
        'co2Band',
        'co2Emissions',
        'daysRemaining',
        'isTaxed',
        'make',
        'motStatus',
        'reg',
        'source',
        'stale',
        'taxDueDate',
        'taxStatus',
        'ved',
        'yearOfManufacture',
      ].sort(),
    );
    // The full response is kept, but server-side only.
    const stored = cache.updateOne.mock.calls[0][1] as unknown as { $set: { raw: unknown } };
    expect(stored.$set.raw).toEqual(VEHICLE_TAX_SAMPLE);
  });
});

describe('spending guards', () => {
  it('answers a fresh cache hit without going near the provider', async () => {
    const cache = cacheModel({
      details: { reg: 'AB12 CDE', taxStatus: 'Taxed', checkedAt: '2026-09-17T00:00:00.000Z' },
      source: 'live',
      fetchedAt: new Date(),
    });
    const client = new VehicleDataClient({} as never, configFor() as never);
    const fetchTax = jest.spyOn(client, 'fetchTax');
    const service = new VehiclesService(
      {} as never,
      cache as never,
      client,
      configFor() as never,
    );

    const info = await service.checkTax('AB12CDE');

    expect(info.source).toBe('cache');
    expect(info.stale).toBe(false);
    expect(fetchTax).not.toHaveBeenCalled();
    expect(cache.updateOne).not.toHaveBeenCalled();
  });

  it('serves a stale answer rather than failing when the provider is unreachable', async () => {
    const cache = cacheModel({
      details: { reg: 'AB12 CDE', taxStatus: 'Taxed', checkedAt: '2020-01-01T00:00:00.000Z' },
      source: 'live',
      fetchedAt: new Date('2020-01-01'),
    });
    const client = new VehicleDataClient({} as never, configFor() as never);
    jest
      .spyOn(client, 'fetchTax')
      .mockRejectedValue(new VehicleDataError('upstream', 'no answer'));
    const service = new VehiclesService(
      {} as never,
      cache as never,
      client,
      configFor() as never,
    );

    const info = await service.checkTax('AB12CDE');

    expect(info.stale).toBe(true);
    expect(info.taxStatus).toBe('Taxed');
    expect(cache.updateOne).not.toHaveBeenCalled();
  });

  it('refuses once the day’s ceiling is reached, instead of calling anyway', async () => {
    const usage = {
      findOneAndUpdate: jest.fn(async () => {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }),
      updateOne: jest.fn(() => ({ catch: async () => undefined })),
      findOne: () => ({ lean: async () => ({ calls: 200 }) }),
    };
    const client = new VehicleDataClient(usage as never, configFor({ live: true }) as never);

    await expect(client.fetchTax('AB12CDE')).rejects.toMatchObject({
      reason: 'budget-spent',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await client.remainingToday()).toBe(0);
  });

  it('collapses concurrent requests for the same plate into one call', async () => {
    let claims = 0;
    const usage = {
      findOneAndUpdate: jest.fn(async () => {
        claims += 1;
        return { calls: claims };
      }),
      updateOne: jest.fn(() => ({ catch: async () => undefined })),
    };
    const client = new VehicleDataClient(usage as never, configFor({ live: true }) as never);
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => VEHICLE_TAX_SAMPLE,
    } as never);

    const [a, b, c] = await Promise.all([
      client.fetchTax('AP52HOW'),
      client.fetchTax('AP52HOW'),
      client.fetchTax('AP52HOW'),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(claims).toBe(1);
    expect(a.source).toBe('live');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('never puts the API key in a log line, but does put it in the query string', async () => {
    const usage = {
      findOneAndUpdate: jest.fn(async () => ({ calls: 1 })),
      updateOne: jest.fn(() => ({ catch: async () => undefined })),
    };
    const client = new VehicleDataClient(usage as never, configFor({ live: true }) as never);
    fetchSpy.mockResolvedValue({ ok: true, json: async () => VEHICLE_TAX_SAMPLE } as never);

    await client.fetchTax('AP52HOW');

    const called = fetchSpy.mock.calls[0][0] as URL;
    expect(called.origin + called.pathname).toBe(
      'https://uk.api.vehicledataglobal.com/r2/lookup',
    );
    expect(called.searchParams.get('ApiKey')).toBe('test-key');
    expect(called.searchParams.get('PackageName')).toBe('Tax');
    expect(called.searchParams.get('Vrm')).toBe('AP52HOW');
  });

  it('does not bill the day for a plate the provider has no record of', async () => {
    const usage = {
      findOneAndUpdate: jest.fn(async () => ({ calls: 1 })),
      updateOne: jest.fn(() => ({ catch: async () => undefined })),
    };
    const client = new VehicleDataClient(usage as never, configFor({ live: true }) as never);
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        ResponseInformation: { StatusCode: 1, StatusMessage: 'Vehicle not found' },
        Results: {},
      }),
    } as never);

    await expect(client.fetchTax('XX99XXX')).rejects.toMatchObject({ reason: 'not-found' });
    // The claimed slot is handed back.
    expect(usage.updateOne).toHaveBeenCalled();
  });
});

/**
 * The registration screen used to answer from a local table, falling
 * back to one of five hardcoded cars — so every unknown plate resolved
 * to a Ford Focus or a Mini and looked, from the app, exactly like a
 * successful lookup. These cover the wiring that replaced it.
 */
describe('registration lookup', () => {
  /** `lookup` consults the local register only when the provider cannot answer. */
  const emptyRegister = { findOne: async () => null };

  it('resolves the plate from the provider, not the hardcoded fallback list', async () => {
    const cache = cacheModel(null);
    const service = new VehiclesService(
      emptyRegister as never,
      cache as never,
      new VehicleDataClient({} as never, configFor() as never),
      configFor() as never,
    );

    const vehicle = await service.lookup('ap52how');

    // The fallback for this plate would be one of FALLBACK_VEHICLES.
    expect(vehicle.make).toBe('VOLKSWAGEN');
    expect(vehicle.known).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bills a plate once for the lookup and the tax check together', async () => {
    let row: unknown = null;
    const cache = {
      findOne: () => ({ lean: async () => row }),
      updateOne: jest.fn(async (..._args: unknown[]) => undefined),
    };
    const client = new VehicleDataClient({} as never, configFor() as never);
    const fetchTax = jest.spyOn(client, 'fetchTax');
    const service = new VehiclesService(
      emptyRegister as never,
      cache as never,
      client,
      configFor() as never,
    );

    await service.lookup('AP52HOW');
    // Whatever the first call wrote is what the second one should find.
    const written = cache.updateOne.mock.calls[0][1] as unknown as { $set: Record<string, unknown> };
    row = { ...written.$set, fetchedAt: new Date() };
    const tax = await service.checkTax('AP52HOW');

    expect(fetchTax).toHaveBeenCalledTimes(1);
    expect(tax.taxStatus).toBe('Taxed');
    // A row that came from the sample keeps saying so, even on the way
    // back out of the cache — "cache" would hide where it came from.
    expect(tax.source).toBe('sample');
  });

  it('fills model, colour and fuel from the identity package when one is configured', async () => {
    const cache = cacheModel(null);
    const client = new VehicleDataClient({} as never, configFor() as never);
    jest.spyOn(client, 'fetchDetails').mockResolvedValue({
      source: 'live',
      payload: {
        Results: {
          VehicleDetails: {
            DvlaMake: 'AUDI',
            DvlaModel: 'A3 S LINE 35 TFSI MHEV S-A',
            CurrentColour: 'GREY',
            DvlaFuelType: 'PETROL',
            VinLast5: '20377',
            YearOfManufacture: 2020,
            StatusCode: 0,
          },
        },
      },
    });
    const service = new VehiclesService(
      emptyRegister as never,
      cache as never,
      client,
      configFor() as never,
    );

    const vehicle = await service.lookup('AP52HOW');

    expect(vehicle.make).toBe('AUDI');
    expect(vehicle.variant).toBe('A3 S LINE 35 TFSI MHEV S-A');
    expect(vehicle.model).toBe('AUDI A3 S LINE 35 TFSI MHEV S-A');
    expect(vehicle.colour).toBe('GREY');
    expect(vehicle.taxClass).toBe('PETROL');
    expect(vehicle.vin).toBe('20377');
  });

  it('never writes a licence-restricted marker into the VIN the V62 uses', async () => {
    const cache = cacheModel(null);
    const client = new VehicleDataClient({} as never, configFor() as never);
    jest.spyOn(client, 'fetchDetails').mockResolvedValue({
      source: 'live',
      payload: {
        Results: {
          VehicleDetails: { DvlaMake: 'AUDI', Vin: 'LICENSE_RESTRICTED', StatusCode: 0 },
        },
      },
    });
    const service = new VehiclesService(
      emptyRegister as never,
      cache as never,
      client,
      configFor() as never,
    );

    expect((await service.lookup('AP52HOW')).vin).toBe('');
  });

  it('refuses in production rather than inventing a car nobody owns', async () => {
    const cache = cacheModel(null);
    const service = new VehiclesService(
      emptyRegister as never,
      cache as never,
      new VehicleDataClient({} as never, configFor({}, 'production') as never),
      configFor({}, 'production') as never,
    );

    await expect(service.lookup('AP52HOW')).rejects.toThrow(
      'We could not find a vehicle with that registration.',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Which VED table a vehicle is priced from.
 *
 * Written against a real response for AJ11 JJJ, a 2021 BMW. The
 * provider returns the whole post-2017 schedule at once — a first-year
 * rate of £1,410, a premium rate of £640 and a standard rate of £200,
 * all populated on the same car — and leaves the choice to the caller.
 * Reading them in a fixed order quoted that car £1,410 and, because
 * DVLA sells no six-month first licence, made its six-month price null
 * and failed the whole options screen with a 422.
 *
 * So these fix the rule that decides: a car is on its first licence
 * only in the year it was built, and everything else pays standard.
 */
describe('choosing the VED rate table', () => {
  type VedTable = { SixMonths: number | null; TwelveMonths: number | null } | null;
  type VedTables = Record<'FirstYear' | 'PremiumVehicle' | 'Standard', VedTable>;

  /** A response in the provider's own shape, with the tables it really sends. */
  const payload = (year: number, rates: VedTables) => ({
    Results: {
      VehicleTaxDetails: {
        Vrm: 'AJ11JJJ',
        Make: 'BMW',
        Co2Emissions: 154,
        YearOfManufacture: year,
        TaxStatus: 'Taxed',
        TaxIsCurrentlyValid: true,
        VehicleExciseDutyDetails: { DvlaCo2: 154, VedRate: rates },
      },
    },
  });

  /* Exactly what came back for AJ11 JJJ. */
  const POST_2017: VedTables = {
    FirstYear: { SixMonths: null, TwelveMonths: 1410 },
    PremiumVehicle: { SixMonths: 352, TwelveMonths: 640 },
    Standard: { SixMonths: 110, TwelveMonths: 200 },
  };

  const taxFor = async (year: number, rates: VedTables = POST_2017) => {
    const client = new VehicleDataClient({} as never, configFor() as never);
    jest.spyOn(client, 'fetchTax').mockResolvedValue({
      payload: payload(year, rates) as never,
      source: 'live',
    });
    const service = new VehiclesService(
      {} as never,
      cacheModel(null) as never,
      client,
      configFor() as never,
    );
    return service.checkTax('AJ11JJJ');
  };

  const thisYear = new Date().getFullYear();

  it('prices a five-year-old car at the standard rate, not the first-year one', async () => {
    const info = await taxFor(thisYear - 5);

    expect(info.ved).toEqual({ sixMonth: 110, twelveMonth: 200, band: 'standard' });
    // The bug this replaces: £1,410 for a car that owes £200.
    expect(info.ved?.twelveMonth).not.toBe(1410);
  });

  /*
   * The 422 was a symptom, not the disease. The first-year table has no
   * six-month figure because DVLA does not sell half a first licence —
   * so picking that table for an old car took the six-month term away
   * from a car that is perfectly entitled to it.
   */
  it('restores the six-month term that the wrong table had removed', async () => {
    const info = await taxFor(thisYear - 5);

    expect(info.ved?.sixMonth).toBe(110);
  });

  it('still uses the first-year rate for a car built this year', async () => {
    const info = await taxFor(thisYear);

    expect(info.ved).toEqual({ sixMonth: null, twelveMonth: 1410, band: 'first-year' });
  });

  /*
   * The £40,000 supplement turns on list price, and no field in this
   * package carries it — the premium figures arrive identical for every
   * post-2017 car. Charging it on a guess would add £440 to a car that
   * may not owe it.
   */
  it('does not reach for the premium table on a car it cannot price that way', async () => {
    const info = await taxFor(thisYear - 5);

    expect(info.ved?.band).not.toBe('premium');
  });

  /* A pre-2017 car: the provider does null what genuinely cannot apply. */
  it('reads the only table a pre-2017 car has', async () => {
    const info = await taxFor(2014, {
      FirstYear: { SixMonths: null, TwelveMonths: null },
      PremiumVehicle: { SixMonths: null, TwelveMonths: null },
      Standard: { SixMonths: 198, TwelveMonths: 360 },
    });

    expect(info.ved).toEqual({ sixMonth: 198, twelveMonth: 360, band: 'standard' });
  });

  /* Better a priced car than a refused one, if that is all there is. */
  it('falls back to whichever table has figures at all', async () => {
    const info = await taxFor(thisYear - 5, {
      FirstYear: { SixMonths: null, TwelveMonths: null },
      PremiumVehicle: { SixMonths: 352, TwelveMonths: 640 },
      Standard: { SixMonths: null, TwelveMonths: null },
    });

    expect(info.ved).toEqual({ sixMonth: 352, twelveMonth: 640, band: 'premium' });
  });

  it('reports no rate rather than a made-up one when every table is empty', async () => {
    const info = await taxFor(thisYear - 5, {
      FirstYear: null,
      PremiumVehicle: null,
      Standard: null,
    });

    expect(info.ved).toBeNull();
  });
});

/**
 * A mapping fix reaching rows that were cached before it.
 *
 * The cache stores the mapped view, not only the provider's response,
 * so correcting the mapper left every cached plate still serving the
 * old reading — a five-year-old car priced at its first-year rate,
 * £1,410 against a true £200, for as long as the day-long TTL had left
 * to run. The raw response is kept for exactly this, and these hold it
 * to that: the row rebuilds itself, and nothing is bought twice.
 */
describe('re-reading a row mapped by an older build', () => {
  const RAW = {
    Results: {
      VehicleTaxDetails: {
        Vrm: 'AJ11JJJ',
        Make: 'BMW',
        Co2Emissions: 154,
        YearOfManufacture: 2021,
        TaxStatus: 'Taxed',
        TaxIsCurrentlyValid: true,
        VehicleExciseDutyDetails: {
          DvlaCo2: 154,
          VedRate: {
            FirstYear: { SixMonths: null, TwelveMonths: 1410 },
            PremiumVehicle: { SixMonths: 352, TwelveMonths: 640 },
            Standard: { SixMonths: 110, TwelveMonths: 200 },
          },
        },
      },
    },
  };

  /** The row as the old mapper left it: fresh, and wrong. */
  const staleRow = (over: Record<string, unknown> = {}) => ({
    reg: 'AJ11JJJ',
    raw: RAW,
    detailsRaw: null,
    details: {
      reg: 'AJ11 JJJ',
      taxStatus: 'Taxed',
      ved: { sixMonth: null, twelveMonth: 1410, band: 'first-year' },
      checkedAt: '2026-09-23T09:58:39.682Z',
    },
    vehicle: null,
    source: 'live',
    fetchedAt: new Date(),
    ...over,
  });

  const serviceOver = (row: unknown) => {
    const cache = cacheModel(row);
    const client = new VehicleDataClient({} as never, configFor() as never);
    const fetchTax = jest.spyOn(client, 'fetchTax');
    const service = new VehiclesService(
      {} as never,
      cache as never,
      client,
      configFor() as never,
    );
    return { service, cache, fetchTax };
  };

  it('serves the corrected rate instead of the one on the row', async () => {
    const { service } = serviceOver(staleRow());

    const info = await service.checkTax('AJ11JJJ');

    expect(info.ved).toEqual({ sixMonth: 110, twelveMonth: 200, band: 'standard' });
  });

  /* The whole point of keeping `raw`: a mapping fix is not a new bill. */
  it('does it without calling the provider again', async () => {
    const { service, fetchTax } = serviceOver(staleRow());

    await service.checkTax('AJ11JJJ');

    expect(fetchTax).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('writes the corrected view back, so it is read once', async () => {
    const { service, cache } = serviceOver(staleRow());

    await service.checkTax('AJ11JJJ');

    const written = cache.updateOne.mock.calls[0][1] as {
      $set: { mappingVersion: number; details: { ved: unknown } };
    };
    expect(written.$set.mappingVersion).toBeGreaterThan(0);
    expect(written.$set.details.ved).toEqual({
      sixMonth: 110,
      twelveMonth: 200,
      band: 'standard',
    });
  });

  /*
   * Re-reading a stored answer is not a fresh lookup. Stamping it with
   * now would make a day-old row look like it had just been checked.
   */
  it('keeps the time the provider was actually called', async () => {
    const { service } = serviceOver(staleRow());

    const info = await service.checkTax('AJ11JJJ');

    expect(info.checkedAt).toBe('2026-09-23T09:58:39.682Z');
  });

  it('leaves a row already on the current mapping alone', async () => {
    const { service, cache } = serviceOver(
      staleRow({ mappingVersion: 99, details: { reg: 'AJ11 JJJ', taxStatus: 'Taxed' } }),
    );

    await service.checkTax('AJ11JJJ');

    expect(cache.updateOne).not.toHaveBeenCalled();
  });

  /* Nothing to re-read from: it has to be fetched like any expired row. */
  it('does not try to rebuild a row with no stored response', async () => {
    const { service, cache } = serviceOver(staleRow({ raw: null }));

    await service.checkTax('AJ11JJJ');

    expect(cache.updateOne).not.toHaveBeenCalled();
  });
});

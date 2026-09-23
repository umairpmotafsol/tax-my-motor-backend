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

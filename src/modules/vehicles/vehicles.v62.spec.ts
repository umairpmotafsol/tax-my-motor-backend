/**
 * The vehicle half of a V62: the identity package is bought for a plate
 * whose tax lookup left it undescribed, once, and never otherwise. As in
 * vehicles.tax.spec, nothing here reaches the paid endpoint.
 */
import { VehicleDataClient } from './vehicle-data.client';
import { VEHICLE_TAX_SAMPLE } from './fixtures/vehicle-tax.sample';
import { VehiclesService } from './vehicles.service';

const settings = {
  apiKey: 'test-key',
  baseUrl: 'https://uk.api.vehicledataglobal.com',
  packageName: 'Tax',
  detailsPackage: 'VehicleDetails',
  valuationPackage: '',
  live: false,
  cacheTtlMs: 86_400_000,
  dailyCallLimit: 200,
  minCallIntervalMs: 0,
  requestTimeoutMs: 10_000,
};

const config = { get: (key: string) => (key === 'env' ? 'development' : settings) };

/** A cache that remembers what it is told, so a second read sees the first write. */
const rememberingCache = () => {
  let row: Record<string, unknown> | null = null;
  return {
    findOne: () => ({ lean: async () => row }),
    updateOne: jest.fn(async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
      row = { ...(row ?? {}), ...update.$set };
    }),
  };
};

const emptyRegister = { findOne: async () => null };

const IDENTITY = {
  Results: {
    VehicleDetails: {
      VehicleIdentification: {
        DvlaMake: 'VOLKSWAGEN',
        DvlaModel: 'GOLF GTI',
        Vin: 'WVWZZZ1JZ2W386752',
        DvlaFuelType: 'PETROL',
        YearOfManufacture: 2002,
      },
      VehicleHistory: { ColourDetails: { CurrentColour: 'SILVER' } },
      StatusCode: 0,
    },
  },
};

const fetchSpy = jest.spyOn(global, 'fetch' as never) as unknown as jest.SpyInstance;

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(() => {
    throw new Error('the tests must never call the paid endpoint');
  });
});

afterAll(() => fetchSpy.mockRestore());

function setup(details: unknown) {
  const cache = rememberingCache();
  const client = new VehicleDataClient({} as never, config as never);
  jest.spyOn(client, 'fetchTax').mockResolvedValue({
    payload: structuredClone(VEHICLE_TAX_SAMPLE) as unknown as Record<string, unknown>,
    source: 'live',
  });
  const fetchDetails = jest
    .spyOn(client, 'fetchDetails')
    .mockResolvedValue(
      details ? { payload: details as Record<string, unknown>, source: 'live' } : null,
    );
  const service = new VehiclesService(
    emptyRegister as never,
    cache as never,
    client,
    config as never,
  );
  return { service, cache, fetchDetails };
}

describe('the vehicle on a V62', () => {
  it('is not described beyond its make by the lookup a quote uses', async () => {
    const { service, fetchDetails } = setup(IDENTITY);

    const vehicle = await service.lookup('AP52HOW');

    expect(vehicle).toMatchObject({
      make: 'VOLKSWAGEN',
      variant: '',
      colour: '',
      vin: '',
      year: 2002,
    });
    expect(fetchDetails).not.toHaveBeenCalled();
  });

  it('gains its model, colour and VIN when the order carries a V62', async () => {
    const { service, fetchDetails } = setup(IDENTITY);

    const vehicle = await service.lookupForV62('AP52HOW');

    expect(vehicle).toMatchObject({
      reg: 'AP52 HOW',
      make: 'VOLKSWAGEN',
      variant: 'GOLF GTI',
      colour: 'SILVER',
      vin: 'WVWZZZ1JZ2W386752',
      taxClass: 'PETROL',
      year: 2002,
      known: true,
    });
    expect(fetchDetails).toHaveBeenCalledTimes(1);
  });

  it('buys the identity once, however many V62s are placed for the plate', async () => {
    const { service, fetchDetails } = setup(IDENTITY);

    await service.lookupForV62('AP52HOW');
    await service.lookupForV62('AP52HOW');

    expect(fetchDetails).toHaveBeenCalledTimes(1);
  });

  it('leaves the price the customer was quoted exactly as it was', async () => {
    const { service } = setup(IDENTITY);
    const before = await service.checkTax('AP52HOW');

    await service.lookupForV62('AP52HOW');

    expect((await service.checkTax('AP52HOW')).ved).toEqual(before.ved);
  });

  it('goes ahead on what is known when the identity package does not answer', async () => {
    const { service, cache } = setup(null);

    const vehicle = await service.lookupForV62('AP52HOW');

    expect(vehicle).toMatchObject({ make: 'VOLKSWAGEN', colour: '', vin: '' });
    /* The one write is the tax lookup's own — nothing was added to it. */
    expect(cache.updateOne).toHaveBeenCalledTimes(1);
  });
});

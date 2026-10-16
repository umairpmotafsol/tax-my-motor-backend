/**
 * The address search, without ever calling it: `fetch` is replaced, and
 * the tests that must not reach the provider assert that they did not.
 */
import {
  AddressLookupClient,
  AddressLookupError,
  normalisePostcode,
} from './address-lookup.client';

const configFor = (url = 'https://example.test/api/address-lookup') => ({
  get: () => ({ url, timeoutMs: 8000 }),
});

const reply = (status: number, body: unknown) =>
  ({ status, ok: status < 400, json: async () => body }) as Response;

const CARLISLE = {
  ok: true,
  postcode: 'CA3 0BY',
  addresses: [
    {
      id: '3846119',
      label: '40 California Road, Carlisle, CA3 0BY',
      address1: '40 California Road',
      address2: '',
      city: 'Carlisle',
      postcode: 'CA3 0BY',
      uprn: 'not passed on',
    },
    { id: 'broken', address1: '' },
  ],
};

const fetchSpy = jest.spyOn(global, 'fetch' as never) as unknown as jest.SpyInstance;

beforeEach(() => fetchSpy.mockReset());
afterAll(() => fetchSpy.mockRestore());

const failure = async (run: Promise<unknown>) => {
  const err = await run.catch(e => e);
  expect(err).toBeInstanceOf(AddressLookupError);
  return (err as AddressLookupError).reason;
};

describe('normalising a postcode', () => {
  it.each([
    ['ca30by', 'CA3 0BY'],
    [' sw1a 1aa ', 'SW1A 1AA'],
    ['M1 1AE', 'M1 1AE'],
    ['ls1-4dy', 'LS1 4DY'],
  ])('reads %p as %p', (typed, expected) => {
    expect(normalisePostcode(typed)).toBe(expected);
  });

  it.each([[''], ['ZZZ'], ['12345'], ['CA3'], ['CA3 0BYY']])('refuses %p', typed => {
    expect(normalisePostcode(typed)).toBeNull();
  });
});

describe('finding the addresses at a postcode', () => {
  it('returns the addresses in the parts the form wants, and nothing else', async () => {
    fetchSpy.mockResolvedValue(reply(200, CARLISLE));
    const client = new AddressLookupClient(configFor() as never);

    const found = await client.find('ca30by');

    expect(found).toEqual({
      postcode: 'CA3 0BY',
      addresses: [
        {
          id: '3846119',
          label: '40 California Road, Carlisle, CA3 0BY',
          address1: '40 California Road',
          address2: '',
          city: 'Carlisle',
          postcode: 'CA3 0BY',
        },
      ],
    });
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://example.test/api/address-lookup?postcode=CA3+0BY',
    );
  });

  it('asks once for a postcode searched twice', async () => {
    fetchSpy.mockResolvedValue(reply(200, CARLISLE));
    const client = new AddressLookupClient(configFor() as never);

    await client.find('CA3 0BY');
    await client.find('ca30by');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('never sends something that is not a postcode', async () => {
    const client = new AddressLookupClient(configFor() as never);

    expect(await failure(client.find('not a postcode'))).toBe('invalid-postcode');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says so when no search is configured, without calling anything', async () => {
    const client = new AddressLookupClient(configFor('') as never);

    expect(await failure(client.find('CA3 0BY'))).toBe('not-configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a postcode with nothing at it as not found', async () => {
    fetchSpy.mockResolvedValue(reply(404, { ok: false, code: 'not_found', suggestions: [] }));
    const client = new AddressLookupClient(configFor() as never);

    expect(await failure(client.find('ZZ99 9ZZ'))).toBe('not-found');
  });

  it('reports an empty list as not found, and does not remember it', async () => {
    fetchSpy.mockResolvedValue(reply(200, { ok: true, addresses: [] }));
    const client = new AddressLookupClient(configFor() as never);

    expect(await failure(client.find('CA3 0BY'))).toBe('not-found');
    expect(await failure(client.find('CA3 0BY'))).toBe('not-found');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a server error', () => Promise.resolve(reply(500, { message: 'boom' }))],
    [
      'a reply that is not JSON',
      () =>
        Promise.resolve({
          status: 200,
          json: async () => {
            throw new Error('html');
          },
        } as never),
    ],
    ['no reply at all', () => Promise.reject(new Error('timeout'))],
  ])('reports %s as the search being unavailable', async (_label, respond) => {
    fetchSpy.mockImplementation(respond);
    const client = new AddressLookupClient(configFor() as never);

    expect(await failure(client.find('CA3 0BY'))).toBe('upstream');
  });
});

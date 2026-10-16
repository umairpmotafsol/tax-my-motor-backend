import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppConfig } from '../../config/configuration';

/** One deliverable address, in the parts the V62 asks for separately. */
export interface PostalAddress {
  id: string;
  /** "40 California Road, Carlisle, CA3 0BY" — the line a customer picks from. */
  label: string;
  address1: string;
  address2: string;
  city: string;
  postcode: string;
}

/** Why a search produced nothing, so the app can say something the customer can act on. */
export type AddressLookupFailure =
  | 'invalid-postcode' // not shaped like a UK postcode — never sent upstream
  | 'not-found' // the provider looked and has nothing at that postcode
  | 'not-configured' // no ADDRESS_LOOKUP_URL
  | 'upstream'; // it refused, errored, or did not answer in time

export class AddressLookupError extends Error {
  constructor(readonly reason: AddressLookupFailure) {
    super('Address lookup failed: ' + reason);
    this.name = 'AddressLookupError';
  }
}

/** GIR 0AA aside, every UK postcode: one or two letters, a digit, an optional third, then digit-letter-letter. */
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;

/** "ca30by" -> "CA3 0BY", or null when it is not a postcode at all. */
export function normalisePostcode(value: string): string | null {
  const bare = (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return UK_POSTCODE.test(bare) ? bare.slice(0, -3) + ' ' + bare.slice(-3) : null;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

/**
 * The one place that searches for addresses.
 *
 * The search itself belongs to the TaxMyMotor website, which already
 * pays for one and answers `GET <url>?postcode=` with
 * `{ ok, addresses: [{ id, label, address1, address2, city, postcode }] }`,
 * or `{ ok: false, code }`. This asks it, so the app and the website
 * offer a customer the same list for the same postcode.
 *
 * It is a convenience and is built like one: with no URL configured, or
 * the provider down, the caller is told so and the app falls back to
 * typing the address — an order is never held up by a search.
 */
@Injectable()
export class AddressLookupClient {
  private readonly logger = new Logger(AddressLookupClient.name);
  private readonly settings: AppConfig['addressLookup'];

  /** The addresses at a postcode do not change within a day, and each search is somebody's bill. */
  private readonly cache = new Map<string, { at: number; addresses: PostalAddress[] }>();

  constructor(config: ConfigService) {
    this.settings = config.get<AppConfig['addressLookup']>('addressLookup')!;
  }

  async find(postcode: string): Promise<{ postcode: string; addresses: PostalAddress[] }> {
    const normalised = normalisePostcode(postcode);
    if (!normalised) {
      throw new AddressLookupError('invalid-postcode');
    }

    const cached = this.cache.get(normalised);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { postcode: normalised, addresses: cached.addresses };
    }

    if (!this.settings.url) {
      throw new AddressLookupError('not-configured');
    }

    const addresses = await this.request(normalised);
    if (addresses.length === 0) {
      throw new AddressLookupError('not-found');
    }

    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      /* A Map iterates in insertion order, so the first key is the oldest. */
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(normalised, { at: Date.now(), addresses });
    return { postcode: normalised, addresses };
  }

  private async request(postcode: string): Promise<PostalAddress[]> {
    let status: number;
    let body: Record<string, unknown> | null;
    try {
      const url = new URL(this.settings.url);
      url.searchParams.set('postcode', postcode);
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      status = res.status;
      body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    } catch (err) {
      this.logger.warn('Address lookup did not answer: ' + (err as Error).message);
      throw new AddressLookupError('upstream');
    }

    if (body?.ok === true && Array.isArray(body.addresses)) {
      return body.addresses.map(toAddress).filter((a): a is PostalAddress => a !== null);
    }
    if (body?.code === 'not_found') {
      throw new AddressLookupError('not-found');
    }
    if (body?.code === 'invalid_postcode') {
      throw new AddressLookupError('invalid-postcode');
    }
    this.logger.warn('Address lookup answered HTTP ' + status + ' with nothing usable.');
    throw new AddressLookupError('upstream');
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Only what the form needs, and only as text — whatever else the provider sends is not passed on. */
function toAddress(raw: unknown, index: number): PostalAddress | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const address1 = text(entry.address1);
  if (!address1) {
    return null;
  }
  const address2 = text(entry.address2);
  const city = text(entry.city);
  const postcode = text(entry.postcode);
  return {
    id: text(entry.id) || String(index),
    label: text(entry.label) || [address1, address2, city, postcode].filter(Boolean).join(', '),
    address1,
    address2,
    city,
    postcode,
  };
}

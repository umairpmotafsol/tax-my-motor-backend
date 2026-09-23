import { Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
} from 'crypto';

/**
 * Field-level encryption for the two pieces of a Direct Debit mandate
 * that are worth stealing: the account number and the date of birth.
 *
 * They cannot be hashed, because the supplier reviewing the mandate has
 * to read them back and check them against a statement — so they are
 * encrypted with AES-256-GCM instead. The auth tag is stored alongside
 * the ciphertext, so tampering fails to decrypt rather than silently
 * returning something else.
 *
 * Stored as `v1:<iv>:<tag>:<ciphertext>`, all base64. The version
 * prefix is what lets the key be rotated later without guessing at the
 * format of what is already in the database.
 */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

const logger = new Logger('CryptoUtil');

let key: Buffer | null = null;

/**
 * Called once at boot. A missing key is fatal in production and merely
 * loud in development, where a derived throwaway key keeps the app
 * runnable without inventing a secret somebody might then deploy.
 */
export function initEncryption(hexKey: string, env: string): void {
  if (hexKey && hexKey.length === 64) {
    key = Buffer.from(hexKey, 'hex');
    return;
  }
  if (env === 'production') {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string in production.');
  }
  logger.warn(
    'ENCRYPTION_KEY is not set — using a key derived from the process for development only. ' +
      'Encrypted values will not be readable after a restart.',
  );
  key = createHash('sha256').update('taxmymotor-development-key').digest();
}

function requireKey(): Buffer {
  if (!key) {
    throw new Error('Encryption is not initialised. Call initEncryption() at boot.');
  }
  return key;
}

export function encryptField(plain: string): string {
  if (!plain) {
    return '';
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, requireKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/**
 * Returns the plaintext, or the input unchanged when it was never
 * encrypted — so a record written before encryption was switched on
 * still reads, rather than throwing on every access.
 */
export function decryptField(stored: string): string {
  if (!stored) {
    return '';
  }
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    return stored;
  }
  const [, iv, tag, payload] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, requireKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    logger.error('Failed to decrypt a stored field — wrong key, or the value was tampered with.');
    throw new Error('Stored value could not be decrypted.');
  }
}

/** "61220945" -> "****0945", for anywhere the full number is not needed. */
export function maskAccountNumber(accountNumber: string): string {
  const clean = (accountNumber ?? '').trim();
  if (clean.length <= 4) {
    return '****';
  }
  return '****' + clean.slice(-4);
}

/** Opaque, URL-safe token — refresh tokens and referral codes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Refresh tokens are stored hashed, so a database dump is not a set of sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A first password for an account somebody else is opening — the admin
 * creating a supplier's sign-in, who then has to read it down a phone
 * or paste it into an email.
 *
 * "K7QM-4RPT-9WXN": grouped so it can be dictated, and drawn from the
 * same 32-symbol alphabet as referral codes — no O/0 and no I/1, the
 * pairs that turn into a support call. Twelve characters out of 32 is
 * ~60 bits, plenty for a credential meant to be changed on first use.
 * `randomInt` rather than Math.random: unbiased, and from the CSPRNG.
 */
export function randomPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups = [];
  for (let group = 0; group < 3; group += 1) {
    let chunk = '';
    for (let i = 0; i < 4; i += 1) {
      chunk += alphabet[randomInt(alphabet.length)];
    }
    groups.push(chunk);
  }
  return groups.join('-');
}

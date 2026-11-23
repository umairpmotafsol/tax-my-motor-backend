import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, initializeApp } from 'firebase-admin/app';
import { Messaging, getMessaging } from 'firebase-admin/messaging';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Firebase sender, or null when the app is running without
 * credentials.
 *
 * Kept apart from `PushService` on purpose. Reading a file and talking
 * to Google is the one part of pushing a notification that cannot be
 * exercised in a test, so it lives behind an injection token: the
 * service is then handed a sender, and a test can hand it one that
 * records what it was asked to send.
 */
export const FIREBASE_MESSAGING = 'FIREBASE_MESSAGING';

/** What PushService needs of Firebase — and all a test has to stand in for. */
export type PushSender = Pick<Messaging, 'sendEachForMulticast'>;

/** The fields of a service-account key that Firebase cannot do without. */
const REQUIRED_FIELDS = ['project_id', 'client_email', 'private_key'] as const;

export type FirebaseCredentials = Record<string, string>;

/**
 * A service-account key from an inline value: the JSON itself, or the
 * JSON base64-encoded (which survives hosts and shells that mangle the
 * newlines inside the private key).
 *
 * Throws a message that never quotes the value - it is a private key,
 * and a log line is the last place it belongs.
 */
export function parseInlineCredentials(inline: string): FirebaseCredentials {
  const text = inline.trim();
  const json = text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('FIREBASE_CREDENTIALS_JSON is neither JSON nor base64-encoded JSON.');
  }
  const credentials = (parsed ?? {}) as FirebaseCredentials;
  const missing = REQUIRED_FIELDS.filter(field => typeof credentials[field] !== 'string' || !credentials[field]);
  if (missing.length > 0) {
    throw new Error('FIREBASE_CREDENTIALS_JSON is missing ' + missing.join(', ') + '.');
  }
  return credentials;
}

/**
 * Where the key comes from: the inline value if there is one, else the
 * file, else nowhere (push off). `source` is a label for the log, never
 * the key.
 */
export function loadCredentials(
  inline: string,
  configuredFile: string,
): { credentials: FirebaseCredentials; source: string } | { credentials: null; source: string } {
  if (inline.trim()) {
    return { credentials: parseInlineCredentials(inline), source: 'FIREBASE_CREDENTIALS_JSON' };
  }
  const file = configuredFile ? resolve(process.cwd(), configuredFile) : '';
  if (!file || !existsSync(file)) {
    return { credentials: null, source: configuredFile || '(unset)' };
  }
  return {
    credentials: JSON.parse(readFileSync(file, 'utf8')) as FirebaseCredentials,
    source: configuredFile,
  };
}

export const firebaseMessagingProvider: Provider = {
  provide: FIREBASE_MESSAGING,
  inject: [ConfigService],
  useFactory: (config: ConfigService): PushSender | null => {
    const logger = new Logger('Push');

    try {
      const { credentials, source } = loadCredentials(
        config.get<string>('push.credentialsJson') ?? '',
        config.get<string>('push.credentialsFile') ?? '',
      );

      /*
       * Missing credentials switch push off rather than stopping the
       * boot. A developer without the key runs the whole app, and CI has
       * no Firebase project - neither should be blocked by a courtesy
       * notification.
       */
      if (!credentials) {
        logger.warn('No Firebase credentials at ' + source + ' - push notifications are off.');
        return null;
      }

      /* Named, so it cannot collide with a default app elsewhere in the process. */
      const app = initializeApp({ credential: cert(credentials as never) }, 'taxmymotor-push');
      logger.log('Push notifications are on (project ' + credentials.project_id + ', key from ' + source + ').');
      return getMessaging(app);
    } catch (error) {
      /* Only the message: it never carries the key, and a stack adds nothing here. */
      logger.error('Firebase credentials could not be read - push is off. ' + (error as Error).message);
      return null;
    }
  },
};

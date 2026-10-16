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

export const firebaseMessagingProvider: Provider = {
  provide: FIREBASE_MESSAGING,
  inject: [ConfigService],
  useFactory: (config: ConfigService): PushSender | null => {
    const logger = new Logger('Push');
    const configured = config.get<string>('push.credentialsFile') ?? '';
    const file = configured ? resolve(process.cwd(), configured) : '';

    /*
     * Missing credentials switch push off rather than stopping the
     * boot. A developer without the key runs the whole app, and CI has
     * no Firebase project — neither should be blocked by a courtesy
     * notification.
     */
    if (!file || !existsSync(file)) {
      logger.warn(
        'No Firebase credentials at ' +
          (configured || '(unset)') +
          ' — push notifications are off.',
      );
      return null;
    }

    try {
      const credentials = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      /* Named, so it cannot collide with a default app elsewhere in the process. */
      const app = initializeApp({ credential: cert(credentials as never) }, 'taxmymotor-push');
      logger.log('Push notifications are on (project ' + credentials.project_id + ').');
      return getMessaging(app);
    } catch (error) {
      logger.error('Firebase credentials could not be read — push is off.', error as Error);
      return null;
    }
  },
};

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';

import { Role } from '../../common/enums/role.enum';
import { UsersService } from '../users/users.service';
import { FIREBASE_MESSAGING, PushSender } from './push.provider';

/**
 * What a phone is told, and what the app gets when the notification is
 * tapped. `data` is a string map because that is all FCM carries — a
 * number or a nested object arrives as `[object Object]`.
 */
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** The Android channel the app creates; without it Android 8+ shows nothing. */
export const ORDERS_CHANNEL = 'orders';

/**
 * Push notifications, over Firebase Cloud Messaging.
 *
 * Two rules hold everywhere in here, because both are about not making
 * a worse problem out of a smaller one:
 *
 *  - **Nothing thrown.** A notification is a courtesy on top of an
 *    order that has already been placed and a socket that has already
 *    fired. Firebase being unreachable must not fail the request that
 *    happened to trigger it, so every path logs and returns a count.
 *  - **Off is a valid state.** No credentials, no push, and nothing
 *    else changes (see push.provider.ts).
 *
 * Which phones a message reaches is decided here rather than by the
 * caller, so "the supplier who got the order" means the same thing in
 * every place that says it.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @Inject(FIREBASE_MESSAGING) private readonly sender: PushSender | null,
    private readonly users: UsersService,
  ) {}

  /** False when there are no credentials, so callers can skip the lookups. */
  get enabled(): boolean {
    return this.sender !== null;
  }

  /* -------------------------------- audiences ------------------------------- */

  /**
   * The supplier company that holds the order — every sign-in it has,
   * and no other company's. A firm with two people on the phones is not
   * a special case worth forbidding, and whoever picks it up does it.
   */
  async toSupplier(
    supplierId: string | Types.ObjectId | null,
    message: PushMessage,
  ): Promise<number> {
    if (!this.sender || !supplierId) {
      return 0;
    }
    const users = await this.users.listBySupplier(supplierId);
    return this.toUsers(
      users.map(user => user._id),
      message,
    );
  }

  /** Every admin. There is no per-order admin, so they all get it. */
  async toAdmins(message: PushMessage): Promise<number> {
    if (!this.sender) {
      return 0;
    }
    const admins = await this.users.listByRole(Role.Admin);
    return this.toUsers(
      admins.map(admin => admin._id),
      message,
    );
  }

  /* ---------------------------------- send ---------------------------------- */

  /** @returns how many phones took it — 0 is ordinary, not a failure. */
  async toUsers(ids: (string | Types.ObjectId)[], message: PushMessage): Promise<number> {
    if (!this.sender || ids.length === 0) {
      return 0;
    }

    try {
      const tokens = await this.users.deviceTokensFor(ids);
      if (tokens.length === 0) {
        return 0;
      }

      const response = await this.sender.sendEachForMulticast({
        tokens,
        /*
         * A `notification` block rather than data alone, and this is
         * the whole of how "not while they are using it" works: FCM
         * shows a tray notification only while the app is backgrounded
         * or closed. In the foreground the SDK hands it to the app's
         * own handler instead and displays nothing, which is exactly
         * the rule — the in-app alert has that moment covered.
         */
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: {
          /* An order has seven minutes on it; it does not wait for a doze window. */
          priority: 'high',
          notification: { channelId: ORDERS_CHANNEL, sound: 'default' },
        },
        apns: { payload: { aps: { sound: 'default' } } },
      });

      await this.prune(tokens, response.responses);
      return response.successCount;
    } catch (error) {
      this.logger.error('A push could not be sent: ' + message.title, error as Error);
      return 0;
    }
  }

  /**
   * Uninstalled apps and stale tokens, dropped as Firebase reports
   * them. Left alone they are retried on every send forever, and the
   * count of "phones notified" quietly stops meaning anything.
   */
  private async prune(
    tokens: string[],
    responses: { success: boolean; error?: { code: string } }[],
  ): Promise<void> {
    const dead = responses.flatMap((response, index) =>
      !response.success && isGone(response.error?.code) ? [tokens[index]] : [],
    );
    if (dead.length > 0) {
      await this.users.forgetDevices(dead);
      this.logger.log('Dropped ' + dead.length + ' dead device token(s).');
    }
  }
}

/** A token that will never work again, as opposed to a send that failed today. */
function isGone(code?: string): boolean {
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/invalid-argument'
  );
}

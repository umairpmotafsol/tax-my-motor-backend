import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { OrdersService } from './orders.service';

/**
 * The invoice window, enforced.
 *
 * The front ends each run their own countdown so the number on screen
 * ticks, but a countdown in a browser is a display, not a rule — it
 * stops when the tab closes and it never agrees with the next client.
 * This is what actually decides an order is overdue.
 *
 * Every thirty seconds is close enough for a seven-minute window, and
 * the query behind it is indexed on {status, dueAt}, so a quiet minute
 * costs a lookup that matches nothing.
 */
@Injectable()
export class OrdersTasks {
  private readonly logger = new Logger(OrdersTasks.name);
  private running = false;

  constructor(private readonly orders: OrdersService) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'sweep-overdue-orders' })
  async sweepOverdue(): Promise<void> {
    /*
     * A slow sweep must not overlap itself — two passes would each see
     * the same orders as newly overdue and raise the alerts twice.
     */
    if (this.running) {
      this.logger.warn('The previous overdue sweep is still running; skipping this one.');
      return;
    }

    this.running = true;
    try {
      await this.orders.sweepOverdue();
    } catch (error) {
      /* Swallowed on purpose: a failed sweep must not stop the schedule. */
      this.logger.error('The overdue sweep failed', error as Error);
    } finally {
      this.running = false;
    }
  }
}

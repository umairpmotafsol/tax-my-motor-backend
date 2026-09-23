import { BadRequestException, Injectable } from '@nestjs/common';

import {
  BankField,
  BankReviewActor,
  BankReviewStatus,
} from '../../common/enums/bank.enum';
import { NotificationType } from '../../common/enums/notification.enum';
import { InvoiceStatus, OrderType } from '../../common/enums/order.enum';
import { Role } from '../../common/enums/role.enum';
import { bankProblems } from '../../common/utils/bank.util';
import { encryptField } from '../../common/utils/crypto.util';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { BankDetailsDto } from '../orders/dto/order.dto';
import { OrderDocument } from '../orders/schemas/order.schema';
import { OrdersService } from '../orders/orders.service';

/**
 * The Direct Debit review loop.
 *
 * A mandate arrives with the order and somebody at the supplier has to
 * check it before the first collection. When something is wrong the
 * order goes back to the customer with the bad fields named, and
 * returns when they have fixed it — as many times as it takes.
 *
 * The invoice window is paused while the ball is in the customer's
 * court and restarted when it comes back, because the window measures
 * how quickly the *supplier* responds. Leaving it running would make an
 * order overdue for something the supplier could do nothing about.
 */
@Injectable()
export class BankReviewService {
  constructor(
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /* -------------------------------- supplier -------------------------------- */

  /** Signed off. The supplier can now raise the invoice. */
  async approve(order: OrderDocument): Promise<OrderDocument> {
    this.assertAwaitingReview(order);

    const at = new Date();
    order.bankReview!.status = BankReviewStatus.Approved;
    order.bankReview!.flagged = [];
    order.bankReview!.notes.push({
      at,
      by: BankReviewActor.Supplier,
      fields: [],
      message: 'Approved — mandate set up.',
    });
    order.timeline.push({
      at,
      actor: 'supplier',
      title: 'Bank details approved',
      detail: 'Mandate set up',
      tone: 'green',
    });

    /*
     * The invoice is still outstanding, so the supplier's window has to
     * be running again — it was paused while the customer held it.
     */
    if (order.invoiceStatus === InvoiceStatus.Pending && !order.dueAt) {
      this.orders.restartWindow(order, at);
    }

    await order.save();
    await this.notifications.raise(
      NotificationType.BankApproved,
      order._id,
      Role.Customer,
      order.customer,
    );
    this.realtime.bankApproved(order);
    return order;
  }

  /**
   * Flag what is wrong and hand the order back. The flags and the note
   * both travel: "wrong" on its own gives the customer nothing to act
   * on. Every note is kept, so the third time round still reads in the
   * context of the first two.
   */
  async requestChanges(
    order: OrderDocument,
    fields: BankField[],
    message: string,
  ): Promise<OrderDocument> {
    this.assertAwaitingReview(order);

    const at = new Date();
    order.bankReview!.status = BankReviewStatus.ChangesRequested;
    order.bankReview!.flagged = fields;
    order.bankReview!.notes.push({
      at,
      by: BankReviewActor.Supplier,
      fields,
      message,
    });
    order.timeline.push({
      at,
      actor: 'supplier',
      title: 'Bank details sent back',
      detail: fields.join(', '),
      tone: 'red',
    });

    /* Their turn is over; the clock stops until the customer replies. */
    this.orders.pauseWindow(order);

    await order.save();
    await this.notifications.raise(
      NotificationType.BankChangesRequested,
      order._id,
      Role.Customer,
      order.customer,
    );
    this.realtime.bankChangesRequested(order);
    return order;
  }

  /* -------------------------------- customer -------------------------------- */

  /**
   * The corrected details, sent back. The flags clear but every note
   * stays — the thread is the record of what was asked for.
   */
  async resubmit(order: OrderDocument, bank: BankDetailsDto): Promise<OrderDocument> {
    if (order.orderType !== OrderType.DirectDebit || !order.bankReview) {
      throw new BadRequestException('There is no mandate on this order.');
    }
    if (order.bankReview.status !== BankReviewStatus.ChangesRequested) {
      throw new BadRequestException('These details are not waiting on you.');
    }

    const problems = bankProblems(bank);
    if (problems.length > 0) {
      throw new BadRequestException('Please check these details: ' + problems.join(', ') + '.');
    }

    const at = new Date();
    order.bank = {
      accountHolder: bank.accountHolder,
      accountNumber: encryptField(bank.accountNumber),
      sortCode: bank.sortCode,
      dateOfBirth: encryptField(bank.dateOfBirth),
    };
    order.bankReview.status = BankReviewStatus.Submitted;
    order.bankReview.flagged = [];
    order.bankReview.notes.push({
      at,
      by: BankReviewActor.Customer,
      fields: [],
      message: 'Details updated and sent back for review.',
    });
    order.timeline.push({
      at,
      actor: 'customer',
      title: 'Bank details resubmitted',
      detail: 'Back with the supplier to check',
      tone: null,
    });

    /* Back in the supplier's court, so their window starts again. */
    if (order.invoiceStatus === InvoiceStatus.Pending) {
      this.orders.restartWindow(order, at);
    }

    await order.save();
    await this.notifications.resolve(NotificationType.BankChangesRequested, order._id);
    this.realtime.bankResubmitted(order);
    return order;
  }

  /* -------------------------------- internals ------------------------------- */

  private assertAwaitingReview(order: OrderDocument): void {
    if (order.orderType !== OrderType.DirectDebit || !order.bank || !order.bankReview) {
      throw new BadRequestException('There is no mandate on this order.');
    }
    if (order.bankReview.status !== BankReviewStatus.Submitted) {
      throw new BadRequestException(
        order.bankReview.status === BankReviewStatus.Approved
          ? 'These details have already been approved.'
          : 'These details are back with the customer.',
      );
    }
  }
}

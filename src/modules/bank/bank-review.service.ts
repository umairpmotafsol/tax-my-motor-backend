import { BadRequestException, Injectable } from '@nestjs/common';

import {
  BANK_FIELDS,
  BANK_ROUNDS_BEFORE_FLAG,
  BankField,
  BankReviewActor,
  BankReviewStatus,
} from '../../common/enums/bank.enum';
import { NotificationType } from '../../common/enums/notification.enum';
import { InvoiceStatus, OrderFlagSource, OrderType } from '../../common/enums/order.enum';
import { Role } from '../../common/enums/role.enum';
import { bankProblems } from '../../common/utils/bank.util';
import { decryptField, encryptField } from '../../common/utils/crypto.util';
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
 * returns when they have fixed it — as many times as it takes. Past
 * BANK_ROUNDS_BEFORE_FLAG send-backs the order is also flagged to an
 * admin, who can let it run or call it off.
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

  /**
   * Signed off, on its own. The supplier app no longer asks for this as
   * a separate step — uploading the invoice signs the mandate off (see
   * `OrdersService.attachInvoice`) — but the route stays for a client
   * that wants to approve first and invoice later.
   */
  async approve(order: OrderDocument): Promise<OrderDocument> {
    this.assertAwaitingReview(order);

    const at = new Date();
    this.orders.signOffMandate(order, at);

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

    /*
     * A mandate that keeps coming back wrong is no longer something the
     * supplier and the customer are going to settle between them. The
     * send-back still goes — the admin may well let it run — but they
     * get to see it. Flagged once: an order already flagged stays as is.
     */
    const rounds = sendBacks(order);
    const escalated =
      rounds > BANK_ROUNDS_BEFORE_FLAG &&
      this.orders.applyFlag(
        order,
        OrderFlagSource.System,
        'Bank details sent back ' + rounds + ' times',
      );

    await order.save();
    await this.notifications.raise(
      NotificationType.BankChangesRequested,
      order._id,
      Role.Customer,
      order.customer,
    );
    this.realtime.bankChangesRequested(order);
    if (escalated) {
      await this.orders.announceFlag(order);
    }
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
    this.assertOpen(order);
    if (order.bankReview.status !== BankReviewStatus.ChangesRequested) {
      throw new BadRequestException('These details are not waiting on you.');
    }

    const problems = bankProblems(bank);
    if (problems.length > 0) {
      throw new BadRequestException('Please check these details: ' + problems.join(', ') + '.');
    }

    /*
     * What they actually changed, worked out before the old values are
     * replaced. The supplier is about to check the details again, and
     * "the sort code is different now" is what tells them where to look.
     */
    const previous: Record<BankField, string> = {
      [BankField.AccountHolder]: order.bank?.accountHolder ?? '',
      [BankField.AccountNumber]: decryptField(order.bank?.accountNumber ?? ''),
      [BankField.SortCode]: order.bank?.sortCode ?? '',
      [BankField.DateOfBirth]: decryptField(order.bank?.dateOfBirth ?? ''),
    };
    const changed = BANK_FIELDS.filter(field => previous[field] !== bank[field]);

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
      fields: changed,
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
    await this.orders.pushBankReturned(order);
    return order;
  }

  /* -------------------------------- internals ------------------------------- */

  /**
   * The loop only runs while the order is still to be invoiced. An admin
   * can cancel a flagged order, or complete it over a mandate nobody
   * signed off; either way there is nothing left to review.
   */
  private assertOpen(order: OrderDocument): void {
    this.orders.assertLive(order);
    if (order.invoiceStatus === InvoiceStatus.Sent) {
      throw new BadRequestException('This order has already been completed.');
    }
  }

  private assertAwaitingReview(order: OrderDocument): void {
    if (order.orderType !== OrderType.DirectDebit || !order.bank || !order.bankReview) {
      throw new BadRequestException('There is no mandate on this order.');
    }
    this.assertOpen(order);
    if (order.bankReview.status !== BankReviewStatus.Submitted) {
      throw new BadRequestException(
        order.bankReview.status === BankReviewStatus.Approved
          ? 'These details have already been approved.'
          : 'These details are back with the customer.',
      );
    }
  }
}

/**
 * How many times the supplier has handed this mandate back. The approval
 * is a supplier note too, but it names no fields, which is what tells
 * the two apart.
 */
function sendBacks(order: OrderDocument): number {
  return (order.bankReview?.notes ?? []).filter(
    note => note.by === BankReviewActor.Supplier && note.fields.length > 0,
  ).length;
}

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { Role } from '../../common/enums/role.enum';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { OrderDocument } from '../orders/schemas/order.schema';

/**
 * Live order pushes.
 *
 * The supplier app's whole shape depends on this: a new order has to
 * interrupt like a push notification and start a countdown that is
 * already running. Polling for that would be either slow or wasteful,
 * and the apps already carry the connection state to report it.
 *
 * Rooms are the delivery rule, so a socket only ever receives what its
 * token entitles it to:
 *
 *   admins              one shared room — admins see everything
 *   supplier:<id>       the orders assigned to that supplier
 *   user:<id>           one customer's own orders
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server?: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The token is verified here rather than trusted, and a socket that
   * cannot prove who it is gets disconnected instead of silently
   * joining no rooms — a client that thinks it is subscribed and is not
   * is worse than one that knows it failed.
   */
  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      stripBearer(client.handshake.headers.authorization);

    if (!token) {
      client.emit('unauthorized', { message: 'A token is required.' });
      client.disconnect(true);
      return;
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.getOrThrow<string>('jwt.accessSecret'),
      });

      client.data.userId = payload.sub;
      client.data.role = payload.role;

      await client.join('user:' + payload.sub);
      if (payload.role === Role.Admin) {
        await client.join('admins');
      }
      if (payload.role === Role.Supplier && payload.supplierId) {
        await client.join('supplier:' + payload.supplierId);
      }

      client.emit('ready', { role: payload.role });
    } catch {
      client.emit('unauthorized', { message: 'That token is not valid.' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug('Socket disconnected: ' + client.id);
  }

  /* --------------------------------- emitters -------------------------------- */

  /** A new order: the assigned supplier gets the alert, admins get the feed. */
  orderPlaced(order: OrderDocument): void {
    const payload = this.summary(order);
    this.toSupplier(order, 'order:new', payload);
    this.toAdmins('order:new', payload);
    this.toCustomer(order, 'order:update', payload);
  }

  orderAssigned(order: OrderDocument): void {
    const payload = this.summary(order);
    this.toSupplier(order, 'order:assigned', payload);
    this.toAdmins('order:update', payload);
  }

  orderChanged(order: OrderDocument): void {
    const payload = this.summary(order);
    this.toSupplier(order, 'order:update', payload);
    this.toAdmins('order:update', payload);
    this.toCustomer(order, 'order:update', payload);
  }

  orderOverdue(order: OrderDocument): void {
    const payload = this.summary(order);
    this.toSupplier(order, 'order:overdue', payload);
    this.toAdmins('order:overdue', payload);
  }

  /** The customer has to be told their details came back. */
  bankChangesRequested(order: OrderDocument): void {
    const payload = this.summary(order);
    this.toCustomer(order, 'bank:changes-requested', payload);
    this.toAdmins('order:update', payload);
  }

  bankResubmitted(order: OrderDocument): void {
    const payload = this.summary(order);
    this.toSupplier(order, 'bank:resubmitted', payload);
    this.toAdmins('order:update', payload);
  }

  bankApproved(order: OrderDocument): void {
    const payload = this.summary(order);
    this.toCustomer(order, 'bank:approved', payload);
    this.toSupplier(order, 'order:update', payload);
    this.toAdmins('order:update', payload);
  }

  /* --------------------------------- internals ------------------------------- */

  /**
   * Deliberately thin: an id and enough to render a row or an alert.
   * The client refetches the order through the API, so the socket never
   * becomes a second way to read data the REST scoping rules govern.
   */
  private summary(order: OrderDocument) {
    return {
      id: String(order._id),
      orderNumber: order.orderNumber,
      reg: order.reg,
      vehicleModel: order.vehicle.model,
      orderType: order.orderType,
      total: order.total,
      status: order.status,
      dueAt: order.dueAt ? order.dueAt.toISOString() : null,
      at: new Date().toISOString(),
    };
  }

  private toAdmins(event: string, payload: unknown): void {
    this.server?.to('admins').emit(event, payload);
  }

  private toSupplier(order: OrderDocument, event: string, payload: unknown): void {
    if (order.supplier) {
      this.server?.to('supplier:' + String(order.supplier)).emit(event, payload);
    }
  }

  private toCustomer(order: OrderDocument, event: string, payload: unknown): void {
    this.server?.to('user:' + String(order.customer)).emit(event, payload);
  }
}

function stripBearer(header?: string): string | undefined {
  if (!header) {
    return undefined;
  }
  return header.startsWith('Bearer ') ? header.slice(7) : header;
}

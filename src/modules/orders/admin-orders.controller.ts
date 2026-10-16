import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { paginate } from '../../common/dto/pagination.dto';
import { Role } from '../../common/enums/role.enum';
import { SuppliersService } from '../suppliers/suppliers.service';
import {
  CancelOrderDto,
  ListOrdersDto,
  ReassignOrderDto,
  SendBackOrderDto,
} from './dto/order.dto';
import { toAdminOrder } from './orders.serializer';
import { OrdersService } from './orders.service';
import { renderV62Pdf, v62FileName } from './v62-pdf';

/**
 * The admin's view of the whole order book. Admins see the customer,
 * because they are the one who has to contact them.
 */
@ApiTags('orders (admin)')
@Roles(Role.Admin)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly suppliers: SuppliersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every order, filtered and paged' })
  async list(@Query() query: ListOrdersDto) {
    const [page, names] = await Promise.all([
      this.orders.listForAdmin(query),
      this.suppliers.nameMap(),
    ]);
    return paginate(
      page.items.map(order => toAdminOrder(order, names)),
      page.total,
      page.page,
      page.limit,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'The dashboard tiles' })
  stats() {
    return this.orders.adminStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'One order, in full' })
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const [order, names] = await Promise.all([
      this.orders.findScoped(id, user),
      this.suppliers.nameMap(),
    ]);
    return toAdminOrder(order, names);
  }

  /** Flow 5 fallback and Flow 2 recovery: move an order to another supplier. */
  @Post(':id/reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reassign an order and start a fresh invoice window' })
  async reassign(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReassignOrderDto,
  ) {
    const order = await this.orders.findScoped(id, user);
    const updated = await this.orders.reassign(order, dto.supplierId);
    return toAdminOrder(updated, await this.suppliers.nameMap());
  }

  /**
   * Flow 1, final step for a WhatsApp order. The admin sends it from
   * their own device — this records that they did. Email invoices never
   * reach here; the server emails those when the supplier uploads.
   */
  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a WhatsApp invoice as sent to the customer' })
  async send(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.findScoped(id, user);
    const updated = await this.orders.markSent(order, user);
    return toAdminOrder(updated, await this.suppliers.nameMap());
  }

  /**
   * The invoice email, sent again. For an order whose email failed, or
   * a customer who cannot find theirs. The response carries the outcome
   * in `invoiceEmail` — a failed send is a 200 with `status: 'failed'`,
   * because the request to try was carried out.
   */
  @Post(':id/invoice-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email the invoice to the customer again' })
  async resendInvoiceEmail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.findScoped(id, user);
    const updated = await this.orders.resendInvoiceEmail(order);
    return toAdminOrder(updated, await this.suppliers.nameMap());
  }

  /** An admin's answer to a flag: hand it back to the supplier, saying what to do. */
  @Post(':id/send-back')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a flagged order back to its supplier with a comment' })
  async sendBack(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SendBackOrderDto,
  ) {
    const order = await this.orders.findScoped(id, user);
    const updated = await this.orders.sendBack(order, user, dto.comment);
    return toAdminOrder(updated, await this.suppliers.nameMap());
  }

  /** An admin's answer to a flag: close the order as done. */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete an order that was flagged' })
  async complete(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.findScoped(id, user);
    const updated = await this.orders.complete(order, user);
    return toAdminOrder(updated, await this.suppliers.nameMap());
  }

  /** An admin's answer to a flag: call the order off. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an order that was flagged' })
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    /* Optional all the way down — the apps send no body for a plain cancel. */
    @Body() dto?: CancelOrderDto,
  ) {
    const order = await this.orders.findScoped(id, user);
    const updated = await this.orders.cancel(order, user, dto?.reason);
    return toAdminOrder(updated, await this.suppliers.nameMap());
  }

  /** Flow 4, final step: the admin prints the V62 the customer submitted. */
  @Post(':id/v62/printed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the V62 as printed' })
  async markV62Printed(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.findScoped(id, user);
    const updated = await this.orders.markV62Printed(order);
    return toAdminOrder(updated, await this.suppliers.nameMap());
  }

  /**
   * The DVLA form itself, filled in with what the customer declared and
   * what the lookup knows — ready to print, sign and post.
   *
   * Drawn on request rather than stored: it is a view of the order's
   * `v62`, so it can never disagree with what the portal shows.
   */
  @Get(':id/v62.pdf')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'The V62 application as a filled-in DVLA form' })
  async v62Pdf(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.findScoped(id, user);
    if (!order.v62Requested || !order.v62) {
      throw new BadRequestException('There is no V62 on this order.');
    }
    return new StreamableFile(Buffer.from(await renderV62Pdf(order.v62)), {
      type: 'application/pdf',
      disposition:
        'attachment; filename="' + v62FileName(order.v62.registrationNumber, order.orderNumber) + '"',
    });
  }

  /** The V62 on its own, shaped for the printed DVLA form. */
  @Get(':id/v62')
  @ApiOperation({ summary: 'The V62 application to print' })
  async v62(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.findScoped(id, user);
    return {
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      printedAt: order.v62PrintedAt ? order.v62PrintedAt.toISOString() : null,
      v62: order.v62,
    };
  }
}

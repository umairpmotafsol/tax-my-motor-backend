import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { paginate } from '../../common/dto/pagination.dto';
import { Role } from '../../common/enums/role.enum';
import { SuppliersService } from '../suppliers/suppliers.service';
import { ListOrdersDto, ReassignOrderDto } from './dto/order.dto';
import { toAdminOrder } from './orders.serializer';
import { OrdersService } from './orders.service';

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
   * reach here; the supplier's system sends those on upload.
   */
  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a WhatsApp invoice as sent to the customer' })
  async send(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.findScoped(id, user);
    const updated = await this.orders.markSent(order, user);
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

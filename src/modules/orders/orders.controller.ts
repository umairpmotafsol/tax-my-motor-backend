import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { Role } from '../../common/enums/role.enum';
import { BankReviewService } from '../bank/bank-review.service';
import { PlaceOrderDto, ResubmitBankDto } from './dto/order.dto';
import { toCustomerOrder } from './orders.serializer';
import { OrdersService } from './orders.service';

/**
 * The customer's own order book. Every read is scoped to the caller, so
 * there is no route here that takes a customer id.
 */
@ApiTags('orders (customer)')
@Roles(Role.Customer)
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly bankReview: BankReviewService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Place an order — the end of checkout' })
  async place(@CurrentUser() user: AuthUser, @Body() dto: PlaceOrderDto) {
    const order = await this.orders.placeOrder(user.userId, dto);
    return toCustomerOrder(order);
  }

  @Get()
  @ApiOperation({ summary: 'My orders, newest first' })
  async list(@CurrentUser() user: AuthUser, @Query() query: PaginationDto) {
    const page = await this.orders.listForCustomer(user.userId, query.page, query.limit);
    return paginate(page.items.map(toCustomerOrder), page.total, page.page, page.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my orders' })
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return toCustomerOrder(await this.orders.findScoped(id, user));
  }

  /**
   * The customer's half of the Direct Debit review loop: the corrected
   * details, sent back to the supplier.
   */
  @Post(':id/bank/resubmit')
  @ApiOperation({ summary: 'Send corrected bank details back for review' })
  async resubmitBank(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ResubmitBankDto,
  ) {
    const order = await this.orders.findScoped(id, user);
    return toCustomerOrder(await this.bankReview.resubmit(order, dto.bank));
  }
}

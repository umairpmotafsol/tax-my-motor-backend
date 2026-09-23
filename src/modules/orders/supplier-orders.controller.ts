import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { paginate } from '../../common/dto/pagination.dto';
import { Role } from '../../common/enums/role.enum';
import { BankReviewService } from '../bank/bank-review.service';
import { ListOrdersDto, RequestBankChangesDto } from './dto/order.dto';
import { toBankReviewView, toSupplierOrder } from './orders.serializer';
import { OrdersService } from './orders.service';

/**
 * The supplier's order book, scoped to whichever supplier the caller
 * works for. The serializer decides what a supplier may see — the
 * customer's name and home address are not part of it.
 */
@ApiTags('orders (supplier)')
@Roles(Role.Supplier)
@Controller('supplier/orders')
export class SupplierOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly bankReview: BankReviewService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Orders assigned to my supplier' })
  async list(@CurrentUser() user: AuthUser, @Query() query: ListOrdersDto) {
    const page = await this.orders.listForSupplier(requireSupplier(user), query);
    return paginate(page.items.map(toSupplierOrder), page.total, page.page, page.limit);
  }

  @Get('stats')
  @ApiOperation({ summary: 'The supplier dashboard tiles' })
  async stats(@CurrentUser() user: AuthUser) {
    return this.orders.supplierStats(requireSupplier(user));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One assigned order' })
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return toSupplierOrder(await this.orders.findScoped(id, user));
  }

  /* ------------------------------ the bank loop ----------------------------- */

  @Get(':id/bank')
  @ApiOperation({ summary: 'The Direct Debit mandate to check' })
  async bank(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.findScoped(id, user);
    if (!order.bank) {
      throw new BadRequestException('There is no mandate on this order.');
    }
    return toBankReviewView(order);
  }

  @Post(':id/bank/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign off the mandate so the invoice can be raised' })
  async approveBank(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.findScoped(id, user);
    return toSupplierOrder(await this.bankReview.approve(order));
  }

  @Post(':id/bank/request-changes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Flag what is wrong and hand the order back' })
  async requestBankChanges(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RequestBankChangesDto,
  ) {
    const order = await this.orders.findScoped(id, user);
    return toSupplierOrder(await this.bankReview.requestChanges(order, dto.fields, dto.message));
  }
}

function requireSupplier(user: AuthUser): string {
  if (!user.supplierId) {
    throw new ForbiddenException('This account is not linked to a supplier.');
  }
  return user.supplierId;
}

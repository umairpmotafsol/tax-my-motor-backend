import { Body, Controller, ForbiddenException, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { OrdersService } from './orders.service';

export class SetDutyDto {
  @IsBoolean()
  onDuty!: boolean;
}

/**
 * The supplier app's On duty / Off duty switch.
 *
 * Lives with the orders rather than the suppliers because both
 * directions are about orders: coming on duty hands over every order
 * that was waiting for somebody, and going off duty is refused while
 * any are still to finish.
 */
@ApiTags('orders (supplier)')
@Roles(Role.Supplier)
@Controller('supplier/duty')
export class SupplierDutyController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: 'Whether I am on duty, and how many orders I still have to finish' })
  async get(@CurrentUser() user: AuthUser) {
    return this.orders.dutyFor(requireSupplier(user));
  }

  /**
   * 409 when going off duty with orders still to finish, and when
   * coming on duty on an account the admin has taken out of rotation.
   */
  @Put()
  @ApiOperation({ summary: 'Go on or off duty' })
  async set(@CurrentUser() user: AuthUser, @Body() dto: SetDutyDto) {
    return this.orders.setDuty(requireSupplier(user), dto.onDuty);
  }
}

function requireSupplier(user: AuthUser): string {
  if (!user.supplierId) {
    throw new ForbiddenException('This account is not linked to a supplier.');
  }
  return user.supplierId;
}

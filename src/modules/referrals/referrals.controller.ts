import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { formatOrderDate, initials } from '../../common/utils/format.util';
import { UsersService } from '../users/users.service';

/** How many orders an invitee has to place before the referrer earns one. */
const ORDERS_NEEDED = 10;

@ApiTags('referrals')
@Roles(Role.Customer)
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'My referral code, balance and invitees' })
  async me(@CurrentUser() user: AuthUser) {
    const me = await this.users.findById(user.userId);
    const invitees = await this.users.listInvitees(me._id);

    return {
      code: me.referralCode ?? null,
      freeOrders: me.freeOrders,
      freeOrderEarnedOn: me.freeOrderEarnedOn
        ? formatOrderDate(new Date(me.freeOrderEarnedOn))
        : null,
      ordersDone: invitees.length,
      ordersNeeded: ORDERS_NEEDED,
      invitees: invitees.map(invitee => ({
        initials: initials(invitee.name),
        name: invitee.name,
        joinedOn: formatOrderDate(
          new Date((invitee as unknown as { createdAt: Date }).createdAt),
        ),
      })),
    };
  }
}

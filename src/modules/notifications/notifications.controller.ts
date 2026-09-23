import { Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /* ---------------------------------- admin --------------------------------- */

  @Roles(Role.Admin)
  @Get('admin/notifications')
  @ApiOperation({ summary: 'The admin bell — newest first' })
  async listForAdmin() {
    const [items, unread] = await Promise.all([
      this.notifications.listForAdmin(),
      this.notifications.unreadCount(Role.Admin),
    ]);
    return { items, unread };
  }

  @Roles(Role.Admin)
  @Patch('admin/notifications/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark one notification read' })
  async markRead(@Param('id') id: string) {
    await this.notifications.markRead(id);
  }

  @Roles(Role.Admin)
  @Post('admin/notifications/read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark every admin notification read' })
  async markAllRead() {
    await this.notifications.markAllRead(Role.Admin);
  }

  /* -------------------------------- customer -------------------------------- */

  /**
   * The customer's own — "your bank details were sent back", and the
   * approval that closes it. Addressed to them individually rather than
   * to a role, so the query is by recipient.
   */
  @Get('notifications')
  @ApiOperation({ summary: 'Notifications addressed to me' })
  async listForMe(@CurrentUser() user: AuthUser) {
    return { items: await this.notifications.listForUser(user.userId) };
  }
}

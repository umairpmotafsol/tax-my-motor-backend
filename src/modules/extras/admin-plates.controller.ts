import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { paginate } from '../../common/dto/pagination.dto';
import { Role } from '../../common/enums/role.enum';
import { ListPlateOrdersDto, UpdatePlateStatusDto } from './dto/extras.dto';
import { PlatesService, toAdminPlateOrder } from './plates.service';

/**
 * Number plates orders, as the admin portal works them: every order with
 * its delivery details, and the status an admin moves along by hand.
 */
@ApiTags('number plates (admin)')
@Roles(Role.Admin)
@Controller('admin/plates')
export class AdminPlatesController {
  constructor(private readonly plates: PlatesService) {}

  @Get()
  @ApiOperation({ summary: 'Every number plates order, filtered and paged' })
  async list(@Query() query: ListPlateOrdersDto) {
    const [page, counts] = await Promise.all([
      this.plates.listForAdmin(query),
      this.plates.countsByStatus(),
    ]);
    return {
      ...paginate(page.items.map(toAdminPlateOrder), page.total, page.page, page.limit),
      counts,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One number plates order' })
  async get(@Param('id') id: string) {
    return toAdminPlateOrder(await this.plates.findById(id));
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Move a number plates order to another status' })
  async setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdatePlateStatusDto,
  ) {
    return toAdminPlateOrder(await this.plates.setStatus(id, dto.status, user.userId));
  }
}

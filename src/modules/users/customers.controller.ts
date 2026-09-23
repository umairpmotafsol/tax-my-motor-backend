import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { Role } from '../../common/enums/role.enum';
import { toAdminCustomer } from './users.serializer';
import { UsersService } from './users.service';

/** The admin portal's customer directory. Read-only: customers manage themselves. */
@ApiTags('customers (admin)')
@Roles(Role.Admin)
@Controller('admin/customers')
export class CustomersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Customers, searchable by name, email, phone or city' })
  async list(@Query() query: PaginationDto) {
    const page = await this.users.listCustomers(query.page, query.limit, query.search);
    const stats = await this.users.customerOrderStats(page.items.map(u => u._id));
    return paginate(
      page.items.map(u => toAdminCustomer(u, stats.get(String(u._id)))),
      page.total,
      page.page,
      page.limit,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One customer' })
  async detail(@Param('id') id: string) {
    const user = await this.users.findById(id);
    const stats = await this.users.customerOrderStats([user._id]);
    return toAdminCustomer(user, stats.get(String(user._id)));
  }
}

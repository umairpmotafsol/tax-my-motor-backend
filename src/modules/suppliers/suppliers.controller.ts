import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  forwardRef,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { OrderType } from '../../common/enums/order.enum';
import { Role } from '../../common/enums/role.enum';
import { randomPassword } from '../../common/utils/crypto.util';
import { OrdersService } from '../orders/orders.service';
import { UsersService } from '../users/users.service';
import {
  CreateSupplierDto,
  CreateSupplierUserDto,
  SetSupplierStatusDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';
import { SupplierDocument } from './schemas/supplier.schema';
import { toSupplier, toSupplierLogin } from './suppliers.serializer';
import { SuppliersService } from './suppliers.service';

/**
 * The admin's supplier list and the routing rules that go with it.
 * Changing who holds an order type changes where new orders land, so
 * this is admin-only throughout.
 */
@ApiTags('suppliers (admin)')
@Roles(Role.Admin)
@Controller('admin/suppliers')
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
    private readonly users: UsersService,
  ) {}

  /**
   * Each supplier carries its sign-ins, so the portal's supplier page —
   * who they are, what they route, and who can log in as them — is one
   * request rather than one per card.
   */
  @Get()
  @ApiOperation({ summary: 'Every supplier, the order types they hold and their sign-ins' })
  async list() {
    const [all, loginsByOwner] = await Promise.all([
      this.suppliers.findAll(),
      this.users.listSupplierLoginsByOwner(),
    ]);
    return all.map(supplier => ({
      ...toSupplier(supplier),
      logins: (loginsByOwner.get(String(supplier._id)) ?? []).map(toSupplierLogin),
    }));
  }

  /** Order types no active supplier covers — what the admin has to fix. */
  @Get('routing-gaps')
  @ApiOperation({ summary: 'Order types no active supplier handles' })
  async routingGaps() {
    return { orderTypes: await this.suppliers.uncoveredOrderTypes() };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One supplier' })
  async detail(@Param('id') id: string) {
    return this.withLogins(await this.suppliers.findById(id));
  }

  /**
   * One supplier as every route here returns it. Writes go through it
   * too: the admin portal replaces a row with what a write hands back,
   * so a response missing `logins` would blank the access panel on the
   * card until the next full refresh.
   */
  private async withLogins(supplier: SupplierDocument) {
    const logins = await this.users.listBySupplier(supplier._id);
    return { ...toSupplier(supplier), logins: logins.map(toSupplierLogin) };
  }

  @Post()
  @ApiOperation({ summary: 'Add a supplier' })
  async create(@Body() dto: CreateSupplierDto) {
    return this.withLogins(await this.suppliers.create(dto));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a supplier' })
  async update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.withLogins(await this.suppliers.update(id, dto));
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate or deactivate a supplier' })
  async setStatus(@Param('id') id: string, @Body() dto: SetSupplierStatusDto) {
    return this.withLogins(await this.suppliers.setStatus(id, dto.status));
  }

  /**
   * Hand an order type over. Exclusive: whoever held it loses it, so
   * there is never a question of which of several eligible suppliers an
   * order happened to go to.
   */
  @Put(':id/order-types/:orderType')
  @ApiOperation({ summary: 'Give this supplier an order type, taking it off the last holder' })
  async assignOrderType(@Param('id') id: string, @Param('orderType') orderType: OrderType) {
    return this.withLogins(await this.suppliers.assignOrderType(id, orderType));
  }

  @Delete(':id/order-types/:orderType')
  @ApiOperation({ summary: 'Take an order type off this supplier' })
  async releaseOrderType(@Param('id') id: string, @Param('orderType') orderType: OrderType) {
    return this.withLogins(await this.suppliers.releaseOrderType(id, orderType));
  }

  /* ------------------------------- sign-ins -------------------------------- */

  @Get(':id/users')
  @ApiOperation({ summary: 'The sign-ins that belong to this supplier' })
  async listUsers(@Param('id') id: string) {
    const supplier = await this.suppliers.findById(id);
    const users = await this.users.listBySupplier(supplier._id);
    return users.map(toSupplierLogin);
  }

  /**
   * The login that goes with a supplier. Suppliers cannot sign
   * themselves up: the admin holds the email address they were given
   * and opens the account on their behalf.
   *
   * The password comes back in plaintext here and nowhere else, ever —
   * this response is the one chance to read it, which is why the admin
   * portal shows it as something to copy rather than as a value on the
   * supplier's card.
   */
  @Post(':id/users')
  @ApiOperation({ summary: 'Create a sign-in for this supplier, with a generated password' })
  async createUser(@Param('id') id: string, @Body() dto: CreateSupplierUserDto) {
    const supplier = await this.suppliers.findById(id);
    const password = dto.password ?? randomPassword();
    const user = await this.users.create({
      name: dto.name || supplier.contact || supplier.name,
      email: dto.email,
      password,
      role: Role.Supplier,
      supplier: supplier._id,
      /* Generated here and sent over, so the holder is asked to replace it. */
      mustChangePassword: true,
    });
    return { login: toSupplierLogin(user), password };
  }

  /**
   * A new password for a supplier who has lost theirs. Same one-shot
   * response as creating the login, and scoped to this supplier so an
   * id from elsewhere cannot be reset through their URL.
   */
  @Post(':id/users/:userId/password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a new password for this sign-in' })
  async resetUserPassword(@Param('id') id: string, @Param('userId') userId: string) {
    const supplier = await this.suppliers.findById(id);
    const user = await this.users.findById(userId);
    if (String(user.supplier ?? '') !== String(supplier._id)) {
      throw new NotFoundException('That sign-in does not belong to this supplier.');
    }
    const password = randomPassword();
    return { login: toSupplierLogin(await this.users.setPassword(user._id, password)), password };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a supplier that holds no open orders' })
  async remove(@Param('id') id: string) {
    const open = await this.orders.countOpenForSupplier(id);
    await this.suppliers.remove(id, open);
  }
}

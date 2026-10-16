import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ForgetDeviceDto, RegisterDeviceDto } from './dto/device.dto';

/**
 * Where an app says "push to this phone", and "stop".
 *
 * Both are authenticated, which is the point of the first: the token
 * alone says which handset, never whose. Registering attaches it to the
 * account making the call, so a phone can only ever be signed up for
 * the notifications of whoever is signed in on it.
 */
@ApiTags('devices')
@Controller('devices')
export class DevicesController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register this phone for push notifications' })
  async register(@CurrentUser() user: AuthUser, @Body() dto: RegisterDeviceDto): Promise<void> {
    await this.users.registerDevice(user.userId, dto.token, dto.platform);
  }

  /**
   * Called on sign-out, before the token is thrown away. Not scoped to
   * the caller on purpose: the phone is asking to be forgotten, and the
   * only thing it can forget is itself.
   */
  @Post('forget')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop pushing to this phone' })
  async forget(@Body() dto: ForgetDeviceDto): Promise<void> {
    await this.users.forgetDevices([dto.token]);
  }
}

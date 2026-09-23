import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { toPublicUser } from '../users/users.serializer';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto/auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  /** Tighter than the global limit: this is where guessing happens. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Create a customer account and sign in' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, context(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in as a customer, supplier or admin' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, context(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new pair' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, context(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End this session' })
  async logout(@Body() dto: Partial<RefreshDto>) {
    await this.auth.logout(dto?.refreshToken);
  }

  @Post('logout-everywhere')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End every session for this account' })
  async logoutEverywhere(@CurrentUser() user: AuthUser) {
    await this.auth.logoutEverywhere(user.userId);
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in account' })
  async me(@CurrentUser() user: AuthUser) {
    return toPublicUser(await this.users.findById(user.userId));
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the saved profile reused on every order' })
  async updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return toPublicUser(await this.users.updateProfile(user.userId, dto));
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change the password on the signed-in account' })
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    await this.users.changePassword(user.userId, dto.currentPassword, dto.newPassword);
    /* Every other device is signed out — a password change is usually a response to something. */
    await this.auth.logoutEverywhere(user.userId);
  }
}

function context(req: Request) {
  return { userAgent: req.headers['user-agent'] ?? '', ip: req.ip ?? '' };
}

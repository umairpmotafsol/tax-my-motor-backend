import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { toPublicUser } from '../users/users.serializer';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
  UpdateProfileDto,
  VerifyResetCodeDto,
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

  /* Customers only: supplier and admin passwords are issued by an admin. */
  @Roles(Role.Customer)
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change the password on the signed-in customer account' })
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(
      user.userId,
      dto.currentPassword,
      dto.newPassword,
      dto.refreshToken,
    );
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Email a 6-digit password reset code, valid for 15 minutes' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.requestPasswordReset(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-reset-code')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Check a password reset code without using it up' })
  async verifyResetCode(@Body() dto: VerifyResetCodeDto) {
    await this.auth.verifyResetCode(dto.email, dto.code);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set a new password with an emailed reset code' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.email, dto.code, dto.newPassword);
  }
}

function context(req: Request) {
  return { userAgent: req.headers['user-agent'] ?? '', ip: req.ip ?? '' };
}

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { Model, Types } from 'mongoose';

import { Role } from '../../common/enums/role.enum';
import { hashToken, randomToken } from '../../common/utils/crypto.util';
import { MailService } from '../mail/mail.service';
import { PublicUser, toPublicUser } from '../users/users.serializer';
import { UsersService } from '../users/users.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { PasswordReset, PasswordResetDocument } from './schemas/password-reset.schema';
import { Session, SessionDocument } from './schemas/session.schema';
import { JwtPayload } from './strategies/jwt.strategy';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface AuthResult extends AuthTokens {
  user: PublicUser;
}

/** How long an emailed reset code lasts. */
export const RESET_CODE_TTL_MS = 15 * 60_000;
/** Wrong codes before the code is used up and a new one has to be asked for. */
export const RESET_CODE_MAX_ATTEMPTS = 5;

interface RequestContext {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectModel(Session.name) private readonly sessionModel: Model<SessionDocument>,
    @InjectModel(PasswordReset.name) private readonly resetModel: Model<PasswordResetDocument>,
    private readonly mail: MailService,
  ) {}

  /** Self-service sign-up is for customers. Suppliers and admins are created by an admin. */
  async register(dto: RegisterDto, ctx: RequestContext = {}): Promise<AuthResult> {
    const user = await this.users.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      name: dto.name,
      email: dto.email,
      password: dto.password,
      role: Role.Customer,
      phone: dto.phone,
      address: dto.address,
      referredByCode: dto.referralCode,
    });

    /*
     * The reward lands when the invitee signs up, not when they order.
     * Whoever invited them has done their part either way.
     */
    if (user.referredBy) {
      await this.users.grantFreeOrder(user.referredBy);
    }

    return this.issue(user, ctx);
  }

  async login(dto: LoginDto, ctx: RequestContext = {}): Promise<AuthResult> {
    const user = await this.users.findByEmailWithPassword(dto.email);

    /*
     * The same message and the same amount of work whether the address
     * is unknown or the password is wrong, so the response cannot be
     * used to find out which addresses have accounts.
     */
    const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const matches = await bcrypt.compare(dto.password, hash);

    if (!user || !matches) {
      throw new UnauthorizedException('That email address and password do not match.');
    }
    if (!user.active) {
      throw new UnauthorizedException('This account has been deactivated.');
    }

    await this.users.recordLogin(user._id);
    return this.issue(user, ctx);
  }

  /**
   * Refresh rotates: the presented token is deleted as the new one is
   * stored, so a stolen token is usable once at most, and the theft
   * shows up as the real user being signed out.
   */
  async refresh(refreshToken: string, ctx: RequestContext = {}): Promise<AuthResult> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }

    const deleted = await this.sessionModel.findOneAndDelete({
      tokenHash: hashToken(refreshToken),
      user: payload.sub,
    });
    if (!deleted) {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }

    const user = await this.users.findById(payload.sub);
    if (!user.active) {
      throw new UnauthorizedException('This account has been deactivated.');
    }
    return this.issue(user, ctx);
  }

  /** Ends this one session. Other devices stay signed in. */
  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) {
      return;
    }
    await this.sessionModel.deleteOne({ tokenHash: hashToken(refreshToken) });
  }

  async logoutEverywhere(userId: string): Promise<void> {
    await this.sessionModel.deleteMany({ user: userId });
  }

  /* -------------------------------- passwords ------------------------------- */

  /**
   * From Settings. Every other device is signed out — a password change
   * is usually a response to something — but this one stays signed in
   * when it says which session it is.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepRefreshToken?: string,
  ): Promise<void> {
    await this.users.changePassword(userId, currentPassword, newPassword);
    await this.sessionModel.deleteMany({
      user: userId,
      ...(keepRefreshToken ? { tokenHash: { $ne: hashToken(keepRefreshToken) } } : {}),
    });
  }

  /**
   * "Forgot password?": emails a six-digit code, good for fifteen
   * minutes. Asking again replaces the code, so only the latest email
   * works.
   *
   * The answer is the same whether or not the address has an account,
   * so this cannot be used to find out who is a customer. Only customer
   * accounts are sent a code — suppliers and admins get a new password
   * from an admin.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.users.findByEmailWithPassword(email);
    if (!user || user.role !== Role.Customer || !user.active) {
      this.logger.log('Password reset asked for an address with no customer account.');
      return;
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.resetModel.findOneAndUpdate(
      { user: user._id },
      {
        $set: {
          codeHash: this.codeHash(user._id, code),
          expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
          attempts: 0,
        },
      },
      { upsert: true },
    );

    const sent = await this.mail.sendPasswordResetCode({
      to: user.email,
      customerName: user.name,
      code,
      minutes: RESET_CODE_TTL_MS / 60_000,
    });
    if (!sent.sent) {
      /* A code nobody received is no use to anybody. */
      await this.resetModel.deleteOne({ user: user._id });
      throw new ServiceUnavailableException(
        'We could not send the email just now. Please try again in a few minutes.',
      );
    }
  }

  /** The code screen's check, before the new password is asked for. Uses nothing up. */
  async verifyResetCode(email: string, code: string): Promise<void> {
    await this.checkResetCode(email, code);
  }

  /**
   * Sets the new password, once the code checks out. The code is used
   * up, and every session the account had is ended: whoever forgot the
   * password signs in again with the new one, and anybody else who was
   * signed in is not any more.
   */
  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    const { user, reset } = await this.checkResetCode(email, code);
    await this.users.setPassword(user._id, newPassword);
    await this.resetModel.deleteOne({ _id: reset._id });
    await this.sessionModel.deleteMany({ user: user._id });
  }

  private async checkResetCode(email: string, code: string) {
    const invalid = () =>
      new BadRequestException('That code is not right. Check the email and try again.');
    const expired = () =>
      new BadRequestException('That code has expired. Ask for a new one.');

    const user = await this.users.findByEmailWithPassword(email);
    const reset = user ? await this.resetModel.findOne({ user: user._id }) : null;
    if (!user || !reset) {
      throw expired();
    }
    if (reset.expiresAt.getTime() <= Date.now() || reset.attempts >= RESET_CODE_MAX_ATTEMPTS) {
      await this.resetModel.deleteOne({ _id: reset._id });
      throw expired();
    }
    if (reset.codeHash !== this.codeHash(user._id, code)) {
      reset.attempts += 1;
      await reset.save();
      if (reset.attempts >= RESET_CODE_MAX_ATTEMPTS) {
        await this.resetModel.deleteOne({ _id: reset._id });
        throw new BadRequestException('Too many wrong codes. Ask for a new one.');
      }
      throw invalid();
    }
    return { user, reset };
  }

  /** Bound to the account, so one customer's code is not another's. */
  private codeHash(userId: Types.ObjectId, code: string): string {
    return hashToken(String(userId) + ':' + code);
  }

  /* -------------------------------- internals ------------------------------- */

  private async issue(
    user: Awaited<ReturnType<UsersService['findById']>>,
    ctx: RequestContext,
  ): Promise<AuthResult> {
    const payload: JwtPayload = {
      sub: String(user._id),
      email: user.email,
      role: user.role,
      supplierId: user.supplier ? String(user.supplier) : undefined,
      name: user.name,
    };

    const accessTtl = this.config.getOrThrow<string>('jwt.accessTtl');
    const refreshTtl = this.config.getOrThrow<string>('jwt.refreshTtl');

    /*
     * jsonwebtoken types `expiresIn` as a template-literal union ("15m",
     * "30d", ...). These come from configuration, so the shape is
     * checked by the Joi schema at boot rather than by the compiler.
     */
    const expires = (ttl: string) => ttl as unknown as JwtSignOptions['expiresIn'];

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('jwt.accessSecret'),
      expiresIn: expires(accessTtl),
    });

    /*
     * A random jti keeps two refresh tokens issued in the same second
     * from being byte-identical, which the unique index would reject.
     */
    const refreshToken = await this.jwt.signAsync(
      { ...payload, jti: randomToken(16) },
      {
        secret: this.config.getOrThrow<string>('jwt.refreshSecret'),
        expiresIn: expires(refreshTtl),
      },
    );

    await this.sessionModel.create({
      user: user._id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + ttlToMs(refreshTtl)),
      userAgent: ctx.userAgent ?? '',
      ip: ctx.ip ?? '',
    });

    return { accessToken, refreshToken, expiresIn: accessTtl, user: toPublicUser(user) };
  }
}

/** "30d" / "15m" / "3600" -> milliseconds. */
export function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])?$/.exec(ttl.trim());
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000;
  return value * factor;
}

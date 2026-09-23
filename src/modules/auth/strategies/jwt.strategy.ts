import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AuthUser } from '../../../common/decorators/current-user.decorator';
import { Role } from '../../../common/enums/role.enum';
import { UsersService } from '../../users/users.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  supplierId?: string;
  name: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.accessSecret'),
    });
  }

  /**
   * The account is re-read on every request rather than trusted from
   * the token, so deactivating someone takes effect immediately instead
   * of whenever their access token happens to expire.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.users.findById(payload.sub).catch(() => null);
    if (!user || !user.active) {
      throw new UnauthorizedException('Your session is no longer valid. Please sign in again.');
    }
    return {
      userId: String(user._id),
      email: user.email,
      role: user.role,
      supplierId: user.supplier ? String(user.supplier) : undefined,
      name: user.name,
    };
  }
}

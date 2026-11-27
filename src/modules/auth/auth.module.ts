import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';

import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordReset, PasswordResetSchema } from './schemas/password-reset.schema';
import { Session, SessionSchema } from './schemas/session.schema';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    UsersModule,
    MailModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    /* Secrets are passed per sign/verify call, since access and refresh use different ones. */
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: PasswordReset.name, schema: PasswordResetSchema },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}

import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module';
import { DevicesController } from './devices.controller';
import { firebaseMessagingProvider } from './push.provider';
import { PushService } from './push.service';

/**
 * Push notifications. Depends on UsersModule because a device token is
 * kept on the account it belongs to — see `User.deviceTokens`.
 */
@Module({
  imports: [UsersModule],
  controllers: [DevicesController],
  providers: [firebaseMessagingProvider, PushService],
  exports: [PushService],
})
export class PushModule {}

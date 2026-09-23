import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module';
import { ReferralsController } from './referrals.controller';

@Module({
  imports: [UsersModule],
  controllers: [ReferralsController],
})
export class ReferralsModule {}

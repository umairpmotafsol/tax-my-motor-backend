import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { RealtimeGateway } from './realtime.gateway';

/**
 * Global, because almost every state change is worth pushing and
 * threading the gateway through each module's imports would add noise
 * without adding a decision.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}

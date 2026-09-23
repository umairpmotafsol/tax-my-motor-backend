import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Connection } from 'mongoose';

import { Public } from '../../common/decorators/public.decorator';

const STATE: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /**
   * What a load balancer polls. It reports the database connection
   * because a process that is up but cannot reach Mongo is not healthy
   * — it is just quiet about it.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness and database connectivity' })
  check() {
    const state = this.connection.readyState;
    return {
      status: state === 1 ? 'ok' : 'degraded',
      database: STATE[state] ?? 'unknown',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}

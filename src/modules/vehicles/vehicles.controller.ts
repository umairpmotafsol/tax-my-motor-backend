import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsString } from 'class-validator';

import { Public } from '../../common/decorators/public.decorator';
import { VehiclesService } from './vehicles.service';

class LookupDto {
  @IsString()
  @IsNotEmpty({ message: 'Please enter your registration number.' })
  reg!: string;
}

@ApiTags('vehicles')
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  /**
   * Public, because the customer app asks for a quote before anyone
   * signs in — that is the first screen.
   *
   * Throttled hard, because this now resolves against Vehicle Data
   * Global and a plate not already cached costs money. 30/min was fine
   * when the answer came from a local table; on a metered supplier it
   * is an invitation. Matches the tax route, which shares the same
   * cache and the same daily ceiling.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get('lookup')
  @ApiOperation({ summary: 'Resolve a UK registration to a vehicle' })
  lookup(@Query() query: LookupDto) {
    return this.vehicles.lookup(query.reg);
  }

  /**
   * DVLA tax status via Vehicle Data Global — separate from `lookup`,
   * which every order and V62 depends on and must keep resolving with
   * no key configured at all.
   *
   * Public for the same reason `lookup` is: the customer is quoted
   * before they sign in. That makes it an open door onto a metered
   * supplier, so it is throttled hard here and answered from the cache
   * wherever possible in the service; the daily ceiling behind it is
   * the backstop if both are beaten.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get('tax')
  @ApiOperation({ summary: 'DVLA tax status and VED rate for a registration' })
  checkTax(@Query() query: LookupDto) {
    return this.vehicles.checkTax(query.reg);
  }
}

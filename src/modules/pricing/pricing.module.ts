import { Module } from '@nestjs/common';

import { VehiclesModule } from '../vehicles/vehicles.module';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

@Module({
  /* Prices come from the vehicle's own VED rates, so this needs the lookup. */
  imports: [VehiclesModule],
  controllers: [PricingController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}

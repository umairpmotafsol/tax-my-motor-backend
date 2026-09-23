import { Module } from '@nestjs/common';

import { PricingModule } from '../pricing/pricing.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [PricingModule, VehiclesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}

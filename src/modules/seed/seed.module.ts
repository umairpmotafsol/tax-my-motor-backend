import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module';
import { PricingModule } from '../pricing/pricing.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { UsersModule } from '../users/users.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { SeedService } from './seed.service';

@Module({
  imports: [UsersModule, SuppliersModule, OrdersModule, VehiclesModule, PricingModule],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}

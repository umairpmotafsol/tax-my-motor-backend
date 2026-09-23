import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Vehicle, VehicleSchema } from './schemas/vehicle.schema';
import {
  VehicleDataUsage,
  VehicleDataUsageSchema,
} from './schemas/vehicle-data-usage.schema';
import {
  VehicleTaxLookup,
  VehicleTaxLookupSchema,
} from './schemas/vehicle-tax-lookup.schema';
import { VehicleDataClient } from './vehicle-data.client';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Vehicle.name, schema: VehicleSchema },
      { name: VehicleTaxLookup.name, schema: VehicleTaxLookupSchema },
      { name: VehicleDataUsage.name, schema: VehicleDataUsageSchema },
    ]),
  ],
  controllers: [VehiclesController],
  providers: [VehiclesService, VehicleDataClient],
  exports: [VehiclesService],
})
export class VehiclesModule {}

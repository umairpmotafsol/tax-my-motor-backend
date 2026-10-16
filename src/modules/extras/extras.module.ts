import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { MailModule } from '../mail/mail.module';
import { PaymentsModule } from '../payments/payments.module';
import { UsersModule } from '../users/users.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { AdminPlatesController } from './admin-plates.controller';
import { ExtrasController } from './extras.controller';
import { PlatesService } from './plates.service';
import { PlateOrder, PlateOrderSchema } from './schemas/plate-order.schema';
import { VinPurchase, VinPurchaseSchema } from './schemas/vin-purchase.schema';
import { VinService } from './vin.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VinPurchase.name, schema: VinPurchaseSchema },
      { name: PlateOrder.name, schema: PlateOrderSchema },
    ]),
    VehiclesModule,
    PaymentsModule,
    UsersModule,
    MailModule,
  ],
  controllers: [ExtrasController, AdminPlatesController],
  providers: [VinService, PlatesService],
})
export class ExtrasModule {}

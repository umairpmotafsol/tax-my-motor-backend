import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OrdersModule } from '../orders/orders.module';
import { UsersModule } from '../users/users.module';
import { Supplier, SupplierSchema } from './schemas/supplier.schema';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/**
 * Orders needs suppliers to route, and the supplier controller needs
 * orders to count what a supplier still holds before allowing a delete.
 * That is a genuine two-way relationship rather than a layering
 * mistake, so it is declared with forwardRef and left explicit.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Supplier.name, schema: SupplierSchema }]),
    UsersModule,
    forwardRef(() => OrdersModule),
  ],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService, MongooseModule],
})
export class SuppliersModule {}

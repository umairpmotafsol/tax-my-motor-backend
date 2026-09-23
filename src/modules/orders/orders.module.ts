import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BankReviewService } from '../bank/bank-review.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { PricingModule } from '../pricing/pricing.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { UsersModule } from '../users/users.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { AdminOrdersController } from './admin-orders.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersTasks } from './orders.tasks';
import { Counter, CounterSchema } from './schemas/counter.schema';
import { Order, OrderSchema } from './schemas/order.schema';
import { SupplierOrdersController } from './supplier-orders.controller';

/**
 * The order book, and the three views of it.
 *
 * BankReviewService is provided here rather than in a module of its
 * own: it is a second set of operations on the same aggregate, and
 * splitting it into a module would only buy a circular import.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Counter.name, schema: CounterSchema },
    ]),
    forwardRef(() => SuppliersModule),
    UsersModule,
    VehiclesModule,
    PricingModule,
    PaymentsModule,
    NotificationsModule,
  ],
  controllers: [OrdersController, SupplierOrdersController, AdminOrdersController],
  providers: [OrdersService, BankReviewService, OrdersTasks],
  exports: [OrdersService, BankReviewService, MongooseModule],
})
export class OrdersModule {}

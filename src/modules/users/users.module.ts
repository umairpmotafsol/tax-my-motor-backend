import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { CustomersController } from './customers.controller';
import { User, UserSchema } from './schemas/user.schema';
import { UsersService } from './users.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      /*
       * Read-only, for the admin customer directory's order aggregates
       * (spend, WhatsApp/V62 preference, latest order). Registering the
       * schema here rather than importing OrdersModule avoids a circular
       * module dependency — Mongoose models live on the connection, not
       * on the module that first declares them, so this is safe.
       */
      { name: Order.name, schema: OrderSchema },
    ]),
  ],
  controllers: [CustomersController],
  providers: [UsersService],
  exports: [UsersService, MongooseModule],
})
export class UsersModule {}

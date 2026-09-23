import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { OrdersModule } from '../orders/orders.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

/**
 * Uploads are buffered in memory rather than written straight to disk,
 * so a rejected file — wrong type, wrong supplier — never lands on the
 * filesystem at all. Invoice photos are small enough for that to be the
 * cheaper trade; the size cap is what keeps it true.
 */
@Module({
  imports: [
    OrdersModule,
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: memoryStorage(),
        limits: {
          fileSize: config.get<number>('maxUploadBytes') ?? 10 * 1024 * 1024,
          files: 1,
        },
      }),
    }),
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}

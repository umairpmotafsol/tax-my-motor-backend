import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { SeedService } from './seed.service';

/**
 * `npm run seed` — seeds without starting the HTTP server.
 *
 * Pass --with-orders to add the demo order book as well; reference data
 * (suppliers, accounts, the vehicle register) is always safe to re-run,
 * and demo orders are only written into an empty order book.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const withOrders = process.argv.includes('--with-orders');
    await app.get(SeedService).run(withOrders);
  } catch (error) {
    logger.error('Seeding failed', error as Error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();

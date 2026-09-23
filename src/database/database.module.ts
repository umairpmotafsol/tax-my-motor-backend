import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

/**
 * The MongoDB connection. Mongoose buffers commands while it is still
 * connecting, so a request that lands during startup waits rather than
 * failing — but only briefly, so a genuinely unreachable database is
 * reported instead of hanging.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('databaseUri'),
        serverSelectionTimeoutMS: 10000,
        bufferCommands: true,
        autoIndex: config.get<string>('env') !== 'production',
        retryWrites: true,
      }),
    }),
  ],
})
export class DatabaseModule {}

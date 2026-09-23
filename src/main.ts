import dns from 'dns';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';

/*
 * Windows sometimes reports a stale 127.0.0.1 resolver (left behind by a
 * disconnected VPN/TAP adapter) via GetNetworkParams, which Node's DNS
 * module trusts over the adapter actually in use. That breaks the SRV/TXT
 * lookups mongodb+srv:// needs. Pointing at public resolvers up front
 * avoids depending on whatever Windows hands back.
 */
dns.setServers(['8.8.8.8', '1.1.1.1']);

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { initEncryption } from './common/utils/crypto.util';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  /*
   * rawBody: true keeps the exact request bytes alongside the parsed
   * body. The Stripe webhook needs them — a signature checked against a
   * re-serialised JSON body would fail even for a genuine event.
   */
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  const config = app.get(ConfigService);

  const env = config.getOrThrow<string>('env');
  const port = config.getOrThrow<number>('port');
  const prefix = config.getOrThrow<string>('apiPrefix');
  const origins = config.get<string[]>('corsOrigins') ?? [];

  /* Fails fast in production if the key is missing, rather than at first write. */
  initEncryption(config.get<string>('encryptionKey') ?? '', env);

  app.setGlobalPrefix(prefix);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());

  /**
   * An empty allowlist means every origin, which is only tolerable
   * while developing — the mobile apps have no origin at all, and the
   * portal runs on whichever port Vite picked. In production the list
   * has to be set, and anything not on it is refused.
   */
  app.enableCors({
    origin: origins.length > 0 ? origins : env === 'production' ? false : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      /* An unknown field is a bug or an attack; either way, say so. */
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  app.enableShutdownHooks();

  if (env !== 'production') {
    const swagger = new DocumentBuilder()
      .setTitle('TaxMyMotor API')
      .setDescription(
        'One order book behind the customer app, the supplier app and the admin portal.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(prefix + '/docs', app, SwaggerModule.createDocument(app, swagger));
  }

  await app.listen(port, '0.0.0.0');
  logger.log('TaxMyMotor API listening on port ' + port + ' (' + env + ')');
  logger.log('REST      http://localhost:' + port + '/' + prefix);
  logger.log('WebSocket ws://localhost:' + port + '/realtime');
  if (env !== 'production') {
    logger.log('Docs      http://localhost:' + port + '/' + prefix + '/docs');
  }
}

void bootstrap();

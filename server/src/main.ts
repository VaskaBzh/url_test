import type { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module';

function resolveEnabledLogLevels(
  requestedLogLevel: string | undefined,
): LogLevel[] {
  switch (requestedLogLevel?.toLowerCase()) {
    case 'error':
      return ['error'];
    case 'warn':
      return ['error', 'warn'];
    case 'info':
    case 'log':
      return ['error', 'warn', 'log'];
    case 'verbose':
      return ['error', 'warn', 'log', 'debug', 'verbose'];
    case 'debug':
    default:
      return ['error', 'warn', 'log', 'debug'];
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: resolveEnabledLogLevels(process.env.LOG_LEVEL),
  });
  app.enableCors({
    origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  });
  app.setGlobalPrefix('api');
  app.useStaticAssets(join(__dirname, '..', 'public'));
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();

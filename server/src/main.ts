import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { configureApplication, resolveLoggerLevels } from './app.config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const application = await NestFactory.create<NestExpressApplication>(
    AppModule,
    { logger: resolveLoggerLevels(process.env.LOG_LEVEL) },
  );
  configureApplication(application);
  application.useStaticAssets(join(__dirname, '..', 'public'));
  await application.listen(process.env.PORT ?? 3000);
}
void bootstrap();

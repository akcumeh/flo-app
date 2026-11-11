import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import * as OpenApiValidator from 'express-openapi-validator';
import { AppModule, type AppDeps } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';

export interface CreateAppOptions extends AppDeps {
  validateResponses?: boolean;
  logger?: false;
}

export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    logger: options.logger === false ? false : ['error', 'warn', 'log'],
    bodyParser: false,
  });

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  app.use(json({ limit: '1mb' }));
  app.enableCors({ origin: options.config.webOrigin, credentials: true });

  app.use(
    OpenApiValidator.middleware({
      apiSpec: join(process.cwd(), 'openapi.yaml'),
      validateRequests: true,
      validateResponses: options.validateResponses ?? false,
      validateSecurity: false,
      ignoreUndocumented: true,
    })
  );

  app.useGlobalFilters(new ProblemFilter());
  return app;
}

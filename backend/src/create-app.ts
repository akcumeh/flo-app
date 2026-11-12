import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import * as OpenApiValidator from 'express-openapi-validator';
import { AppModule, type AppDeps } from './app.module.js';
import { JsonLogger, requestIds } from './common/logging.js';
import { ProblemFilter } from './common/problem.filter.js';
import { rateLimit } from './common/rate-limit.js';
import { MAX_PARTS, MAX_UPLOAD_BYTES } from './files/files.service.js';

export interface CreateAppOptions extends AppDeps {
  validateResponses?: boolean;
  logger?: false;
  rateLimits?: boolean;
}

export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    logger: options.logger === false ? false : new JsonLogger(),
    bodyParser: false,
  });

  app.set('trust proxy', 1);
  app.use(requestIds(options.logger !== false));
  if (options.rateLimits ?? options.config.nodeEnv !== 'test') app.use(rateLimit());
  app.use(helmet());
  app.use(cookieParser());
  app.use(
    json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );
  app.enableCors({ origin: options.config.webOrigin, credentials: true });

  app.use(
    OpenApiValidator.middleware({
      apiSpec: join(process.cwd(), 'openapi.yaml'),
      validateRequests: true,
      validateResponses: options.validateResponses ?? false,
      validateSecurity: false,
      ignoreUndocumented: true,
      fileUploader: { limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: MAX_PARTS + 1, fields: 10 } },
    })
  );

  app.useGlobalFilters(new ProblemFilter());
  return app;
}

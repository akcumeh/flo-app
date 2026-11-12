import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { json, type NextFunction, type Request, type Response } from 'express';
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

const API_PREFIXES = ['/v1/', '/internal/', '/storage/'];

function serveWeb(app: NestExpressApplication, dir: string) {
    const index = join(dir, 'index.html');
    app.use(
        express.static(dir, {
            index: false,
            setHeaders: (res, path) => {
                if (/[\\/]assets[\\/]/.test(path))
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                else res.setHeader('Cache-Control', 'no-cache');
            },
        })
    );
    app.use((req: Request, res: Response, next: NextFunction) => {
        if (
            req.method !== 'GET' ||
            API_PREFIXES.some((p) => req.path.startsWith(p)) ||
            req.path === '/v1'
        )
            return next();
        if (!req.accepts('html')) return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(index);
    });
}

export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
        logger: options.logger === false ? false : new JsonLogger(),
        bodyParser: false,
    });

    app.set('trust proxy', 1);
    app.use(requestIds(options.logger !== false));
    if (options.rateLimits ?? options.config.nodeEnv !== 'test') app.use(rateLimit());
    app.use(
        helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
                    styleSrc: [
                        "'self'",
                        "'unsafe-inline'",
                        'https://accounts.google.com/gsi/style',
                    ],
                    frameSrc: ["'self'", 'https://accounts.google.com/gsi/'],
                    connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
                    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                    fontSrc: ["'self'", 'data:'],
                    workerSrc: ["'self'"],
                    manifestSrc: ["'self'"],
                },
            },
            crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
        })
    );
    if (options.config.webDist) serveWeb(app, options.config.webDist);
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
            fileUploader: {
                defParamCharset: 'utf8',
                limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: MAX_PARTS + 1, fields: 10 },
            },
        })
    );

    app.useGlobalFilters(new ProblemFilter());
    return app;
}

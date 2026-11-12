import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../common/app-error.js';
import { safeEqual } from '../common/crypto.js';
import { CONFIG, type Config } from '../config.js';

@Injectable()
export class ServiceKeyGuard implements CanActivate {
    constructor(@Inject(CONFIG) private readonly config: Config) {}

    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>();
        const key = req.headers['x-service-key'];
        if (typeof key !== 'string' || !safeEqual(key, this.config.internalApiSecret)) {
            throw AppError.unauthorized('invalid_service_key', 'Missing or wrong service key.');
        }
        return true;
    }
}

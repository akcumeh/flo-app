import { All, Controller, Get, Inject } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { CONFIG, type Config } from '../config.js';

@Controller()
export class SystemController {
    constructor(@Inject(CONFIG) private readonly config: Config) {}

    @Get('v1/health')
    health() {
        return { status: 'ok' };
    }

    @Get('v1/status')
    status() {
        return {
            maintenance: false,
            message: null,
            minClientVersion: '0.0.0',
            latestClientVersion: '0.0.0',
            support: {
                whatsapp: this.config.supportWhatsapp,
                email: this.config.supportEmail,
            },
        };
    }
}

@Controller()
export class UnknownRouteController {
    @All(['v1/*path', 'internal/*path'])
    unknown() {
        throw AppError.notFound('No such endpoint.');
    }
}

import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../common/app-error.js';
import { AuthService } from './auth.service.js';

export interface AuthedRequest extends Request {
    accountId: string;
}

export function optionalAccount(req: Request, auth: AuthService): string | null {
    const header = req.headers.authorization;
    if (!header) return null;
    if (!header.startsWith('Bearer ')) throw AppError.unauthorized();
    return auth.verifyAccess(header.slice('Bearer '.length));
}

@Injectable()
export class JwtGuard implements CanActivate {
    constructor(@Inject(AuthService) private readonly auth: AuthService) {}

    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<AuthedRequest>();
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) throw AppError.unauthorized();
        req.accountId = this.auth.verifyAccess(header.slice('Bearer '.length));
        return true;
    }
}

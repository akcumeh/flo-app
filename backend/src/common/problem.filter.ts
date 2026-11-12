import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { AppError } from './app-error.js';

interface ValidatorError {
    status?: number;
    message?: string;
    errors?: Array<{ path?: string; message?: string }>;
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
    private readonly logger = new Logger('Problem');

    catch(exception: unknown, host: ArgumentsHost) {
        const http = host.switchToHttp();
        const res = http.getResponse<Response>();
        const req = http.getRequest<Request>();
        const requestId =
            (req.headers['x-request-id'] as string) || `req_${randomUUID().slice(0, 12)}`;

        let status = 500;
        let code = 'internal_error';
        let title = 'Something went wrong';
        let detail: string | undefined;
        let extra: Record<string, unknown> = {};

        if (exception instanceof AppError) {
            status = exception.status;
            code = exception.code;
            title = exception.title;
            detail = exception.detail;
            extra = exception.extra;
            for (const [k, v] of Object.entries(exception.headers)) res.setHeader(k, v);
        } else if (exception instanceof HttpException) {
            status = exception.getStatus();
            code = status === 404 ? 'not_found' : 'http_error';
            title = exception.message;
        } else if (typeof (exception as ValidatorError)?.status === 'number') {
            const err = exception as ValidatorError;
            status = err.status as number;
            code =
                status === 400
                    ? 'invalid_request'
                    : status === 404
                      ? 'not_found'
                      : status === 405
                        ? 'method_not_allowed'
                        : 'http_error';
            title = status === 400 ? 'Invalid request' : (err.message ?? 'Error');
            detail =
                err.errors?.map((e) => `${e.path ?? ''} ${e.message ?? ''}`.trim()).join('; ') ||
                err.message;
            if (status === 413) {
                code = 'file_too_large';
                title = 'Too large';
                detail = 'Files can be at most 20 MB in total.';
            }
        } else {
            this.logger.error(
                exception instanceof Error
                    ? (exception.stack ?? exception.message)
                    : String(exception)
            );
        }

        res.status(status)
            .type('application/problem+json')
            .json({
                type: `https://florence.example/problems/${code.replace(/_/g, '-')}`,
                title,
                status,
                code,
                ...(detail ? { detail } : {}),
                requestId,
                ...extra,
            });
    }
}

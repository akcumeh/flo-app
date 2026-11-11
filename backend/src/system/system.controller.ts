import { All, Controller, Get } from '@nestjs/common';
import { AppError } from '../common/app-error.js';

@Controller()
export class SystemController {
  @Get('v1/health')
  health() {
    return { status: 'ok' };
  }

  @Get('v1/status')
  status() {
    return { maintenance: false, message: null, minClientVersion: '0.0.0', latestClientVersion: '0.0.0' };
  }
}

@Controller()
export class NotImplementedController {
  @All(['v1/*path', 'internal/*path'])
  notImplemented() {
    throw AppError.notImplemented();
  }
}

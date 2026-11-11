import { DynamicModule, Module } from '@nestjs/common';
import { AccountsController } from './accounts/accounts.controller.js';
import { AccountsService } from './accounts/accounts.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { JwtGuard } from './auth/jwt.guard.js';
import { MAILER, type Mailer } from './auth/mailer.js';
import { CONFIG, type Config } from './config.js';
import { DB, type Db } from './db/db.js';
import { NotImplementedController, SystemController } from './system/system.controller.js';
import { TokensController } from './tokens/tokens.controller.js';
import { TokensService } from './tokens/tokens.service.js';

export interface AppDeps {
  config: Config;
  db: Db;
  mailer: Mailer;
}

@Module({})
export class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AuthController,
        AccountsController,
        TokensController,
        SystemController,
        NotImplementedController,
      ],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: DB, useValue: deps.db },
        { provide: MAILER, useValue: deps.mailer },
        AuthService,
        AccountsService,
        TokensService,
        JwtGuard,
      ],
    };
  }
}

import { DynamicModule, Module } from '@nestjs/common';
import { AccountsController } from './accounts/accounts.controller.js';
import { AccountsService } from './accounts/accounts.service.js';
import { MergeService } from './accounts/merge.service.js';
import { AI_PROVIDER, AnthropicProvider, FakeAiProvider, type AiProvider } from './ai/ai.provider.js';
import { StudentService } from './accounts/student.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { ChallengesController } from './auth/challenges.controller.js';
import { ChallengesService } from './auth/challenges.service.js';
import { EXTERNAL_AUTH, JoseExternalAuth, type ExternalAuth } from './auth/external-auth.js';
import { IdentityService } from './auth/identity.service.js';
import { JwtGuard } from './auth/jwt.guard.js';
import { MAILER, type Mailer } from './auth/mailer.js';
import { SocialAuthService } from './auth/social.service.js';
import { CONFIG, type Config } from './config.js';
import { ChatController, GuestClaimController, GuestController } from './chat/chat.controller.js';
import { ChatService } from './chat/chat.service.js';
import { GuestService } from './chat/guest.service.js';
import { CLOCK, Clock } from './common/clock.js';
import { DB, type Db } from './db/db.js';
import { GeneratorService } from './study/generator.service.js';
import { ProgressService } from './study/progress.service.js';
import { SessionsService } from './study/sessions.service.js';
import { StreakService } from './study/streak.service.js';
import { BoardsController, ProgressController, SessionsController } from './study/study.controller.js';
import { FilesController, LocalStorageController } from './files/files.controller.js';
import { FilesService } from './files/files.service.js';
import { ReaderService } from './files/reader.service.js';
import { JobsService } from './jobs/jobs.service.js';
import { SchedulerService } from './jobs/scheduler.service.js';
import { FactsService } from './profile/facts.service.js';
import { FactsController, ProfileController, SchoolsController } from './profile/profile.controller.js';
import { ProfileService } from './profile/profile.service.js';
import { LocalDiskStorage, STORAGE, SupabaseStorage, type ObjectStorage } from './storage/storage.js';
import { BotEventsService } from './internal/bot-events.service.js';
import { InternalController } from './internal/internal.controller.js';
import { DisabledPaystack, HttpPaystack, PAYSTACK, type PaystackClient } from './money/paystack.js';
import { PurchasesService } from './money/purchases.service.js';
import { AccountLifecycleService } from './platform/account-lifecycle.service.js';
import { MESSENGER, TelegramMessenger, type BotMessenger } from './platform/messenger.js';
import { NotificationsService } from './platform/notifications.service.js';
import { PlatformController, PublicPlatformController } from './platform/platform.controller.js';
import { PUSH, WebPushSender, ephemeralVapid, type PushSender } from './platform/push.js';
import { ReferralsService } from './platform/referrals.service.js';
import { ServiceKeyGuard } from './internal/service-key.guard.js';
import { UnknownRouteController, SystemController } from './system/system.controller.js';
import { TokensController } from './tokens/tokens.controller.js';
import { TokensService } from './tokens/tokens.service.js';

export interface AppDeps {
  config: Config;
  db: Db;
  mailer: Mailer;
  externalAuth?: ExternalAuth;
  ai?: AiProvider;
  storage?: ObjectStorage;
  clock?: Clock;
  paystack?: PaystackClient;
  push?: PushSender;
  messenger?: BotMessenger;
}

function defaultPaystack(config: Config): PaystackClient {
  const key = config.paystackSecretKey;
  if (!key) return new DisabledPaystack('PAYSTACK_SK_TEST (or PAYSTACK_SK_LIVE in production) is not set');
  if (config.nodeEnv !== 'production' && !key.startsWith('sk_test_')) {
    return new DisabledPaystack('Outside production the API only uses a Paystack test key (sk_test_)');
  }
  return new HttpPaystack(key);
}

function defaultPush(config: Config): PushSender {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    return new WebPushSender(config.vapidPublicKey, config.vapidPrivateKey, config.vapidSubject);
  }
  if (config.nodeEnv === 'production') throw new Error('Missing required environment variables: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY');
  const keys = ephemeralVapid();
  return new WebPushSender(keys.publicKey, keys.privateKey, config.vapidSubject);
}

function defaultAi(config: Config): AiProvider {
  if (config.anthropicApiKey) return new AnthropicProvider(config.anthropicApiKey, config.aiModel);
  if (config.nodeEnv === 'production') throw new Error('Missing required environment variable: ANTHROPIC_API_KEY');
  return new FakeAiProvider();
}

function defaultStorage(config: Config): ObjectStorage {
  if (config.supabaseUrl && config.supabaseServiceKey) {
    return new SupabaseStorage(config.supabaseUrl, config.supabaseServiceKey, config.storageBucket);
  }
  if (config.nodeEnv === 'production') throw new Error('Missing required environment variables: SUPABASE_URL (or SUPABASE_DB_URL), SUPABASE_SECRET_KEY');
  return new LocalDiskStorage(config.storageDir, config.publicApiUrl, config.codePepper);
}

@Module({})
export class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AuthController,
        ChallengesController,
        AccountsController,
        TokensController,
        SystemController,
        InternalController,
        SchoolsController,
        ProfileController,
        FactsController,
        FilesController,
        LocalStorageController,
        SessionsController,
        ProgressController,
        BoardsController,
        ChatController,
        PublicPlatformController,
        PlatformController,
        GuestController,
        GuestClaimController,
        UnknownRouteController,
      ],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: DB, useValue: deps.db },
        { provide: MAILER, useValue: deps.mailer },
        { provide: EXTERNAL_AUTH, useValue: deps.externalAuth ?? new JoseExternalAuth(deps.config) },
        { provide: AI_PROVIDER, useValue: deps.ai ?? defaultAi(deps.config) },
        { provide: STORAGE, useValue: deps.storage ?? defaultStorage(deps.config) },
        { provide: CLOCK, useValue: deps.clock ?? new Clock() },
        { provide: PAYSTACK, useValue: deps.paystack ?? defaultPaystack(deps.config) },
        { provide: PUSH, useValue: deps.push ?? defaultPush(deps.config) },
        { provide: MESSENGER, useValue: deps.messenger ?? new TelegramMessenger(deps.config.telegramBotToken) },
        PurchasesService,
        NotificationsService,
        ReferralsService,
        AccountLifecycleService,
        BotEventsService,
        JobsService,
        SchedulerService,
        StreakService,
        GeneratorService,
        SessionsService,
        ProgressService,
        ChatService,
        GuestService,
        FilesService,
        ReaderService,
        ProfileService,
        FactsService,
        AuthService,
        SocialAuthService,
        StudentService,
        MergeService,
        IdentityService,
        ChallengesService,
        AccountsService,
        TokensService,
        JwtGuard,
        ServiceKeyGuard,
      ],
    };
  }
}

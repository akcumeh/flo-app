import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthedRequest, JwtGuard } from '../auth/jwt.guard.js';
import { AppError } from '../common/app-error.js';
import { DB, type Db } from '../db/db.js';
import type { StudyMode } from './generator.service.js';
import { ProgressService } from './progress.service.js';
import { SessionsService, type AnswerInput } from './sessions.service.js';
import { renderSessionCard } from './share-image.js';
import { StreakService } from './streak.service.js';

@Controller('v1/sessions')
@UseGuards(JwtGuard)
export class SessionsController {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(StreakService) private readonly streaks: StreakService
  ) {}

  @Get()
  list(
    @Req() req: AuthedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('mode') mode?: StudyMode,
    @Query('status') status?: 'active' | 'completed'
  ) {
    return this.sessions.list(req.accountId, { cursor, limit: Number(limit ?? 25), mode, status });
  }

  @Post()
  @HttpCode(202)
  create(
    @Req() req: AuthedRequest,
    @Body() body: { mode: StudyMode; fileIds: string[]; topicIds?: string[]; questionCount?: number; timeLimitMinutes?: number }
  ) {
    return this.sessions.create(req.accountId, body);
  }

  @Get(':sessionId')
  get(@Req() req: AuthedRequest, @Param('sessionId') id: string) {
    return this.sessions.get(req.accountId, id);
  }

  @Delete(':sessionId')
  @HttpCode(204)
  async exit(@Req() req: AuthedRequest, @Param('sessionId') id: string) {
    await this.sessions.exit(req.accountId, id);
  }

  @Patch(':sessionId/mode')
  switchMode(@Req() req: AuthedRequest, @Param('sessionId') id: string, @Body() body: { mode: StudyMode }) {
    return this.sessions.switchMode(req.accountId, id, body.mode);
  }

  @Post(':sessionId/answers')
  @HttpCode(200)
  answer(
    @Req() req: AuthedRequest,
    @Param('sessionId') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: AnswerInput
  ) {
    return this.sessions.answer(req.accountId, id, key, body);
  }

  @Post(':sessionId/complete')
  @HttpCode(200)
  complete(@Req() req: AuthedRequest, @Param('sessionId') id: string) {
    return this.sessions.complete(req.accountId, id);
  }

  @Get(':sessionId/mistakes')
  mistakes(@Req() req: AuthedRequest, @Param('sessionId') id: string) {
    return this.sessions.mistakes(req.accountId, id);
  }

  @Post(':sessionId/retry')
  @HttpCode(202)
  retry(@Req() req: AuthedRequest, @Param('sessionId') id: string, @Body() body: { mode?: StudyMode } = {}) {
    return this.sessions.retry(req.accountId, id, body?.mode);
  }

  @Get(':sessionId/share-image')
  async share(
    @Req() req: AuthedRequest,
    @Param('sessionId') id: string,
    @Query('showScore') showScore: string | boolean | undefined,
    @Res() res: Response
  ) {
    const result = await this.sessions.shareData(req.accountId, id);
    const streak = await this.streaks.summary(req.accountId);
    const png = await renderSessionCard({
      mode: result.mode,
      score: result.score,
      total: result.total,
      showScore: showScore === true || showScore === 'true',
      streak: streak.current,
      topics: result.failedTopics.length > 0 ? result.failedTopics : result.sourceDocs,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(png);
  }
}

@Controller('v1')
@UseGuards(JwtGuard)
export class ProgressController {
  constructor(
    @Inject(ProgressService) private readonly progress: ProgressService,
    @Inject(StreakService) private readonly streaks: StreakService
  ) {}

  @Get('home')
  home(@Req() req: AuthedRequest) {
    return this.progress.home(req.accountId);
  }

  @Get('progress')
  overview(@Req() req: AuthedRequest) {
    return this.progress.overview(req.accountId);
  }

  @Get('progress/courses/:courseId')
  course(@Req() req: AuthedRequest, @Param('courseId') courseId: string) {
    return this.progress.courseMastery(req.accountId, courseId);
  }

  @Get('streak')
  streak(@Req() req: AuthedRequest, @Query('month') month?: string) {
    return this.streaks.full(req.accountId, month);
  }
}

const BLOCKLIST = [
  'admin',
  'florence',
  'moderator',
  'support',
  'fuck',
  'shit',
  'bitch',
  'nigga',
  'nigger',
  'pussy',
  'dick',
  'ashawo',
  'olodo',
  'mumu',
  'ode',
  'werey',
  'yahoo boy',
];

export function nameRejected(name: string): boolean {
  const leet: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
  const flat = name
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => leet[c])
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ');
  const squashed = flat.replace(/ /g, '');
  return BLOCKLIST.some((w) => (w.length <= 4 ? flat.split(' ').includes(w) : squashed.includes(w.replace(/ /g, ''))));
}

function weekOf(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  const start = new Date(d.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

@Controller('v1')
@UseGuards(JwtGuard)
export class BoardsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(StreakService) private readonly streaks: StreakService
  ) {}

  private async optIn(accountId: string) {
    const [row] = await this.db.query<{ opted_in: boolean; display_name: string | null }>(
      'select opted_in, display_name from leaderboard_optins where account_id = $1',
      [accountId]
    );
    return { optedIn: row?.opted_in ?? false, displayName: row?.display_name ?? null };
  }

  @Get('leaderboard')
  async board(@Req() req: AuthedRequest, @Query('scope') scope: 'course' | 'campus', @Query('courseId') courseId?: string) {
    if (scope === 'course' && !courseId) throw AppError.unprocessable('course_required', 'Pick a course for a course board.');
    const [{ days }] = await this.db.query<{ days: number }>(
      'select count(*)::int as days from study_days where account_id = $1 and day between $2 and $3',
      [req.accountId, ...Object.values(weekOf(this.streaks.today()))]
    );
    return {
      scope,
      ...(courseId ? { courseId } : {}),
      status: 'not_open',
      optedIn: (await this.optIn(req.accountId)).optedIn,
      optedInCount: 0,
      minToOpen: 5,
      week: weekOf(this.streaks.today()),
      entries: [],
      you: { rank: null, studyDays: Math.min(7, days) },
    };
  }

  @Put('leaderboard/optin')
  async setOptIn(@Req() req: AuthedRequest, @Body() body: { optedIn: boolean; displayName?: string }) {
    const name = body.displayName?.trim().replace(/\s+/g, ' ');
    if (name !== undefined && (name.length < 2 || name.length > 20 || nameRejected(name))) {
      throw AppError.unprocessable('display_name_rejected', 'Choose a different name for the leaderboard.');
    }
    await this.db.query(
      `insert into leaderboard_optins (account_id, opted_in, display_name) values ($1, $2, $3)
       on conflict (account_id) do update set opted_in = excluded.opted_in,
         display_name = coalesce(excluded.display_name, leaderboard_optins.display_name)`,
      [req.accountId, body.optedIn, name ?? null]
    );
    return this.optIn(req.accountId);
  }

  @Get('leaderboard/weekly-results')
  weekly() {
    return { items: [] };
  }

  @Get('wrapped')
  wrapped() {
    throw AppError.conflict('wrapped_not_ready', 'Your recap is not ready yet. Keep studying and check back.');
  }

  @Get('wrapped/share-image')
  wrappedImage() {
    throw AppError.conflict('wrapped_not_ready', 'Your recap is not ready yet. Keep studying and check back.');
  }
}

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthedRequest, JwtGuard } from '../auth/jwt.guard.js';
import { FactsService } from './facts.service.js';
import { ProfileService, type ProfileUpdate } from './profile.service.js';

@Controller('v1/schools')
export class SchoolsController {
  constructor(@Inject(ProfileService) private readonly profiles: ProfileService) {}

  @Get()
  async search(@Query('q') q?: string, @Query('limit') limit?: string) {
    return { items: await this.profiles.searchSchools(q, Number(limit ?? 25)) };
  }

  @Get(':schoolId/departments')
  async departments(@Param('schoolId') schoolId: string) {
    return { items: await this.profiles.departments(schoolId) };
  }
}

@Controller('v1/me')
@UseGuards(JwtGuard)
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly profiles: ProfileService) {}

  @Put('profile')
  update(@Req() req: AuthedRequest, @Body() body: ProfileUpdate) {
    return this.profiles.update(req.accountId, body);
  }

  @Get('courses')
  async courses(@Req() req: AuthedRequest) {
    return { items: await this.profiles.listCourses(req.accountId) };
  }

  @Post('courses')
  @HttpCode(201)
  enrol(@Req() req: AuthedRequest, @Body() body: { code: string; title?: string }) {
    return this.profiles.enrol(req.accountId, body.code, body.title);
  }

  @Get('courses/:courseId')
  course(@Req() req: AuthedRequest, @Param('courseId') courseId: string) {
    return this.profiles.course(req.accountId, courseId);
  }

  @Delete('courses/:courseId')
  @HttpCode(204)
  async leave(@Req() req: AuthedRequest, @Param('courseId') courseId: string) {
    await this.profiles.leave(req.accountId, courseId);
  }
}

@Controller('v1/facts')
@UseGuards(JwtGuard)
export class FactsController {
  constructor(@Inject(FactsService) private readonly facts: FactsService) {}

  @Get('today')
  today() {
    return this.facts.today();
  }
}

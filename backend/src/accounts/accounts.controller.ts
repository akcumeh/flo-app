import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    Param,
    Patch,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { AuthedRequest, JwtGuard } from '../auth/jwt.guard.js';
import { AccountsService } from './accounts.service.js';
import { MergeService } from './merge.service.js';
import { StudentService } from './student.service.js';

@Controller('v1/me')
@UseGuards(JwtGuard)
export class AccountsController {
    constructor(
        @Inject(AccountsService) private readonly accounts: AccountsService,
        @Inject(MergeService) private readonly merges: MergeService,
        @Inject(StudentService) private readonly students: StudentService
    ) {}

    @Delete('identities/:identityId')
    @HttpCode(204)
    async unlink(@Req() req: AuthedRequest, @Param('identityId') identityId: string) {
        await this.accounts.unlink(req.accountId, identityId);
    }

    @Post('merge')
    @HttpCode(200)
    merge(@Req() req: AuthedRequest, @Body() body: { mergeToken: string }) {
        return this.merges.merge(req.accountId, body.mergeToken);
    }

    @Post('student/verify/start')
    @HttpCode(202)
    async startStudent(@Req() req: AuthedRequest, @Body() body: { schoolEmail: string }) {
        await this.students.start(req.accountId, body.schoolEmail, req.ip ?? 'unknown');
    }

    @Post('student/verify/confirm')
    @HttpCode(200)
    confirmStudent(@Req() req: AuthedRequest, @Body() body: { schoolEmail: string; code: string }) {
        return this.students.confirm(req.accountId, body.schoolEmail, body.code);
    }

    @Get()
    me(@Req() req: AuthedRequest) {
        return this.accounts.view(req.accountId);
    }

    @Patch()
    update(
        @Req() req: AuthedRequest,
        @Body() body: { displayName?: string; username?: string | null; timezone?: string }
    ) {
        return this.accounts.update(req.accountId, body);
    }
}

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthedRequest, JwtGuard } from '../auth/jwt.guard.js';
import { AppError } from '../common/app-error.js';
import { STORAGE, LocalDiskStorage, type ObjectStorage } from '../storage/storage.js';
import { FilesService, type UploadPart } from './files.service.js';

@Controller('v1/files')
@UseGuards(JwtGuard)
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return { items: await this.files.list(req.accountId) };
  }

  @Post()
  @HttpCode(201)
  upload(@Req() req: AuthedRequest & { files?: Array<UploadPart & { fieldname: string }> }, @Body() body: { name?: string; courseId?: string }) {
    const parts = (req.files ?? []).filter((f) => f.fieldname === 'pages' || f.fieldname === 'pages[]');
    return this.files.upload(req.accountId, parts, { name: body.name, courseId: body.courseId || undefined });
  }

  @Get(':fileId')
  get(@Req() req: AuthedRequest, @Param('fileId') fileId: string) {
    return this.files.get(req.accountId, fileId);
  }

  @Delete(':fileId')
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('fileId') fileId: string) {
    await this.files.remove(req.accountId, fileId);
  }

  @Get(':fileId/content')
  async content(@Req() req: AuthedRequest, @Param('fileId') fileId: string, @Res() res: Response) {
    res.redirect(302, await this.files.contentUrl(req.accountId, fileId));
  }
}

@Controller('storage')
export class LocalStorageController {
  constructor(@Inject(STORAGE) private readonly storage: ObjectStorage) {}

  @Get(':token')
  async read(@Param('token') token: string, @Res() res: Response) {
    if (!(this.storage instanceof LocalDiskStorage)) throw AppError.notFound();
    const path = this.storage.verify(token);
    if (!path) throw AppError.notFound('This link has expired.');
    const { data, mimeType } = await this.storage.read(path).catch(() => {
      throw AppError.notFound();
    });
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(data);
  }
}

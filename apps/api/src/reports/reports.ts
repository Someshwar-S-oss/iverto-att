import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { BullModule } from '@nestjs/bullmq';
import { Body, Controller, Delete, Get, Injectable, Logger, Module, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma, ReportJob } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { createHash } from 'crypto';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Role, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { BUCKETS, SupabaseService } from '../common/supabase.service';
import { addDays, diffDays, localYmd, monthRange } from '../common/time';
import { IsTimeZone, IsYmd } from '../common/validators';
import { LiveGateway } from '../live/live.gateway';
import { NotificationsService } from '../notifications/notifications';
import { toCsv } from './csv';
import { REPORTS, ReportFilters, reportByType } from './definitions';
import { PdfRenderer } from './pdf';

export const REPORTS_QUEUE = 'reports';

// ── DTOs ────────────────────────────────────────────────────────────────────

export class FiltersDto implements ReportFilters {
  @IsOptional() @IsYmd() dateFrom?: string;
  @IsOptional() @IsYmd() dateTo?: string;
  @IsOptional() @IsIn(['today', 'yesterday', 'last7', 'thisMonth', 'lastMonth']) period?: ReportFilters['period'];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) siteIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) departmentIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) projectIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsString({ each: true }) employeeIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) statuses?: string[];
  @IsOptional() @IsIn(['none', 'department', 'project', 'site']) groupBy?: ReportFilters['groupBy'];
}

export class ExportDto {
  @IsIn(REPORTS.map((r) => r.type)) type: string;
  @IsIn(['csv', 'pdf']) format: 'csv' | 'pdf';
  @ValidateNested() @Type(() => FiltersDto) filters: FiltersDto;
}

export class ExportListQuery {
  @IsOptional() @IsIn(['mine', 'all']) scope?: 'mine' | 'all';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) size?: number;
}

export class ScheduleDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsIn(REPORTS.map((r) => r.type)) type: string;
  @IsIn(['csv', 'pdf']) format: 'csv' | 'pdf';
  @ValidateNested() @Type(() => FiltersDto) filters: FiltersDto;
  /** Standard 5-field cron, e.g. "0 7 * * 1" = Mondays 07:00. */
  @Matches(/^(\S+\s+){4}\S+$/, { message: 'cron must have 5 fields' }) cron: string;
  @IsTimeZone() timezone: string;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) recipientUserIds: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

interface JobScope {
  userId: string;
  role: Role;
  employeeId: string | null;
  siteIds: string[];
  displayName: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly supabase: SupabaseService,
    private readonly pdf: PdfRenderer,
    private readonly audit: AuditableActionService,
    private readonly live: LiveGateway,
    private readonly notifications: NotificationsService,
    @InjectQueue(REPORTS_QUEUE) private readonly queue: Queue,
  ) {}

  catalogue(user: AuthUser) {
    return REPORTS.filter((r) => this.allowed(user.role, r.type)).map(({ run, ...r }) => r);
  }

  /** EMPLOYEE: own timesheet only; everyone else is limited by scope (§13). */
  private allowed(role: Role, type: string) {
    return role !== 'EMPLOYEE' || type === 'timesheet';
  }

  /** Relative periods resolve in the tenant's time zone at run time. */
  resolvePeriod(filters: ReportFilters, tz: string): { from: string; to: string } {
    const today = localYmd(new Date(), tz);
    switch (filters.period) {
      case 'today':
        return { from: today, to: today };
      case 'yesterday':
        return { from: addDays(today, -1), to: addDays(today, -1) };
      case 'last7':
        return { from: addDays(today, -7), to: addDays(today, -1) };
      case 'thisMonth':
        return { from: monthRange(today.slice(0, 7)).from, to: today };
      case 'lastMonth':
        return monthRange(addDays(monthRange(today.slice(0, 7)).from, -1).slice(0, 7));
    }
    if (!filters.dateFrom) throw new AppError(400, 'DATE_REQUIRED', 'Give dateFrom/dateTo or a period');
    return { from: filters.dateFrom, to: filters.dateTo ?? filters.dateFrom };
  }

  private scopeOf(user: AuthUser, displayName: string): JobScope {
    return { userId: user.sub, role: user.role, employeeId: user.employeeId, siteIds: user.siteIds, displayName };
  }

  async requestExport(user: AuthUser, dto: ExportDto, scheduleId?: string) {
    const def = reportByType(dto.type)!;
    if (!this.allowed(user.role, dto.type)) throw new AppError(403, 'FORBIDDEN', 'Employees can export only their own timesheet');
    if (!def.formats.includes(dto.format)) throw new AppError(400, 'FORMAT_UNSUPPORTED', `${def.title} is not available as ${dto.format}`);
    const tz = await this.tenantTz(user.tenantId);
    const { from, to } = this.resolvePeriod(dto.filters, tz);
    if (from > to) throw new AppError(400, 'BAD_RANGE', 'dateFrom is after dateTo');
    if (diffDays(from, to) + 1 > def.maxDays) throw new AppError(400, 'RANGE_TOO_LARGE', `${def.title} covers at most ${def.maxDays} days`);

    const profile = await this.prisma.userProfile.findUnique({ where: { userId: user.sub } });
    const job = await this.prisma.reportJob.create({
      data: {
        tenantId: user.tenantId,
        requestedBy: user.sub,
        scheduleId,
        type: dto.type,
        format: dto.format,
        filters: dto.filters as unknown as Prisma.InputJsonValue,
        scope: this.scopeOf(user, profile?.displayName ?? user.email) as unknown as Prisma.InputJsonValue,
      },
    });
    await this.queue.add('export', { jobId: job.id }, { jobId: `export-${job.id}`, removeOnComplete: 500, removeOnFail: 1000, attempts: 2 });
    return { jobId: job.id, status: job.status };
  }

  private async tenantTz(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    return ((t?.settings as any)?.timezone as string) || 'Asia/Kolkata';
  }

  /** The worker side: query → CSV | PDF → Storage → READY → report.ready (§11.2). */
  async runExport(jobId: string) {
    const job = await this.prisma.reportJob.findUnique({ where: { id: jobId } });
    if (!job || job.status === 'READY') return;
    await this.prisma.reportJob.update({ where: { id: jobId }, data: { status: 'RUNNING' } });
    try {
      const def = reportByType(job.type)!;
      const scope = job.scope as unknown as JobScope;
      const filters = job.filters as ReportFilters;
      const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: job.tenantId } });
      const settings = (tenant.settings ?? {}) as Record<string, any>;
      const tz = settings.timezone || 'Asia/Kolkata';
      const { from, to } = this.resolvePeriod(filters, tz);
      // Reports run under the scope they were requested with.
      const user: AuthUser = {
        sub: scope.userId, email: '', tenantId: job.tenantId, role: scope.role, employeeId: scope.employeeId,
        siteIds: scope.siteIds ?? [], isSuperAdmin: false, mustChangePassword: false,
      };
      const data = await def.run({ prisma: this.prisma, tenantId: job.tenantId, from, to, filters, employeeWhere: await this.scope.employeeWhere(user) });
      const rowCount = data.sections.reduce((s, x) => s + x.rows.length, 0);

      // CSV and the PDF footer hash the same thing: the data, not the rendering.
      const grouped = data.sections.length > 1 || Boolean(data.sections[0]?.title);
      const columns = data.sections[0]?.columns ?? [];
      const csv = toCsv(
        [...(grouped ? ['Group'] : []), ...columns.map((c) => c.label)],
        data.sections.flatMap((s) => s.rows.map((r) => [...(grouped ? [s.title ?? ''] : []), ...s.columns.map((c) => r[c.key])])),
      );
      const dataSha256 = createHash('sha256').update(csv).digest('hex');

      let body: Buffer;
      if (job.format === 'csv') {
        body = Buffer.from(csv, 'utf8');
      } else {
        const meta = {
          orgName: settings.branding?.displayName || tenant.name,
          logoUrl: settings.branding?.logoUrl ?? null,
          period: from === to ? from : `${from} – ${to}`,
          filterChips: await this.filterChips(job.tenantId, filters),
          generatedBy: scope.displayName,
          generatedAt: `${localYmd(new Date(), tz)} ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date())} ${tz}`,
          jobId,
          dataSha256,
        };
        body = await this.pdf.render(def, data, meta);
      }

      const key = `${job.tenantId}/${jobId}.${job.format}`;
      await this.supabase.upload(BUCKETS.reports(), key, body, job.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf');
      const sha256 = createHash('sha256').update(body).digest('hex');
      await this.audit.run({
        action: 'REPORT_EXPORTED',
        targetType: 'ReportJob',
        targetId: jobId,
        actor: { type: job.scheduleId ? 'system' : 'user', userId: job.requestedBy ?? undefined },
        tenantId: job.tenantId,
        payloadFrom: () => ({ type: job.type, format: job.format, filters, from, to, rowCount, sha256, dataSha256 }),
        run: (tx) =>
          tx.reportJob.update({ where: { id: jobId }, data: { status: 'READY', storageKey: key, sha256, rowCount, generatedAt: new Date(), error: null } }),
      });
      if (job.requestedBy) this.live.emitToUser('report.ready', job.requestedBy, { jobId, type: job.type, format: job.format });
      if (job.scheduleId) await this.notifyRecipients(job, def.title, from, to);
    } catch (err) {
      this.logger.error(`Report ${jobId} failed: ${(err as Error).message}`, (err as Error).stack);
      await this.prisma.reportJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: (err as Error).message.slice(0, 1000) } });
      if (job.requestedBy) this.live.emitToUser('report.failed', job.requestedBy, { jobId, type: job.type, format: job.format });
      throw err;
    }
  }

  private async filterChips(tenantId: string, f: ReportFilters): Promise<string[]> {
    const names = async (model: 'site' | 'department' | 'project', ids?: string[]) =>
      ids?.length ? ((await (this.prisma[model] as any).findMany({ where: { tenantId, id: { in: ids } }, select: { name: true } })) as { name: string }[]).map((x) => x.name) : [];
    return [
      ...(await names('site', f.siteIds)).map((n) => `Site: ${n}`),
      ...(await names('department', f.departmentIds)).map((n) => `Dept: ${n}`),
      ...(await names('project', f.projectIds)).map((n) => `Project: ${n}`),
      ...(f.employeeIds?.length ? [`${f.employeeIds.length} employee(s)`] : []),
      ...(f.statuses?.length ? [`Status: ${f.statuses.join(', ')}`] : []),
      ...(f.groupBy && f.groupBy !== 'none' ? [`Grouped by ${f.groupBy}`] : []),
    ];
  }

  private async notifyRecipients(job: ReportJob, title: string, from: string, to: string) {
    const schedule = await this.prisma.reportSchedule.findUnique({ where: { id: job.scheduleId! } });
    if (!schedule) return;
    await this.notifications.notify(job.tenantId, schedule.recipientUserIds, {
      type: 'REPORT_READY',
      title: `${title} is ready`,
      body: `${schedule.name}: ${from === to ? from : `${from} – ${to}`} (${job.format.toUpperCase()})`,
      data: { jobId: job.id },
    });
  }

  async list(user: AuthUser, q: ExportListQuery) {
    const page = q.page ?? 1;
    const size = q.size ?? 50;
    const mine = q.scope !== 'all' || !isHrOrAdmin(user);
    const where: Prisma.ReportJobWhereInput = { tenantId: user.tenantId };
    // "Mine" also shows scheduled reports I receive.
    if (mine) {
      const schedules = await this.prisma.reportSchedule.findMany({ where: { tenantId: user.tenantId, recipientUserIds: { has: user.sub } }, select: { id: true } });
      where.OR = [{ requestedBy: user.sub }, { scheduleId: { in: schedules.map((s) => s.id) } }];
    }
    const [items, total] = await Promise.all([
      this.prisma.reportJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size, omit: { scope: true } }),
      this.prisma.reportJob.count({ where }),
    ]);
    return { items, total, page, size };
  }

  async get(user: AuthUser, jobId: string) {
    const job = await this.prisma.reportJob.findFirst({ where: { id: jobId, tenantId: user.tenantId }, omit: { scope: true } });
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Export not found');
    if (job.requestedBy !== user.sub && !isHrOrAdmin(user)) {
      const recipient = job.scheduleId
        ? await this.prisma.reportSchedule.count({ where: { id: job.scheduleId, recipientUserIds: { has: user.sub } } })
        : 0;
      if (!recipient) throw new AppError(404, 'NOT_FOUND', 'Export not found');
    }
    return job;
  }

  async downloadUrl(user: AuthUser, jobId: string) {
    const job = await this.get(user, jobId);
    if (job.status !== 'READY' || !job.storageKey) throw new AppError(409, 'NOT_READY', `Export is ${job.status.toLowerCase()}`);
    const def = reportByType(job.type);
    const name = `${def?.title.replace(/[^\w]+/g, '-') ?? job.type}-${job.id}.${job.format}`;
    return this.supabase.signedUrl(BUCKETS.reports(), job.storageKey, 300, name);
  }

  // ── Schedules (BullMQ job schedulers, D10) ─────────────────────────────────

  async syncScheduler(scheduleId: string) {
    const s = await this.prisma.reportSchedule.findUnique({ where: { id: scheduleId } });
    const key = `report-schedule:${scheduleId}`;
    if (!s || !s.enabled) {
      await this.queue.removeJobScheduler(key);
      return;
    }
    await this.queue.upsertJobScheduler(key, { pattern: s.cron, tz: s.timezone }, { name: 'schedule', data: { scheduleId }, opts: { removeOnComplete: 100, removeOnFail: 500 } });
  }

  async runSchedule(scheduleId: string) {
    const s = await this.prisma.reportSchedule.findUnique({ where: { id: scheduleId } });
    if (!s || !s.enabled) return;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: s.tenantId } });
    if (tenant?.status !== 'ACTIVE') return; // suspended tenants skip their schedules (§13.1)
    const creator = await this.prisma.userProfile.findUnique({ where: { userId: s.createdBy } });
    if (!creator || creator.status !== 'ACTIVE') {
      this.logger.warn(`Schedule ${s.id} skipped: its creator is no longer active`);
      return;
    }
    const user: AuthUser = {
      sub: creator.userId, email: creator.email, tenantId: s.tenantId, role: creator.role as Role, employeeId: creator.employeeId,
      siteIds: creator.siteIds, isSuperAdmin: false, mustChangePassword: false,
    };
    await this.requestExport(user, { type: s.type, format: s.format as 'csv' | 'pdf', filters: s.filters as FiltersDto }, s.id);
    await this.prisma.reportSchedule.update({ where: { id: s.id }, data: { lastRunAt: new Date() } });
  }

  /** Daily: stored files are immutable until retention expires them (§11.5). */
  async purgeExpired() {
    const tenants = await this.prisma.tenant.findMany();
    for (const t of tenants) {
      const days = Number((t.settings as any)?.reportRetentionDays ?? 90);
      const old = await this.prisma.reportJob.findMany({
        where: { tenantId: t.id, status: 'READY', createdAt: { lt: new Date(Date.now() - days * 86_400_000) } },
        select: { id: true, storageKey: true },
      });
      if (!old.length) continue;
      await this.supabase.remove(BUCKETS.reports(), old.map((o) => o.storageKey!).filter(Boolean));
      await this.prisma.reportJob.updateMany({ where: { id: { in: old.map((o) => o.id) } }, data: { status: 'EXPIRED', storageKey: null } });
    }
  }
}

@Processor(REPORTS_QUEUE, { concurrency: 2 })
export class ReportsProcessor extends WorkerHost {
  constructor(private readonly reports: ReportsService) {
    super();
  }

  process(job: Job<{ jobId?: string; scheduleId?: string }>) {
    return runAsSystem(async () => {
      if (job.name === 'schedule') return this.reports.runSchedule(job.data.scheduleId!);
      return this.reports.runExport(job.data.jobId!);
    });
  }
}

// ── Controllers ─────────────────────────────────────────────────────────────

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
  ) {}

  @Get('types')
  types(@CurrentUser() user: AuthUser) {
    return this.reports.catalogue(user);
  }

  /** 202 { jobId }; the file arrives via report.ready on the socket, or poll the status. */
  @Post('exports')
  async export(@CurrentUser() user: AuthUser, @Body() dto: ExportDto, @Res({ passthrough: true }) res: any) {
    res.status(202);
    return this.reports.requestExport(user, dto);
  }

  @Get('exports')
  list(@CurrentUser() user: AuthUser, @Query() q: ExportListQuery) {
    return this.reports.list(user, q);
  }

  @Get('exports/:jobId')
  get(@CurrentUser() user: AuthUser, @Param('jobId') jobId: string) {
    return this.reports.get(user, jobId);
  }

  /** 302 to a 5-minute signed URL; `?redirect=false` returns `{ url }` instead. */
  @Get('exports/:jobId/download')
  async download(@CurrentUser() user: AuthUser, @Param('jobId') jobId: string, @Query('redirect') redirect: string, @Res() res: any) {
    const url = await this.reports.downloadUrl(user, jobId);
    if (redirect === 'false') return res.status(200).send({ url, expiresInSeconds: 300 });
    return res.status(302).redirect(url);
  }

  @Get('schedules')
  @Roles('ADMIN', 'HR', 'MANAGER')
  schedules(@CurrentUser() user: AuthUser) {
    return this.prisma.reportSchedule.findMany({
      where: { tenantId: user.tenantId, ...(isHrOrAdmin(user) ? {} : { createdBy: user.sub }) },
      orderBy: { name: 'asc' },
    });
  }

  @Post('schedules')
  @Roles('ADMIN', 'HR', 'MANAGER')
  async createSchedule(@CurrentUser() user: AuthUser, @Body() dto: ScheduleDto) {
    await this.checkRecipients(user, dto.recipientUserIds);
    if (!dto.filters.period) throw new AppError(400, 'PERIOD_REQUIRED', 'Scheduled reports need a relative period (e.g. yesterday, lastMonth)');
    const s = await this.audit.run({
      action: 'REPORT_SCHEDULE_CREATED',
      targetType: 'ReportSchedule',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) =>
        tx.reportSchedule.create({
          data: { ...dto, filters: dto.filters as unknown as Prisma.InputJsonValue, tenantId: user.tenantId, createdBy: user.sub, enabled: dto.enabled ?? true },
        }),
    });
    await this.reports.syncScheduler(s.id);
    return s;
  }

  @Patch('schedules/:id')
  @Roles('ADMIN', 'HR', 'MANAGER')
  async updateSchedule(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ScheduleDto) {
    await this.ownSchedule(user, id);
    await this.checkRecipients(user, dto.recipientUserIds);
    const s = await this.audit.run({
      action: 'REPORT_SCHEDULE_UPDATED',
      targetType: 'ReportSchedule',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => tx.reportSchedule.update({ where: { id }, data: { ...dto, filters: dto.filters as unknown as Prisma.InputJsonValue } }),
    });
    await this.reports.syncScheduler(id);
    return s;
  }

  @Delete('schedules/:id')
  @Roles('ADMIN', 'HR', 'MANAGER')
  async deleteSchedule(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.ownSchedule(user, id);
    await this.audit.run({
      action: 'REPORT_SCHEDULE_DELETED',
      targetType: 'ReportSchedule',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      run: (tx) => tx.reportSchedule.delete({ where: { id } }),
    });
    await this.reports.syncScheduler(id);
    return { deleted: true };
  }

  private async ownSchedule(user: AuthUser, id: string) {
    const s = await this.prisma.reportSchedule.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!s || (!isHrOrAdmin(user) && s.createdBy !== user.sub)) throw new AppError(404, 'NOT_FOUND', 'Schedule not found');
  }

  private async checkRecipients(user: AuthUser, ids: string[]) {
    const found = await this.prisma.userProfile.count({ where: { tenantId: user.tenantId, userId: { in: ids }, status: 'ACTIVE' } });
    if (found !== new Set(ids).size) throw new AppError(400, 'UNKNOWN_RECIPIENT', 'Unknown or inactive recipient(s)');
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: REPORTS_QUEUE })],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsProcessor, PdfRenderer],
  exports: [ReportsService],
})
export class ReportsModule {}


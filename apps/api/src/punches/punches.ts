import { Body, Controller, Get, Injectable, Logger, Module, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Employee, Prisma, Punch } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { presentPunch } from '../attendance/present';
import { RecomputeQueue, RecomputeService } from '../attendance/recompute.service';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { dbDate, localYmd } from '../common/time';
import { IsYmd } from '../common/validators';
import { LiveGateway } from '../live/live.gateway';

export type PunchInput = Omit<Prisma.PunchUncheckedCreateInput, 'id' | 'receivedAt' | 'workDate'>;

/**
 * The punch store (§5). Punches are immutable; every source goes through
 * `record`, which is idempotent on (device, LogID, time) and ends in a
 * debounced recompute of the day the punch belongs to.
 */
@Injectable()
export class PunchesService {
  private readonly logger = new Logger(PunchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recompute: RecomputeService,
    private readonly queue: RecomputeQueue,
    private readonly live: LiveGateway,
  ) {}

  /** @returns the inserted row, or null when it was a duplicate. */
  async record(input: PunchInput, employee?: Employee | null): Promise<Punch | null> {
    const [punch] = await this.prisma.punch.createManyAndReturn({ data: [input], skipDuplicates: true });
    if (!punch) return null;
    // Recompute is queued; the ack (terminal) or response (API) does not wait for it.
    void this.afterInsert(punch, employee).catch((err) =>
      this.logger.error(`Post-insert for punch ${punch.id} failed: ${(err as Error).message}`),
    );
    return punch;
  }

  private async afterInsert(punch: Punch, employee?: Employee | null) {
    const emp = employee ?? (punch.employeeId ? await this.prisma.employee.findUnique({ where: { id: punch.employeeId } }) : null);
    const site = await this.prisma.site.findUnique({ where: { id: punch.siteId } });
    const tz = site?.timezone ?? 'UTC';
    if (emp) {
      const workDate = await this.recompute.workDateFor(emp, punch.punchedAt, localYmd(punch.punchedAt, tz));
      await this.prisma.punch.update({
        where: { id_punchedAt: { id: punch.id, punchedAt: punch.punchedAt } },
        data: { workDate: dbDate(workDate) },
      });
      await this.queue.day(emp.id, workDate);
    }
    const withNames = await this.prisma.punch.findUnique({
      where: { id_punchedAt: { id: punch.id, punchedAt: punch.punchedAt } },
      include: { employee: true, device: true },
    });
    const rooms = emp ?? { tenantId: punch.tenantId, siteId: punch.siteId };
    this.live.emitForEmployee('punch.created', rooms, presentPunch(withNames!, tz));
  }
}

export class PunchQuery {
  @IsOptional() @IsYmd() from?: string;
  @IsOptional() @IsYmd() to?: string;
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsString() deviceId?: string;
  @IsOptional() @IsIn(['TERMINAL', 'MOBILE', 'CORRECTION', 'MANUAL']) source?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() unknownOnly?: boolean;
  /** Opaque cursor from the previous page's `nextCursor`. */
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export class ManualPunchDto {
  @IsString() employeeId: string;
  @IsISO8601({ strict: true }) at: string;
  @IsIn(['in', 'out']) direction: 'in' | 'out';
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

@ApiTags('punches')
@Controller('punches')
export class PunchesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly punches: PunchesService,
    private readonly audit: AuditableActionService,
  ) {}

  /** Daily logs (raw punches), newest first, cursor-paginated. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: PunchQuery) {
    const limit = q.limit ?? 100;
    const sites = await this.prisma.site.findMany({ where: { tenantId: user.tenantId } });
    const tz = new Map(sites.map((s) => [s.id, s.timezone]));
    const anyTz = sites[0]?.timezone ?? 'UTC';
    // Day bounds are generous (±14 h covers every timezone); work_date narrows exactly.
    const from = q.from ? new Date(new Date(`${q.from}T00:00:00Z`).getTime() - 14 * 3_600_000) : undefined;
    const to = q.to ? new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 38 * 3_600_000) : undefined;

    const employeeWhere: Prisma.EmployeeWhereInput = {
      AND: [
        await this.scope.employeeWhere(user),
        q.departmentId ? { departmentId: q.departmentId } : {},
        q.projectId ? { projects: { some: { projectId: q.projectId } } } : {},
        q.employeeId ? { id: q.employeeId } : {},
      ],
    };
    const canSeeUnknown = ['ADMIN', 'HR'].includes(user.role);
    const where: Prisma.PunchWhereInput = {
      tenantId: user.tenantId,
      siteId: q.siteId ?? (user.siteIds.length ? { in: user.siteIds } : undefined),
      deviceId: q.deviceId,
      source: q.source,
      punchedAt: from || to ? { gte: from, lt: to } : undefined,
      ...(q.unknownOnly
        ? { employeeId: null }
        : canSeeUnknown && !q.employeeId && !q.departmentId && !q.projectId
          ? { OR: [{ employeeId: null }, { employee: employeeWhere }] }
          : { employee: employeeWhere }),
    };
    if (q.unknownOnly && !canSeeUnknown) throw new AppError(403, 'FORBIDDEN', 'Only HR and admins see unattributed punches');

    const cursor = q.cursor ? JSON.parse(Buffer.from(q.cursor, 'base64url').toString()) : null;
    const rows = await this.prisma.punch.findMany({
      where: cursor
        ? { AND: [where, { OR: [{ punchedAt: { lt: new Date(cursor.t) } }, { punchedAt: new Date(cursor.t), id: { lt: cursor.id } }] }] }
        : where,
      include: { employee: true, device: true },
      orderBy: [{ punchedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page
        .filter((p) => !q.from || !p.workDate || p.workDate >= dbDate(q.from))
        .filter((p) => !q.to || !p.workDate || p.workDate <= dbDate(q.to))
        .map((p) => presentPunch(p, tz.get(p.siteId) ?? anyTz)),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ t: last.punchedAt.toISOString(), id: last.id })).toString('base64url')
          : null,
    };
  }

  /** Manual punch (HR, reason required, audited). */
  @Post()
  @Roles('ADMIN', 'HR')
  async manual(@CurrentUser() user: AuthUser, @Body() dto: ManualPunchDto) {
    const employee = await this.scope.assertEmployee(user, dto.employeeId);
    const at = new Date(dto.at);
    if (at.getTime() > Date.now() + 5 * 60_000) throw new AppError(400, 'FUTURE_PUNCH', 'A punch cannot be in the future');
    const punch = await this.punches.record(
      {
        tenantId: user.tenantId,
        siteId: employee.siteId,
        employeeId: employee.id,
        punchedAt: at,
        source: 'MANUAL',
        direction: dto.direction,
        reason: dto.reason,
        createdBy: user.sub,
      },
      employee,
    );
    await this.audit.log({
      tenantId: user.tenantId,
      actor: actorOf(user),
      action: 'PUNCH_MANUAL',
      targetType: 'Punch',
      targetId: punch?.id,
      payload: { employeeId: employee.id, at: dto.at, direction: dto.direction, reason: dto.reason },
    });
    return punch;
  }
}

@Module({
  controllers: [PunchesController],
  providers: [PunchesService],
  exports: [PunchesService],
})
export class PunchesModule {}

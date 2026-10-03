import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { dbDate, diffDays, eachDay, monthRange, ymdOf } from '../common/time';
import { IsMonth, IsYmd } from '../common/validators';
import { presentDay, presentPunch, statusCode } from './present';
import { RecomputeQueue } from './recompute.service';

const STATUSES = ['PENDING', 'PRESENT', 'HALF_DAY', 'ABSENT', 'ON_LEAVE', 'HALF_LEAVE', 'REMOTE', 'HOLIDAY', 'WEEKLY_OFF'];
const toBool = ({ value }: { value: unknown }) => (value === undefined ? undefined : value === 'true' || value === true);
const toList = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value);

export class EmployeeFilter {
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() employeeId?: string;
}

export class DaysQuery extends EmployeeFilter {
  /** Single day; or use from/to. */
  @IsOptional() @IsYmd() date?: string;
  @IsOptional() @IsYmd() from?: string;
  @IsOptional() @IsYmd() to?: string;
  @IsOptional() @Transform(toList) @IsArray() @IsIn(STATUSES, { each: true }) status?: string[];
  @IsOptional() @Transform(toBool) @IsBoolean() isLate?: boolean;
  @IsOptional() @Transform(toBool) @IsBoolean() missedPunch?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) size?: number;
}

export class OverviewQuery extends EmployeeFilter {
  @IsMonth() month: string;
  @IsOptional() @Transform(toBool) @IsBoolean() grid?: boolean;
}

export class RecomputeDto {
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsString({ each: true }) employeeIds?: string[];
  @IsYmd() from: string;
  @IsYmd() to: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

/** Scope + the common employee filters; project = membership overlapping the range (§11.1). */
export async function scopedEmployees(
  scope: ScopeService,
  user: AuthUser,
  f: EmployeeFilter,
  from?: string,
  to?: string,
): Promise<Prisma.EmployeeWhereInput> {
  return {
    AND: [
      await scope.employeeWhere(user),
      f.siteId ? { siteId: f.siteId } : {},
      f.departmentId ? { departmentId: f.departmentId } : {},
      f.employeeId ? { id: f.employeeId } : {},
      f.projectId
        ? {
            projects: {
              some: {
                projectId: f.projectId,
                ...(to ? { from: { lte: dbDate(to) } } : {}),
                ...(from ? { OR: [{ to: null }, { to: { gte: dbDate(from) } }] } : {}),
              },
            },
          }
        : {},
    ],
  };
}

@ApiTags('attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly queue: RecomputeQueue,
    private readonly audit: AuditableActionService,
  ) {}

  /** Daily attendance status. */
  @Get('days')
  async days(@CurrentUser() user: AuthUser, @Query() q: DaysQuery) {
    const from = q.date ?? q.from;
    const to = q.date ?? q.to ?? from;
    if (!from) throw new AppError(400, 'DATE_REQUIRED', 'Pass date, or from and to');
    if (diffDays(from, to) > 92) throw new AppError(400, 'RANGE_TOO_LARGE', 'At most 93 days per request');
    const page = q.page ?? 1;
    const size = q.size ?? 100;
    const where: Prisma.AttendanceDayWhereInput = {
      tenantId: user.tenantId,
      workDate: { gte: dbDate(from), lte: dbDate(to) },
      employee: await scopedEmployees(this.scope, user, q, from, to),
      status: q.status?.length ? { in: q.status } : undefined,
      isLate: q.isLate,
      missedPunch: q.missedPunch,
    };
    const [rows, total] = await Promise.all([
      this.prisma.attendanceDay.findMany({
        where,
        include: { employee: true },
        orderBy: [{ workDate: 'desc' }, { employee: { fullName: 'asc' } }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.attendanceDay.count({ where }),
    ]);
    return { items: rows.map(presentDay), total, page, size };
  }

  /** Detailed in/out: segments, punches, leave, corrections, audit. */
  @Get('days/:id')
  async day(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const day = await this.prisma.attendanceDay.findFirst({
      where: { id, tenantId: user.tenantId, employee: await this.scope.employeeWhere(user) },
      include: { employee: true },
    });
    if (!day) throw new AppError(404, 'NOT_FOUND', 'Attendance day not found');
    const [punches, leave, remote, corrections, audit] = await Promise.all([
      this.prisma.punch.findMany({
        where: { employeeId: day.employeeId, punchedAt: { gte: day.windowStart, lt: day.windowEnd } },
        include: { employee: true, device: true },
        orderBy: { punchedAt: 'asc' },
      }),
      this.prisma.leaveRequest.findMany({
        where: { employeeId: day.employeeId, startDate: { lte: day.workDate }, endDate: { gte: day.workDate }, status: { in: ['PENDING', 'APPROVED'] } },
        include: { leaveType: true },
      }),
      this.prisma.remoteWorkRequest.findMany({
        where: { employeeId: day.employeeId, startDate: { lte: day.workDate }, endDate: { gte: day.workDate }, status: { in: ['PENDING', 'APPROVED'] } },
      }),
      this.prisma.attendanceCorrection.findMany({ where: { employeeId: day.employeeId, workDate: day.workDate }, orderBy: { createdAt: 'desc' } }),
      this.prisma.auditLog.findMany({ where: { targetType: 'AttendanceDay', targetId: day.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      ...presentDay(day),
      windowStart: day.windowStart,
      windowEnd: day.windowEnd,
      policy: day.policy,
      punches: punches.map((p) => presentPunch(p, day.timezone)),
      leave,
      remote,
      corrections,
      audit,
    };
  }

  /** Month overview: per-employee totals + per-day distribution (+ muster grid on request). */
  @Get('overview')
  async overview(@CurrentUser() user: AuthUser, @Query() q: OverviewQuery) {
    const { from, to } = monthRange(q.month);
    const where: Prisma.AttendanceDayWhereInput = {
      tenantId: user.tenantId,
      workDate: { gte: dbDate(from), lte: dbDate(to) },
      employee: await scopedEmployees(this.scope, user, q, from, to),
    };
    const [byEmployeeStatus, sums, lates, byDay, employees] = await Promise.all([
      this.prisma.attendanceDay.groupBy({ by: ['employeeId', 'status'], where, _count: { _all: true } }),
      this.prisma.attendanceDay.groupBy({
        by: ['employeeId'],
        where,
        _sum: { workedMinutes: true, overtimeMinutes: true, lateMinutes: true, earlyExitMinutes: true },
      }),
      this.prisma.attendanceDay.groupBy({ by: ['employeeId'], where: { ...where, isLate: true }, _count: { _all: true } }),
      this.prisma.attendanceDay.groupBy({ by: ['workDate', 'status'], where, _count: { _all: true } }),
      this.prisma.employee.findMany({
        where: { AND: [where.employee as Prisma.EmployeeWhereInput, { days: { some: { workDate: { gte: dbDate(from), lte: dbDate(to) } } } }] },
        select: { id: true, fullName: true, employeeCode: true, departmentId: true, siteId: true },
        orderBy: { fullName: 'asc' },
      }),
    ]);

    const totals = employees.map((e) => {
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const r of byEmployeeStatus) if (r.employeeId === e.id) counts[r.status] = r._count._all;
      const s = sums.find((x) => x.employeeId === e.id)?._sum;
      return {
        employee: e,
        counts,
        lateDays: lates.find((x) => x.employeeId === e.id)?._count._all ?? 0,
        workedMinutes: s?.workedMinutes ?? 0,
        overtimeMinutes: s?.overtimeMinutes ?? 0,
        lateMinutes: s?.lateMinutes ?? 0,
        earlyExitMinutes: s?.earlyExitMinutes ?? 0,
      };
    });
    const distribution = eachDay(from, to).map((date) => ({
      date,
      counts: Object.fromEntries(
        byDay.filter((r) => ymdOf(r.workDate) === date).map((r) => [r.status, r._count._all]),
      ),
    }));

    let grid: Record<string, Record<string, { code: string; isLate: boolean; dayId: string }>> | undefined;
    if (q.grid) {
      const cells = await this.prisma.attendanceDay.findMany({
        where,
        select: { id: true, employeeId: true, workDate: true, status: true, isLate: true, leavePortion: true },
      });
      grid = {};
      for (const c of cells) {
        (grid[c.employeeId] ??= {})[ymdOf(c.workDate)] = { code: statusCode(c), isLate: c.isLate, dayId: c.id };
      }
    }
    return { month: q.month, from, to, totals, distribution, grid };
  }

  /**
   * HR recompute / "re-evaluate history" (§6.6). Rewrites the frozen schedule of
   * every day in range, finalised ones included, and audits the request.
   */
  @Post('recompute')
  @Roles('ADMIN', 'HR')
  async recompute(@CurrentUser() user: AuthUser, @Body() dto: RecomputeDto) {
    if (dto.from > dto.to) throw new AppError(400, 'BAD_RANGE', 'from must be on or before to');
    if (diffDays(dto.from, dto.to) > 366) throw new AppError(400, 'RANGE_TOO_LARGE', 'At most one year per request');
    if (dto.employeeIds?.length) {
      const inScope = await this.prisma.employee.count({
        where: { AND: [await this.scope.employeeWhere(user), { id: { in: dto.employeeIds } }] },
      });
      if (inScope !== new Set(dto.employeeIds).size) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Unknown employee id(s)');
    }
    await this.audit.log({
      tenantId: user.tenantId,
      actor: actorOf(user),
      action: 'ATTENDANCE_REEVALUATE',
      targetType: 'AttendanceDay',
      payload: { ...dto },
    });
    const job = await this.queue.bulk({
      tenantId: user.tenantId,
      employeeIds: dto.employeeIds,
      from: dto.from,
      to: dto.to,
      rematerialise: true,
      includeFinalized: true,
    });
    return { jobId: job.id, status: 'queued' };
  }
}

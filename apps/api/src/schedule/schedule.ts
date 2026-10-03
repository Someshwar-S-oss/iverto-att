import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { RecomputeQueue } from '../attendance/recompute.service';
import { RosterService } from '../attendance/roster.service';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { addDays, dbDate, diffDays, eachDay, localYmd, Ymd, ymdOf } from '../common/time';
import { IsHm, IsYmd } from '../common/validators';

// ── DTOs ────────────────────────────────────────────────────────────────────

export class ShiftDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsString() @MinLength(1) @MaxLength(12) code: string;
  @IsOptional() @IsHexColor() color?: string;
  @IsIn(['FIXED', 'FLEXIBLE']) kind: 'FIXED' | 'FLEXIBLE';
  @IsHm() startTime: string;
  @IsHm() endTime: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(600) breakMinutes: number;
  /** FLEXIBLE only; FIXED derives it from start/end/break. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440) requiredMinutes?: number;
  @IsOptional() @IsHm() coreStart?: string;
  @IsOptional() @IsHm() coreEnd?: string;
  @IsOptional() @IsBoolean() worksHolidays?: boolean;
  @IsOptional() @IsString() policyId?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class PatternDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  /** One entry per day of the cycle: a shift id, or null for off. */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(62) days: (string | null)[];
}

export class AssignScheduleDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsString({ each: true }) employeeIds: string[];
  @IsYmd() effectiveFrom: string;
  @IsOptional() @IsYmd() effectiveTo?: string;
  @IsOptional() @IsString() shiftId?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) weeklyOffs?: number[];
  @IsOptional() @IsString() patternId?: string;
  @IsOptional() @IsYmd() anchorDate?: string;
  /** Also rewrite past days already judged (audited). */
  @IsOptional() @IsBoolean() reevaluateHistory?: boolean;
}

export class OverrideItem {
  @IsString() employeeId: string;
  @IsYmd() date: string;
  /** null = day off */
  @IsOptional() @IsString() shiftId?: string | null;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class OverridesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => OverrideItem) items: OverrideItem[];
  @IsOptional() @IsBoolean() reevaluateHistory?: boolean;
}

export class DeleteOverridesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => OverrideKey) items: OverrideKey[];
  @IsOptional() @IsBoolean() reevaluateHistory?: boolean;
}

export class OverrideKey {
  @IsString() employeeId: string;
  @IsYmd() date: string;
}

export class RosterQuery {
  @IsYmd() from: string;
  @IsYmd() to: string;
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() employeeId?: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

const HORIZON_DAYS = 14;

@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roster: RosterService,
    private readonly queue: RecomputeQueue,
    private readonly audit: AuditableActionService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * §6.6: a roster change re-materialises and recomputes today onward (up to the
   * materialised horizon). Past days only when HR explicitly re-evaluates history.
   */
  async rosterChanged(user: AuthUser, employeeIds: string[] | undefined, from: Ymd, to: Ymd, reevaluate = false) {
    const today = localYmd(new Date(), 'UTC');
    const start = reevaluate ? from : from < addDays(today, -1) ? addDays(today, -1) : from;
    const end = to > addDays(today, HORIZON_DAYS + 1) ? addDays(today, HORIZON_DAYS + 1) : to;
    if (reevaluate) {
      if (!isHrOrAdmin(user)) throw new AppError(403, 'FORBIDDEN', 'Only HR can re-evaluate history');
      await this.audit.log({
        tenantId: user.tenantId,
        actor: actorOf(user),
        action: 'ATTENDANCE_REEVALUATE',
        targetType: 'AttendanceDay',
        payload: { employeeIds: employeeIds ?? 'ALL', from, to, cause: 'ROSTER_CHANGE' },
      });
    }
    if (start > end) return;
    await this.queue.bulk({
      tenantId: user.tenantId,
      employeeIds,
      from: start,
      to: end,
      rematerialise: true,
      includeFinalized: reevaluate,
    });
  }

  private shiftData(dto: ShiftDto) {
    if (dto.kind === 'FLEXIBLE') {
      if (!dto.coreStart || !dto.coreEnd) throw new AppError(400, 'CORE_HOURS_REQUIRED', 'Flexible shifts need coreStart and coreEnd');
      if (dto.requiredMinutes === undefined) throw new AppError(400, 'REQUIRED_MINUTES', 'Flexible shifts need requiredMinutes');
    }
    const [sh, sm] = dto.startTime.split(':').map(Number);
    const [eh, em] = dto.endTime.split(':').map(Number);
    let span = eh * 60 + em - (sh * 60 + sm);
    if (span <= 0) span += 1440; // overnight
    const required = dto.kind === 'FIXED' ? span - dto.breakMinutes : dto.requiredMinutes!;
    if (required <= 0) throw new AppError(400, 'BAD_SHIFT', 'Break is longer than the shift');
    return { ...dto, requiredMinutes: required, coreStart: dto.kind === 'FLEXIBLE' ? dto.coreStart : null, coreEnd: dto.kind === 'FLEXIBLE' ? dto.coreEnd : null };
  }

  /** Night shift = ends on or before it starts (derived, §7.1). */
  presentShift<T extends { startTime: string; endTime: string }>(s: T) {
    return { ...s, isNight: s.endTime <= s.startTime };
  }

  async createShift(user: AuthUser, dto: ShiftDto) {
    const data = this.shiftData(dto);
    return this.audit.run({
      action: 'SHIFT_CREATED',
      targetType: 'Shift',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...data }),
      run: async (tx) => {
        if (data.isDefault) await tx.shift.updateMany({ where: { tenantId: user.tenantId }, data: { isDefault: false } });
        return tx.shift.create({ data: { ...data, tenantId: user.tenantId } });
      },
    });
  }

  async updateShift(user: AuthUser, id: string, dto: ShiftDto) {
    await this.prisma.shift.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    const data = this.shiftData(dto);
    const shift = await this.audit.run({
      action: 'SHIFT_UPDATED',
      targetType: 'Shift',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...data }),
      run: async (tx) => {
        if (data.isDefault) await tx.shift.updateMany({ where: { tenantId: user.tenantId, id: { not: id } }, data: { isDefault: false } });
        return tx.shift.update({ where: { id }, data });
      },
    });
    const today = localYmd(new Date(), 'UTC');
    await this.rosterChanged(user, undefined, addDays(today, -1), addDays(today, HORIZON_DAYS));
    return shift;
  }

  async validatePattern(user: AuthUser, dto: PatternDto) {
    const ids = [...new Set(dto.days.filter((d): d is string => Boolean(d)))];
    const found = await this.prisma.shift.count({ where: { tenantId: user.tenantId, id: { in: ids } } });
    if (found !== ids.length) throw new AppError(400, 'UNKNOWN_SHIFT', 'Pattern references an unknown shift');
    return { name: dto.name, cycleDays: dto.days.length, days: dto.days.map((d) => d ?? null) as Prisma.InputJsonValue };
  }

  /**
   * Assign a fixed shift or a pattern from `effectiveFrom`. Anything already
   * assigned in that range is superseded: truncated, split or removed, so the
   * no-overlap exclusion constraint always holds.
   */
  async assign(user: AuthUser, dto: AssignScheduleDto) {
    if (!!dto.shiftId === !!dto.patternId) throw new AppError(400, 'SHIFT_OR_PATTERN', 'Give exactly one of shiftId or patternId');
    if (dto.patternId && !dto.anchorDate) throw new AppError(400, 'ANCHOR_REQUIRED', 'A pattern needs anchorDate (the date of cycle day 1)');
    if (dto.effectiveTo && dto.effectiveTo < dto.effectiveFrom) throw new AppError(400, 'BAD_RANGE', 'effectiveTo is before effectiveFrom');
    if (dto.shiftId) await this.prisma.shift.findFirstOrThrow({ where: { id: dto.shiftId, tenantId: user.tenantId } });
    if (dto.patternId) await this.prisma.shiftPattern.findFirstOrThrow({ where: { id: dto.patternId, tenantId: user.tenantId } });
    const employees = await this.prisma.employee.findMany({
      where: { AND: [await this.scope.employeeWhere(user), { id: { in: dto.employeeIds } }] },
    });
    if (employees.length !== new Set(dto.employeeIds).size) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Unknown employee id(s)');

    const from = dbDate(dto.effectiveFrom);
    const to = dto.effectiveTo ? dbDate(dto.effectiveTo) : null;
    await this.audit.run({
      action: 'SCHEDULE_ASSIGNED',
      targetType: 'EmployeeSchedule',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: async (tx) => {
        for (const e of employees) {
          const overlapping = await tx.employeeSchedule.findMany({
            where: {
              employeeId: e.id,
              ...(to ? { effectiveFrom: { lte: to } } : {}),
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
            },
          });
          for (const s of overlapping) {
            const startsBefore = s.effectiveFrom < from;
            const endsAfter = to && (s.effectiveTo === null || s.effectiveTo > to);
            if (endsAfter) {
              await tx.employeeSchedule.create({
                data: { ...s, id: undefined, createdAt: undefined, effectiveFrom: dbDate(addDays(ymdOf(to), 1)) },
              });
            }
            if (startsBefore) {
              await tx.employeeSchedule.update({ where: { id: s.id }, data: { effectiveTo: dbDate(addDays(dto.effectiveFrom, -1)) } });
            } else {
              await tx.employeeSchedule.delete({ where: { id: s.id } });
            }
          }
          await tx.employeeSchedule.create({
            data: {
              tenantId: user.tenantId,
              employeeId: e.id,
              effectiveFrom: from,
              effectiveTo: to,
              shiftId: dto.shiftId ?? null,
              weeklyOffs: dto.shiftId ? dto.weeklyOffs ?? [0] : [],
              patternId: dto.patternId ?? null,
              anchorDate: dto.anchorDate ? dbDate(dto.anchorDate) : null,
              createdBy: user.sub,
            },
          });
        }
        return null;
      },
    });
    await this.rosterChanged(user, employees.map((e) => e.id), dto.effectiveFrom, dto.effectiveTo ?? addDays(dto.effectiveFrom, 400), dto.reevaluateHistory);
    return { assigned: employees.length };
  }

  private async assertOverrideScope(user: AuthUser, employeeIds: string[]) {
    const unique = [...new Set(employeeIds)];
    const inScope = await this.prisma.employee.count({ where: { AND: [await this.scope.employeeWhere(user), { id: { in: unique } }] } });
    if (inScope !== unique.length) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Unknown employee id(s)');
  }

  async upsertOverrides(user: AuthUser, dto: OverridesDto) {
    await this.assertOverrideScope(user, dto.items.map((i) => i.employeeId));
    const shiftIds = [...new Set(dto.items.map((i) => i.shiftId).filter((s): s is string => Boolean(s)))];
    if ((await this.prisma.shift.count({ where: { tenantId: user.tenantId, id: { in: shiftIds } } })) !== shiftIds.length) {
      throw new AppError(400, 'UNKNOWN_SHIFT', 'Unknown shift id(s)');
    }
    await this.audit.run({
      action: 'ROSTER_OVERRIDES_SET',
      targetType: 'RosterOverride',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ items: dto.items }),
      run: async (tx) => {
        for (const i of dto.items) {
          await tx.rosterOverride.upsert({
            where: { employeeId_date: { employeeId: i.employeeId, date: dbDate(i.date) } },
            create: { tenantId: user.tenantId, employeeId: i.employeeId, date: dbDate(i.date), shiftId: i.shiftId ?? null, reason: i.reason, createdBy: user.sub },
            update: { shiftId: i.shiftId ?? null, reason: i.reason, createdBy: user.sub },
          });
        }
        return null;
      },
    });
    await this.recomputeAround(user, dto.items, dto.reevaluateHistory);
    return { updated: dto.items.length };
  }

  async deleteOverrides(user: AuthUser, dto: DeleteOverridesDto) {
    await this.assertOverrideScope(user, dto.items.map((i) => i.employeeId));
    await this.audit.run({
      action: 'ROSTER_OVERRIDES_DELETED',
      targetType: 'RosterOverride',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ items: dto.items }),
      run: (tx) =>
        tx.rosterOverride.deleteMany({
          where: { tenantId: user.tenantId, OR: dto.items.map((i) => ({ employeeId: i.employeeId, date: dbDate(i.date) })) },
        }),
    });
    await this.recomputeAround(user, dto.items, dto.reevaluateHistory);
    return { deleted: dto.items.length };
  }

  /** An override moves windows of D−1 and D+1 too. */
  private async recomputeAround(user: AuthUser, items: Array<{ employeeId: string; date: string }>, reevaluate?: boolean) {
    const byEmployee = new Map<string, string[]>();
    for (const i of items) byEmployee.set(i.employeeId, [...(byEmployee.get(i.employeeId) ?? []), i.date]);
    for (const [employeeId, dates] of byEmployee) {
      dates.sort();
      await this.rosterChanged(user, [employeeId], addDays(dates[0], -1), addDays(dates[dates.length - 1], 1), reevaluate);
    }
  }

  /**
   * The planner grid: materialised days where they exist, planned on the fly
   * beyond the horizon, with conflict warnings (§7.4). Warnings only.
   */
  async grid(user: AuthUser, q: RosterQuery) {
    if (q.from > q.to || diffDays(q.from, q.to) > 62) throw new AppError(400, 'BAD_RANGE', 'Range must be 1–63 days');
    const employees = await this.prisma.employee.findMany({
      where: {
        AND: [
          await this.scope.employeeWhere(user),
          { status: 'ACTIVE' },
          q.siteId ? { siteId: q.siteId } : {},
          q.departmentId ? { departmentId: q.departmentId } : {},
          q.employeeId ? { id: q.employeeId } : {},
        ],
      },
      orderBy: { fullName: 'asc' },
      take: 500,
    });
    const ids = employees.map((e) => e.id);
    const [days, overrides, leave, tr] = await Promise.all([
      this.prisma.attendanceDay.findMany({ where: { employeeId: { in: ids }, workDate: { gte: dbDate(q.from), lte: dbDate(q.to) } } }),
      this.prisma.rosterOverride.findMany({ where: { employeeId: { in: ids }, date: { gte: dbDate(q.from), lte: dbDate(q.to) } } }),
      this.prisma.leaveRequest.findMany({
        where: { employeeId: { in: ids }, status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: dbDate(q.to) }, endDate: { gte: dbDate(q.from) } },
        select: { employeeId: true, startDate: true, endDate: true, status: true },
      }),
      this.roster.tenantRoster(user.tenantId, q.from, q.to),
    ]);
    const rosters = await this.roster.employeeRosters(tr, employees, q.from, q.to);
    const minRest = (tr.defaultPolicy?.minRestHours ?? 8) * 60;
    const maxWeek = (tr.defaultPolicy?.maxWeeklyHours ?? 60) * 60;

    const rows = employees.map((e) => {
      const cells = eachDay(q.from, q.to).map((date) => {
        const row = days.find((d) => d.employeeId === e.id && ymdOf(d.workDate) === date);
        const plan = row ? null : this.roster.planDay(tr, e, rosters.get(e.id)!, date);
        const override = overrides.find((o) => o.employeeId === e.id && ymdOf(o.date) === date);
        return {
          date,
          materialised: Boolean(row),
          dayType: row ? row.dayType : plan!.dayType,
          shiftId: row ? row.shiftId : (plan!.shiftId as string | null),
          holidayName: row ? row.holidayName : (plan!.holidayName as string | null),
          schedStart: row ? row.schedStart : (plan!.schedStart as Date | null),
          schedEnd: row ? row.schedEnd : (plan!.schedEnd as Date | null),
          requiredMinutes: row ? row.requiredMinutes : (plan!.requiredMinutes as number),
          status: row?.status ?? null,
          override: override ? { shiftId: override.shiftId, reason: override.reason } : null,
          conflicts: [] as string[],
        };
      });
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const prev = cells[i - 1];
        if (prev?.schedEnd && c.schedStart && (c.schedStart.getTime() - prev.schedEnd.getTime()) / 60_000 < minRest) {
          c.conflicts.push('REST_TOO_SHORT');
        }
        if (c.dayType === 'WORKING' && leave.some((l) => l.employeeId === e.id && ymdOf(l.startDate) <= c.date && c.date <= ymdOf(l.endDate))) {
          c.conflicts.push('LEAVE_OVERLAP');
        }
      }
      // Rolling 7-day required hours.
      for (let i = 6; i < cells.length; i++) {
        const week = cells.slice(i - 6, i + 1).reduce((sum, c) => sum + (c.dayType === 'WORKING' ? c.requiredMinutes : 0), 0);
        if (week > maxWeek) cells[i].conflicts.push('WEEKLY_HOURS_EXCEEDED');
      }
      return { employee: { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, departmentId: e.departmentId, siteId: e.siteId }, cells };
    });
    return { from: q.from, to: q.to, rows };
  }
}

// ── Controllers ─────────────────────────────────────────────────────────────

@ApiTags('schedule')
@Controller('shifts')
export class ShiftsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ScheduleService,
    private readonly audit: AuditableActionService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const shifts = await this.prisma.shift.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } });
    return shifts.map((s) => this.schedule.presentShift(s));
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.schedule.presentShift(await this.prisma.shift.findFirstOrThrow({ where: { id, tenantId: user.tenantId } }));
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: ShiftDto) {
    return this.schedule.createShift(user, dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ShiftDto) {
    return this.schedule.updateShift(user, id, dto);
  }

  /** Deactivates; a shift referenced by history is never hard-deleted. */
  @Delete(':id')
  @Roles('ADMIN', 'HR')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.shift.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    return this.audit.run({
      action: 'SHIFT_DEACTIVATED',
      targetType: 'Shift',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      run: (tx) => tx.shift.update({ where: { id }, data: { active: false, isDefault: false } }),
    });
  }
}

@ApiTags('schedule')
@Controller('shift-patterns')
export class PatternsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ScheduleService,
    private readonly audit: AuditableActionService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.shiftPattern.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.shiftPattern.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
  }

  @Post()
  @Roles('ADMIN', 'HR')
  async create(@CurrentUser() user: AuthUser, @Body() dto: PatternDto) {
    const data = await this.schedule.validatePattern(user, dto);
    return this.audit.run({
      action: 'PATTERN_CREATED',
      targetType: 'ShiftPattern',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => tx.shiftPattern.create({ data: { ...data, tenantId: user.tenantId } }),
    });
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PatternDto) {
    await this.prisma.shiftPattern.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    const data = await this.schedule.validatePattern(user, dto);
    const pattern = await this.audit.run({
      action: 'PATTERN_UPDATED',
      targetType: 'ShiftPattern',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => tx.shiftPattern.update({ where: { id }, data }),
    });
    const users = await this.prisma.employeeSchedule.findMany({ where: { patternId: id }, select: { employeeId: true } });
    const today = localYmd(new Date(), 'UTC');
    if (users.length) await this.schedule.rosterChanged(user, [...new Set(users.map((u) => u.employeeId))], today, addDays(today, HORIZON_DAYS));
    return pattern;
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.shiftPattern.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    if (await this.prisma.employeeSchedule.count({ where: { patternId: id } })) {
      throw new AppError(409, 'PATTERN_IN_USE', 'Pattern is assigned to employees');
    }
    return this.audit.run({
      action: 'PATTERN_DELETED',
      targetType: 'ShiftPattern',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      run: (tx) => tx.shiftPattern.delete({ where: { id } }),
    });
  }
}

@ApiTags('schedule')
@Controller()
export class RosterController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ScheduleService,
    private readonly scope: ScopeService,
  ) {}

  @Get('employee-schedules')
  async schedules(@CurrentUser() user: AuthUser, @Query('employeeId') employeeId?: string) {
    const visible = await this.prisma.employee.findMany({
      where: { AND: [await this.scope.employeeWhere(user), employeeId ? { id: employeeId } : {}] },
      select: { id: true },
    });
    const rows = await this.prisma.employeeSchedule.findMany({
      where: { tenantId: user.tenantId, employeeId: { in: visible.map((e) => e.id) } },
      orderBy: [{ employeeId: 'asc' }, { effectiveFrom: 'desc' }],
    });
    return rows.map((r) => ({
      ...r,
      effectiveFrom: ymdOf(r.effectiveFrom),
      effectiveTo: r.effectiveTo ? ymdOf(r.effectiveTo) : null,
      anchorDate: r.anchorDate ? ymdOf(r.anchorDate) : null,
    }));
  }

  /** Assign a fixed shift or a rotation to many employees at once. */
  @Post('employee-schedules')
  @Roles('ADMIN', 'HR')
  assign(@CurrentUser() user: AuthUser, @Body() dto: AssignScheduleDto) {
    return this.schedule.assign(user, dto);
  }

  @Get('roster')
  @Roles('ADMIN', 'HR', 'MANAGER')
  grid(@CurrentUser() user: AuthUser, @Query() q: RosterQuery) {
    return this.schedule.grid(user, q);
  }

  /** Managers may set overrides for their own team (§13). */
  @Put('roster/overrides')
  @Roles('ADMIN', 'HR', 'MANAGER')
  upsert(@CurrentUser() user: AuthUser, @Body() dto: OverridesDto) {
    return this.schedule.upsertOverrides(user, dto);
  }

  @Delete('roster/overrides')
  @Roles('ADMIN', 'HR', 'MANAGER')
  remove(@CurrentUser() user: AuthUser, @Body() dto: DeleteOverridesDto) {
    return this.schedule.deleteOverrides(user, dto);
  }
}

@Module({
  controllers: [ShiftsController, PatternsController, RosterController],
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}


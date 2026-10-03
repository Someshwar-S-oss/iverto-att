import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { RecomputeQueue } from '../attendance/recompute.service';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { addDays, dbDate, localYmd, ymdOf } from '../common/time';
import { IsHm, IsTimeZone, IsYmd } from '../common/validators';

// ── DTOs ────────────────────────────────────────────────────────────────────

class BrandingDto {
  @IsOptional() @IsUrl({ protocols: ['https'], require_protocol: true }) logoUrl?: string;
  @IsOptional() @IsHexColor() primaryColor?: string;
  @IsOptional() @IsString() @MaxLength(120) displayName?: string;
}

export class OrgSettingsDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsHm() dayBoundary?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) defaultWeeklyOffs?: number[];
  @IsOptional() @IsBoolean() storePunchPhotos?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) punchPhotoRetentionDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) reportRetentionDays?: number;
  @IsOptional() @ValidateNested() @Type(() => BrandingDto) branding?: BrandingDto;
}

export class SiteDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsTimeZone() timezone: string;
  @IsOptional() @IsString() holidayCalendarId?: string | null;
}

export class DepartmentDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(20) code?: string;
  @IsOptional() @IsString() headEmployeeId?: string | null;
  @IsOptional() @IsString() policyId?: string | null;
}

export class ProjectDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(20) code?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class MemberDto {
  @IsString() employeeId: string;
  @IsYmd() from: string;
  @IsOptional() @IsYmd() to?: string | null;
}

export class MembersDto {
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => MemberDto) members: MemberDto[];
}

export class CalendarDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
}

export class HolidayDto {
  @IsYmd() date: string;
  @IsString() @MinLength(1) @MaxLength(120) name: string;
}

export class HolidayImportDto {
  @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => HolidayDto) holidays: HolidayDto[];
}

export class CalendarSitesDto {
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) siteIds: string[];
}

export class PolicyDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(240) graceInMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(240) graceOutMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) halfDayMinPercent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) fullDayMinPercent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(720) earlyWindowMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(720) lateWindowMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3600) duplicatePunchSeconds?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(240) minSessionMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1440) absentAfterMinutes?: number;
  @IsOptional() @IsIn(['NONE', 'UNTIL_SHIFT_END']) missedOutCredit?: string;
  @IsOptional() @IsBoolean() overtimeEnabled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(720) overtimeMinMinutes?: number;
  @IsOptional() @IsIn(['SHIFT_BREAK', 'NONE']) breakDeduction?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60) roundingMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(24) minRestHours?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(168) maxWeeklyHours?: number;
}

/** Records audited through one helper to keep controllers flat. */
function audited<T>(audit: AuditableActionService, user: AuthUser, action: string, targetType: string, run: (tx: Prisma.TransactionClient) => Promise<T>, targetId?: string, payload?: object) {
  return audit.run({ action, targetType, targetId, actor: actorOf(user), tenantId: user.tenantId, payloadFrom: () => ({ ...(payload ?? {}) }), run });
}

// ── Controllers ─────────────────────────────────────────────────────────────

@ApiTags('org')
@Controller('org')
export class OrgController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly queue: RecomputeQueue,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const t = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
    const { adminUserId, pendingAdmin, ...settings } = t.settings as Record<string, unknown>;
    return { id: t.id, name: t.name, slug: t.slug, status: t.status, settings };
  }

  @Patch()
  @Roles('ADMIN')
  async update(@CurrentUser() user: AuthUser, @Body() dto: OrgSettingsDto) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
    const { name, ...patch } = dto;
    const settings = { ...(tenant.settings as object), ...patch };
    const updated = await audited(this.audit, user, 'ORG_SETTINGS_UPDATED', 'Tenant', (tx) =>
      tx.tenant.update({ where: { id: user.tenantId }, data: { name, settings: settings as Prisma.InputJsonValue } }),
      user.tenantId, dto,
    );
    if (dto.dayBoundary) {
      const today = localYmd(new Date(), 'UTC');
      await this.queue.bulk({ tenantId: user.tenantId, from: addDays(today, -1), to: addDays(today, 14), rematerialise: true });
    }
    return updated;
  }
}

/** How far ahead attendance days are materialised (jobs.ts). */
const HORIZON_DAYS = 14;

async function assertCalendar(prisma: PrismaService, tenantId: string, calendarId?: string | null) {
  if (calendarId && !(await prisma.holidayCalendar.count({ where: { id: calendarId, tenantId } }))) {
    throw new AppError(400, 'CALENDAR_NOT_FOUND', 'Unknown holiday calendar');
  }
}

/** A site switched holiday calendar: its employees' days around today are judged against the new one. */
async function sitesCalendarChanged(prisma: PrismaService, queue: RecomputeQueue, tenantId: string, siteIds: string[]) {
  if (!siteIds.length) return;
  const employees = await prisma.employee.findMany({ where: { tenantId, siteId: { in: siteIds } }, select: { id: true } });
  if (!employees.length) return;
  const today = localYmd(new Date(), 'UTC');
  await queue.bulk({ tenantId, employeeIds: employees.map((e) => e.id), from: addDays(today, -1), to: addDays(today, HORIZON_DAYS), rematerialise: true });
}

@ApiTags('org')
@Controller('sites')
export class SitesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditableActionService, private readonly queue: RecomputeQueue) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.site.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.site.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
  }

  @Post()
  @Roles('ADMIN')
  async create(@CurrentUser() user: AuthUser, @Body() dto: SiteDto) {
    await assertCalendar(this.prisma, user.tenantId, dto.holidayCalendarId);
    return audited(this.audit, user, 'SITE_CREATED', 'Site', (tx) => tx.site.create({ data: { ...dto, tenantId: user.tenantId } }), undefined, dto);
  }

  @Patch(':id')
  @Roles('ADMIN')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SiteDto) {
    const before = await this.prisma.site.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    await assertCalendar(this.prisma, user.tenantId, dto.holidayCalendarId);
    const site = await audited(this.audit, user, 'SITE_UPDATED', 'Site', (tx) => tx.site.update({ where: { id }, data: dto }), id, dto);
    if (dto.holidayCalendarId !== undefined && (dto.holidayCalendarId || null) !== before.holidayCalendarId) {
      await sitesCalendarChanged(this.prisma, this.queue, user.tenantId, [id]);
    }
    return site;
  }

  @Delete(':id')
  @Roles('ADMIN')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.site.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    if ((await this.prisma.employee.count({ where: { siteId: id } })) || (await this.prisma.device.count({ where: { siteId: id } }))) {
      throw new AppError(409, 'SITE_IN_USE', 'Move its employees and terminals first');
    }
    return audited(this.audit, user, 'SITE_DELETED', 'Site', (tx) => tx.site.delete({ where: { id } }), id);
  }
}

@ApiTags('org')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditableActionService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.department.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { employees: true } } },
    });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.department.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: DepartmentDto) {
    return audited(this.audit, user, 'DEPARTMENT_CREATED', 'Department', (tx) => tx.department.create({ data: { ...dto, tenantId: user.tenantId } }), undefined, dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DepartmentDto) {
    await this.prisma.department.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    return audited(this.audit, user, 'DEPARTMENT_UPDATED', 'Department', (tx) => tx.department.update({ where: { id }, data: dto }), id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.department.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    if (await this.prisma.employee.count({ where: { departmentId: id } })) throw new AppError(409, 'DEPARTMENT_IN_USE', 'Department still has employees');
    return audited(this.audit, user, 'DEPARTMENT_DELETED', 'Department', (tx) => tx.department.delete({ where: { id } }), id);
  }
}

@ApiTags('org')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditableActionService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.project.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' }, include: { _count: { select: { members: true } } } });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.project.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: ProjectDto) {
    return audited(this.audit, user, 'PROJECT_CREATED', 'Project', (tx) => tx.project.create({ data: { ...dto, tenantId: user.tenantId } }), undefined, dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ProjectDto) {
    await this.prisma.project.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    return audited(this.audit, user, 'PROJECT_UPDATED', 'Project', (tx) => tx.project.update({ where: { id }, data: dto }), id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.project.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    return audited(this.audit, user, 'PROJECT_DELETED', 'Project', (tx) => tx.project.delete({ where: { id } }), id);
  }

  @Get(':id/members')
  async members(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.project.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    const rows = await this.prisma.employeeProject.findMany({
      where: { projectId: id },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
    });
    return rows.map((r) => ({ ...r, from: ymdOf(r.from), to: r.to ? ymdOf(r.to) : null }));
  }

  /** Replaces the membership list (memberships carry from/to so history stays reportable). */
  @Put(':id/members')
  @Roles('ADMIN', 'HR')
  async setMembers(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: MembersDto) {
    await this.prisma.project.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    const ids = [...new Set(dto.members.map((m) => m.employeeId))];
    if ((await this.prisma.employee.count({ where: { tenantId: user.tenantId, id: { in: ids } } })) !== ids.length) {
      throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Unknown employee id(s)');
    }
    return audited(this.audit, user, 'PROJECT_MEMBERS_SET', 'Project', async (tx) => {
      await tx.employeeProject.deleteMany({ where: { projectId: id } });
      await tx.employeeProject.createMany({
        data: dto.members.map((m) => ({ tenantId: user.tenantId, projectId: id, employeeId: m.employeeId, from: dbDate(m.from), to: m.to ? dbDate(m.to) : null })),
      });
      return { projectId: id, members: dto.members.length };
    }, id, dto);
  }
}

@ApiTags('org')
@Controller('holiday-calendars')
export class HolidaysController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly queue: RecomputeQueue,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.holidayCalendar.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.holidayCalendar.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: CalendarDto) {
    return audited(this.audit, user, 'HOLIDAY_CALENDAR_CREATED', 'HolidayCalendar', (tx) => tx.holidayCalendar.create({ data: { ...dto, tenantId: user.tenantId } }), undefined, dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CalendarDto) {
    await this.prisma.holidayCalendar.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    return audited(this.audit, user, 'HOLIDAY_CALENDAR_UPDATED', 'HolidayCalendar', (tx) => tx.holidayCalendar.update({ where: { id }, data: dto }), id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.holidayCalendar.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    if (await this.prisma.site.count({ where: { holidayCalendarId: id } })) throw new AppError(409, 'CALENDAR_IN_USE', 'A site uses this calendar');
    return audited(this.audit, user, 'HOLIDAY_CALENDAR_DELETED', 'HolidayCalendar', (tx) => tx.holidayCalendar.delete({ where: { id } }), id);
  }

  @Get(':id/holidays')
  async holidays(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.holidayCalendar.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    const rows = await this.prisma.holiday.findMany({ where: { calendarId: id }, orderBy: { date: 'asc' } });
    return rows.map((h) => ({ ...h, date: ymdOf(h.date) }));
  }

  @Post(':id/holidays')
  @Roles('ADMIN', 'HR')
  async addHoliday(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: HolidayDto) {
    await this.prisma.holidayCalendar.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    const h = await audited(this.audit, user, 'HOLIDAY_ADDED', 'Holiday', (tx) =>
      tx.holiday.create({ data: { tenantId: user.tenantId, calendarId: id, date: dbDate(dto.date), name: dto.name } }),
      undefined, { calendarId: id, ...dto },
    );
    await this.holidayChanged(user, id, dto.date, dto.date);
    return { ...h, date: dto.date };
  }

  /** Bulk add from a CSV the web app parsed; an existing date keeps its row and takes the new name. */
  @Post(':id/holidays/import')
  @Roles('ADMIN', 'HR')
  async importHolidays(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: HolidayImportDto) {
    await this.prisma.holidayCalendar.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    const byDate = new Map(dto.holidays.map((h) => [h.date, h.name.trim()])); // last row for a date wins
    if (!byDate.size) throw new AppError(400, 'EMPTY_IMPORT', 'No holidays to import');
    const existing = new Set((await this.prisma.holiday.findMany({ where: { calendarId: id, date: { in: [...byDate.keys()].map(dbDate) } }, select: { date: true } })).map((h) => ymdOf(h.date)));
    // Two statements instead of one upsert per row: nothing references a holiday row by id.
    await audited(this.audit, user, 'HOLIDAYS_IMPORTED', 'HolidayCalendar', async (tx) => {
      await tx.holiday.deleteMany({ where: { calendarId: id, date: { in: [...byDate.keys()].map(dbDate) } } });
      await tx.holiday.createMany({ data: [...byDate].map(([date, name]) => ({ tenantId: user.tenantId, calendarId: id, date: dbDate(date), name })) });
    }, id, { count: byDate.size });
    const dates = [...byDate.keys()].sort();
    await this.holidayChanged(user, id, dates[0], dates[dates.length - 1]);
    return { imported: byDate.size, created: byDate.size - existing.size, updated: existing.size };
  }

  /** Which office locations follow this calendar. A site follows one calendar, so listed sites move here. */
  @Put(':id/sites')
  @Roles('ADMIN', 'HR')
  async setSites(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CalendarSitesDto) {
    await this.prisma.holidayCalendar.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    const ids = [...new Set(dto.siteIds)];
    const sites = await this.prisma.site.findMany({ where: { tenantId: user.tenantId }, select: { id: true, holidayCalendarId: true } });
    if (ids.some((sid) => !sites.find((s) => s.id === sid))) throw new AppError(400, 'SITE_NOT_FOUND', 'Unknown site');
    const added = sites.filter((s) => ids.includes(s.id) && s.holidayCalendarId !== id).map((s) => s.id);
    const removed = sites.filter((s) => !ids.includes(s.id) && s.holidayCalendarId === id).map((s) => s.id);
    await audited(this.audit, user, 'HOLIDAY_CALENDAR_SITES_SET', 'HolidayCalendar', async (tx) => {
      await tx.site.updateMany({ where: { id: { in: added } }, data: { holidayCalendarId: id } });
      await tx.site.updateMany({ where: { id: { in: removed } }, data: { holidayCalendarId: null } });
    }, id, { siteIds: ids });
    await sitesCalendarChanged(this.prisma, this.queue, user.tenantId, [...added, ...removed]);
    return { siteIds: ids };
  }

  @Delete(':id/holidays/:holidayId')
  @Roles('ADMIN', 'HR')
  async removeHoliday(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('holidayId') holidayId: string) {
    const h = await this.prisma.holiday.findFirstOrThrow({ where: { id: holidayId, calendarId: id, tenantId: user.tenantId } });
    await audited(this.audit, user, 'HOLIDAY_REMOVED', 'Holiday', (tx) => tx.holiday.delete({ where: { id: holidayId } }), holidayId, { date: ymdOf(h.date), name: h.name });
    await this.holidayChanged(user, id, ymdOf(h.date), ymdOf(h.date));
    return { deleted: true };
  }

  /**
   * §6.6: those dates (and their neighbours' windows), every employee of the calendar's sites.
   * Days past the materialised horizon pick the holiday up when they are materialised.
   */
  private async holidayChanged(user: AuthUser, calendarId: string, first: string, last: string) {
    const horizon = addDays(localYmd(new Date(), 'UTC'), HORIZON_DAYS);
    const from = addDays(first, -1);
    const to = addDays(last, 1) < horizon ? addDays(last, 1) : horizon;
    if (from > to) return;
    const sites = await this.prisma.site.findMany({ where: { tenantId: user.tenantId, holidayCalendarId: calendarId }, select: { id: true } });
    if (!sites.length) return;
    const employees = await this.prisma.employee.findMany({ where: { siteId: { in: sites.map((s) => s.id) } }, select: { id: true } });
    if (!employees.length) return;
    await this.queue.bulk({
      tenantId: user.tenantId,
      employeeIds: employees.map((e) => e.id),
      from,
      to,
      rematerialise: true,
      includeFinalized: true,
    });
  }
}

@ApiTags('org')
@Controller('attendance-policies')
export class PoliciesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly queue: RecomputeQueue,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.attendancePolicy.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.attendancePolicy.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: PolicyDto) {
    return audited(this.audit, user, 'POLICY_CREATED', 'AttendancePolicy', async (tx) => {
      if (dto.isDefault) await tx.attendancePolicy.updateMany({ where: { tenantId: user.tenantId }, data: { isDefault: false } });
      return tx.attendancePolicy.create({ data: { ...dto, tenantId: user.tenantId } });
    }, undefined, dto);
  }

  /** Applies today onward; past days keep the snapshot they were judged with (§6.6). */
  @Patch(':id')
  @Roles('ADMIN', 'HR')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PolicyDto) {
    await this.prisma.attendancePolicy.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    const policy = await audited(this.audit, user, 'POLICY_UPDATED', 'AttendancePolicy', async (tx) => {
      if (dto.isDefault) await tx.attendancePolicy.updateMany({ where: { tenantId: user.tenantId, id: { not: id } }, data: { isDefault: false } });
      return tx.attendancePolicy.update({ where: { id }, data: dto });
    }, id, dto);
    const today = localYmd(new Date(), 'UTC');
    await this.queue.bulk({ tenantId: user.tenantId, from: today, to: addDays(today, 14), rematerialise: true });
    return policy;
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const p = await this.prisma.attendancePolicy.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    if (p.isDefault) throw new AppError(409, 'DEFAULT_POLICY', 'Make another policy the default first');
    const used = (await this.prisma.department.count({ where: { policyId: id } })) + (await this.prisma.shift.count({ where: { policyId: id } }));
    if (used) throw new AppError(409, 'POLICY_IN_USE', 'A department or shift uses this policy');
    return audited(this.audit, user, 'POLICY_DELETED', 'AttendancePolicy', (tx) => tx.attendancePolicy.delete({ where: { id } }), id);
  }
}

@Module({
  controllers: [OrgController, SitesController, DepartmentsController, ProjectsController, HolidaysController, PoliciesController],
})
export class OrgModule {}


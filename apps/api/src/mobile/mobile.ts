import { Body, Controller, Delete, Get, Injectable, Module, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AttendanceDay } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
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
} from 'class-validator';
import { randomUUID } from 'crypto';
import { AttendanceModule } from '../attendance/attendance.module';
import { CorrectionsService, CreateCorrectionDto, RequestListQuery } from '../attendance/corrections';
import { presentDay, presentPunch, statusCode } from '../attendance/present';
import { RosterService } from '../attendance/roster.service';
import { AllowPendingPassword, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { BUCKETS, SupabaseService } from '../common/supabase.service';
import { addDays, dbDate, formatLocal, localYmd, monthRange, ymdOf } from '../common/time';
import { IsMonth, IsYmd } from '../common/validators';
import { LeaveListQuery, LeaveModule, LeaveRequestDto, LeaveService, NoteDto } from '../leave/leave';
import { LiveService } from '../live/live.module';
import { NotificationsService } from '../notifications/notifications';
import { MobilePunchDto, RemoteModule, RemoteRequestDto, RemoteService } from '../remote/remote';
import { ScheduleModule, ScheduleService } from '../schedule/schedule';
import { ChangePasswordDto, UsersModule } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { IdempotencyInterceptor } from './idempotency';

// ── DTOs ────────────────────────────────────────────────────────────────────

export class PushDeviceDto {
  @IsString() @MinLength(10) @MaxLength(4096) token: string;
  @IsIn(['android', 'ios', 'web']) platform: 'android' | 'ios' | 'web';
}

export class ReadDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) ids?: string[];
  @IsOptional() @IsBoolean() all?: boolean;
}

export class CursorQuery {
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class MonthQuery {
  @IsMonth() month: string;
}

export class RangeQuery {
  @IsOptional() @IsYmd() from?: string;
  @IsOptional() @IsYmd() to?: string;
}

export class YearQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
}

export class DateQuery {
  @IsOptional() @IsYmd() date?: string;
}

export class ApprovalsQuery extends CursorQuery {
  @IsIn(['leave', 'correction', 'remote']) type: 'leave' | 'correction' | 'remote';
}

export class MobileLeaveListQuery extends CursorQuery {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) status?: string;
}

export class UploadDto {
  @IsString() @Matches(/^[\w .()-]{1,120}$/, { message: 'fileName has invalid characters' }) fileName: string;
  @IsIn(['image/jpeg', 'image/png', 'application/pdf']) contentType: 'image/jpeg' | 'image/png' | 'application/pdf';
  @IsBase64() dataBase64: string;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
};

// ── Service ─────────────────────────────────────────────────────────────────

/** Thin shaping over the domain services: small payloads, local times next to instants (§14.2). */
@Injectable()
export class MobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly roster: RosterService,
    private readonly schedule: ScheduleService,
  ) {}

  async me(user: AuthUser) {
    const profile = await this.prisma.userProfile.findUnique({ where: { userId: user.sub } });
    const employee = user.employeeId
      ? await this.prisma.employee.findFirst({
          where: { id: user.employeeId, tenantId: user.tenantId },
          include: { site: true, department: true, manager: { select: { id: true, fullName: true, phone: true, email: true } } },
        })
      : null;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: user.tenantId } });
    const settings = (tenant?.settings ?? {}) as Record<string, any>;
    return {
      userId: user.sub,
      email: user.email,
      displayName: profile?.displayName ?? employee?.fullName ?? user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      organisation: { id: tenant?.id, name: settings.branding?.displayName ?? tenant?.name, logoUrl: settings.branding?.logoUrl ?? null, primaryColor: settings.branding?.primaryColor ?? null },
      employee: employee
        ? {
            id: employee.id,
            employeeCode: employee.employeeCode,
            fullName: employee.fullName,
            designation: employee.designation,
            department: employee.department ? { id: employee.department.id, name: employee.department.name } : null,
            site: { id: employee.site.id, name: employee.site.name, timezone: employee.site.timezone },
            manager: employee.manager,
            joinedOn: ymdOf(employee.joinedOn),
          }
        : null,
      features: {
        mobilePunch: employee?.mobilePunch ?? 'NEVER',
        canApprove: user.role !== 'EMPLOYEE',
        teamView: user.role !== 'EMPLOYEE',
        remoteWork: Boolean(employee),
        leave: Boolean(employee),
      },
    };
  }

  private async todayRow(employee: { id: string; tenantId: string; siteId: string }, date: string) {
    let day = await this.prisma.attendanceDay.findUnique({ where: { employeeId_workDate: { employeeId: employee.id, workDate: dbDate(date) } } });
    if (!day) {
      const e = await this.prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
      await this.roster.ensureDays(employee.tenantId, [e], date, date);
      day = await this.prisma.attendanceDay.findUnique({ where: { employeeId_workDate: { employeeId: employee.id, workDate: dbDate(date) } } });
    }
    return day;
  }

  private shape(day: AttendanceDay, shiftName?: string | null) {
    const p = presentDay(day);
    return { ...p, code: statusCode(day), shiftName: shiftName ?? null };
  }

  async today(user: AuthUser) {
    const employee = await this.scope.self(user);
    const tz = employee.site.timezone;
    const now = new Date();
    // Attendance "today" is the work date whose window contains now (a night shift is still yesterday's).
    const open = await this.prisma.attendanceDay.findFirst({
      where: { employeeId: employee.id, windowStart: { lte: now }, windowEnd: { gt: now } },
    });
    const day = open ?? (await this.todayRow(employee, localYmd(now, tz)));
    const [shifts, next, punches, remote] = await Promise.all([
      this.prisma.shift.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true, code: true, color: true } }),
      this.prisma.attendanceDay.findFirst({
        where: { employeeId: employee.id, workDate: { gt: day?.workDate ?? dbDate(localYmd(now, tz)) }, dayType: 'WORKING' },
        orderBy: { workDate: 'asc' },
      }),
      day
        ? this.prisma.punch.findMany({
            where: { employeeId: employee.id, punchedAt: { gte: day.windowStart, lt: day.windowEnd } },
            include: { device: true },
            orderBy: { punchedAt: 'asc' },
          })
        : [],
      this.prisma.remoteWorkRequest.findFirst({
        where: { employeeId: employee.id, status: 'APPROVED', startDate: { lte: dbDate(localYmd(now, tz)) }, endDate: { gte: dbDate(localYmd(now, tz)) } },
      }),
    ]);
    const shiftOf = (id?: string | null) => shifts.find((s) => s.id === id) ?? null;
    return {
      timezone: tz,
      now,
      day: day ? { ...this.shape(day, shiftOf(day.shiftId)?.name), shift: shiftOf(day.shiftId) } : null,
      punches: punches.map((p) => presentPunch(p, tz)),
      nextShift: next
        ? { date: ymdOf(next.workDate), shift: shiftOf(next.shiftId), start: next.schedStart, end: next.schedEnd, local: { start: formatLocal(next.schedStart, tz), end: formatLocal(next.schedEnd, tz) } }
        : null,
      mobilePunch: {
        mode: employee.mobilePunch,
        allowedNow: employee.mobilePunch === 'ALWAYS' || (employee.mobilePunch === 'REMOTE_DAYS' && Boolean(remote)),
      },
    };
  }

  async month(user: AuthUser, month: string) {
    const employee = await this.scope.self(user);
    const { from, to } = monthRange(month);
    const days = await this.prisma.attendanceDay.findMany({
      where: { employeeId: employee.id, workDate: { gte: dbDate(from), lte: dbDate(to) } },
      orderBy: { workDate: 'asc' },
    });
    const count = (s: string) => days.filter((d) => d.status === s).length;
    return {
      month,
      timezone: employee.site.timezone,
      days: days.map((d) => ({
        date: ymdOf(d.workDate),
        dayId: d.id,
        status: d.status,
        code: statusCode(d),
        dayType: d.dayType,
        holidayName: d.holidayName,
        isLate: d.isLate,
        missedPunch: d.missedPunch,
        workedMinutes: d.workedMinutes,
        firstIn: formatLocal(d.firstIn, d.timezone),
        lastOut: formatLocal(d.lastOut, d.timezone),
      })),
      totals: {
        present: count('PRESENT'),
        remote: count('REMOTE'),
        halfDay: count('HALF_DAY'),
        absent: count('ABSENT'),
        leave: count('ON_LEAVE') + count('HALF_LEAVE') * 0.5,
        holidays: count('HOLIDAY'),
        weeklyOff: count('WEEKLY_OFF'),
        late: days.filter((d) => d.isLate).length,
        workedMinutes: days.reduce((s, d) => s + d.workedMinutes, 0),
        overtimeMinutes: days.reduce((s, d) => s + d.overtimeMinutes, 0),
      },
    };
  }

  async day(user: AuthUser, date: string) {
    const employee = await this.scope.self(user);
    const day = await this.prisma.attendanceDay.findUnique({ where: { employeeId_workDate: { employeeId: employee.id, workDate: dbDate(date) } } });
    if (!day) throw new AppError(404, 'NOT_FOUND', 'No attendance for that day');
    const [punches, corrections, shift] = await Promise.all([
      this.prisma.punch.findMany({
        where: { employeeId: employee.id, punchedAt: { gte: day.windowStart, lt: day.windowEnd } },
        include: { device: true },
        orderBy: { punchedAt: 'asc' },
      }),
      this.prisma.attendanceCorrection.findMany({ where: { employeeId: employee.id, workDate: day.workDate }, orderBy: { createdAt: 'desc' } }),
      day.shiftId ? this.prisma.shift.findUnique({ where: { id: day.shiftId }, select: { id: true, name: true, code: true, color: true } }) : null,
    ]);
    const tz = day.timezone;
    return {
      ...this.shape(day, shift?.name),
      shift,
      segments: (day.segments as Array<{ in: string; out: string | null; credited?: boolean }>).map((s) => ({
        ...s,
        local: { in: formatLocal(new Date(s.in), tz), out: s.out ? formatLocal(new Date(s.out), tz) : null },
      })),
      punches: punches.map((p) => presentPunch(p, tz)),
      corrections: corrections.map((c) => ({ ...c, workDate: ymdOf(c.workDate), local: { in: formatLocal(c.inAt, tz), out: formatLocal(c.outAt, tz) } })),
    };
  }

  async scheduleFor(user: AuthUser, from?: string, to?: string) {
    const employee = await this.scope.self(user);
    const start = from ?? localYmd(new Date(), employee.site.timezone);
    const end = to ?? addDays(start, 13);
    const grid = await this.schedule.grid(user, { from: start, to: end, employeeId: employee.id });
    const shifts = await this.prisma.shift.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true, code: true, color: true } });
    const tz = employee.site.timezone;
    return {
      timezone: tz,
      days: (grid.rows[0]?.cells ?? []).map((c) => ({
        date: c.date,
        dayType: c.dayType,
        holidayName: c.holidayName,
        shift: shifts.find((s) => s.id === c.shiftId) ?? null,
        start: c.schedStart,
        end: c.schedEnd,
        local: { start: formatLocal(c.schedStart, tz), end: formatLocal(c.schedEnd, tz) },
        override: Boolean(c.override),
      })),
    };
  }

  async holidays(user: AuthUser, year?: number) {
    const employee = await this.scope.self(user);
    const y = year ?? Number(localYmd(new Date(), employee.site.timezone).slice(0, 4));
    if (!employee.site.holidayCalendarId) return { year: y, holidays: [] };
    const rows = await this.prisma.holiday.findMany({
      where: { calendarId: employee.site.holidayCalendarId, date: { gte: dbDate(`${y}-01-01`), lte: dbDate(`${y}-12-31`) } },
      orderBy: { date: 'asc' },
    });
    return { year: y, holidays: rows.map((h) => ({ date: ymdOf(h.date), name: h.name })) };
  }

  async teamAttendance(user: AuthUser, date?: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: user.tenantId } });
    const d = date ?? localYmd(new Date(), ((tenant?.settings as any)?.timezone as string) || 'Asia/Kolkata');
    const days = await this.prisma.attendanceDay.findMany({
      where: { tenantId: user.tenantId, workDate: dbDate(d), employee: await this.scope.employeeWhere(user) },
      include: { employee: true },
      orderBy: { employee: { fullName: 'asc' } },
    });
    return { date: d, items: days.map((x) => ({ ...presentDay(x), code: statusCode(x) })) };
  }
}

// ── Controllers ─────────────────────────────────────────────────────────────

@ApiTags('mobile')
@Controller('mobile')
@UseInterceptors(IdempotencyInterceptor)
export class MobileController {
  constructor(
    private readonly mobile: MobileService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly leave: LeaveService,
    private readonly corrections: CorrectionsService,
    private readonly remote: RemoteService,
    private readonly live: LiveService,
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  // Session & profile

  @Get('me')
  @AllowPendingPassword()
  me(@CurrentUser() user: AuthUser) {
    return this.mobile.me(user);
  }

  @Post('password')
  @AllowPendingPassword()
  password(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.users.changeOwnPassword(user, dto.currentPassword, dto.newPassword);
  }

  @Post('push-devices')
  pushDevice(@CurrentUser() user: AuthUser, @Body() dto: PushDeviceDto) {
    return this.notifications.registerDevice(user.tenantId, user.sub, dto.platform, dto.token);
  }

  @Delete('push-devices/:token')
  async unregister(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    await this.notifications.unregisterDevice(user.sub, token);
    return { ok: true };
  }

  @Get('notifications')
  inbox(@CurrentUser() user: AuthUser, @Query() q: CursorQuery) {
    return this.notifications.inbox(user.sub, q.cursor, q.limit);
  }

  @Post('notifications/read')
  async read(@CurrentUser() user: AuthUser, @Body() dto: ReadDto) {
    if (!dto.all && !dto.ids?.length) throw new AppError(400, 'NOTHING_TO_MARK', 'Give ids or all: true');
    const { count } = await this.notifications.markRead(user.sub, dto.all ? 'all' : dto.ids!);
    return { updated: count };
  }

  // Employee self-service

  @Get('today')
  today(@CurrentUser() user: AuthUser) {
    return this.mobile.today(user);
  }

  @Get('attendance')
  month(@CurrentUser() user: AuthUser, @Query() q: MonthQuery) {
    return this.mobile.month(user, q.month);
  }

  @Get('attendance/:date')
  day(@CurrentUser() user: AuthUser, @Param('date') date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'BAD_DATE', 'date must be YYYY-MM-DD');
    return this.mobile.day(user, date);
  }

  @Get('schedule')
  schedule(@CurrentUser() user: AuthUser, @Query() q: RangeQuery) {
    return this.mobile.scheduleFor(user, q.from, q.to);
  }

  @Get('holidays')
  holidays(@CurrentUser() user: AuthUser, @Query() q: YearQuery) {
    return this.mobile.holidays(user, q.year);
  }

  @Post('punches')
  punch(@CurrentUser() user: AuthUser, @Body() dto: MobilePunchDto) {
    return this.remote.mobilePunch(user, dto);
  }

  @Get('leave/balances')
  balances(@CurrentUser() user: AuthUser, @Query() q: YearQuery) {
    return this.leave.balances(user, undefined, q.year);
  }

  /** Types I can apply for, with the rules the form needs. */
  @Get('leave/types')
  async leaveTypes(@CurrentUser() user: AuthUser) {
    const { balances } = await this.leave.balances(user, undefined);
    const types = await this.prisma.leaveType.findMany({ where: { tenantId: user.tenantId, active: true }, orderBy: { code: 'asc' } });
    return types.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      color: t.color,
      paid: t.paid,
      allowHalfDay: t.allowHalfDay,
      requiresAttachment: t.requiresAttachment,
      minNoticeDays: t.minNoticeDays,
      countsOffDays: t.countsOffDays,
      allowNegative: t.allowNegative,
      available: balances.find((b) => b.leaveType.id === t.id)?.available ?? 0,
    }));
  }

  @Get('leave/requests')
  leaveRequests(@CurrentUser() user: AuthUser, @Query() q: MobileLeaveListQuery) {
    return this.leave.list(user, q as LeaveListQuery, true);
  }

  @Post('leave/requests/preview')
  leavePreview(@CurrentUser() user: AuthUser, @Body() dto: LeaveRequestDto) {
    return this.leave.preview(user, { ...dto, employeeId: undefined });
  }

  @Post('leave/requests')
  applyLeave(@CurrentUser() user: AuthUser, @Body() dto: LeaveRequestDto) {
    return this.leave.create(user, { ...dto, employeeId: undefined });
  }

  @Post('leave/requests/:id/cancel')
  cancelLeave(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.leave.cancel(user, id, dto.note);
  }

  @Get('corrections')
  myCorrections(@CurrentUser() user: AuthUser, @Query() q: CursorQuery) {
    return this.corrections.list(user, q as RequestListQuery, true);
  }

  @Post('corrections')
  requestCorrection(@CurrentUser() user: AuthUser, @Body() dto: CreateCorrectionDto) {
    return this.corrections.create(user, { ...dto, employeeId: undefined });
  }

  @Get('remote-work')
  myRemote(@CurrentUser() user: AuthUser, @Query() q: CursorQuery) {
    return this.remote.list(user, q as RequestListQuery, true);
  }

  @Post('remote-work')
  requestRemote(@CurrentUser() user: AuthUser, @Body() dto: RemoteRequestDto) {
    return this.remote.create(user, dto);
  }

  /** Private bucket; type checked by magic bytes, 5 MB cap. Returns the key to attach. */
  @Post('uploads')
  async upload(@CurrentUser() user: AuthUser, @Body() dto: UploadDto) {
    const body = Buffer.from(dto.dataBase64, 'base64');
    if (body.byteLength > MAX_UPLOAD_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'At most 5 MB');
    if (!MAGIC[dto.contentType](body)) throw new AppError(400, 'FILE_TYPE_MISMATCH', `The file is not a valid ${dto.contentType}`);
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' }[dto.contentType];
    const key = `${user.tenantId}/${user.sub}/${randomUUID()}.${ext}`;
    await this.supabase.upload(BUCKETS.uploads(), key, body, dto.contentType);
    return { key, size: body.byteLength, contentType: dto.contentType };
  }

  // Manager

  @Get('team/live')
  @Roles('ADMIN', 'HR', 'MANAGER')
  async teamLive(@CurrentUser() user: AuthUser) {
    const board = await this.live.board(user, {});
    return {
      generatedAt: board.generatedAt,
      summary: board.summary,
      counts: board.counts,
      people: board.rows.map((r) => ({
        employeeId: r.employeeId,
        fullName: r.employee?.fullName,
        employeeCode: r.employee?.employeeCode,
        liveState: r.liveState,
        isLate: r.isLate,
        firstIn: r.local.firstIn,
        lastOut: r.local.lastOut,
        shiftStart: r.local.schedStart,
      })),
      offlineDevices: board.devices.filter((d) => !d.online).map((d) => ({ id: d.id, name: d.name, gateName: d.gateName })),
    };
  }

  @Get('team/attendance')
  @Roles('ADMIN', 'HR', 'MANAGER')
  teamAttendance(@CurrentUser() user: AuthUser, @Query() q: DateQuery) {
    return this.mobile.teamAttendance(user, q.date);
  }

  @Get('approvals')
  @Roles('ADMIN', 'HR', 'MANAGER')
  async approvals(@CurrentUser() user: AuthUser, @Query() q: ApprovalsQuery) {
    const base = { status: 'PENDING', cursor: q.cursor, limit: q.limit };
    const page =
      q.type === 'leave'
        ? await this.leave.list(user, { ...base, awaitingMe: true } as LeaveListQuery)
        : q.type === 'correction'
          ? await this.corrections.list(user, base as RequestListQuery)
          : await this.remote.list(user, base as RequestListQuery);
    // Never show someone their own request to decide.
    return { ...page, data: (page.data as Array<{ employeeId: string }>).filter((r) => r.employeeId !== user.employeeId) };
  }

  @Post('approvals/:type/:id/approve')
  @Roles('ADMIN', 'HR', 'MANAGER')
  approve(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id') id: string, @Body() dto: NoteDto) {
    if (type === 'leave') return this.leave.approve(user, id, dto.note);
    if (type === 'correction') return this.corrections.decide(user, id, true, dto.note);
    if (type === 'remote') return this.remote.decide(user, id, 'APPROVED', dto.note);
    throw new AppError(404, 'NOT_FOUND', 'Unknown approval type');
  }

  @Post('approvals/:type/:id/reject')
  @Roles('ADMIN', 'HR', 'MANAGER')
  reject(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id') id: string, @Body() dto: NoteDto) {
    const note = dto.note?.trim() || 'Rejected';
    if (type === 'leave') return this.leave.reject(user, id, note);
    if (type === 'correction') return this.corrections.decide(user, id, false, note);
    if (type === 'remote') return this.remote.decide(user, id, 'REJECTED', note);
    throw new AppError(404, 'NOT_FOUND', 'Unknown approval type');
  }
}

@Module({
  imports: [UsersModule, LeaveModule, AttendanceModule, RemoteModule, ScheduleModule],
  controllers: [MobileController],
  providers: [MobileService, IdempotencyInterceptor],
})
export class MobileModule {}

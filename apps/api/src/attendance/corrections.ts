import { Body, Controller, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { addDays, dbDate, localYmd, ymdOf, zonedInstant } from '../common/time';
import { IsYmd } from '../common/validators';
import { NotificationsService } from '../notifications/notifications';
import { PunchesService } from '../punches/punches';
import { scopedEmployees } from './attendance.controller';

/** 'HH:mm' (site-local on the date) or a full ISO instant. */
const TIME_OR_INSTANT = /^(([01]\d|2[0-3]):[0-5]\d|\d{4}-\d{2}-\d{2}T.+)$/;

export class CreateCorrectionDto {
  /** Omit for yourself. */
  @IsOptional() @IsString() employeeId?: string;
  @IsYmd() date: string;
  @IsOptional() @Matches(TIME_OR_INSTANT, { message: 'in must be HH:mm or an ISO datetime' }) in?: string;
  @IsOptional() @Matches(TIME_OR_INSTANT, { message: 'out must be HH:mm or an ISO datetime' }) out?: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class DecisionDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RejectDto {
  @IsString() @MinLength(3) @MaxLength(500) note: string;
}

export class RequestListQuery {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) status?: string;
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsYmd() from?: string;
  @IsOptional() @IsYmd() to?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/** Missed-punch fixes (§1: without it "absent" is unfixable). Approval adds CORRECTION punches; nothing is overwritten (D5). */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditableActionService,
    private readonly punches: PunchesService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(user: AuthUser, q: RequestListQuery, mineOnly = false) {
    const limit = q.limit ?? 50;
    const employee = mineOnly ? { id: user.employeeId ?? '__none__' } : await scopedEmployees(this.scope, user, q);
    const rows = await this.prisma.attendanceCorrection.findMany({
      where: {
        tenantId: user.tenantId,
        status: q.status,
        employee,
        workDate: q.from || q.to ? { gte: q.from ? dbDate(q.from) : undefined, lte: q.to ? dbDate(q.to) : undefined } : undefined,
      },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const data = rows.slice(0, limit).map((r) => ({ ...r, workDate: ymdOf(r.workDate) }));
    return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
  }

  async create(user: AuthUser, dto: CreateCorrectionDto) {
    const self = !dto.employeeId || dto.employeeId === user.employeeId;
    const employee = self ? await this.scope.self(user) : await this.scope.assertEmployee(user, dto.employeeId!);
    if (!self && user.role === 'EMPLOYEE') throw new AppError(403, 'FORBIDDEN', 'You can only correct your own attendance');
    if (!dto.in && !dto.out) throw new AppError(400, 'NOTHING_TO_CORRECT', 'Give an in time, an out time or both');
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: employee.siteId } });
    if (dto.date > localYmd(new Date(), site.timezone)) throw new AppError(400, 'FUTURE_DATE', 'Cannot correct a future day');

    const inAt = dto.in ? this.instant(dto.date, dto.in, site.timezone) : null;
    let outAt = dto.out ? this.instant(dto.date, dto.out, site.timezone) : null;
    // "out" earlier than "in" on the form means the next morning (night shift).
    if (inAt && outAt && outAt <= inAt && dto.out!.length === 5) outAt = this.instant(addDays(dto.date, 1), dto.out!, site.timezone);
    if (inAt && outAt && outAt <= inAt) throw new AppError(400, 'OUT_BEFORE_IN', 'Out must be after in');

    const correction = await this.audit.run({
      action: 'CORRECTION_REQUESTED',
      targetType: 'AttendanceCorrection',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: employee.id, date: dto.date, inAt, outAt, reason: dto.reason }),
      run: (tx) =>
        tx.attendanceCorrection.create({
          data: {
            tenantId: user.tenantId,
            employeeId: employee.id,
            workDate: dbDate(dto.date),
            inAt,
            outAt,
            reason: dto.reason,
            requestedBy: user.sub,
          },
        }),
    });
    // HR filing on someone's behalf decides it themselves; everyone else waits for an approver.
    if (!isHrOrAdmin(user) || self) {
      await this.notifications.approvalPending(user.tenantId, employee.id, 'correction', correction.id, employee.fullName);
    }
    return { ...correction, workDate: dto.date };
  }

  private instant(date: string, value: string, tz: string): Date {
    return value.length === 5 ? zonedInstant(date, value, tz) : new Date(value);
  }

  async decide(user: AuthUser, id: string, approve: boolean, note?: string) {
    const c = await this.prisma.attendanceCorrection.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Correction not found');
    if (c.status !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', `This correction is already ${c.status.toLowerCase()}`);
    const employee = await this.scope.assertApprover(user, c.employeeId);

    const updated = await this.audit.run({
      action: approve ? 'CORRECTION_APPROVED' : 'CORRECTION_REJECTED',
      targetType: 'AttendanceCorrection',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: c.employeeId, date: ymdOf(c.workDate), note: note ?? null }),
      run: async (tx) => {
        const res = await tx.attendanceCorrection.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: approve ? 'APPROVED' : 'REJECTED', approverId: user.sub, decidedAt: new Date(), decisionNote: note ?? null },
        });
        if (!res.count) throw new AppError(409, 'ALREADY_DECIDED', 'This correction was decided meanwhile');
        return tx.attendanceCorrection.findUniqueOrThrow({ where: { id } });
      },
    });

    if (approve) {
      for (const [at, direction] of [[c.inAt, 'in'], [c.outAt, 'out']] as const) {
        if (!at) continue;
        await this.punches.record(
          {
            tenantId: c.tenantId,
            siteId: employee.siteId,
            employeeId: c.employeeId,
            punchedAt: at,
            source: 'CORRECTION',
            direction,
            correctionId: c.id,
            reason: c.reason,
            createdBy: user.sub,
          },
          employee,
        );
      }
    }
    const requester = await this.notifications.userIdOfEmployee(c.employeeId);
    await this.notifications.notify(c.tenantId, [requester], {
      type: approve ? 'CORRECTION_APPROVED' : 'CORRECTION_REJECTED',
      title: `Correction ${approve ? 'approved' : 'rejected'}`,
      body: `Your correction for ${ymdOf(c.workDate)} was ${approve ? 'approved' : 'rejected'}${note ? `: ${note}` : ''}`,
      data: { id: c.id, date: ymdOf(c.workDate) },
    });
    return { ...updated, workDate: ymdOf(updated.workDate) };
  }

  async cancel(user: AuthUser, id: string) {
    const c = await this.prisma.attendanceCorrection.findFirst({ where: { id, tenantId: user.tenantId, employeeId: user.employeeId ?? '__none__' } });
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Correction not found');
    if (c.status !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', 'Only pending corrections can be cancelled');
    return this.audit.run({
      action: 'CORRECTION_CANCELLED',
      targetType: 'AttendanceCorrection',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      run: (tx) => tx.attendanceCorrection.update({ where: { id }, data: { status: 'CANCELLED', decidedAt: new Date() } }),
    });
  }
}

@ApiTags('attendance')
@Controller('attendance/corrections')
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: RequestListQuery) {
    return this.corrections.list(user, q);
  }

  /** Create for yourself, or on behalf of someone in your scope. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCorrectionDto) {
    return this.corrections.create(user, dto);
  }

  @Post(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.corrections.decide(user, id, true, dto.note);
  }

  @Post(':id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.corrections.decide(user, id, false, dto.note);
  }
}


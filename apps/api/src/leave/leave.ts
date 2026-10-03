import { Body, Controller, Delete, Get, Injectable, Logger, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Employee, LeaveRequest, LeaveType, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsHexColor, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { resolveDay } from '../attendance/engine/schedule';
import { RecomputeQueue } from '../attendance/recompute.service';
import { RosterService } from '../attendance/roster.service';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { BUCKETS, SupabaseService } from '../common/supabase.service';
import { addDays, dbDate, diffDays, leaveYearOf, leaveYearRange, localYmd, monthRange, Ymd, ymdOf } from '../common/time';
import { IsYmd } from '../common/validators';
import { NotificationsService } from '../notifications/notifications';
import { carryForwardOf, Half, leaveDays } from './leave-days';

// ── DTOs ────────────────────────────────────────────────────────────────────

export class LeaveTypeDto {
  @Matches(/^[A-Z0-9_]{1,12}$/, { message: 'code must be 1–12 uppercase letters/digits' }) code: string;
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @IsHexColor() color?: string;
  @IsOptional() @IsBoolean() paid?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() allowHalfDay?: boolean;
  @IsOptional() @IsIn(['NONE', 'MONTHLY', 'YEARLY_UPFRONT']) accrualKind?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(366) accrualAmount?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(999) maxBalance?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(999) carryForwardMax?: number | null;
  @IsOptional() @IsBoolean() allowNegative?: boolean;
  @IsOptional() @IsBoolean() requiresAttachment?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) minNoticeDays?: number;
  @IsOptional() @IsBoolean() countsOffDays?: boolean;
  @IsOptional() @IsBoolean() requiresHrApproval?: boolean;
}

export class LeaveRequestDto {
  /** Omit for yourself; HR files on behalf. */
  @IsOptional() @IsString() employeeId?: string;
  @IsString() leaveTypeId: string;
  @IsYmd() from: string;
  @IsYmd() to: string;
  @IsOptional() @IsIn(['FIRST', 'SECOND']) startHalf?: Half;
  @IsOptional() @IsIn(['FIRST', 'SECOND']) endHalf?: Half;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
  /** Key from POST /v1/mobile/uploads. */
  @IsOptional() @IsString() @MaxLength(300) attachmentKey?: string;
}

export class LeaveListQuery {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) status?: string;
  @IsOptional() @IsString() leaveTypeId?: string;
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsYmd() from?: string;
  @IsOptional() @IsYmd() to?: string;
  /** Requests waiting for *my* decision. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() awaitingMe?: boolean;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class BalanceQuery {
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
}

export class LedgerQuery extends BalanceQuery {
  @IsOptional() @IsString() leaveTypeId?: string;
}

export class AdjustmentDto {
  @IsString() employeeId: string;
  @IsString() leaveTypeId: string;
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 1 }) @Min(-366) @Max(366) delta: number;
  @IsOptional() @IsIn(['ADJUSTMENT', 'OPENING']) kind?: 'ADJUSTMENT' | 'OPENING';
  @IsString() @MinLength(3) @MaxLength(500) note: string;
}

export class CompOffDto {
  @IsString() employeeId: string;
  @IsYmd() date: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class NoteDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RequiredNoteDto {
  @IsString() @MinLength(3) @MaxLength(500) note: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;

@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly roster: RosterService,
    private readonly recompute: RecomputeQueue,
    private readonly audit: AuditableActionService,
    private readonly notifications: NotificationsService,
  ) {}

  presentRequest(r: LeaveRequest & Record<string, any>) {
    return { ...r, startDate: ymdOf(r.startDate), endDate: ymdOf(r.endDate), days: Number(r.days) };
  }

  /** Days are always computed server-side through the schedule resolver (§8.2). */
  async countDays(employee: Employee, type: LeaveType, from: Ymd, to: Ymd, startHalf: Half | null, endHalf: Half | null) {
    if (diffDays(from, to) > 366) throw new AppError(400, 'RANGE_TOO_LARGE', 'A leave request can span at most a year');
    const tr = await this.roster.tenantRoster(employee.tenantId, from, to);
    const roster = (await this.roster.employeeRosters(tr, [employee], from, to)).get(employee.id)!;
    return leaveDays(from, to, startHalf, endHalf, (d) => resolveDay(roster, d).dayType === 'WORKING', type.countsOffDays);
  }

  /** Balance per leave year from the ledger; `available` also subtracts pending requests. */
  async balance(employeeId: string, leaveTypeId: string, year: number) {
    const [sum, pending] = await Promise.all([
      this.prisma.leaveLedger.aggregate({ where: { employeeId, leaveTypeId, leaveYear: year }, _sum: { delta: true } }),
      this.prisma.leaveRequest.findMany({ where: { employeeId, leaveTypeId, status: 'PENDING' }, select: { startDate: true, days: true } }),
    ]);
    const balance = Number(sum._sum.delta ?? 0);
    const pend = pending.filter((p) => leaveYearOf(ymdOf(p.startDate)) === year).reduce((s, p) => s + Number(p.days), 0);
    return { balance: round1(balance), pending: round1(pend), available: round1(balance - pend) };
  }

  private normaliseHalves(dto: { from: string; to: string; startHalf?: Half; endHalf?: Half }) {
    if (dto.to < dto.from) throw new AppError(400, 'BAD_RANGE', 'to is before from');
    if (dto.from === dto.to) return { startHalf: dto.startHalf ?? null, endHalf: dto.startHalf ?? null };
    if (dto.startHalf && dto.startHalf !== 'SECOND') throw new AppError(400, 'BAD_HALF', 'A multi-day leave can only start in the SECOND half');
    if (dto.endHalf && dto.endHalf !== 'FIRST') throw new AppError(400, 'BAD_HALF', 'A multi-day leave can only end after the FIRST half');
    return { startHalf: dto.startHalf ?? null, endHalf: dto.endHalf ?? null };
  }

  /** Everything the apply form needs to show before submitting. Throws only for impossible input. */
  async preview(user: AuthUser, dto: LeaveRequestDto) {
    const employee = !dto.employeeId || dto.employeeId === user.employeeId ? await this.scope.self(user) : await this.scope.assertEmployee(user, dto.employeeId);
    const type = await this.prisma.leaveType.findFirst({ where: { id: dto.leaveTypeId, tenantId: user.tenantId } });
    if (!type || !type.active) throw new AppError(400, 'LEAVE_TYPE_UNAVAILABLE', 'This leave type is not available');
    const { startHalf, endHalf } = this.normaliseHalves(dto);
    if ((startHalf || endHalf) && !type.allowHalfDay) throw new AppError(400, 'NO_HALF_DAY', `${type.name} cannot be taken as half days`);

    const days = await this.countDays(employee, type, dto.from, dto.to, startHalf, endHalf);
    const warnings: string[] = [];
    const errors: string[] = [];
    const tz = (await this.prisma.site.findUnique({ where: { id: employee.siteId } }))?.timezone ?? 'UTC';
    const today = localYmd(new Date(), tz);
    if (days.total === 0) errors.push('NO_WORKING_DAYS');
    if (type.minNoticeDays && diffDays(today, dto.from) < type.minNoticeDays) {
      (isHrOrAdmin(user) && dto.employeeId ? warnings : errors).push(`MIN_NOTICE_${type.minNoticeDays}_DAYS`);
    }
    if (type.requiresAttachment && !dto.attachmentKey) errors.push('ATTACHMENT_REQUIRED');
    // Only your own uploads can be attached.
    if (dto.attachmentKey && !dto.attachmentKey.startsWith(`${user.tenantId}/${user.sub}/`)) errors.push('BAD_ATTACHMENT');
    if (dto.from < today) warnings.push('PAST_DATES');

    const balances = [];
    for (const [year, needed] of days.byYear) {
      const b = await this.balance(employee.id, type.id, year);
      const after = round1(b.available - needed);
      if (after < 0 && !type.allowNegative) errors.push(`INSUFFICIENT_BALANCE_${year}`);
      balances.push({ leaveYear: year, ...b, requested: needed, availableAfter: after });
    }
    const overlap = await this.prisma.leaveRequest.findFirst({
      where: { employeeId: employee.id, status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: dbDate(dto.to) }, endDate: { gte: dbDate(dto.from) } },
    });
    if (overlap) errors.push('OVERLAPS_EXISTING_REQUEST');

    return {
      employeeId: employee.id,
      leaveType: { id: type.id, code: type.code, name: type.name },
      from: dto.from,
      to: dto.to,
      startHalf,
      endHalf,
      days: days.total,
      perDay: days.perDay,
      balances,
      warnings,
      errors,
      canSubmit: errors.length === 0,
    };
  }

  async create(user: AuthUser, dto: LeaveRequestDto) {
    const p = await this.preview(user, dto);
    if (!p.canSubmit) throw new AppError(400, p.errors[0], 'This leave request cannot be submitted', p.errors);
    const employee = await this.prisma.employee.findUniqueOrThrow({ where: { id: p.employeeId } });
    const request = await this.audit.run({
      action: 'LEAVE_REQUESTED',
      targetType: 'LeaveRequest',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: employee.id, leaveTypeId: dto.leaveTypeId, from: dto.from, to: dto.to, days: p.days }),
      run: (tx) =>
        tx.leaveRequest.create({
          data: {
            tenantId: user.tenantId,
            employeeId: employee.id,
            leaveTypeId: dto.leaveTypeId,
            startDate: dbDate(dto.from),
            endDate: dbDate(dto.to),
            startHalf: p.startHalf,
            endHalf: p.endHalf,
            days: p.days,
            reason: dto.reason,
            attachmentKey: dto.attachmentKey,
            createdBy: user.sub,
          },
        }),
    });
    await this.notifications.approvalPending(user.tenantId, employee.id, 'leave', request.id, employee.fullName);
    return this.presentRequest(request);
  }

  async list(user: AuthUser, q: LeaveListQuery, mineOnly = false) {
    const limit = q.limit ?? 50;
    const employeeWhere: Prisma.EmployeeWhereInput = mineOnly
      ? { id: user.employeeId ?? '__none__' }
      : {
          AND: [
            await this.scope.employeeWhere(user),
            q.employeeId ? { id: q.employeeId } : {},
            q.departmentId ? { departmentId: q.departmentId } : {},
            // A manager's queue excludes requests already passed on to HR.
            q.awaitingMe && user.role === 'MANAGER' ? { id: { not: user.employeeId ?? '' } } : {},
          ],
        };
    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        tenantId: user.tenantId,
        status: q.awaitingMe ? 'PENDING' : q.status,
        leaveTypeId: q.leaveTypeId,
        employee: employeeWhere,
        ...(q.awaitingMe && user.role === 'MANAGER' ? { managerApproverId: null } : {}),
        ...(q.from ? { endDate: { gte: dbDate(q.from) } } : {}),
        ...(q.to ? { startDate: { lte: dbDate(q.to) } } : {}),
      },
      include: { leaveType: { select: { id: true, code: true, name: true, color: true } }, employee: { select: { id: true, fullName: true, employeeCode: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const data = rows.slice(0, limit).map((r) => this.presentRequest(r));
    return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
  }

  /**
   * Two levels, no workflow engine (§8.2): the manager approves; if the type
   * requires HR, HR approves after. HR/Admin approval is always final.
   */
  async approve(user: AuthUser, id: string, note?: string) {
    const r = await this.prisma.leaveRequest.findFirst({ where: { id, tenantId: user.tenantId }, include: { leaveType: true, employee: true } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Leave request not found');
    if (r.status !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', `This request is already ${r.status.toLowerCase()}`);
    await this.scope.assertApprover(user, r.employeeId);

    if (!isHrOrAdmin(user) && r.leaveType.requiresHrApproval) {
      if (r.managerApproverId) throw new AppError(409, 'AWAITING_HR', 'Already approved by a manager; waiting for HR');
      await this.audit.run({
        action: 'LEAVE_MANAGER_APPROVED',
        targetType: 'LeaveRequest',
        targetId: id,
        actor: actorOf(user),
        tenantId: user.tenantId,
        payloadFrom: () => ({ note: note ?? null }),
        run: (tx) => tx.leaveRequest.update({ where: { id }, data: { managerApproverId: user.sub, managerDecidedAt: new Date(), decisionNote: note } }),
      });
      await this.notifications.approvalPending(user.tenantId, r.employeeId, 'leave', id, r.employee.fullName, true);
      return this.presentRequest(await this.prisma.leaveRequest.findUniqueOrThrow({ where: { id } }));
    }

    // Balance is re-checked at approval: other requests may have been approved meanwhile.
    const counted = await this.countDays(r.employee, r.leaveType, ymdOf(r.startDate), ymdOf(r.endDate), r.startHalf as Half, r.endHalf as Half);
    if (!r.leaveType.allowNegative) {
      for (const [year, needed] of counted.byYear) {
        const b = await this.balance(r.employeeId, r.leaveTypeId, year);
        // `available` already subtracts this pending request.
        if (b.balance - needed < 0) throw new AppError(409, 'INSUFFICIENT_BALANCE', `Not enough ${r.leaveType.code} balance for ${year}`);
      }
    }

    const approved = await this.audit.run({
      action: 'LEAVE_APPROVED',
      targetType: 'LeaveRequest',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ days: counted.total, note: note ?? null }),
      run: async (tx) => {
        const res = await tx.leaveRequest.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'APPROVED', approverId: user.sub, decidedAt: new Date(), decisionNote: note ?? r.decisionNote, days: counted.total },
        });
        if (!res.count) throw new AppError(409, 'ALREADY_DECIDED', 'This request was decided meanwhile');
        // One DEBIT per leave year (a request across 31 March debits both).
        for (const [year, days] of counted.byYear) {
          await tx.leaveLedger.create({
            data: { tenantId: r.tenantId, employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, leaveYear: year, delta: -days, kind: 'DEBIT', requestId: id, createdBy: user.sub },
          });
        }
        return tx.leaveRequest.findUniqueOrThrow({ where: { id } });
      },
    });
    await this.recompute.range(r.employeeId, ymdOf(r.startDate), ymdOf(r.endDate));
    await this.notifyDecision(r, 'approved', note);
    return this.presentRequest(approved);
  }

  async reject(user: AuthUser, id: string, note: string) {
    const r = await this.prisma.leaveRequest.findFirst({ where: { id, tenantId: user.tenantId }, include: { leaveType: true, employee: true } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Leave request not found');
    if (r.status !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', `This request is already ${r.status.toLowerCase()}`);
    await this.scope.assertApprover(user, r.employeeId);
    const rejected = await this.audit.run({
      action: 'LEAVE_REJECTED',
      targetType: 'LeaveRequest',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ note }),
      run: (tx) => tx.leaveRequest.update({ where: { id }, data: { status: 'REJECTED', approverId: user.sub, decidedAt: new Date(), decisionNote: note } }),
    });
    await this.notifyDecision(r, 'rejected', note);
    return this.presentRequest(rejected);
  }

  /** Pending: the employee or HR. Approved: HR any time, the employee only before it starts. */
  async cancel(user: AuthUser, id: string, note?: string) {
    const r = await this.prisma.leaveRequest.findFirst({ where: { id, tenantId: user.tenantId }, include: { employee: { include: { site: true } }, leaveType: true } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Leave request not found');
    const own = r.employeeId === user.employeeId;
    if (!own) await this.scope.assertApprover(user, r.employeeId);
    if (!['PENDING', 'APPROVED'].includes(r.status)) throw new AppError(409, 'NOT_CANCELLABLE', `This request is ${r.status.toLowerCase()}`);
    if (r.status === 'APPROVED' && own && !isHrOrAdmin(user) && ymdOf(r.startDate) <= localYmd(new Date(), r.employee.site.timezone)) {
      throw new AppError(409, 'ALREADY_STARTED', 'Ask HR to cancel a leave that has already started');
    }
    const wasApproved = r.status === 'APPROVED';
    const cancelled = await this.audit.run({
      action: 'LEAVE_CANCELLED',
      targetType: 'LeaveRequest',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ wasApproved, note: note ?? null }),
      run: async (tx) => {
        if (wasApproved) {
          const debits = await tx.leaveLedger.findMany({ where: { requestId: id, kind: 'DEBIT' } });
          for (const d of debits) {
            await tx.leaveLedger.create({
              data: { tenantId: d.tenantId, employeeId: d.employeeId, leaveTypeId: d.leaveTypeId, leaveYear: d.leaveYear, delta: d.delta.negated(), kind: 'REVERSAL', requestId: id, createdBy: user.sub },
            });
          }
        }
        return tx.leaveRequest.update({ where: { id }, data: { status: 'CANCELLED', decidedAt: new Date(), decisionNote: note ?? r.decisionNote } });
      },
    });
    if (wasApproved) await this.recompute.range(r.employeeId, ymdOf(r.startDate), ymdOf(r.endDate));
    if (!own) await this.notifyDecision(r, 'cancelled', note);
    return this.presentRequest(cancelled);
  }

  private async notifyDecision(r: LeaveRequest & { employee: Employee }, verb: string, note?: string) {
    await this.notifications.notify(r.tenantId, [r.employee.userId], {
      type: `LEAVE_${verb.toUpperCase()}`,
      title: `Leave ${verb}`,
      body: `Your leave ${ymdOf(r.startDate)} – ${ymdOf(r.endDate)} was ${verb}${note ? `: ${note}` : ''}`,
      data: { id: r.id },
    });
  }

  async balances(user: AuthUser, employeeId: string | undefined, year?: number) {
    const employee = !employeeId || employeeId === user.employeeId ? await this.scope.self(user) : await this.scope.assertEmployee(user, employeeId);
    const site = await this.prisma.site.findUnique({ where: { id: employee.siteId } });
    const y = year ?? leaveYearOf(localYmd(new Date(), site?.timezone ?? 'UTC'));
    const [types, ledger, pending] = await Promise.all([
      this.prisma.leaveType.findMany({ where: { tenantId: user.tenantId }, orderBy: { code: 'asc' } }),
      // periodKey splits CARRY_FORWARD into what came in (CF-IN) and what moved on at year end (CF-OUT).
      this.prisma.leaveLedger.groupBy({ by: ['leaveTypeId', 'kind', 'periodKey'], where: { employeeId: employee.id, leaveYear: y }, _sum: { delta: true } }),
      this.prisma.leaveRequest.findMany({ where: { employeeId: employee.id, status: 'PENDING' }, select: { leaveTypeId: true, startDate: true, days: true } }),
    ]);
    const sum = (typeId: string, kinds: string[], periodPrefix = '') =>
      round1(ledger.filter((l) => l.leaveTypeId === typeId && kinds.includes(l.kind) && (l.periodKey ?? '').startsWith(periodPrefix)).reduce((s, l) => s + Number(l._sum.delta ?? 0), 0));
    return {
      employeeId: employee.id,
      leaveYear: y,
      period: leaveYearRange(y),
      balances: types
        .filter((t) => t.active || ledger.some((l) => l.leaveTypeId === t.id))
        .map((t) => {
          const balance = sum(t.id, ['OPENING', 'ACCRUAL', 'DEBIT', 'REVERSAL', 'ADJUSTMENT', 'CARRY_FORWARD', 'LAPSE', 'COMP_CREDIT']);
          const pend = round1(pending.filter((p) => p.leaveTypeId === t.id && leaveYearOf(ymdOf(p.startDate)) === y).reduce((s, p) => s + Number(p.days), 0));
          return {
            leaveType: { id: t.id, code: t.code, name: t.name, color: t.color, paid: t.paid },
            opening: sum(t.id, ['OPENING']),
            carriedForward: sum(t.id, ['CARRY_FORWARD']),
            carriedIn: sum(t.id, ['CARRY_FORWARD'], 'CF-IN:'),
            carriedOut: -sum(t.id, ['CARRY_FORWARD'], 'CF-OUT:'),
            accrued: sum(t.id, ['ACCRUAL', 'COMP_CREDIT']),
            used: -sum(t.id, ['DEBIT', 'REVERSAL']),
            adjusted: sum(t.id, ['ADJUSTMENT']),
            lapsed: -sum(t.id, ['LAPSE']),
            balance,
            pending: pend,
            available: round1(balance - pend),
          };
        }),
    };
  }

  async ledger(user: AuthUser, q: LedgerQuery) {
    const employee = !q.employeeId || q.employeeId === user.employeeId ? await this.scope.self(user) : await this.scope.assertEmployee(user, q.employeeId);
    return this.prisma.leaveLedger.findMany({
      where: { employeeId: employee.id, leaveTypeId: q.leaveTypeId, leaveYear: q.year },
      orderBy: { createdAt: 'asc' },
    });
  }

  async adjust(user: AuthUser, dto: AdjustmentDto) {
    await this.scope.assertEmployee(user, dto.employeeId);
    await this.prisma.leaveType.findFirstOrThrow({ where: { id: dto.leaveTypeId, tenantId: user.tenantId } });
    return this.audit.run({
      action: 'LEAVE_ADJUSTED',
      targetType: 'LeaveLedger',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) =>
        tx.leaveLedger.create({
          data: {
            tenantId: user.tenantId,
            employeeId: dto.employeeId,
            leaveTypeId: dto.leaveTypeId,
            leaveYear: dto.year,
            delta: dto.delta,
            kind: dto.kind ?? 'ADJUSTMENT',
            note: dto.note,
            createdBy: user.sub,
            ...(dto.kind === 'OPENING' ? { periodKey: `OPENING:${dto.year}` } : {}),
          },
        }),
    });
  }

  /** Comp-off (§8.2): a finalised off-day worked for ≥ half a day earns 0.5 or 1 day of COMP. */
  async compOff(user: AuthUser, dto: CompOffDto) {
    await this.scope.assertEmployee(user, dto.employeeId);
    const type = await this.prisma.leaveType.findFirst({ where: { tenantId: user.tenantId, code: 'COMP' } });
    if (!type) throw new AppError(400, 'NO_COMP_TYPE', 'Create a leave type with code COMP first');
    const day = await this.prisma.attendanceDay.findUnique({ where: { employeeId_workDate: { employeeId: dto.employeeId, workDate: dbDate(dto.date) } } });
    if (!day?.finalizedAt || !day.workedOnOffDay) throw new AppError(409, 'NOT_ELIGIBLE', 'Only a finalised day worked on an off day earns comp-off');
    const policy = day.policy as Record<string, number>;
    const shiftMinutes = 480; // an off day has no shift; judge against a standard day
    const credit = day.workedMinutes >= (shiftMinutes * policy.fullDayMinPercent) / 100 ? 1 : day.workedMinutes >= (shiftMinutes * policy.halfDayMinPercent) / 100 ? 0.5 : 0;
    if (!credit) throw new AppError(409, 'NOT_ELIGIBLE', 'Worked less than half a day');
    return this.audit.run({
      action: 'LEAVE_COMP_CREDIT',
      targetType: 'LeaveLedger',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto, credit }),
      run: (tx) =>
        tx.leaveLedger.create({
          data: {
            tenantId: user.tenantId,
            employeeId: dto.employeeId,
            leaveTypeId: type.id,
            leaveYear: leaveYearOf(dto.date),
            delta: credit,
            kind: 'COMP_CREDIT',
            periodKey: `COMP:${dto.date}`,
            note: dto.note,
            createdBy: user.sub,
          },
        }),
    });
  }

  // ── Jobs (idempotent: ledger rows carry a unique periodKey) ────────────────

  /**
   * Hourly. For every active tenant, in the tenant's timezone: ensure monthly
   * accruals for each month of the current leave year so far (so a month missed
   * while suspended is caught up), yearly-upfront credits, and the year-end
   * carry-forward/lapse of the previous leave year (§8.2, §13.1).
   */
  async runAccruals(): Promise<void> {
    await runAsSystem(async () => {
      const tenants = await this.prisma.tenant.findMany({ where: { status: 'ACTIVE' } });
      for (const t of tenants) {
        try {
          await this.accrueTenant(t.id, ((t.settings as any)?.timezone as string) || 'Asia/Kolkata');
        } catch (err) {
          this.logger.error(`Accrual for tenant ${t.id} failed: ${(err as Error).message}`);
        }
      }
    });
  }

  private async accrueTenant(tenantId: string, tz: string) {
    const today = localYmd(new Date(), tz);
    const year = leaveYearOf(today);
    const { from: yearStart } = leaveYearRange(year);
    const [types, employees] = await Promise.all([
      this.prisma.leaveType.findMany({ where: { tenantId, active: true } }),
      this.prisma.employee.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { id: true, joinedOn: true } }),
    ]);
    // Close last year first, so this year's max-balance cap already sees what was carried in.
    await this.closeYear(tenantId, year - 1, types);
    const months: string[] = [];
    for (let m = yearStart.slice(0, 7); `${m}-01` <= today; m = addDays(monthRange(m).to, 1).slice(0, 7)) months.push(m);

    const rows: Prisma.LeaveLedgerCreateManyInput[] = [];
    for (const type of types) {
      const amount = Number(type.accrualAmount);
      if (type.accrualKind === 'NONE' || amount <= 0) continue;
      for (const e of employees) {
        const joined = ymdOf(e.joinedOn);
        const periods =
          type.accrualKind === 'MONTHLY'
            ? months.filter((m) => joined <= monthRange(m).to).map((m) => `ACCRUAL:${m}`)
            : joined <= today
              ? [`ACCRUAL:Y${year}`]
              : [];
        for (const periodKey of periods) {
          rows.push({ tenantId, employeeId: e.id, leaveTypeId: type.id, leaveYear: year, delta: amount, kind: 'ACCRUAL', periodKey });
        }
      }
    }
    if (rows.length) {
      // Cap by max_balance per employee/type, then insert whatever is new.
      const existing = await this.prisma.leaveLedger.findMany({
        where: { tenantId, leaveYear: year, periodKey: { startsWith: 'ACCRUAL:' } },
        select: { employeeId: true, leaveTypeId: true, periodKey: true },
      });
      const have = new Set(existing.map((x) => `${x.employeeId}:${x.leaveTypeId}:${x.periodKey}`));
      const fresh = rows.filter((r) => !have.has(`${r.employeeId}:${r.leaveTypeId}:${r.periodKey}`));
      for (const r of fresh) {
        const type = types.find((t) => t.id === r.leaveTypeId)!;
        if (type.maxBalance !== null) {
          const { balance } = await this.balance(r.employeeId, r.leaveTypeId, year);
          const room = Number(type.maxBalance) - balance;
          r.delta = Math.max(0, Math.min(Number(r.delta), room));
          r.note = Number(r.delta) < Number(type.accrualAmount) ? 'capped at max balance' : undefined;
        }
      }
      if (fresh.length) await this.prisma.leaveLedger.createMany({ data: fresh, skipDuplicates: true });
    }
  }

  /** Year end: CARRY_FORWARD up to cap into the new year, LAPSE the rest. */
  private async closeYear(tenantId: string, closing: number, types: LeaveType[]) {
    const balances = await this.prisma.leaveLedger.groupBy({
      by: ['employeeId', 'leaveTypeId'],
      where: { tenantId, leaveYear: closing },
      _sum: { delta: true },
    });
    const done = new Set(
      (await this.prisma.leaveLedger.findMany({ where: { tenantId, leaveYear: closing, periodKey: `LAPSE:${closing}` }, select: { employeeId: true, leaveTypeId: true } })).map(
        (r) => `${r.employeeId}:${r.leaveTypeId}`,
      ),
    );
    const rows: Prisma.LeaveLedgerCreateManyInput[] = [];
    for (const b of balances) {
      const type = types.find((t) => t.id === b.leaveTypeId);
      const balance = Number(b._sum.delta ?? 0);
      if (!type || balance <= 0 || done.has(`${b.employeeId}:${b.leaveTypeId}`)) continue;
      const { carried: cf, lapsed } = carryForwardOf(balance, type.carryForwardMax === null ? null : Number(type.carryForwardMax));
      const base = { tenantId, employeeId: b.employeeId, leaveTypeId: b.leaveTypeId };
      if (cf > 0) {
        rows.push({ ...base, leaveYear: closing, delta: -cf, kind: 'CARRY_FORWARD', periodKey: `CF-OUT:${closing}`, note: `carried to ${closing + 1}` });
        rows.push({ ...base, leaveYear: closing + 1, delta: cf, kind: 'CARRY_FORWARD', periodKey: `CF-IN:${closing + 1}`, note: `from ${closing}` });
      }
      // Written even at 0: the LAPSE row marks this employee/type as closed for the year.
      rows.push({ ...base, leaveYear: closing, delta: -lapsed, kind: 'LAPSE', periodKey: `LAPSE:${closing}` });
    }
    if (rows.length) await this.prisma.leaveLedger.createMany({ data: rows, skipDuplicates: true });
  }
}

// ── Controllers ─────────────────────────────────────────────────────────────

@ApiTags('leave')
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leave: LeaveService,
    private readonly audit: AuditableActionService,
    private readonly scope: ScopeService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get('types')
  types(@CurrentUser() user: AuthUser) {
    return this.prisma.leaveType.findMany({ where: { tenantId: user.tenantId }, orderBy: { code: 'asc' } });
  }

  @Post('types')
  @Roles('ADMIN', 'HR')
  createType(@CurrentUser() user: AuthUser, @Body() dto: LeaveTypeDto) {
    return this.audit.run({
      action: 'LEAVE_TYPE_CREATED',
      targetType: 'LeaveType',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => tx.leaveType.create({ data: { ...dto, tenantId: user.tenantId } }),
    });
  }

  @Patch('types/:id')
  @Roles('ADMIN', 'HR')
  async updateType(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: LeaveTypeDto) {
    await this.prisma.leaveType.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    return this.audit.run({
      action: 'LEAVE_TYPE_UPDATED',
      targetType: 'LeaveType',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => tx.leaveType.update({ where: { id }, data: dto }),
    });
  }

  /** Deactivates; the ledger keeps referring to it. */
  @Delete('types/:id')
  @Roles('ADMIN', 'HR')
  async deleteType(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.leaveType.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
    return this.audit.run({
      action: 'LEAVE_TYPE_DEACTIVATED',
      targetType: 'LeaveType',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      run: (tx) => tx.leaveType.update({ where: { id }, data: { active: false } }),
    });
  }

  @Get('requests')
  list(@CurrentUser() user: AuthUser, @Query() q: LeaveListQuery) {
    return this.leave.list(user, q);
  }

  @Post('requests/preview')
  preview(@CurrentUser() user: AuthUser, @Body() dto: LeaveRequestDto) {
    return this.leave.preview(user, dto);
  }

  /** For yourself, or HR on behalf. */
  @Post('requests')
  create(@CurrentUser() user: AuthUser, @Body() dto: LeaveRequestDto) {
    if (dto.employeeId && dto.employeeId !== user.employeeId && !isHrOrAdmin(user)) {
      throw new AppError(403, 'FORBIDDEN', 'Only HR files leave on behalf of others');
    }
    return this.leave.create(user, dto);
  }

  /** 5-minute signed URL for the request's attachment. */
  @Get('requests/:id/attachment')
  async attachment(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const r = await this.prisma.leaveRequest.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!r?.attachmentKey) throw new AppError(404, 'NOT_FOUND', 'No attachment');
    if (r.employeeId !== user.employeeId) await this.scope.assertEmployee(user, r.employeeId);
    return { url: await this.supabase.signedUrl(BUCKETS.uploads(), r.attachmentKey, 300), expiresInSeconds: 300 };
  }

  @Post('requests/:id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.leave.approve(user, id, dto.note);
  }

  @Post('requests/:id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RequiredNoteDto) {
    return this.leave.reject(user, id, dto.note);
  }

  @Post('requests/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.leave.cancel(user, id, dto.note);
  }

  @Get('balances')
  balances(@CurrentUser() user: AuthUser, @Query() q: BalanceQuery) {
    return this.leave.balances(user, q.employeeId, q.year);
  }

  @Get('ledger')
  ledger(@CurrentUser() user: AuthUser, @Query() q: LedgerQuery) {
    return this.leave.ledger(user, q);
  }

  @Post('adjustments')
  @Roles('ADMIN', 'HR')
  adjust(@CurrentUser() user: AuthUser, @Body() dto: AdjustmentDto) {
    return this.leave.adjust(user, dto);
  }

  @Post('comp-off')
  @Roles('ADMIN', 'HR')
  compOff(@CurrentUser() user: AuthUser, @Body() dto: CompOffDto) {
    return this.leave.compOff(user, dto);
  }
}

@Module({
  controllers: [LeaveController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule {}

import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RemoteWorkRequest } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { RecomputeQueue } from '../attendance/recompute.service';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { dbDate, diffDays, localYmd, ymdOf } from '../common/time';
import { IsYmd } from '../common/validators';
import { NoteDto, RequiredNoteDto } from '../leave/leave';
import { NotificationsService } from '../notifications/notifications';
import { PunchesModule, PunchesService } from '../punches/punches';
import { RequestListQuery } from '../attendance/corrections';

export class RemoteRequestDto {
  @IsYmd() from: string;
  @IsYmd() to: string;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class MobilePunchDto {
  @IsIn(['in', 'out']) direction: 'in' | 'out';
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
  @Type(() => Number) @IsNumber() @Min(0) accuracy: number;
  @IsOptional() @IsBoolean() isMockLocation?: boolean;
  /** The device's clock, for audit only — the server time is authoritative (§9). */
  @IsOptional() @IsString() @MaxLength(40) clientTime?: string;
}

/** Remote work (§9): same approval path as leave, same no-overlap constraint, plus field/remote punches. */
@Injectable()
export class RemoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditableActionService,
    private readonly recompute: RecomputeQueue,
    private readonly notifications: NotificationsService,
    private readonly punches: PunchesService,
  ) {}

  present(r: RemoteWorkRequest & Record<string, any>) {
    return { ...r, startDate: ymdOf(r.startDate), endDate: ymdOf(r.endDate) };
  }

  async list(user: AuthUser, q: RequestListQuery, mineOnly = false) {
    const limit = q.limit ?? 50;
    const employee = mineOnly
      ? { id: user.employeeId ?? '__none__' }
      : { AND: [await this.scope.employeeWhere(user), q.employeeId ? { id: q.employeeId } : {}, q.departmentId ? { departmentId: q.departmentId } : {}] };
    const rows = await this.prisma.remoteWorkRequest.findMany({
      where: {
        tenantId: user.tenantId,
        status: q.status,
        employee,
        ...(q.from ? { endDate: { gte: dbDate(q.from) } } : {}),
        ...(q.to ? { startDate: { lte: dbDate(q.to) } } : {}),
      },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const data = rows.slice(0, limit).map((r) => this.present(r));
    return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
  }

  async create(user: AuthUser, dto: RemoteRequestDto) {
    const employee = await this.scope.self(user);
    if (dto.to < dto.from) throw new AppError(400, 'BAD_RANGE', 'to is before from');
    if (diffDays(dto.from, dto.to) > 92) throw new AppError(400, 'RANGE_TOO_LARGE', 'At most 93 days per request');
    const r = await this.audit.run({
      action: 'REMOTE_REQUESTED',
      targetType: 'RemoteWorkRequest',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) =>
        tx.remoteWorkRequest.create({
          data: { tenantId: user.tenantId, employeeId: employee.id, startDate: dbDate(dto.from), endDate: dbDate(dto.to), reason: dto.reason, createdBy: user.sub },
        }),
    });
    await this.notifications.approvalPending(user.tenantId, employee.id, 'remote', r.id, employee.fullName);
    return this.present(r);
  }

  async decide(user: AuthUser, id: string, verdict: 'APPROVED' | 'REJECTED' | 'CANCELLED', note?: string) {
    const r = await this.prisma.remoteWorkRequest.findFirst({ where: { id, tenantId: user.tenantId }, include: { employee: true } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Remote work request not found');
    const own = r.employeeId === user.employeeId;
    if (verdict === 'CANCELLED') {
      if (!own) await this.scope.assertApprover(user, r.employeeId);
      if (!['PENDING', 'APPROVED'].includes(r.status)) throw new AppError(409, 'NOT_CANCELLABLE', `This request is ${r.status.toLowerCase()}`);
    } else {
      await this.scope.assertApprover(user, r.employeeId);
      if (r.status !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', `This request is already ${r.status.toLowerCase()}`);
    }
    const wasApproved = r.status === 'APPROVED';
    const updated = await this.audit.run({
      action: `REMOTE_${verdict}`,
      targetType: 'RemoteWorkRequest',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ note: note ?? null }),
      run: (tx) =>
        tx.remoteWorkRequest.update({
          where: { id },
          data: { status: verdict, decidedAt: new Date(), decisionNote: note ?? null, ...(verdict !== 'CANCELLED' ? { approverId: user.sub } : {}) },
        }),
    });
    if (verdict === 'APPROVED' || wasApproved) await this.recompute.range(r.employeeId, ymdOf(r.startDate), ymdOf(r.endDate));
    if (!own) {
      await this.notifications.notify(r.tenantId, [r.employee.userId], {
        type: `REMOTE_${verdict}`,
        title: `Remote work ${verdict.toLowerCase()}`,
        body: `Your remote work ${ymdOf(r.startDate)} – ${ymdOf(r.endDate)} was ${verdict.toLowerCase()}${note ? `: ${note}` : ''}`,
        data: { id },
      });
    }
    return this.present(updated);
  }

  /**
   * Remote/field check-in (§9). Server time is authoritative; allowed when the
   * employee's mobile_punch is ALWAYS, or REMOTE_DAYS with approved remote work
   * today. Coordinates are stored for audit; no geofencing in v1.
   */
  async mobilePunch(user: AuthUser, dto: MobilePunchDto) {
    const employee = await this.scope.self(user);
    if (employee.status !== 'ACTIVE') throw new AppError(403, 'EMPLOYEE_EXITED', 'Employee has exited');
    const today = localYmd(new Date(), employee.site.timezone);
    let allowed = employee.mobilePunch === 'ALWAYS';
    if (!allowed && employee.mobilePunch === 'REMOTE_DAYS') {
      allowed = Boolean(
        await this.prisma.remoteWorkRequest.findFirst({
          where: { employeeId: employee.id, status: 'APPROVED', startDate: { lte: dbDate(today) }, endDate: { gte: dbDate(today) } },
        }),
      );
    }
    if (!allowed) {
      throw new AppError(403, 'MOBILE_PUNCH_NOT_ALLOWED', employee.mobilePunch === 'NEVER' ? 'Mobile punching is not enabled for you' : 'You have no approved remote work today');
    }
    const punch = await this.punches.record(
      {
        tenantId: employee.tenantId,
        siteId: employee.siteId,
        employeeId: employee.id,
        punchedAt: new Date(),
        source: 'MOBILE',
        direction: dto.direction,
        lat: dto.lat,
        lng: dto.lng,
        accuracy: dto.accuracy,
        isMockLocation: dto.isMockLocation ?? null,
        reason: dto.clientTime ? `clientTime=${dto.clientTime}` : null,
        createdBy: user.sub,
      },
      employee,
    );
    return punch;
  }
}

@ApiTags('remote-work')
@Controller('remote-work/requests')
export class RemoteController {
  constructor(private readonly remote: RemoteService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: RequestListQuery) {
    return this.remote.list(user, q);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: RemoteRequestDto) {
    return this.remote.create(user, dto);
  }

  @Post(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.remote.decide(user, id, 'APPROVED', dto.note);
  }

  @Post(':id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RequiredNoteDto) {
    return this.remote.decide(user, id, 'REJECTED', dto.note);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.remote.decide(user, id, 'CANCELLED', dto.note);
  }
}

@Module({
  imports: [PunchesModule],
  controllers: [RemoteController],
  providers: [RemoteService],
  exports: [RemoteService],
})
export class RemoteModule {}

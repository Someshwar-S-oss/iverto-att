import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma, RemoteWorkRequest } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBase64, IsBoolean, IsIn, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import { presentPunch } from '../attendance/present';
import { RecomputeQueue } from '../attendance/recompute.service';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AzureBlobService } from '../common/azure-blob.service';
import { AppError } from '../common/errors';
import { approvalTrack, approverNames } from '../common/approval';
import { PrismaService } from '../common/prisma.service';
import { dbDate, diffDays, formatLocal, localYmd, ymdOf } from '../common/time';
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
  /** Base64 JPEG taken in-app at the moment of the punch; stored in Azure Blob for review. */
  @IsBase64() selfieBase64: string;
}

export class PunchReviewQuery {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED']) status?: string;
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsYmd() from?: string;
  @IsOptional() @IsYmd() to?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

const MAX_SELFIE_BYTES = 2 * 1024 * 1024;

/** An in-app JPEG selfie (mobile punches, field visits): at most 2 MB, checked by magic bytes. */
export function decodeSelfie(base64: string): Buffer {
  const selfie = Buffer.from(base64, 'base64');
  if (selfie.byteLength > MAX_SELFIE_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'The selfie must be at most 2 MB');
  if (selfie[0] !== 0xff || selfie[1] !== 0xd8) throw new AppError(400, 'FILE_TYPE_MISMATCH', 'The selfie must be a JPEG');
  return selfie;
}

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * null when the site has no geofence. A fix counts as inside only when it is
 * within the radius and the phone did not report a mock location.
 * ponytail: the reported GPS accuracy is not used; require accuracy ≤ radius if vague fixes slip through.
 */
export function geofenceCheck(
  site: { lat: number | null; lng: number | null; geofenceRadiusM: number | null },
  fix: { lat: number; lng: number; isMockLocation?: boolean | null },
) {
  if (site.lat === null || site.lng === null || !site.geofenceRadiusM) return null;
  const d = Math.round(distanceM({ lat: site.lat, lng: site.lng }, fix));
  return { distanceM: d, inside: d <= site.geofenceRadiusM && fix.isMockLocation !== true };
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
    private readonly blobs: AzureBlobService,
  ) {}

  present(r: RemoteWorkRequest & Record<string, any>) {
    return { ...r, startDate: ymdOf(r.startDate), endDate: ymdOf(r.endDate) };
  }

  /** Org setting: remote work needs a manager and then HR/admin to approve. */
  async twoLevel(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
    return (t?.settings as Record<string, unknown> | undefined)?.remoteRequiresHrApproval === true;
  }

  async list(user: AuthUser, q: RequestListQuery & { awaitingMe?: boolean }, mineOnly = false) {
    const limit = q.limit ?? 50;
    const employee = mineOnly
      ? { id: user.employeeId ?? '__none__' }
      : { AND: [await this.scope.employeeWhere(user), q.employeeId ? { id: q.employeeId } : {}, q.departmentId ? { departmentId: q.departmentId } : {}] };
    const rows = await this.prisma.remoteWorkRequest.findMany({
      where: {
        tenantId: user.tenantId,
        status: q.awaitingMe ? 'PENDING' : q.status,
        // A manager's queue leaves out requests already passed on to HR.
        ...(q.awaitingMe && user.role === 'MANAGER' ? { managerApproverId: null } : {}),
        employee,
        ...(q.from ? { endDate: { gte: dbDate(q.from) } } : {}),
        ...(q.to ? { startDate: { lte: dbDate(q.to) } } : {}),
      },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const [names, twoLevel] = await Promise.all([approverNames(this.prisma, page), this.twoLevel(user.tenantId)]);
    const data = page.map((r) => ({ ...this.present(r), progress: approvalTrack(r, twoLevel, names) }));
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
      payloadFrom: () => ({ employeeId: employee.id, ...dto }),
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
      if (verdict === 'REJECTED' && (note?.trim().length ?? 0) < 3) throw new AppError(400, 'REASON_REQUIRED', 'Give a reason for the rejection');
      if (r.status !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', `This request is already ${r.status.toLowerCase()}`);
    }
    // Two levels (org setting): a manager's approval passes it on to HR; HR/Admin approval is final.
    if (verdict === 'APPROVED' && !isHrOrAdmin(user) && (await this.twoLevel(user.tenantId))) {
      if (r.managerApproverId) throw new AppError(409, 'AWAITING_HR', 'Already approved by a manager; waiting for HR');
      const passed = await this.audit.run({
        action: 'REMOTE_MANAGER_APPROVED',
        targetType: 'RemoteWorkRequest',
        targetId: id,
        actor: actorOf(user),
        tenantId: user.tenantId,
        payloadFrom: () => ({ employeeId: r.employeeId, from: ymdOf(r.startDate), to: ymdOf(r.endDate), note: note ?? null }),
        run: (tx) => tx.remoteWorkRequest.update({ where: { id }, data: { managerApproverId: user.sub, managerDecidedAt: new Date(), decisionNote: note ?? null } }),
      });
      await this.notifications.approvalPending(user.tenantId, r.employeeId, 'remote', id, r.employee.fullName, true);
      await this.notifications.notify(r.tenantId, [r.employee.userId], {
        type: 'REMOTE_MANAGER_APPROVED',
        title: 'Remote work approved by your manager',
        body: `Your remote work ${ymdOf(r.startDate)} – ${ymdOf(r.endDate)} is now waiting for HR`,
        data: { id },
      });
      return this.present(passed);
    }
    const wasApproved = r.status === 'APPROVED';
    const updated = await this.audit.run({
      action: `REMOTE_${verdict}`,
      targetType: 'RemoteWorkRequest',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: r.employeeId, from: ymdOf(r.startDate), to: ymdOf(r.endDate), note: note ?? null }),
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
   * employee's mobile_punch is ALWAYS or FULL_REMOTE, or REMOTE_DAYS with approved remote work
   * today. Coordinates and a selfie are stored; the punch counts at once and
   * waits in PENDING review — a rejection takes it out of the day.
   */
  async mobilePunch(user: AuthUser, dto: MobilePunchDto) {
    const employee = await this.scope.self(user);
    if (employee.status !== 'ACTIVE') throw new AppError(403, 'EMPLOYEE_EXITED', 'Employee has exited');
    const today = localYmd(new Date(), employee.site.timezone);
    let allowed = employee.mobilePunch === 'ALWAYS' || employee.mobilePunch === 'FULL_REMOTE';
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
    // Geofence: inside the site's circle (and not a mock fix) approves the punch on the spot;
    // outside waits for a manager, or is refused when the site is strict.
    const fence = geofenceCheck(employee.site, dto);
    if (fence && !fence.inside && employee.site.geofenceStrict) {
      throw new AppError(403, 'OUTSIDE_GEOFENCE', `You are ${fence.distanceM} m from ${employee.site.name}; punch within ${employee.site.geofenceRadiusM} m`);
    }
    const selfie = decodeSelfie(dto.selfieBase64);
    // Upload first so a punch never exists without its selfie; a failed insert only leaves an orphan blob.
    const photoKey = `${employee.tenantId}/${employee.id}/${today}/${randomUUID()}.jpg`;
    await this.blobs.upload(photoKey, selfie, 'image/jpeg');
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
        photoKey,
        reviewStatus: fence?.inside ? 'APPROVED' : 'PENDING',
        ...(fence && { reviewNote: fence.inside ? `Auto-approved: ${fence.distanceM} m from ${employee.site.name}` : `Outside geofence: ${fence.distanceM} m from ${employee.site.name}` }),
        ...(fence?.inside && { reviewedAt: new Date() }),
      },
      employee,
    );
    return punch;
  }

  /** Mobile check-ins for review, newest first, each with a 1-hour selfie link. */
  async listPunches(user: AuthUser, q: PunchReviewQuery) {
    const limit = q.limit ?? 50;
    const where: Prisma.PunchWhereInput = {
      tenantId: user.tenantId,
      source: 'MOBILE',
      reviewStatus: q.status ?? { not: null },
      employee: { AND: [await this.scope.employeeWhere(user), q.employeeId ? { id: q.employeeId } : {}] },
      ...(q.from || q.to ? { workDate: { gte: q.from ? dbDate(q.from) : undefined, lte: q.to ? dbDate(q.to) : undefined } } : {}),
    };
    const cursor = q.cursor ? JSON.parse(Buffer.from(q.cursor, 'base64url').toString()) : null;
    const rows = await this.prisma.punch.findMany({
      where: cursor
        ? { AND: [where, { OR: [{ punchedAt: { lt: new Date(cursor.t) } }, { punchedAt: new Date(cursor.t), id: { lt: cursor.id } }] }] }
        : where,
      include: { employee: { include: { site: true } }, device: true },
      orderBy: [{ punchedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: await Promise.all(page.map(async (p) => ({ ...presentPunch(p, p.employee!.site.timezone), selfieUrl: p.photoKey ? await this.blobs.readUrl(p.photoKey) : null }))),
      nextCursor:
        rows.length > limit && last ? Buffer.from(JSON.stringify({ t: last.punchedAt.toISOString(), id: last.id })).toString('base64url') : null,
    };
  }

  async reviewPunch(user: AuthUser, id: string, verdict: 'APPROVED' | 'REJECTED', note?: string) {
    const p = await this.prisma.punch.findFirst({
      where: { id, tenantId: user.tenantId, source: 'MOBILE' },
      include: { employee: { include: { site: true } } },
    });
    if (!p?.employee) throw new AppError(404, 'NOT_FOUND', 'Mobile check-in not found');
    await this.scope.assertApprover(user, p.employee.id);
    if (p.reviewStatus !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', `This check-in is already ${(p.reviewStatus ?? 'reviewed').toLowerCase()}`);
    const updated = await this.audit.run({
      action: `MOBILE_PUNCH_${verdict}`,
      targetType: 'Punch',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: p.employee.id, note: note ?? null }),
      run: (tx) =>
        tx.punch.update({
          where: { id_punchedAt: { id, punchedAt: p.punchedAt } },
          // DENIED takes it out of the day: the engine only reads GRANTED punches.
          data: { reviewStatus: verdict, reviewedBy: user.sub, reviewedAt: new Date(), reviewNote: note ?? null, ...(verdict === 'REJECTED' ? { outcome: 'DENIED' } : {}) },
        }),
    });
    const tz = p.employee.site.timezone;
    if (verdict === 'REJECTED') {
      if (p.workDate) await this.recompute.day(p.employee.id, ymdOf(p.workDate), 500);
      await this.notifications.notify(p.tenantId, [p.employee.userId], {
        type: 'MOBILE_PUNCH_REJECTED',
        title: 'Check-in rejected',
        body: `Your mobile check-${p.direction} at ${formatLocal(p.punchedAt, tz, 'yyyy-MM-dd HH:mm')} was rejected${note ? `: ${note}` : ''}`,
        data: { id },
      });
    }
    return presentPunch({ ...updated, employee: p.employee, device: null }, tz);
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

@ApiTags('remote-work')
@Controller('remote-work/punches')
export class RemotePunchesController {
  constructor(private readonly remote: RemoteService) {}

  @Get()
  @Roles('ADMIN', 'HR', 'MANAGER')
  list(@CurrentUser() user: AuthUser, @Query() q: PunchReviewQuery) {
    return this.remote.listPunches(user, q);
  }

  @Post(':id/approve')
  @Roles('ADMIN', 'HR', 'MANAGER')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.remote.reviewPunch(user, id, 'APPROVED', dto.note);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR', 'MANAGER')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RequiredNoteDto) {
    return this.remote.reviewPunch(user, id, 'REJECTED', dto.note);
  }
}

@Module({
  imports: [PunchesModule],
  controllers: [RemoteController, RemotePunchesController],
  providers: [RemoteService],
  exports: [RemoteService],
})
export class RemoteModule {}

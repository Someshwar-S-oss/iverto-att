import { Controller, Get, Global, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';
import { presentDay, presentPunch } from '../attendance/present';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { PrismaService } from '../common/prisma.service';
import { dbDate, localYmd } from '../common/time';
import { LiveGateway } from './live.gateway';

export class BoardQuery {
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() projectId?: string;
}

const LIVE_STATES = ['OFF', 'ON_LEAVE', 'NOT_YET_IN', 'LATE_NOT_IN', 'IN', 'IN_LATE', 'REMOTE', 'ON_BREAK', 'LEFT', 'ABSENT'];

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** Snapshot for /live (§10): counts per live state, one row per employee today, devices. */
  async board(user: AuthUser, q: BoardQuery) {
    const now = new Date();
    const where: Prisma.EmployeeWhereInput = {
      AND: [
        await this.scope.employeeWhere(user),
        { status: 'ACTIVE' },
        q.siteId ? { siteId: q.siteId } : {},
        q.departmentId ? { departmentId: q.departmentId } : {},
        q.projectId ? { projects: { some: { projectId: q.projectId, OR: [{ to: null }, { to: { gte: now } }] } } } : {},
      ],
    };
    const sites = await this.prisma.site.findMany({ where: { tenantId: user.tenantId, ...(q.siteId ? { id: q.siteId } : {}) } });
    // "Today" is each employee's own site's today.
    const siteToday = sites.map((s) => ({ siteId: s.id, workDate: dbDate(localYmd(now, s.timezone)) }));

    const [days, devices, punches] = await Promise.all([
      this.prisma.attendanceDay.findMany({
        where: { employee: where, OR: siteToday },
        include: { employee: true },
        orderBy: { employee: { fullName: 'asc' } },
      }),
      this.prisma.device.findMany({
        where: { tenantId: user.tenantId, ...(q.siteId ? { siteId: q.siteId } : {}) },
        select: { id: true, name: true, serialNo: true, gateName: true, direction: true, siteId: true, status: true, lastSeenAt: true },
      }),
      this.prisma.punch.findMany({
        where: { tenantId: user.tenantId, employee: where, punchedAt: { gte: new Date(now.getTime() - 12 * 3_600_000) } },
        include: { employee: true, device: true },
        orderBy: { punchedAt: 'desc' },
        take: 30,
      }),
    ]);

    const counts = Object.fromEntries(LIVE_STATES.map((s) => [s, 0]));
    for (const d of days) counts[d.liveState] = (counts[d.liveState] ?? 0) + 1;
    const tzOf = new Map(sites.map((s) => [s.id, s.timezone]));

    return {
      generatedAt: now,
      counts,
      summary: {
        present: counts.IN + counts.IN_LATE + counts.ON_BREAK + counts.LEFT,
        late: days.filter((d) => d.isLate).length,
        absent: counts.ABSENT,
        notYetIn: counts.NOT_YET_IN + counts.LATE_NOT_IN,
        onLeave: counts.ON_LEAVE,
        remote: counts.REMOTE,
        off: counts.OFF,
        scheduled: days.filter((d) => d.dayType === 'WORKING').length,
      },
      rows: days.map(presentDay),
      devices: devices.map((d) => ({ ...d, online: d.status === 'online' })),
      recentPunches: punches.map((p) => presentPunch(p, tzOf.get(p.siteId) ?? 'UTC')),
    };
  }
}

@ApiTags('live')
@Controller('live')
export class LiveController {
  constructor(private readonly live: LiveService) {}

  @Get('board')
  @Roles('ADMIN', 'HR', 'MANAGER')
  board(@CurrentUser() user: AuthUser, @Query() q: BoardQuery) {
    return this.live.board(user, q);
  }
}

@Global()
@Module({
  controllers: [LiveController],
  providers: [LiveGateway, LiveService],
  exports: [LiveGateway, LiveService],
})
export class LiveModule {}

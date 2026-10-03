import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { presentDay } from '../attendance/present';
import { RecomputeQueue } from '../attendance/recompute.service';
import { RosterService } from '../attendance/roster.service';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { BUCKETS, SupabaseService } from '../common/supabase.service';
import { addDays, localYmd, ymdOf } from '../common/time';
import { EmployeesModule, EmployeesService } from '../employees/employees';
import { LeaveModule, LeaveService } from '../leave/leave';
import { LiveGateway } from '../live/live.gateway';
import { NotificationsService } from '../notifications/notifications';
import { ReportsModule, ReportsService } from '../reports/reports';

export const CRON_QUEUE = 'cron';

/**
 * Every schedule is a BullMQ job scheduler (D10): it runs exactly once across
 * replicas once the API scales out, and upserting on boot is idempotent.
 */
const SCHEDULES: Record<string, number> = {
  'attendance-sweep': 60_000,
  'attendance-finalise': 15 * 60_000,
  'roster-materialise': 60 * 60_000,
  'leave-accrual': 60 * 60_000,
  'terminal-offboard-retry': 60 * 60_000,
  'device-watchdog': 5 * 60_000,
  retention: 24 * 60 * 60_000,
};

const HORIZON_DAYS = 14;
const DEVICE_STALE_MS = 5 * 60_000;

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly roster: RosterService,
    private readonly recompute: RecomputeQueue,
    private readonly live: LiveGateway,
    private readonly leave: LeaveService,
    private readonly employees: EmployeesService,
    private readonly reports: ReportsService,
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Absence without an event (§10): open days with no punch move
   * NOT_YET_IN → LATE_NOT_IN → ABSENT as time passes. One indexed UPDATE per tick.
   */
  async sweep() {
    const changed = await this.prisma.$transaction((tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        WITH next AS (
          SELECT id,
                 CASE WHEN now() >= COALESCE(core_start, sched_start) + make_interval(mins => COALESCE((policy->>'absentAfterMinutes')::int, 120))
                      THEN 'ABSENT' ELSE 'LATE_NOT_IN' END AS state
          FROM attendance_days
          WHERE finalized_at IS NULL
            AND day_type = 'WORKING'
            AND punch_count = 0
            AND remote = false
            AND leave_portion = 0
            AND sched_start IS NOT NULL
            AND live_state IN ('NOT_YET_IN', 'LATE_NOT_IN')
            AND now() < window_end
            AND now() > COALESCE(core_start, sched_start) + make_interval(mins => COALESCE((policy->>'graceInMinutes')::int, 10))
        )
        UPDATE attendance_days a SET live_state = next.state
        FROM next WHERE a.id = next.id AND a.live_state <> next.state
        RETURNING a.id`,
    );
    if (!changed.length) return 0;
    const days = await this.prisma.attendanceDay.findMany({ where: { id: { in: changed.map((c) => c.id) } }, include: { employee: true } });
    for (const d of days) this.live.emitForEmployee('attendance.updated', d.employee, presentDay(d));
    return days.length;
  }

  /** Days whose window closed get their final status via one last recompute (§6.6). */
  async finalise() {
    const due = await this.prisma.attendanceDay.findMany({
      where: { finalizedAt: null, windowEnd: { lt: new Date() } },
      select: { employeeId: true, workDate: true },
      take: 5000,
    });
    await this.recompute.days(due.map((d) => ({ employeeId: d.employeeId, date: ymdOf(d.workDate) })), 0);
    return due.length;
  }

  /** Keep attendance_days for today … today+14 for every active employee (§7.2). */
  async materialise() {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    let created = 0;
    for (const t of tenants) {
      const employees = await this.prisma.employee.findMany({ where: { tenantId: t.id, status: 'ACTIVE' } });
      if (!employees.length) continue;
      const today = localYmd(new Date(), 'UTC');
      const from = addDays(today, -1);
      const to = addDays(today, HORIZON_DAYS);
      const tr = await this.roster.tenantRoster(t.id, from, to);
      for (let i = 0; i < employees.length; i += 200) {
        const touched = await this.roster.ensureDays(t.id, employees.slice(i, i + 200), from, to, { tr });
        // New rows start blank; one engine pass sets OFF / ON_LEAVE / NOT_YET_IN correctly.
        await this.recompute.days(touched, 1000);
        created += touched.length;
      }
    }
    return created;
  }

  /** Mark silent terminals offline and tell the admins (§16). */
  async watchdog() {
    const stale = await this.prisma.device.findMany({
      where: { status: 'online', lastSeenAt: { lt: new Date(Date.now() - DEVICE_STALE_MS) } },
    });
    for (const d of stale) {
      await this.prisma.device.update({ where: { id: d.id }, data: { status: 'offline' } });
      this.live.emitToTenantSite('device.status', d.tenantId, d.siteId, { deviceId: d.id, status: 'offline', lastSeenAt: d.lastSeenAt });
      const admins = await this.prisma.userProfile.findMany({ where: { tenantId: d.tenantId, role: { in: ['ADMIN', 'HR'] }, status: 'ACTIVE' }, select: { userId: true } });
      await this.notifications.notify(d.tenantId, admins.map((a) => a.userId), {
        type: 'DEVICE_OFFLINE',
        title: 'Terminal offline',
        body: `${d.name ?? d.serialNo} (${d.gateName}) has not been heard from since ${d.lastSeenAt?.toISOString() ?? 'ever'}. Expect false "absent" marks until it is back.`,
        data: { deviceId: d.id },
      });
    }
    return stale.length;
  }

  /** Punch photos and report files past their retention (§4.3, §11.5). */
  async retention() {
    const tenants = await this.prisma.tenant.findMany();
    for (const t of tenants) {
      const days = Number((t.settings as any)?.punchPhotoRetentionDays ?? 90);
      for (;;) {
        const old = await this.prisma.punch.findMany({
          where: { tenantId: t.id, photoKey: { not: null }, punchedAt: { lt: new Date(Date.now() - days * 86_400_000) } },
          select: { id: true, punchedAt: true, photoKey: true },
          take: 500,
        });
        if (!old.length) break;
        await this.supabase.remove(BUCKETS.punchPhotos(), old.map((p) => p.photoKey!));
        for (const p of old) {
          await this.prisma.punch.update({ where: { id_punchedAt: { id: p.id, punchedAt: p.punchedAt } }, data: { photoKey: null } });
        }
      }
    }
    await this.reports.purgeExpired();
  }

  run(name: string) {
    switch (name) {
      case 'attendance-sweep':
        return this.sweep();
      case 'attendance-finalise':
        return this.finalise();
      case 'roster-materialise':
        return this.materialise();
      case 'leave-accrual':
        return this.leave.runAccruals();
      case 'terminal-offboard-retry':
        return this.employees.retryPendingOffboarding();
      case 'device-watchdog':
        return this.watchdog();
      case 'retention':
        return this.retention();
      default:
        this.logger.warn(`Unknown cron job ${name}`);
    }
  }
}

@Processor(CRON_QUEUE, { concurrency: 2 })
export class CronProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CronProcessor.name);

  constructor(
    private readonly jobs: JobsService,
    @InjectQueue(CRON_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    if (process.env.DISABLE_CRON === 'true') return;
    for (const [name, every] of Object.entries(SCHEDULES)) {
      await this.queue.upsertJobScheduler(name, { every }, { name, opts: { removeOnComplete: 50, removeOnFail: 200 } });
    }
    // Materialise once at boot so a fresh deploy has today's rows immediately.
    await this.queue.add('roster-materialise', {}, { removeOnComplete: true });
  }

  async process(job: Job) {
    const started = Date.now();
    const result = await runAsSystem(async () => this.jobs.run(job.name));
    if (Date.now() - started > 5000) this.logger.log(`${job.name} took ${Date.now() - started} ms (${result ?? ''})`);
    return result;
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: CRON_QUEUE }), LeaveModule, EmployeesModule, ReportsModule],
  providers: [JobsService, CronProcessor],
})
export class JobsModule {}

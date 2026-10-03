import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { AttendanceDay, Employee, Prisma } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { AuditActor } from '../auth/auth.types';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { addDays, dbDate, eachDay, Ymd, ymdOf } from '../common/time';
import { LiveGateway } from '../live/live.gateway';
import { computeAttendanceDay, EngineLeave, EnginePolicy } from './engine/compute-day';
import { presentDay } from './present';
import { engineDayOf, RosterService } from './roster.service';

export const RECOMPUTE_QUEUE = 'recompute';

export interface DayJob {
  employeeId: string;
  date: Ymd;
}

export interface BulkJob {
  tenantId: string;
  employeeIds?: string[];
  from: Ymd;
  to: Ymd;
  /** Rewrite the frozen schedule first (roster/holiday/policy edits). */
  rematerialise?: boolean;
  /** HR "re-evaluate history": also rewrite finalised days. Audited by the caller. */
  includeFinalized?: boolean;
}

/** Enqueue side: every trigger in §6.6 ends up here. */
@Injectable()
export class RecomputeQueue {
  constructor(@InjectQueue(RECOMPUTE_QUEUE) private readonly queue: Queue) {}

  /**
   * Debounced per employee-day: a double scan triggers one recompute. The
   * dedup key expires before the delay does, so a punch landing while a
   * recompute is already running always gets a fresh job.
   */
  day(employeeId: string, date: Ymd, delayMs = 3000) {
    const delay = Math.max(delayMs, 1000);
    return this.queue.add('day', { employeeId, date } satisfies DayJob, {
      delay,
      deduplication: { id: `rc:${employeeId}:${date}`, ttl: delay - 500 },
      removeOnComplete: true,
      removeOnFail: 1000,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  async days(pairs: Array<{ employeeId: string; date: Ymd }>, delayMs = 3000) {
    for (const p of pairs) await this.day(p.employeeId, p.date, delayMs);
  }

  /** Every date in range for these employees (leave/remote approvals, corrections). */
  async range(employeeId: string, from: Ymd, to: Ymd) {
    await this.days(eachDay(from, to).map((date) => ({ employeeId, date })), 500);
  }

  bulk(job: BulkJob) {
    return this.queue.add('bulk', job, { removeOnComplete: 100, removeOnFail: 1000, attempts: 3 });
  }
}

@Injectable()
export class RecomputeService {
  private readonly logger = new Logger(RecomputeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly roster: RosterService,
    private readonly live: LiveGateway,
    private readonly queue: RecomputeQueue,
  ) {}

  /**
   * Engine for one employee-day. Idempotent: recomputing twice changes nothing.
   * Serialised per employee-day by an advisory lock so two recomputes never
   * interleave (replaces the hostel's SubjectPresence race guard).
   */
  async recompute(employeeId: string, date: Ymd, actor: AuditActor = { type: 'system' }): Promise<AttendanceDay | null> {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return null;
    const exists = await this.prisma.attendanceDay.count({ where: { employeeId, workDate: dbDate(date) } });
    if (!exists) await this.roster.ensureDays(employee.tenantId, [employee], date, date);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${employeeId} || ${date}))`;
      const day = await tx.attendanceDay.findUnique({ where: { employeeId_workDate: { employeeId, workDate: dbDate(date) } } });
      if (!day) return null; // outside employment

      const [punches, leave, remote] = await Promise.all([
        tx.punch.findMany({
          where: { employeeId, outcome: 'GRANTED', punchedAt: { gte: day.windowStart, lt: day.windowEnd } },
          orderBy: { punchedAt: 'asc' },
        }),
        tx.leaveRequest.findFirst({
          where: { employeeId, status: 'APPROVED', startDate: { lte: dbDate(date) }, endDate: { gte: dbDate(date) } },
        }),
        tx.remoteWorkRequest.findFirst({
          where: { employeeId, status: 'APPROVED', startDate: { lte: dbDate(date) }, endDate: { gte: dbDate(date) } },
        }),
      ]);

      let engineLeave: EngineLeave | null = null;
      if (leave) {
        const half = ymdOf(leave.startDate) === date ? leave.startHalf : ymdOf(leave.endDate) === date ? leave.endHalf : null;
        engineLeave = { portion: half ? 0.5 : 1, half: half as EngineLeave['half'], leaveTypeId: leave.leaveTypeId };
      }

      const r = computeAttendanceDay({
        day: engineDayOf(day),
        punches: punches.map((p) => ({ at: p.punchedAt, direction: p.direction as any, source: p.source })),
        leave: engineLeave,
        remote: Boolean(remote),
        policy: day.policy as unknown as EnginePolicy,
        now: new Date(),
      });

      const updated = await tx.attendanceDay.update({
        where: { id: day.id },
        data: {
          firstIn: r.firstIn,
          lastOut: r.lastOut,
          segments: r.segments as unknown as Prisma.InputJsonValue,
          workedMinutes: r.workedMinutes,
          breakMinutes: r.breakMinutes,
          lateMinutes: r.lateMinutes,
          earlyExitMinutes: r.earlyExitMinutes,
          overtimeMinutes: r.overtimeMinutes,
          punchCount: r.punchCount,
          status: r.status,
          liveState: r.liveState,
          isLate: r.isLate,
          isEarlyExit: r.isEarlyExit,
          missedPunch: r.missedPunch,
          workedOnOffDay: r.workedOnOffDay,
          hasLeaveConflict: r.hasLeaveConflict,
          leavePortion: engineLeave?.portion ?? 0,
          leaveHalf: engineLeave?.half ?? null,
          leaveTypeId: engineLeave?.leaveTypeId ?? null,
          remote: Boolean(remote),
          corrected: r.corrected,
          finalizedAt: day.finalizedAt ?? (r.open ? null : new Date()),
          computedAt: new Date(),
        },
        include: { employee: true },
      });

      if (punches.length) {
        await tx.punch.updateMany({
          where: { employeeId, punchedAt: { gte: day.windowStart, lt: day.windowEnd }, NOT: { workDate: dbDate(date) } },
          data: { workDate: dbDate(date) },
        });
      }

      // Past days are only rewritten by explicit actions, and never silently (§6.6).
      if (day.finalizedAt && day.status !== r.status) {
        await tx.auditLog.create({
          data: {
            tenantId: day.tenantId,
            siteId: day.siteId,
            actorType: actor.type,
            actorUserId: actor.userId ?? null,
            action: 'ATTENDANCE_RECOMPUTED',
            targetType: 'AttendanceDay',
            targetId: day.id,
            payload: { employeeId, date, before: day.status, after: r.status },
          },
        });
      }
      return updated;
    });

    if (result) this.live.emitForEmployee('attendance.updated', result.employee, presentDay(result));
    return result;
  }

  async bulk(job: BulkJob) {
    const employees = await this.prisma.employee.findMany({
      where: { tenantId: job.tenantId, ...(job.employeeIds?.length ? { id: { in: job.employeeIds } } : {}) },
    });
    // Chunked so one huge tenant does not hold a single long transaction.
    for (let i = 0; i < employees.length; i += 200) {
      const chunk = employees.slice(i, i + 200);
      if (job.rematerialise) {
        await this.roster.ensureDays(job.tenantId, chunk, job.from, job.to, {
          refresh: true,
          includeFinalized: job.includeFinalized,
        });
      }
      const pairs = chunk.flatMap((e) => eachDay(job.from, job.to).map((date) => ({ employeeId: e.id, date })));
      await this.queue.days(pairs, 500);
    }
  }

  /**
   * Candidate work date for a punch (§5): the materialised window containing it,
   * materialising the neighbourhood first if needed. The recompute is authoritative.
   */
  async workDateFor(employee: Employee, at: Date, localDate: Ymd): Promise<Ymd> {
    const find = () =>
      this.prisma.attendanceDay.findFirst({
        where: { employeeId: employee.id, windowStart: { lte: at }, windowEnd: { gt: at } },
        select: { workDate: true },
      });
    let hit = await find();
    if (!hit) {
      await this.roster.ensureDays(employee.tenantId, [employee], addDays(localDate, -1), addDays(localDate, 1));
      hit = await find();
    }
    return hit ? ymdOf(hit.workDate) : localDate;
  }
}

@Processor(RECOMPUTE_QUEUE, { concurrency: 8 })
export class RecomputeProcessor extends WorkerHost {
  constructor(private readonly service: RecomputeService) {
    super();
  }

  process(job: Job<DayJob | BulkJob>) {
    return runAsSystem(async () => {
      if (job.name === 'bulk') return this.service.bulk(job.data as BulkJob);
      const { employeeId, date } = job.data as DayJob;
      await this.service.recompute(employeeId, date);
    });
  }
}

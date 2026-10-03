import { Injectable, Logger } from '@nestjs/common';
import { Employee, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { BUCKETS, SupabaseService } from '../../common/supabase.service';
import { PunchesService } from '../../punches/punches';
import type { M50DeviceContext } from '../m50-session';
import {
  AdminLogPayload,
  TimeLogPayload,
  actionToOutcome,
  adminActionCategory,
  isSubjectlessAction,
  normalizeAttendStat,
  parseDeviceTime,
} from '../protocol/m50-protocol';

/**
 * AttendStat values that describe an actual movement, as opposed to the mode the
 * terminal happens to be parked in. In the field every scan reads `DutyOff`, so
 * only a literal In/Out may override the gate's configured direction.
 */
const EXPLICIT_TRAVEL_STATS = new Set(['in', 'out']);

export interface IngestResult {
  inserted: boolean;
}

/**
 * TimeLog → `punches` (§5). Changes vs hostel: the punch is written
 * synchronously here (one insert, idempotent on device+LogID+time) instead of
 * via a queue, because the ack depends on it; the recompute is what is queued.
 */
@Injectable()
export class TerminalIngestService {
  private readonly logger = new Logger(TerminalIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly punches: PunchesService,
    private readonly supabase: SupabaseService,
  ) {}

  /** Resolves only once the punch is durable — the caller acks after this. */
  async ingestTimeLog(context: M50DeviceContext, log: TimeLogPayload): Promise<IngestResult> {
    const punchedAt = parseDeviceTime(log.rawTime, context.timeZone);
    const subjectless = log.terminalUserId === 0 || isSubjectlessAction(log.action);
    const employee = subjectless ? null : await this.resolveEmployee(context, log);

    const punch = await this.punches.record(
      {
        tenantId: context.tenantId,
        siteId: context.siteId,
        employeeId: employee?.id ?? null,
        deviceId: context.deviceId,
        // UserID 0 / door events carry no person; keep the slot for UNKNOWN retro-attribution.
        terminalUserId: subjectless ? null : log.terminalUserId,
        deviceLogId: log.logId,
        punchedAt,
        source: 'TERMINAL',
        direction: this.resolveDirection(context, log),
        outcome: actionToOutcome(log.action),
      },
      employee,
    );

    await this.advanceLogCursor(context, log.logId);
    if (punch && log.logImage) void this.storePhoto(context, log, punch.id, punchedAt);
    return { inserted: Boolean(punch) };
  }

  /**
   * Gate configuration decides (§4.3): IN → in, OUT → out, BOTH → unknown
   * (the engine pairs first-in/last-out). A literal In/Out AttendStat overrides.
   */
  private resolveDirection(context: M50DeviceContext, log: TimeLogPayload): 'in' | 'out' | 'unknown' {
    const stat = normalizeAttendStat(log.attendStat);
    if (EXPLICIT_TRAVEL_STATS.has(stat)) return stat as 'in' | 'out';
    return context.direction === 'IN' ? 'in' : context.direction === 'OUT' ? 'out' : 'unknown';
  }

  private async resolveEmployee(context: M50DeviceContext, log: TimeLogPayload): Promise<Employee | null> {
    const mapping = await this.prisma.terminalUser.findUnique({
      where: { deviceId_terminalUserId: { deviceId: context.deviceId, terminalUserId: log.terminalUserId } },
    });
    if (!mapping) {
      // Enrolled at the keypad, or the mapping was deleted. Recorded as UNKNOWN (employee_id NULL,
      // slot kept) so claiming the slot later can retro-attribute it.
      this.logger.warn(`No employee mapped to UserID ${log.terminalUserId} on ${context.serialNo}; recording as UNKNOWN`);
      return null;
    }
    if (!mapping.faceEnrolled) await this.confirmEnrolmentFromScan(context, log);
    return this.prisma.employee.findFirst({ where: { id: mapping.subjectId, tenantId: context.tenantId } });
  }

  /**
   * A granted match proves a face is enrolled in that slot, whatever our record
   * says. Failure-tolerant: losing this flag is cosmetic, losing the punch is not.
   */
  private async confirmEnrolmentFromScan(context: M50DeviceContext, log: TimeLogPayload): Promise<void> {
    if (actionToOutcome(log.action) !== 'GRANTED') return;
    await this.prisma.terminalUser
      .update({
        where: { deviceId_terminalUserId: { deviceId: context.deviceId, terminalUserId: log.terminalUserId } },
        data: { faceEnrolled: true, enrolledAt: parseDeviceTime(log.rawTime, context.timeZone) },
      })
      .catch((err) => this.logger.warn(`Could not confirm enrolment for slot ${log.terminalUserId}: ${err.message}`));
  }

  /** Move the backfill cursor forward, never backward. */
  private async advanceLogCursor(context: M50DeviceContext, logId: number): Promise<void> {
    if (context.lastLogId !== null && logId <= context.lastLogId) return;
    context.lastLogId = logId;
    await this.prisma.device
      .update({ where: { id: context.deviceId }, data: { lastLogId: logId } })
      .catch((err) => this.logger.warn(`Could not advance log cursor: ${err.message}`));
  }

  /**
   * Punch photos are opt-in per tenant (biometric data minimisation) and
   * uploaded after the ack — best effort, never blocking it (§4.3).
   */
  private async storePhoto(context: M50DeviceContext, log: TimeLogPayload, punchId: string, punchedAt: Date) {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: context.tenantId }, select: { settings: true } });
      if (!(tenant?.settings as any)?.storePunchPhotos) return;
      const key = `${context.tenantId}/${context.serialNo}/${log.logId}.jpg`;
      await this.supabase.upload(BUCKETS.punchPhotos(), key, Buffer.from(log.logImage!, 'base64'), 'image/jpeg');
      await this.prisma.punch.update({ where: { id_punchedAt: { id: punchId, punchedAt } }, data: { photoKey: key } });
    } catch (err) {
      this.logger.warn(`Punch photo for ${context.serialNo}/${log.logId} not stored: ${(err as Error).message}`);
    }
  }

  /**
   * AdminLog → audit row. The integration's only push signal for a keypad
   * enrolment, and it cannot be re-pulled from the device, so the caller acks
   * only after this returns.
   */
  async ingestAdminLog(context: M50DeviceContext, log: AdminLogPayload): Promise<void> {
    const timestamp = parseDeviceTime(log.rawTime, context.timeZone);
    const category = adminActionCategory(log.action);

    await this.prisma.auditLog.create({
      data: {
        tenantId: context.tenantId,
        siteId: context.siteId,
        actorUserId: null,
        actorType: 'device',
        action: `TERMINAL_${log.action.toUpperCase()}`,
        targetType: 'Device',
        targetId: context.deviceId,
        payload: {
          serialNo: context.serialNo,
          logId: log.logId,
          adminId: log.adminId,
          terminalUserId: log.terminalUserId,
          action: log.action,
          category,
          stat: log.stat,
          occurredAt: timestamp.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    await this.flagEnrolmentDrift(context, log, category);
  }

  /** Keypad activity that puts the hardware out of step with our mapping. */
  private async flagEnrolmentDrift(
    context: M50DeviceContext,
    log: AdminLogPayload,
    category: ReturnType<typeof adminActionCategory>,
  ): Promise<void> {
    if (category !== 'enrollment' && category !== 'deletion') return;
    if (log.terminalUserId <= 0) return;

    const mapping = await this.prisma.terminalUser.findUnique({
      where: { deviceId_terminalUserId: { deviceId: context.deviceId, terminalUserId: log.terminalUserId } },
    });

    if (category === 'deletion') {
      if (!mapping) return;
      // Keep the mapping so the slot number stays reserved; stop claiming a face is there.
      await this.setFaceEnrolled(context, log.terminalUserId, false);
      this.logger.warn(
        `Terminal ${context.serialNo}: ${log.action} removed UserID ${log.terminalUserId} at the keypad; ` +
          `employee ${mapping.subjectId} will no longer be recognised at this gate`,
      );
      return;
    }

    if (!mapping) {
      this.logger.warn(
        `Terminal ${context.serialNo}: ${log.action} enrolled UserID ${log.terminalUserId} at the keypad with no ` +
          `cloud mapping. Scans will record as UNKNOWN until the slot is claimed`,
      );
      return;
    }
    if (!mapping.faceEnrolled) await this.setFaceEnrolled(context, log.terminalUserId, true);
  }

  private async setFaceEnrolled(context: M50DeviceContext, terminalUserId: number, faceEnrolled: boolean): Promise<void> {
    await this.prisma.terminalUser
      .update({
        where: { deviceId_terminalUserId: { deviceId: context.deviceId, terminalUserId } },
        data: { faceEnrolled, enrolledAt: faceEnrolled ? new Date() : null },
      })
      .catch((err) => this.logger.warn(`Could not update enrolment state for slot ${terminalUserId} on ${context.serialNo}: ${err.message}`));
  }
}

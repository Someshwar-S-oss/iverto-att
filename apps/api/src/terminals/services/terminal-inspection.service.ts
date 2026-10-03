import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import type { M50Session } from '../m50-session';
import {
  AdminLogCategory,
  M50Command,
  M50Fields,
  M50ProtocolError,
  adminActionCategory,
  decodeTerminalName,
  mutatesEnrolment,
  parseDeviceTime,
  parseTimeLog,
} from '../protocol/m50-protocol';
import { TerminalSessionRegistry } from './terminal-session.registry';

/**
 * Commands are serialised one-at-a-time per device, so a long walk blocks
 * enrolment on that terminal for its duration. Read in modest pages.
 */
const MAX_LOG_PAGE = 200;
const DEFAULT_LOG_PAGE = 50;

/** Guard against firmware that never terminates the GetNextUserData cursor. */
const MAX_DEVICE_USERS = 60_000;

/** Admin logs are ordinary audit rows; keep a page sane. */
const MAX_ADMIN_LOG_PAGE = 500;
const DEFAULT_ADMIN_LOG_PAGE = 100;

/**
 * Prefix under which AdminLog events are filed in the audit trail
 * (`TERMINAL_ENTERMENU`, `TERMINAL_DELETEUSER`, …).
 */
const ADMIN_LOG_ACTION_PREFIX = 'TERMINAL_';

/**
 * Read-only window onto what a terminal itself holds.
 *
 * Everything here asks the device rather than our mirror of it, which is the
 * point: it answers "did that enrolment actually land on the hardware?" and
 * "what does the device think it has recorded?" — the two questions our own
 * tables cannot settle, because they are what drifts.
 *
 * Strictly non-mutating. The SDK's DeleteGlogWithPos is deliberately not
 * wired: the device's copy is the backstop that makes backfill possible.
 */
@Injectable()
export class TerminalInspectionService {
  private readonly logger = new Logger(TerminalInspectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: TerminalSessionRegistry,
  ) {}

  /** Device-reported health: firmware, record counts, capacity. */
  async deviceStatus(deviceId: string) {
    const { session, context } = this.requireSession(deviceId);
    const [status, glog] = [
      await session.command(M50Command.GetDeviceStatus),
      await session.command(M50Command.GetGlogPosInfo).catch(() => null),
    ];

    return {
      serialNo: context.serialNo,
      terminalType: context.terminalType,
      // Field names vary by firmware, so pass the device's own answer through
      // rather than pretending to a fixed schema.
      status,
      logs: glog
        ? {
            count: this.toInt(glog.LogCount),
            firstPos: this.toInt(glog.FirstPos),
            lastPos: this.toInt(glog.LastPos),
          }
        : null,
      /** Highest LogID we have durably ingested — compare against logs.count. */
      cursor: context.lastLogId,
    };
  }

  /**
   * What the device holds for one slot.
   *
   * `faceEnrolled` here is the terminal's own answer, which is the one that
   * matters — our TerminalUser.faceEnrolled is only what we believe. A
   * disagreement means someone changed things at the keypad.
   */
  async deviceUser(deviceId: string, terminalUserId: number) {
    const { session } = this.requireSession(deviceId);
    const fields = await session.command(M50Command.GetUserData, { UserID: terminalUserId });

    if (fields.Result === 'Fail') {
      return { terminalUserId, existsOnDevice: false };
    }

    const mapping = await this.prisma.terminalUser.findUnique({
      where: { deviceId_terminalUserId: { deviceId, terminalUserId } },
    });

    const faceEnrolled = fields.FaceEnrolled === 'Yes';
    return {
      terminalUserId,
      existsOnDevice: true,
      name: fields.Name ? decodeTerminalName(fields.Name) : null,
      privilege: fields.Privilege ?? null,
      enabled: fields.Enabled !== 'No',
      faceEnrolled,
      hasCard: Boolean(fields.Card),
      hasPassword: Boolean(fields.PWD),
      cloud: mapping
        ? {
            subjectType: mapping.subjectType,
            subjectId: mapping.subjectId,
            faceEnrolled: mapping.faceEnrolled,
            /** True when our record and the hardware disagree about the face. */
            drifted: mapping.faceEnrolled !== faceEnrolled,
          }
        : null,
    };
  }

  /**
   * The device's administration log, as we received it.
   *
   * These are the events that explain the state of the hardware: who entered
   * the menu, who enrolled or deleted a user at the keypad, when settings or
   * the clock changed. They are also the *only* signal that an at-the-device
   * enrolment completed — the SDK has no "enrolment finished" frame — so this
   * is where you look after asking someone to present their face.
   *
   * Unlike attendance logs, admin logs cannot be pulled back from the terminal:
   * the SDK offers `GetFirstGlog`/`GetNextGlog` for attendance and no
   * equivalent for administration. Anything the device emitted while we were
   * unreachable is gone, so `AdminLog_v2` is acknowledged only after the audit
   * row is committed, and this reads that trail rather than the device.
   */
  async adminLogs(
    deviceId: string,
    options: { limit?: number; skip?: number; category?: AdminLogCategory } = {},
  ) {
    const take = Math.min(Math.max(options.limit ?? DEFAULT_ADMIN_LOG_PAGE, 1), MAX_ADMIN_LOG_PAGE);
    const skip = Math.max(options.skip ?? 0, 0);

    const where = {
      targetType: 'Device',
      targetId: deviceId,
      actorType: 'device',
      action: { startsWith: ADMIN_LOG_ACTION_PREFIX },
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        // Category is derived from the payload rather than stored, so filtering
        // has to happen after the read. Over-fetch enough that a filtered page
        // is still usefully full.
        take: options.category ? Math.min(take * 5, MAX_ADMIN_LOG_PAGE * 5) : take,
        skip,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const decoded = rows.map((row) => this.decodeAdminLogRow(row));
    const filtered = options.category
      ? decoded.filter((entry) => entry.category === options.category)
      : decoded;
    const page = filtered.slice(0, take);

    return {
      total,
      returned: page.length,
      skip,
      records: await this.attributeAdminLogs(deviceId, page),
    };
  }

  private decodeAdminLogRow(row: {
    id: string;
    action: string;
    createdAt: Date;
    payload: unknown;
  }) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    // The device's own Action spelling, kept verbatim — row.action is the
    // upper-cased audit name and loses the original casing.
    const deviceAction = typeof payload.action === 'string' ? payload.action : row.action;

    return {
      id: row.id,
      /** When the device says it happened. Trust this over receivedAt. */
      occurredAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : null,
      /** When we committed it — a large gap means the terminal was offline. */
      receivedAt: row.createdAt.toISOString(),
      logId: this.numeric(payload.logId),
      action: deviceAction,
      category: adminActionCategory(deviceAction),
      /** True when the action changed who the device can recognise. */
      affectsEnrolment: mutatesEnrolment(deviceAction),
      /** Device-local number of the operator who performed it; 0 is the terminal itself. */
      adminId: this.numeric(payload.adminId),
      terminalUserId: this.numeric(payload.terminalUserId),
      /** Vendor status byte, 0-255. Meaning is action-specific and undocumented. */
      stat: typeof payload.stat === 'string' ? payload.stat : null,
      serialNo: typeof payload.serialNo === 'string' ? payload.serialNo : null,
    };
  }

  /** Resolve the subject and the operator a keypad action referred to. */
  private async attributeAdminLogs(
    deviceId: string,
    entries: ReturnType<TerminalInspectionService['decodeAdminLogRow']>[],
  ) {
    if (entries.length === 0) return entries.map((entry) => ({ ...entry, subject: null, admin: null }));

    const slots = [
      ...new Set(
        entries.flatMap((entry) => [entry.terminalUserId, entry.adminId]).filter((n): n is number => !!n),
      ),
    ];
    const mappings = slots.length
      ? await this.prisma.terminalUser.findMany({ where: { deviceId, terminalUserId: { in: slots } } })
      : [];
    const bySlot = new Map(mappings.map((m) => [m.terminalUserId, m]));

    const describe = (slot: number | null) => {
      if (slot === null || slot === 0) return null;
      const mapping = bySlot.get(slot);
      if (!mapping) return { terminalUserId: slot, subjectType: 'UNKNOWN', subjectId: null };
      return {
        terminalUserId: slot,
        subjectType: mapping.subjectType,
        subjectId: mapping.subjectId,
      };
    };

    return entries.map((entry) => ({
      ...entry,
      subject: describe(entry.terminalUserId),
      admin: describe(entry.adminId),
    }));
  }

  /**
   * The enrolment photo the terminal kept for a slot.
   *
   * Not the same thing as `GetFaceData`: that returns the opaque matching
   * template, which is useless to a human. This is a JPEG, which means an
   * unmapped slot is identifiable after the fact — somebody who knows the
   * staff can look at it and say who it is. That is what makes enrolling at
   * the device and binding afterwards a workable process rather than a guess.
   *
   * Firmware that is not configured to keep enrolment photos answers `Fail`;
   * that is reported rather than thrown, because "no photo" is a normal state.
   */
  async deviceUserPhoto(deviceId: string, terminalUserId: number) {
    const { session, context } = this.requireSession(deviceId);
    const fields = await session.command(M50Command.GetUserPhoto, { UserID: terminalUserId });

    const photo = fields.PhotoData;
    if (fields.Result === 'Fail' || !photo) {
      return {
        terminalUserId,
        serialNo: context.serialNo,
        hasPhoto: false,
        photoBase64: null,
        reason:
          'The terminal returned no photo for this slot. Either nothing is enrolled there, or ' +
          'the device is not configured to retain enrolment photos.',
      };
    }

    return {
      terminalUserId,
      serialNo: context.serialNo,
      hasPhoto: true,
      photoBase64: photo,
      reason: null,
    };
  }

  /**
   * Slots the terminal holds that we cannot name — the work queue for binding
   * device enrolments to employees.
   *
   * This is the backbone of the practical enrolment route. Somebody enrols at
   * the terminal, where the lighting and the live face are whatever they really
   * are; the device picks its own number; and this lists what turned up, with
   * enough evidence attached to identify it: the name typed at the keypad, when
   * the enrolment happened (from `AdminLog_v2`), and whether a photo can be
   * pulled. An operator then binds each one with POST users/{slot}/claim.
   *
   * Ordered by enrolment time so a bulk intake session comes back in the order
   * people actually queued.
   */
  async unclaimedSlots(deviceId: string) {
    const { session, context } = this.requireSession(deviceId);

    const onDevice = await this.walkDeviceUsers(session);
    const mapped = new Set(
      (await this.prisma.terminalUser.findMany({ where: { deviceId }, select: { terminalUserId: true } }))
        .map((m) => m.terminalUserId),
    );

    const unclaimed = onDevice.filter((user) => !mapped.has(user.terminalUserId));
    const enrolledAt = await this.enrolmentTimesFromAdminLog(deviceId);

    const slots = unclaimed
      .map((user) => ({
        terminalUserId: user.terminalUserId,
        /** Whatever was typed at the keypad. Often a number or blank — treat as a hint. */
        deviceName: user.name,
        privilege: user.privilege,
        faceEnrolled: user.faceEnrolled,
        /** From the device's own admin log; null when we were offline for it. */
        enrolledAt: enrolledAt.get(user.terminalUserId) ?? null,
        /** Pull it with GET device/users/{terminalUserId}/photo to identify the person. */
        photoEndpoint: `device/users/${user.terminalUserId}/photo`,
      }))
      .sort((a, b) => {
        if (a.enrolledAt && b.enrolledAt) return a.enrolledAt.localeCompare(b.enrolledAt);
        // Slots with no admin log evidence sort last: they are the older ones,
        // predating this integration.
        if (a.enrolledAt) return -1;
        if (b.enrolledAt) return 1;
        return a.terminalUserId - b.terminalUserId;
      });

    return {
      serialNo: context.serialNo,
      totalOnDevice: onDevice.length,
      unclaimed: slots.length,
      slots,
    };
  }

  /**
   * When each slot was last enrolled, according to the device's admin log.
   *
   * Read from the audit trail in one pass rather than with a JSON-path query
   * per slot: terminal admin logs are low-volume, and the alternative is a
   * query shape that has to change every time the payload does.
   */
  private async enrolmentTimesFromAdminLog(deviceId: string): Promise<Map<number, string>> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        targetType: 'Device',
        targetId: deviceId,
        actorType: 'device',
        action: { startsWith: ADMIN_LOG_ACTION_PREFIX },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_ADMIN_LOG_PAGE,
    });

    const times = new Map<number, string>();
    for (const row of rows) {
      const entry = this.decodeAdminLogRow(row);
      if (entry.category !== 'enrollment' || !entry.terminalUserId) continue;
      // Rows arrive newest first, so the first sighting of a slot is its latest
      // enrolment — do not let an older one overwrite it.
      if (times.has(entry.terminalUserId)) continue;
      times.set(entry.terminalUserId, entry.occurredAt ?? entry.receivedAt);
    }
    return times;
  }

  /**
   * Compare every slot the terminal holds against every slot we think it holds.
   *
   * This is the check that settles whether an enrolment landed on top of
   * somebody else. `unmappedOnDevice` is the one to read first: those are
   * people the hardware recognises and we cannot name, which is both how a
   * scan becomes `UNKNOWN` and — if we then allocate into one of those numbers
   * — how a scan gets attributed to the wrong person entirely.
   */
  async deviceUsers(deviceId: string) {
    const { session, context } = this.requireSession(deviceId);

    const onDevice = await this.walkDeviceUsers(session);
    const mappings = await this.prisma.terminalUser.findMany({ where: { deviceId } });
    const byDeviceSlot = new Map(onDevice.map((u) => [u.terminalUserId, u]));
    const byCloudSlot = new Map(mappings.map((m) => [m.terminalUserId, m]));
    const names = await this.resolveSubjectNames(mappings, context.tenantId);

    const slots = [...new Set([...byDeviceSlot.keys(), ...byCloudSlot.keys()])].sort((a, b) => a - b);

    const rows = slots.map((terminalUserId) => {
      const device = byDeviceSlot.get(terminalUserId);
      const cloud = byCloudSlot.get(terminalUserId);
      const cloudName = cloud ? names.get(`${cloud.subjectType}:${cloud.subjectId}`) ?? null : null;

      return {
        terminalUserId,
        onDevice: Boolean(device),
        deviceName: device?.name ?? null,
        deviceFaceEnrolled: device?.faceEnrolled ?? null,
        privilege: device?.privilege ?? null,
        cloud: cloud
          ? {
              subjectType: cloud.subjectType,
              subjectId: cloud.subjectId,
              subjectName: cloudName,
              faceEnrolled: cloud.faceEnrolled,
              enrolledAt: cloud.enrolledAt?.toISOString() ?? null,
              createdAt: cloud.createdAt.toISOString(),
            }
          : null,
        // The names disagreeing is the strongest single indicator that this
        // slot was written over somebody: the device still carries the label
        // the previous occupant was enrolled under.
        nameMismatch: Boolean(
          device?.name && cloudName && device.name.trim() !== cloudName.trim(),
        ),
        faceDrift: Boolean(cloud && device && cloud.faceEnrolled !== device.faceEnrolled),
      };
    });

    return {
      serialNo: context.serialNo,
      totalOnDevice: onDevice.length,
      totalInCloud: mappings.length,
      summary: {
        /** Slots the hardware has and we do not — scans from these read UNKNOWN. */
        unmappedOnDevice: rows.filter((r) => r.onDevice && !r.cloud).map((r) => r.terminalUserId),
        /** Slots we believe in that the hardware does not have — these subjects cannot pass. */
        missingOnDevice: rows.filter((r) => !r.onDevice && r.cloud).map((r) => r.terminalUserId),
        /** Both sides have the slot but name it differently — likely overwritten. */
        nameMismatch: rows.filter((r) => r.nameMismatch).map((r) => r.terminalUserId),
        /** Both sides disagree about whether a face is enrolled. */
        faceDrift: rows.filter((r) => r.faceDrift).map((r) => r.terminalUserId),
      },
      slots: rows,
    };
  }

  /**
   * Walk the terminal's whole user list.
   *
   * The cursor lives on the device and takes no position argument, so this
   * cannot be resumed or paged — and since commands are serialised per device,
   * it blocks enrolment on that terminal for its duration.
   */
  private async walkDeviceUsers(session: M50Session) {
    const users: Array<{
      terminalUserId: number;
      name: string | null;
      privilege: string | null;
      faceEnrolled: boolean;
    }> = [];

    let fields: M50Fields | null = await session.command(M50Command.GetFirstUserData);

    while (fields && fields.Result !== 'Fail' && users.length < MAX_DEVICE_USERS) {
      const terminalUserId = Number.parseInt(fields.UserID ?? '', 10);
      if (Number.isFinite(terminalUserId)) {
        users.push({
          terminalUserId,
          name: fields.Name ? decodeTerminalName(fields.Name) : null,
          privilege: fields.Privilege ?? null,
          faceEnrolled: fields.FaceEnrolled === 'Yes',
        });
      }
      // <More>No</More> ends the walk; some firmware just answers Fail instead.
      if (fields.More === 'No') break;
      fields = await session.command(M50Command.GetNextUserData);
    }

    return users;
  }

  /** Batch-resolve employee names for the slots a device is mapped to. */
  private async resolveSubjectNames(
    mappings: Array<{ subjectType: string; subjectId: string }>,
    tenantId: string,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (mappings.length === 0) return names;
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: mappings.map((m) => m.subjectId) }, tenantId },
      select: { id: true, fullName: true },
    });
    for (const e of employees) names.set(`EMPLOYEE:${e.id}`, e.fullName);
    return names;
  }

  private numeric(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Page through the attendance log stored on the device.
   *
   * This does not ingest and does not advance the backfill cursor — it is a
   * viewer. `from` is a *position* in the device's ring, not a LogID: the two
   * are different namespaces, and paging by LogID skips records on any device
   * whose log has been trimmed.
   */
  async deviceLogs(deviceId: string, options: { from?: number; limit?: number } = {}) {
    const { session, context } = this.requireSession(deviceId);
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LOG_PAGE, 1), MAX_LOG_PAGE);
    const from = options.from ?? 0;

    const posInfo = await session.command(M50Command.GetGlogPosInfo).catch(() => null);

    const records: any[] = [];
    let position = from;
    let fields = await session.command(M50Command.GetFirstGlog, { BeginLogPos: position });

    while (fields && fields.Result !== 'Fail' && records.length < limit) {
      try {
        const log = parseTimeLog(fields);
        records.push({
          logId: log.logId,
          terminalUserId: log.terminalUserId,
          // Both the device's own string and our interpretation of it, because
          // the protocol stamps a trailing "Z" it does not honour — seeing them
          // side by side is how a timezone misconfiguration becomes obvious.
          rawTime: log.rawTime,
          timestamp: this.safeTime(log.rawTime, context.timeZone),
          action: log.action,
          attendStat: log.attendStat,
          // Deliberately omitting logImage: it is a base64 JPEG per record and
          // would dwarf everything else in this response.
          hasPhoto: Boolean(log.logImage),
        });
      } catch (err) {
        if (err instanceof M50ProtocolError) {
          // No LogID means no way to advance past it, so stop cleanly with what
          // we have rather than spinning on the same record.
          this.logger.warn(`Unreadable record on ${context.serialNo}: ${err.message}`);
          break;
        }
        throw err;
      }

      if (records.length >= limit) break;
      position++;
      fields = await session.command(M50Command.GetNextGlog, { BeginLogPos: position });
    }

    return {
      serialNo: context.serialNo,
      totalOnDevice: posInfo ? this.toInt(posInfo.LogCount) : null,
      from,
      returned: records.length,
      /** A position, to hand straight back as `from`. Null when the log ran out. */
      nextFrom: records.length === limit ? from + records.length : null,
      records: await this.attributeRecords(deviceId, records),
    };
  }

  /** Resolve device-local slot numbers to the people they map to, in one query. */
  private async attributeRecords(deviceId: string, records: any[]) {
    if (records.length === 0) return records;

    const slots = [...new Set(records.map((r) => r.terminalUserId))];
    const mappings = await this.prisma.terminalUser.findMany({
      where: { deviceId, terminalUserId: { in: slots } },
    });
    const bySlot = new Map(mappings.map((m) => [m.terminalUserId, m]));

    return records.map((record) => {
      const mapping = bySlot.get(record.terminalUserId);
      return {
        ...record,
        subjectType: mapping?.subjectType ?? 'UNKNOWN',
        subjectId: mapping?.subjectId ?? null,
      };
    });
  }

  private safeTime(raw: string, timeZone: string): string | null {
    try {
      return parseDeviceTime(raw, timeZone).toISOString();
    } catch {
      return null;
    }
  }

  private toInt(value: string | undefined): number | null {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private requireSession(deviceId: string) {
    let session: M50Session;
    try {
      session = this.sessions.require(deviceId);
    } catch {
      throw new ServiceUnavailableException(`Terminal ${deviceId} is not currently connected`);
    }
    return { session, context: session.requireContext() };
  }
}

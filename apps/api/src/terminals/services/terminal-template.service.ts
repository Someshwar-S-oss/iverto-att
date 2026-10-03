import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditableActionService } from '../../audit/audit.service';
import type { AuditActor } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma.service';
import type { CaptureTemplatesDto, DistributeTemplatesDto, SubjectRefDto } from '../dto/terminal.dto';
import { MAX_TEMPLATE_BATCH } from '../dto/terminal.dto';
import { TEMPLATE_VENDOR, TerminalEnrollmentService } from './terminal-enrollment.service';
import { TerminalSessionRegistry } from './terminal-session.registry';

/**
 * Moving face templates around the fleet in batches.
 *
 * The single-subject, single-device endpoints are the primitives and stay
 * correct, but they are the wrong shape for the two things an operator does in
 * practice: put one person on every gate, and populate a gate that was just
 * installed from the terminal that already has everybody. Doing either through
 * the primitives means the browser driving a loop of requests — which is what
 * "go into each device's settings and pull each employee" actually is.
 *
 * Batching it here also puts the work next to the per-device command queues, so
 * devices proceed in parallel while each device's own commands stay serialised.
 */

/** Per-device state for one subject, as our tables record it. */
export interface CoverageSlot {
  deviceId: string;
  terminalUserId: number;
  faceEnrolled: boolean;
}

export interface CoverageSubject {
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  hasTemplate: boolean;
  templateCapturedAt: string | null;
  templateSourceDeviceId: string | null;
  slots: CoverageSlot[];
}

export interface CoverageDevice {
  id: string;
  serialNo: string;
  name: string | null;
  siteId: string;
  gateName: string;
  direction: string;
  online: boolean;
}

export interface TemplateCoverage {
  devices: CoverageDevice[];
  subjects: CoverageSubject[];
}

export type CaptureStatus = 'stored' | 'no-face' | 'skipped' | 'failed';
export type PushStatus = 'pushed' | 'skipped' | 'no-template' | 'device-offline' | 'failed';

export interface CaptureResult {
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  status: CaptureStatus;
  error?: string;
}

export interface PushResult {
  deviceId: string;
  serialNo: string;
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  status: PushStatus;
  error?: string;
}

export interface DistributeOutcome {
  captured: CaptureResult[];
  pushed: PushResult[];
  summary: {
    stored: number;
    pushedCount: number;
    skipped: number;
    failed: number;
    offlineDeviceIds: string[];
  };
}

@Injectable()
export class TerminalTemplateService {
  private readonly logger = new Logger(TerminalTemplateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly enrollment: TerminalEnrollmentService,
    private readonly sessions: TerminalSessionRegistry,
  ) {}

  /**
   * Who has a stored template, and which terminals hold their face.
   *
   * Answered entirely from our own tables: the point is to decide what to move
   * before touching any hardware, and a matrix that had to walk every device
   * would take longer than the transfer it is planning. Anything the devices
   * have drifted from is repaired by "Check the device" on the terminal itself.
   */
  async coverage(tenantId: string): Promise<TemplateCoverage> {
    const [devices, mappings, templates] = await Promise.all([
      this.prisma.device.findMany({
        where: { tenantId },
        orderBy: { serialNo: 'asc' },
        select: { id: true, serialNo: true, name: true, siteId: true, gateName: true, direction: true },
      }),
      this.prisma.terminalUser.findMany({
        where: { tenantId, releasedAt: null },
        select: {
          deviceId: true,
          terminalUserId: true,
          faceEnrolled: true,
          subjectType: true,
          subjectId: true,
        },
      }),
      // Deliberately not selecting `template`: the blob is the largest column in
      // the schema and nothing on this screen renders it.
      this.prisma.terminalFaceTemplate.findMany({
        where: { tenantId, vendor: TEMPLATE_VENDOR, status: 'active' },
        select: { subjectType: true, subjectId: true, sourceDeviceId: true, updatedAt: true },
      }),
    ]);

    const key = (subjectType: string, subjectId: string) => `${subjectType}:${subjectId}`;
    const subjects = new Map<string, CoverageSubject>();

    const upsert = (subjectType: string, subjectId: string): CoverageSubject => {
      const k = key(subjectType, subjectId);
      let row = subjects.get(k);
      if (!row) {
        row = {
          subjectType,
          subjectId,
          subjectName: null,
          hasTemplate: false,
          templateCapturedAt: null,
          templateSourceDeviceId: null,
          slots: [],
        };
        subjects.set(k, row);
      }
      return row;
    };

    for (const mapping of mappings) {
      upsert(mapping.subjectType, mapping.subjectId).slots.push({
        deviceId: mapping.deviceId,
        terminalUserId: mapping.terminalUserId,
        faceEnrolled: mapping.faceEnrolled,
      });
    }
    for (const template of templates) {
      const row = upsert(template.subjectType, template.subjectId);
      row.hasTemplate = true;
      row.templateCapturedAt = template.updatedAt.toISOString();
      row.templateSourceDeviceId = template.sourceDeviceId;
    }

    await this.attachNames(tenantId, [...subjects.values()]);

    return {
      devices: devices.map((device) => ({ ...device, online: this.sessions.isOnline(device.id) })),
      subjects: [...subjects.values()].sort((a, b) =>
        (a.subjectName || a.subjectId).localeCompare(b.subjectName || b.subjectId),
      ),
    };
  }

  /** Harvest several subjects' templates off one terminal. */
  async captureMany(
    tenantId: string,
    dto: CaptureTemplatesDto,
    actor: AuditActor,
  ): Promise<{ captured: CaptureResult[]; summary: { stored: number; failed: number; skipped: number } }> {
    await this.requireTenantDevices(tenantId, [dto.sourceDeviceId]);
    const names = await this.subjectNames(tenantId, dto.subjects);
    const captured = await this.captureStage(tenantId, dto.sourceDeviceId, dto.subjects, names, actor, {
      refresh: dto.refresh ?? false,
    });

    const summary = {
      stored: captured.filter((c) => c.status === 'stored').length,
      failed: captured.filter((c) => c.status === 'failed').length,
      skipped: captured.filter((c) => c.status === 'skipped').length,
    };

    await this.recordBatch(tenantId, actor, 'TERMINAL_CAPTURE_TEMPLATE_BATCH', {
      sourceDeviceId: dto.sourceDeviceId,
      subjects: dto.subjects.length,
      ...summary,
    });

    return { captured, summary };
  }

  /**
   * Put the selected people onto the selected terminals.
   *
   * With `sourceDeviceId` this is the whole "pull from one gate, push to the
   * rest" errand in one request; without it, it replays what is already stored.
   */
  async distribute(
    tenantId: string,
    dto: DistributeTemplatesDto,
    actor: AuditActor,
  ): Promise<DistributeOutcome> {
    const operations = dto.subjects.length * dto.deviceIds.length;
    if (operations > MAX_TEMPLATE_BATCH) {
      throw new BadRequestException(
        `${operations} operations requested (${dto.subjects.length} people × ${dto.deviceIds.length} ` +
          `terminals); the limit is ${MAX_TEMPLATE_BATCH} per request. Split the selection.`,
      );
    }

    const deviceIds = [...new Set(dto.deviceIds)];
    const devices = await this.requireTenantDevices(
      tenantId,
      dto.sourceDeviceId ? [...deviceIds, dto.sourceDeviceId] : deviceIds,
    );
    const serialOf = new Map(devices.map((d) => [d.id, d.serialNo]));
    const names = await this.subjectNames(tenantId, dto.subjects);
    const skipEnrolled = dto.skipEnrolled ?? true;

    // Stage 1: fill the gaps, so the push stage has something to send. Only for
    // subjects with nothing stored — a template that exists is as good as any
    // other copy of it, and re-reading costs a device round trip per person.
    const captured = dto.sourceDeviceId
      ? await this.captureStage(tenantId, dto.sourceDeviceId, dto.subjects, names, actor, { refresh: false })
      : [];

    const stored = await this.storedSubjectKeys(tenantId, dto.subjects);
    const alreadyEnrolled = skipEnrolled
      ? await this.enrolledPairs(deviceIds, dto.subjects)
      : new Set<string>();

    const offlineDeviceIds = deviceIds.filter((id) => !this.sessions.isOnline(id));

    // Devices run in parallel; each device's own commands are serialised by its
    // session queue, so a terminal is never asked for two things at once.
    const perDevice = await Promise.all(
      deviceIds.map((deviceId) =>
        this.pushStage(deviceId, serialOf.get(deviceId) || deviceId, dto.subjects, names, actor, {
          offline: offlineDeviceIds.includes(deviceId),
          stored,
          alreadyEnrolled,
        }),
      ),
    );
    const pushed = perDevice.flat();

    const summary = {
      stored: captured.filter((c) => c.status === 'stored').length,
      pushedCount: pushed.filter((p) => p.status === 'pushed').length,
      skipped: pushed.filter((p) => p.status === 'skipped').length,
      failed:
        pushed.filter((p) => p.status === 'failed').length +
        captured.filter((c) => c.status === 'failed').length,
      offlineDeviceIds,
    };

    await this.recordBatch(tenantId, actor, 'TERMINAL_DISTRIBUTE_TEMPLATES', {
      sourceDeviceId: dto.sourceDeviceId ?? null,
      deviceIds,
      subjects: dto.subjects.length,
      ...summary,
    });

    this.logger.log(
      `Distributed templates for ${dto.subjects.length} subject(s) across ${deviceIds.length} ` +
        `terminal(s): ${summary.pushedCount} pushed, ${summary.skipped} already there, ${summary.failed} failed`,
    );

    return { captured, pushed, summary };
  }

  // ── Stages ─────────────────────────────────────────────────────────────────

  private async captureStage(
    tenantId: string,
    sourceDeviceId: string,
    subjects: SubjectRefDto[],
    names: Map<string, string | null>,
    actor: AuditActor,
    options: { refresh: boolean },
  ): Promise<CaptureResult[]> {
    const existing = options.refresh
      ? new Set<string>()
      : await this.storedSubjectKeys(tenantId, subjects);

    const results: CaptureResult[] = [];
    // Sequential: these all land on one device, and its queue would serialise
    // them anyway. Doing it here keeps the failure of one person from being
    // reported against another.
    for (const subject of subjects) {
      const k = this.key(subject);
      const base = {
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        subjectName: names.get(k) ?? null,
      };
      if (existing.has(k)) {
        results.push({ ...base, status: 'skipped' });
        continue;
      }
      try {
        const { stored } = await this.enrollment.captureTemplate(
          sourceDeviceId,
          subject.subjectType,
          subject.subjectId,
          actor,
        );
        results.push({ ...base, status: stored ? 'stored' : 'no-face' });
      } catch (err) {
        results.push({ ...base, status: 'failed', error: this.reason(err) });
      }
    }
    return results;
  }

  private async pushStage(
    deviceId: string,
    serialNo: string,
    subjects: SubjectRefDto[],
    names: Map<string, string | null>,
    actor: AuditActor,
    context: { offline: boolean; stored: Set<string>; alreadyEnrolled: Set<string> },
  ): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (const subject of subjects) {
      const k = this.key(subject);
      const base = {
        deviceId,
        serialNo,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        subjectName: names.get(k) ?? null,
      };

      // Reported once per subject rather than as N identical failures, so the
      // screen says "this terminal is offline" instead of burying it.
      if (context.offline) {
        results.push({ ...base, status: 'device-offline' });
        continue;
      }
      if (context.alreadyEnrolled.has(`${deviceId}:${k}`)) {
        results.push({ ...base, status: 'skipped' });
        continue;
      }
      if (!context.stored.has(k)) {
        results.push({ ...base, status: 'no-template' });
        continue;
      }
      try {
        await this.enrollment.replicateTemplate(
          deviceId,
          subject.subjectType,
          subject.subjectId,
          actor,
        );
        results.push({ ...base, status: 'pushed' });
      } catch (err) {
        results.push({ ...base, status: 'failed', error: this.reason(err) });
      }
    }
    return results;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private key(subject: { subjectType: string; subjectId: string }): string {
    return `${subject.subjectType}:${subject.subjectId}`;
  }

  /**
   * The device ids arrive in a request body rather than the path, so nothing
   * upstream has checked them against the tenant in the URL.
   */
  private async requireTenantDevices(tenantId: string, deviceIds: string[]) {
    const unique = [...new Set(deviceIds)];
    const devices = await this.prisma.device.findMany({
      where: { id: { in: unique }, tenantId },
      select: { id: true, serialNo: true },
    });
    if (devices.length !== unique.length) {
      const found = new Set(devices.map((d) => d.id));
      const missing = unique.filter((id) => !found.has(id));
      throw new NotFoundException(`Unknown terminal(s) for this tenant: ${missing.join(', ')}`);
    }
    return devices;
  }

  /** Which of these subjects already have an active stored template. */
  private async storedSubjectKeys(tenantId: string, subjects: SubjectRefDto[]): Promise<Set<string>> {
    const rows = await this.prisma.terminalFaceTemplate.findMany({
      where: {
        tenantId,
        vendor: TEMPLATE_VENDOR,
        status: 'active',
        OR: subjects.map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId })),
      },
      select: { subjectType: true, subjectId: true },
    });
    return new Set(rows.map((r) => this.key(r)));
  }

  /** `deviceId:subjectType:subjectId` for every pair the device already has a face for. */
  private async enrolledPairs(deviceIds: string[], subjects: SubjectRefDto[]): Promise<Set<string>> {
    const rows = await this.prisma.terminalUser.findMany({
      where: {
        deviceId: { in: deviceIds },
        faceEnrolled: true,
        OR: subjects.map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId })),
      },
      select: { deviceId: true, subjectType: true, subjectId: true },
    });
    return new Set(rows.map((r) => `${r.deviceId}:${this.key(r)}`));
  }

  private async subjectNames(
    tenantId: string,
    subjects: SubjectRefDto[],
  ): Promise<Map<string, string | null>> {
    const rows: CoverageSubject[] = subjects.map((s) => ({
      subjectType: s.subjectType,
      subjectId: s.subjectId,
      subjectName: null,
      hasTemplate: false,
      templateCapturedAt: null,
      templateSourceDeviceId: null,
      slots: [],
    }));
    await this.attachNames(tenantId, rows);
    return new Map(rows.map((r) => [this.key(r), r.subjectName]));
  }

  /** One lookup for the whole batch rather than one per subject. */
  private async attachNames(tenantId: string, rows: CoverageSubject[]): Promise<void> {
    const employees = await this.prisma.employee.findMany({
      where: { tenantId, id: { in: rows.map((r) => r.subjectId) } },
      select: { id: true, fullName: true, employeeCode: true },
    });
    const names = new Map(employees.map((e) => [e.id, `${e.fullName} (${e.employeeCode})`]));
    for (const row of rows) row.subjectName = names.get(row.subjectId) ?? null;
  }

  /**
   * One audit row for the batch. The per-subject writes audit themselves, but a
   * bulk biometric movement should also be legible as the single act it was.
   */
  private async recordBatch(
    tenantId: string,
    actor: AuditActor,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.run({
      action,
      targetType: 'TerminalFaceTemplate',
      actor,
      tenantId,
      payloadFrom: () => payload,
      run: async () => null,
    });
  }

  private reason(err: unknown): string {
    const response = (err as { response?: { message?: string | string[] } })?.response?.message;
    if (Array.isArray(response)) return response.join(', ');
    if (response) return response;
    return (err as Error)?.message || 'Command failed';
  }
}

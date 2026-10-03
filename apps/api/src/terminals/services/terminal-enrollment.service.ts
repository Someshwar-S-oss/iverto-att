import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Employee } from '@prisma/client';
import { RecomputeQueue } from '../../attendance/recompute.service';
import { AuditableActionService } from '../../audit/audit.service';
import type { AuditActor } from '../../auth/auth.types';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { addDays, localYmd } from '../../common/time';
import type { M50Session } from '../m50-session';
import {
  M50Command,
  M50Fields,
  adminActionCategory,
  decodeTerminalName,
  encodeTerminalName,
  encodeUserPeriod,
} from '../protocol/m50-protocol';
import { TerminalSessionRegistry } from './terminal-session.registry';

/** Namespace for template portability: only same-vendor terminals can consume these. */
export const TEMPLATE_VENDOR = 'm50';

/** The SDK caps EnrollFaceByPhoto payloads at 32KB of JPEG. */
const MAX_PHOTO_BYTES = 32 * 1024;

/**
 * Ceiling on a full user-list walk. Guards against firmware that never
 * terminates the cursor; it is not a real capacity limit.
 */
const MAX_DEVICE_USERS = 60_000;

/** Interactive enrolment waits for a person to present their face at the device. */
const REMOTE_ENROLL_TIMEOUT_MS = 90_000;
const PHOTO_ENROLL_TIMEOUT_MS = 45_000;

export type EnrollBackup = 'RemoteEnrollFace' | 'RemoteEnrollFP' | 'RemoteEnrollCard';

/** What the terminal said when asked to enter enrolment mode, and what it means. */
export interface RemoteEnrollOutcome {
  /** True only for `Success` — the device entered enrolment mode. */
  accepted: boolean;
  /** The slot provisioned for this subject, whether or not enrolment started. */
  terminalUserId: number;
  /** The device's own `ResultCode`, passed through verbatim. */
  resultCode: string;
  enrollmentModeActive: boolean;
  detail: string;
  nextStep: string;
}

/** What binding an existing device slot to a subject actually achieved. */
export interface ClaimOutcome {
  terminalUserId: number;
  subjectType: string;
  subjectId: string;
  subjectName: string;
  /** The terminal's own answer, not an assumption. */
  faceEnrolled: boolean;
  /** What the slot was called on the device before the claim — the evidence trail. */
  deviceNameAtClaim: string | null;
  renamedOnDevice: boolean;
  templateCaptured: boolean;
  /** UNKNOWN punches from this slot now attributed to the employee. */
  retroAttributed?: number;
  /** Non-fatal problems: the mapping is committed regardless. */
  warnings: string[];
}

/** One mapped slot whose enrolment state the device disagreed with. */
export interface EnrolmentSyncChange {
  terminalUserId: number;
  subjectType: string;
  subjectId: string;
}

/** What a reconciliation pass found on the hardware and wrote back. */
export interface EnrolmentSyncOutcome {
  serialNo: string;
  totalOnDevice: number;
  totalMapped: number;
  /** Slots we recorded as empty that the device holds a face for - now marked enrolled. */
  confirmed: EnrolmentSyncChange[];
  /** Slots we recorded as enrolled that the device no longer has a face for. */
  cleared: EnrolmentSyncChange[];
  /** Mapped slots the device does not have at all: deleted at the keypad, or wiped. */
  missingOnDevice: EnrolmentSyncChange[];
  /** Slots the device holds that nothing is bound to - these scan as UNKNOWN. */
  unmapped: number[];
}

/** Plain-language readings of the SDK's RemoteEnroll ResultCode enum. */
const REMOTE_ENROLL_RESULT_NOTES: Record<string, string> = {
  EnrollNumberError:
    'The terminal could not determine which user number to enrol into. RemoteEnroll carries no ' +
    'UserID in the SDK, so this is the expected answer on this hardware rather than a fault.',
  DatabaseFull: 'The terminal has no free user slots left.',
  FaceAlreadyEnrolled: 'That face is already enrolled on this terminal, under some slot.',
  FPAlreadyEnrolled: 'That fingerprint is already enrolled on this terminal.',
  FPAllEnrolled: 'All fingerprint slots for that user are already used.',
  CardAlreadyEnrolled: 'That card is already enrolled on this terminal.',
  InvalidFingerNumber: 'FingerNo was outside 0-9.',
  MenuProcessing: 'Somebody is using the terminal menu; enrolment cannot start until they exit.',
  RemoteEnrollAlreadyStarted:
    'An enrolment is already in progress. POST enroll/cancel to clear it, then retry.',
  Unknown: 'The terminal reported an unspecified failure.',
};

/** One row of the terminal's own user table, as the walk reads it. */
interface DeviceUserRecord {
  terminalUserId: number;
  name: string | null;
  faceEnrolled: boolean;
}

@Injectable()
export class TerminalEnrollmentService {
  private readonly logger = new Logger(TerminalEnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly sessions: TerminalSessionRegistry,
    private readonly recompute: RecomputeQueue,
  ) {}

  /**
   * The employee's validity window on the device (§4.3): joining date → exit
   * date, so a terminal that is offline during offboarding still refuses them.
   */
  private userFields(employee: Employee) {
    const pack = (d: Date) => encodeUserPeriod(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    return {
      Name: encodeTerminalName(employee.fullName),
      Privilege: 'User',
      Enabled: 'Yes',
      AllowNoCertificate: 'Yes',
      UserPeriod_Used: 'Yes',
      UserPeriod_Start: pack(employee.joinedOn),
      // No exit date: open-ended, as far as the packed format reaches.
      UserPeriod_End: employee.exitOn ? pack(employee.exitOn) : encodeUserPeriod(2099, 12, 31),
    };
  }

  // ── Subject provisioning ───────────────────────────────────────────────────

  /**
   * Create (or reuse) this subject's slot on a terminal and push their name.
   *
   * `AllowNoCertificate` is required here: without it the terminal rejects a
   * user record that carries no biometric or card yet, which is precisely the
   * state we are creating before enrolling a face.
   */
  async provisionSubject(
    deviceId: string,
    subjectType: string,
    subjectId: string,
    actor: AuditActor,
  ): Promise<{ terminalUserId: number; subjectName: string }> {
    const { session, context } = this.requireSession(deviceId);
    const employee = await this.resolveEmployee(subjectId, context.tenantId);
    const subjectName = employee.fullName;
    if (!employee.biometricConsentAt) {
      // DPDP / GDPR: no face on a terminal without recorded consent (§17).
      throw new AppError(409, 'BIOMETRIC_CONSENT_REQUIRED', "Record the employee's biometric consent before enrolling");
    }
    if (employee.status !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_EXITED', 'Employee has exited');

    const existing = await this.prisma.terminalUser.findUnique({
      where: { deviceId_subjectType_subjectId: { deviceId, subjectType, subjectId } },
    });
    const terminalUserId =
      existing?.terminalUserId ?? (await this.allocateTerminalUserId(session, deviceId));

    // Claim the slot in our table *before* writing it to the hardware. The
    // reverse order — which this used to do — loses a race in the worst
    // possible way: two concurrent enrolments compute the same free number,
    // both write their own name into that slot on the device, and only then
    // does the unique index reject the loser. The device is left holding the
    // loser's name and face while our mapping points that slot at the winner,
    // so scans by either person are attributed to the winner. Reserving first
    // means the loser fails before it can touch the device at all.
    if (!existing) {
      try {
        await this.audit.run({
          action: 'TERMINAL_PROVISION_USER',
          targetType: 'TerminalUser',
          actor,
          tenantId: context.tenantId,
          siteId: context.siteId,
          payloadFrom: () => ({ terminalUserId, subjectType, subjectId, serialNo: context.serialNo }),
          run: (tx) =>
            tx.terminalUser.create({
              data: { tenantId: context.tenantId, deviceId, terminalUserId, subjectType, subjectId },
            }),
        });
      } catch (err) {
        // Either unique index can fire: another request took this slot number,
        // or another request is provisioning this same subject. Both are
        // transient conflicts a retry resolves, not server faults.
        if ((err as { code?: string }).code === 'P2002') {
          throw new ConflictException(
            `Slot ${terminalUserId} on ${context.serialNo} was claimed concurrently; retry`,
          );
        }
        throw err;
      }
    }

    try {
      const response = await session.command(M50Command.SetUserData, {
        UserID: terminalUserId,
        Type: 'Set',
        ...this.userFields(employee),
      });
      this.assertOk(response, M50Command.SetUserData);
      // A rejoining employee gets their old (reserved) slot back.
      if (existing?.releasedAt) {
        await this.prisma.terminalUser.update({ where: { id: existing.id }, data: { releasedAt: null } });
      }
    } catch (err) {
      // Release a reservation the device never accepted, so the slot number is
      // not burned and the caller can retry cleanly.
      if (!existing) {
        await this.prisma.terminalUser
          .delete({
            where: { deviceId_subjectType_subjectId: { deviceId, subjectType, subjectId } },
          })
          .catch(() => undefined);
      }
      throw err;
    }

    return { terminalUserId, subjectName };
  }

  /**
   * Pick a slot that is free *on the terminal*.
   *
   * Our own table is not sufficient evidence of that. A device commissioned
   * before the cloud existed — or one where anybody ever enrolled at the
   * keypad — holds users we have no row for, so `max(ours) + 1` happily lands
   * on an occupied slot. `SetUserData` then overwrites that person's name while
   * the face already in the slot survives: the original person keeps opening
   * the gate, the device keeps reporting their old UserID, and we attribute
   * every one of those scans to whoever we just wrote in. That is the failure
   * that presents as "the auth log names the wrong employee".
   *
   * So: guess from our table (cheap, and correct on a device we exclusively
   * own), verify the guess against the hardware, and walk the full user list
   * only when the guess turns out to be occupied.
   */
  private async allocateTerminalUserId(session: M50Session, deviceId: string): Promise<number> {
    const highest = await this.prisma.terminalUser.findFirst({
      where: { deviceId },
      orderBy: { terminalUserId: 'desc' },
      select: { terminalUserId: true },
    });
    // UserID 0 is reserved for the terminal administrator.
    const candidate = (highest?.terminalUserId ?? 0) + 1;

    if (!(await this.slotOccupiedOnDevice(session, candidate))) {
      return candidate;
    }

    // The device knows people we do not. Find its true high-water mark so the
    // new slot sits above everything either side already holds.
    const occupied = await this.listDeviceSlots(session);
    const deviceHigh = occupied.length ? Math.max(...occupied) : 0;
    const allocated = Math.max(candidate, deviceHigh + 1);
    this.logger.warn(
      `Terminal ${session.requireContext().serialNo} already holds slot ${candidate}, which the ` +
        `cloud has no mapping for — ${occupied.length} slot(s) exist on the device. Allocating ` +
        `${allocated} rather than overwriting; GET device/users lists the unmapped ones.`,
    );
    return allocated;
  }

  /** Does the terminal already have a user record at this number? */
  private async slotOccupiedOnDevice(session: M50Session, terminalUserId: number): Promise<boolean> {
    try {
      const fields = await session.command(M50Command.GetUserData, { UserID: terminalUserId });
      return fields.Result !== 'Fail';
    } catch (err) {
      // A terminal that will not answer cannot be safely written to either —
      // refusing beats overwriting a slot we were unable to inspect.
      throw new ServiceUnavailableException(
        `Could not verify slot ${terminalUserId} on the terminal: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Every user number the terminal itself holds.
   *
   * `GetFirstUserData`/`GetNextUserData` is a stateful cursor on the device with
   * no position argument, so the walk cannot be resumed or parallelised — and
   * because commands are serialised per device, it blocks other enrolments on
   * that terminal for its duration. Called only once the cheap check has shown
   * the two sides disagree.
   *
   * `TerminalInspectionService` walks the same cursor for the read path; this
   * copy exists so the write path does not depend on it.
   */
  private async walkDeviceUsers(session: M50Session): Promise<DeviceUserRecord[]> {
    const users: DeviceUserRecord[] = [];
    let fields = await session.command(M50Command.GetFirstUserData);

    while (fields && fields.Result !== 'Fail' && users.length < MAX_DEVICE_USERS) {
      const id = Number.parseInt(fields.UserID ?? '', 10);
      if (Number.isFinite(id)) {
        users.push({
          terminalUserId: id,
          name: fields.Name ? decodeTerminalName(fields.Name) : null,
          faceEnrolled: fields.FaceEnrolled === 'Yes',
        });
      }
      // <More>No</More> ends the walk; some firmware simply answers Fail.
      if (fields.More === 'No') break;
      fields = await session.command(M50Command.GetNextUserData);
    }

    return users;
  }

  /** Allocation needs the numbers and nothing else. */
  private async listDeviceSlots(session: M50Session): Promise<number[]> {
    return (await this.walkDeviceUsers(session)).map((u) => u.terminalUserId);
  }

  // -- Reconciliation ---------------------------------------------------------

  /**
   * Make our record of who is enrolled agree with the hardware's.
   *
   * The gap this closes: reserving a slot from the cloud creates an empty named
   * record, somebody then enrols a face against it at the terminal, and nothing
   * tells us. The SDK has no "enrolment finished" frame addressed to us, and
   * `AdminLog_v2` - our push-time signal for exactly this - only helps if the
   * terminal was connected at that moment and if this firmware's action string
   * is one we recognise as an enrolment. Neither is guaranteed, so the device's
   * own `FaceEnrolled` flag is the authority and this is how we ask for it.
   *
   * It reconciles in both directions. A face deleted at the keypad leaves us
   * believing somebody can pass a gate they cannot, which is the same class of
   * error pointing the other way.
   *
   * Costs one full user-list walk, which blocks other commands on this terminal
   * for its duration - so it is an explicit action, not something on a timer.
   */
  async syncEnrolmentState(deviceId: string, actor: AuditActor): Promise<EnrolmentSyncOutcome> {
    const { session, context } = this.requireSession(deviceId);

    const onDevice = await this.walkDeviceUsers(session);
    const mappings = await this.prisma.terminalUser.findMany({ where: { deviceId } });
    const bySlot = new Map(onDevice.map((u) => [u.terminalUserId, u]));

    const confirmed: EnrolmentSyncChange[] = [];
    const cleared: EnrolmentSyncChange[] = [];
    const missingOnDevice: EnrolmentSyncChange[] = [];

    for (const mapping of mappings) {
      const change: EnrolmentSyncChange = {
        terminalUserId: mapping.terminalUserId,
        subjectType: mapping.subjectType,
        subjectId: mapping.subjectId,
      };
      const device = bySlot.get(mapping.terminalUserId);

      // Absent from the device is not the same as present-with-no-face, and it
      // must not be collapsed into one: we cannot tell whether the record was
      // deleted or the walk was cut short, so report it and change nothing.
      if (!device) {
        missingOnDevice.push(change);
        continue;
      }
      if (device.faceEnrolled === mapping.faceEnrolled) continue;
      (device.faceEnrolled ? confirmed : cleared).push(change);
    }

    const mappedSlots = new Set(mappings.map((m) => m.terminalUserId));
    const unmapped = onDevice
      .filter((u) => u.terminalUserId > 0 && !mappedSlots.has(u.terminalUserId))
      .map((u) => u.terminalUserId);

    const outcome: EnrolmentSyncOutcome = {
      serialNo: context.serialNo,
      totalOnDevice: onDevice.length,
      totalMapped: mappings.length,
      confirmed,
      cleared,
      missingOnDevice,
      unmapped,
    };

    if (confirmed.length === 0 && cleared.length === 0) return outcome;

    await this.audit.run({
      action: 'TERMINAL_SYNC_ENROLMENT',
      targetType: 'SiteDevice',
      targetId: deviceId,
      actor,
      tenantId: context.tenantId,
      siteId: context.siteId,
      payloadFrom: () => ({
        serialNo: context.serialNo,
        confirmed: confirmed.map((c) => c.terminalUserId),
        cleared: cleared.map((c) => c.terminalUserId),
        missingOnDevice: missingOnDevice.map((c) => c.terminalUserId),
      }),
      run: async (tx) => {
        if (confirmed.length) {
          await tx.terminalUser.updateMany({
            where: { deviceId, terminalUserId: { in: confirmed.map((c) => c.terminalUserId) } },
            data: { faceEnrolled: true, enrolledAt: new Date() },
          });
        }
        if (cleared.length) {
          await tx.terminalUser.updateMany({
            where: { deviceId, terminalUserId: { in: cleared.map((c) => c.terminalUserId) } },
            data: { faceEnrolled: false, enrolledAt: null },
          });
        }
      },
    });

    this.logger.log(
      `Terminal ${context.serialNo}: enrolment sync confirmed ${confirmed.length}, ` +
        `cleared ${cleared.length}, ${missingOnDevice.length} mapped slot(s) absent from the device`,
    );
    return outcome;
  }

  // ── Face enrolment ─────────────────────────────────────────────────────────

  /**
   * Enrol a face from a photo held in the cloud — no need to walk the subject
   * to the terminal. This is the preferred path because, unlike RemoteEnroll,
   * the command carries an explicit UserID.
   */
  async enrollFromPhoto(
    deviceId: string,
    subjectType: string,
    subjectId: string,
    jpeg: Buffer,
    actor: AuditActor,
  ): Promise<void> {
    if (jpeg.byteLength > MAX_PHOTO_BYTES) {
      throw new BadRequestException(
        `Photo is ${jpeg.byteLength} bytes; the terminal accepts at most ${MAX_PHOTO_BYTES}`,
      );
    }
    const { session, context } = this.requireSession(deviceId);
    const { terminalUserId } = await this.provisionSubject(deviceId, subjectType, subjectId, actor);

    const response = await session.command(
      M50Command.EnrollFaceByPhoto,
      {
        UserID: terminalUserId,
        // Byte length of the JPEG itself, not of its base64 encoding.
        PhotoSize: jpeg.byteLength,
        PhotoData: jpeg.toString('base64'),
      },
      PHOTO_ENROLL_TIMEOUT_MS,
    );
    this.assertOk(response, M50Command.EnrollFaceByPhoto);

    // EnrollFaceByPhoto derives a template; whether the firmware also keeps the
    // JPEG as the slot's user photo is a device setting we do not control. Set
    // it explicitly so GetUserPhoto can answer "who is enrolled here?" later.
    await this.storeUserPhoto(session, terminalUserId, jpeg, context.serialNo);

    this.logger.log(`Enrolled ${subjectType} ${subjectId} by photo on ${context.serialNo}`);
    await this.markEnrolled(deviceId, subjectType, subjectId);
    // Harvest immediately so the template can be replayed onto other terminals.
    await this.captureTemplate(deviceId, subjectType, subjectId, actor);
  }

  /**
   * Ask the terminal to enter interactive enrolment mode.
   *
   * Two things about the feedback here are protocol facts, not implementation
   * choices, and both are why this reads as "nothing happened":
   *
   * 1. **The response says nothing about a face.** `ResultCode` is returned as
   *    soon as the device decides whether it can *enter* enrolment mode — its
   *    own values give it away (`MenuProcessing`, `RemoteEnrollAlreadyStarted`
   *    are both "cannot start right now"). `Success` therefore means "the
   *    device is now waiting for a face", not "a face was captured".
   * 2. **There is no completion event.** The SDK has no "enrolment finished"
   *    frame. The only thing the device volunteers afterwards is an
   *    `AdminLog_v2` with an `Enroll*` action — which is why that stream is
   *    worth reading — and the only way to *ask* is `GetUserData`, whose
   *    `FaceEnrolled` flag is the authoritative answer.
   *
   * On top of that the command carries no `UserID` (the SDK defines only
   * `<Backup>` and an optional `<FingerNo>`), so the cloud cannot say which
   * slot to enrol into; hardware answers `EnrollNumberError`. The slot is
   * provisioned first regardless so its number can be read out to whoever is
   * standing at the terminal.
   *
   * Deliberately does not throw on a refusal: "the device said
   * EnrollNumberError" is the answer the caller needs, and a 409 with a bare
   * string is a poor way to deliver it. `accepted` carries the verdict.
   */
  async startRemoteEnroll(
    deviceId: string,
    subjectType: string,
    subjectId: string,
    backup: EnrollBackup,
    actor: AuditActor,
  ): Promise<RemoteEnrollOutcome> {
    const { session, context } = this.requireSession(deviceId);
    const { terminalUserId } = await this.provisionSubject(deviceId, subjectType, subjectId, actor);

    let resultCode: string;
    try {
      const response = await session.command(
        M50Command.RemoteEnroll,
        { Backup: backup },
        REMOTE_ENROLL_TIMEOUT_MS,
      );
      resultCode = response.ResultCode ?? response.Result ?? 'Unknown';
    } catch (err) {
      // A timeout is itself a finding: the device accepted the frame and never
      // answered, so nobody can say whether it is in enrolment mode. Report it
      // as such rather than as a server error.
      this.logger.warn(
        `RemoteEnroll on ${context.serialNo} produced no response: ${(err as Error).message}`,
      );
      return {
        accepted: false,
        terminalUserId,
        resultCode: 'NoResponse',
        enrollmentModeActive: false,
        detail: (err as Error).message,
        nextStep:
          'The terminal never answered. Check it is still online, then verify with ' +
          'GET device/users/{terminalUserId} whether anything changed.',
      };
    }

    const accepted = resultCode === 'Success';
    this.logger.log(
      `RemoteEnroll(${backup}) for ${subjectType} ${subjectId} (slot ${terminalUserId}) on ` +
        `${context.serialNo} returned ${resultCode}`,
    );

    // Emphatically not markEnrolled(): the device has at most been put into
    // enrolment mode. Recording a face we have no evidence of is how our mirror
    // starts lying about the hardware.
    return {
      accepted,
      terminalUserId,
      resultCode,
      enrollmentModeActive: accepted,
      detail: accepted
        ? 'The terminal is now waiting for a face. It will not report when one is captured.'
        : REMOTE_ENROLL_RESULT_NOTES[resultCode] ?? 'The terminal refused to enter enrolment mode.',
      nextStep: accepted
        ? `Have the subject present at the terminal, then confirm with GET ` +
          `device/users/${terminalUserId} (FaceEnrolled) and harvest with POST templates/capture.`
        : 'Use POST enroll/photo, or POST users followed by an enrolment at the device menu ' +
          'and POST templates/capture.',
    };
  }

  /**
   * Leave enrolment mode.
   *
   * Doubles as the only probe the SDK offers for whether the device is in that
   * mode at all: `NotStartedRemoteEnroll` means it never entered one. That
   * answer costs the mode itself, so it is a diagnostic, not a poll.
   */
  async cancelRemoteEnroll(deviceId: string): Promise<{ resultCode: string; wasActive: boolean }> {
    const { session } = this.requireSession(deviceId);
    const response = await session.command(M50Command.ExitRemoteEnroll);
    const resultCode = response.ResultCode ?? response.Result ?? 'Unknown';
    return { resultCode, wasActive: resultCode !== 'NotStartedRemoteEnroll' };
  }

  /**
   * Bind a slot the device already holds to one of our subjects.
   *
   * This is the other half of enrolling at the terminal, and the route that
   * does not need a usable photograph in advance. Somebody enrols at the device
   * — real lighting, live face, the number chosen by the firmware — and this
   * attaches that number to an employee afterwards. Identify the slot first with
   * GET device/unclaimed and GET device/users/{slot}/photo.
   *
   * Everything here is checked against the hardware rather than assumed:
   *
   * - The slot must actually exist on the device. Claiming a number nothing is
   *   enrolled under would manufacture a mapping that silently swallows the
   *   next person to be given that number.
   * - `faceEnrolled` is taken from the device's own answer, never defaulted to
   *   true, so our mirror cannot claim a face the terminal does not have.
   * - The slot must be unclaimed, and the subject must not already hold a
   *   different slot on this terminal — two numbers for one person means their
   *   scans split across two identities depending on which face the device
   *   matches.
   */
  async claimSlot(
    deviceId: string,
    terminalUserId: number,
    subjectType: string,
    subjectId: string,
    options: { renameOnDevice?: boolean; captureTemplate?: boolean },
    actor: AuditActor,
  ): Promise<ClaimOutcome> {
    const { session, context } = this.requireSession(deviceId);

    const onDevice = await session.command(M50Command.GetUserData, { UserID: terminalUserId });
    if (onDevice.Result === 'Fail') {
      throw new NotFoundException(
        `Terminal ${context.serialNo} has no user at slot ${terminalUserId}; nothing to claim`,
      );
    }
    const faceEnrolled = onDevice.FaceEnrolled === 'Yes';
    const deviceName = onDevice.Name ? decodeTerminalName(onDevice.Name) : null;

    const [slotTaken, subjectElsewhere] = await Promise.all([
      this.prisma.terminalUser.findUnique({
        where: { deviceId_terminalUserId: { deviceId, terminalUserId } },
      }),
      this.prisma.terminalUser.findUnique({
        where: { deviceId_subjectType_subjectId: { deviceId, subjectType, subjectId } },
      }),
    ]);

    if (slotTaken) {
      throw new ConflictException(
        `Slot ${terminalUserId} is already claimed by ${slotTaken.subjectType} ` +
          `${slotTaken.subjectId}. Release it first if that mapping is wrong.`,
      );
    }
    if (subjectElsewhere) {
      throw new ConflictException(
        `${subjectType} ${subjectId} already holds slot ${subjectElsewhere.terminalUserId} on this ` +
          `terminal. Two slots for one person splits their scans across both.`,
      );
    }

    // Resolving the name also proves the subject exists in this tenant, which
    // is the only thing standing between a typo and a mapping to nobody.
    const employee = await this.resolveEmployee(subjectId, context.tenantId);
    const subjectName = employee.fullName;
    if (!employee.biometricConsentAt) {
      throw new AppError(409, 'BIOMETRIC_CONSENT_REQUIRED', "Record the employee's biometric consent before linking a face");
    }

    await this.audit.run({
      action: 'TERMINAL_CLAIM_SLOT',
      targetType: 'TerminalUser',
      actor,
      tenantId: context.tenantId,
      siteId: context.siteId,
      payloadFrom: () => ({
        terminalUserId,
        subjectType,
        subjectId,
        serialNo: context.serialNo,
        // What the device called this slot before we took it over. Kept because
        // it is the evidence the binding was made against.
        deviceNameAtClaim: deviceName,
        faceEnrolled,
      }),
      run: (tx) =>
        tx.terminalUser.create({
          data: {
            tenantId: context.tenantId,
            deviceId,
            terminalUserId,
            subjectType,
            subjectId,
            faceEnrolled,
            enrolledAt: faceEnrolled ? new Date() : null,
          },
        }),
    });

    const result: ClaimOutcome = {
      terminalUserId,
      subjectType,
      subjectId,
      subjectName,
      faceEnrolled,
      deviceNameAtClaim: deviceName,
      renamedOnDevice: false,
      templateCaptured: false,
      retroAttributed: 0,
      warnings: [],
    };

    if (!faceEnrolled) {
      result.warnings.push(
        `Slot ${terminalUserId} exists but the terminal reports no face enrolled. The mapping is ` +
          `recorded, but this subject cannot pass the gate until a face is captured.`,
      );
    }

    // Push our canonical name over whatever was typed at the keypad, so the
    // device is readable by anyone standing in front of it. Best-effort: the
    // mapping is the thing that matters and is already committed.
    if (options.renameOnDevice) {
      try {
        const response = await session.command(M50Command.SetUserData, {
          UserID: terminalUserId,
          Type: 'Set',
          ...this.userFields(employee),
        });
        this.assertOk(response, M50Command.SetUserData);
        result.renamedOnDevice = true;
      } catch (err) {
        result.warnings.push(`Could not rename the slot on the device: ${(err as Error).message}`);
      }
    }

    if (options.captureTemplate && faceEnrolled) {
      try {
        const { stored } = await this.captureTemplate(deviceId, subjectType, subjectId, actor);
        result.templateCaptured = stored;
        if (!stored) {
          result.warnings.push('The terminal returned no template to store for this slot.');
        }
      } catch (err) {
        result.warnings.push(`Could not harvest the template: ${(err as Error).message}`);
      }
    }

    // Unlike hostel auth_events, punches keep the slot, so the claim can retro-attribute (§5).
    try {
      result.retroAttributed = await this.retroAttribute(deviceId, terminalUserId, employee);
    } catch (err) {
      result.warnings.push(`Earlier scans were not re-attributed: ${(err as Error).message}`);
    }

    this.logger.log(
      `Claimed slot ${terminalUserId} on ${context.serialNo} for ${subjectType} ${subjectId} ` +
        `(${subjectName}); device called it "${deviceName ?? ''}"`,
    );
    return result;
  }

  /**
   * Drop a mapping without touching the device.
   *
   * Distinct from removeSubject, which deletes the user from the terminal too.
   * This is the undo for a claim made against the wrong employee: the face stays
   * where it is and the slot returns to the unclaimed queue to be bound again.
   */
  async releaseSlot(
    deviceId: string,
    terminalUserId: number,
    actor: AuditActor,
  ): Promise<{ terminalUserId: number; released: boolean }> {
    const { context } = this.requireSession(deviceId);
    const mapping = await this.prisma.terminalUser.findUnique({
      where: { deviceId_terminalUserId: { deviceId, terminalUserId } },
    });
    if (!mapping) {
      throw new NotFoundException(`Slot ${terminalUserId} is not claimed on this terminal`);
    }

    await this.audit.run({
      action: 'TERMINAL_RELEASE_SLOT',
      targetType: 'TerminalUser',
      targetId: mapping.id,
      actor,
      tenantId: context.tenantId,
      siteId: context.siteId,
      payloadFrom: () => ({
        terminalUserId,
        subjectType: mapping.subjectType,
        subjectId: mapping.subjectId,
        serialNo: context.serialNo,
      }),
      run: (tx) => tx.terminalUser.delete({ where: { id: mapping.id } }),
    });

    return { terminalUserId, released: true };
  }

  // ── Template custody ───────────────────────────────────────────────────────

  /**
   * Pull a face template off a terminal and store it centrally.
   *
   * Stored separately from FaceEnrollment on purpose: that model holds a
   * vector(512) insightface embedding for our own edge pipeline, whereas this
   * is an opaque vendor blob. They are not interchangeable and must not be
   * conflated — but keeping this one means a face enrolled once at any gate can
   * be replayed onto every other terminal without the subject present.
   */
  async captureTemplate(
    deviceId: string,
    subjectType: string,
    subjectId: string,
    actor: AuditActor,
  ): Promise<{ stored: boolean }> {
    const { session, context } = this.requireSession(deviceId);
    const mapping = await this.requireMapping(deviceId, subjectType, subjectId);

    const response = await session.command(M50Command.GetFaceData, { UserID: mapping.terminalUserId });
    const template = response.FaceData;
    if (response.FaceEnrolled !== 'Yes' || !template) {
      this.logger.warn(
        `Terminal ${context.serialNo} reports no face template for slot ${mapping.terminalUserId}`,
      );
      return { stored: false };
    }

    const templateSha256 = createHash('sha256').update(template).digest('hex');

    await this.audit.run({
      action: 'TERMINAL_CAPTURE_TEMPLATE',
      targetType: 'TerminalFaceTemplate',
      actor,
      tenantId: context.tenantId,
      siteId: context.siteId,
      payloadFrom: () => ({ subjectType, subjectId, templateSha256, sourceSerialNo: context.serialNo }),
      run: (tx) =>
        tx.terminalFaceTemplate.upsert({
          where: { subjectType_subjectId_vendor: { subjectType, subjectId, vendor: TEMPLATE_VENDOR } },
          create: {
            tenantId: context.tenantId,
            subjectType,
            subjectId,
            vendor: TEMPLATE_VENDOR,
            terminalType: context.terminalType,
            template,
            templateSha256,
            sourceDeviceId: deviceId,
          },
          update: {
            template,
            templateSha256,
            terminalType: context.terminalType,
            sourceDeviceId: deviceId,
            status: 'active',
          },
        }),
    });

    this.logger.log(`Stored ${TEMPLATE_VENDOR} template for ${subjectType} ${subjectId}`);
    return { stored: true };
  }

  /**
   * Push a stored template onto a terminal, enrolling the subject there without
   * them being physically present.
   */
  async replicateTemplate(
    deviceId: string,
    subjectType: string,
    subjectId: string,
    actor: AuditActor,
  ): Promise<void> {
    const { session, context } = this.requireSession(deviceId);

    const stored = await this.prisma.terminalFaceTemplate.findUnique({
      where: { subjectType_subjectId_vendor: { subjectType, subjectId, vendor: TEMPLATE_VENDOR } },
    });
    if (!stored || stored.status !== 'active') {
      throw new NotFoundException(`No stored ${TEMPLATE_VENDOR} template for ${subjectType} ${subjectId}`);
    }
    if (stored.terminalType && context.terminalType && stored.terminalType !== context.terminalType) {
      // Templates are only portable across terminals of the same model; a
      // mismatch usually means the device is a different generation.
      this.logger.warn(
        `Replicating a ${stored.terminalType} template onto a ${context.terminalType}; ` +
          `the terminal may reject it`,
      );
    }

    const { terminalUserId } = await this.provisionSubject(deviceId, subjectType, subjectId, actor);

    const response = await session.command(M50Command.SetFaceData, {
      UserID: terminalUserId,
      Privilege: 'User',
      DuplicationCheck: 'Yes',
      FaceData: stored.template,
    });
    this.assertOk(response, M50Command.SetFaceData);

    // SetFaceData carries the matching template and nothing a human can look
    // at, so a replicated gate would hold a face it cannot show. Copy the
    // enrolment photo across from the terminal the person actually stood at.
    await this.copyUserPhotoFrom(stored.sourceDeviceId, subjectType, subjectId, session, terminalUserId, context.serialNo);

    await this.markEnrolled(deviceId, subjectType, subjectId);
    this.logger.log(`Replicated template for ${subjectType} ${subjectId} onto ${context.serialNo}`);
  }

  /** Remove a subject from a terminal entirely. */
  async removeSubject(
    deviceId: string,
    subjectType: string,
    subjectId: string,
    actor: AuditActor,
  ): Promise<void> {
    const { session, context } = this.requireSession(deviceId);
    const mapping = await this.requireMapping(deviceId, subjectType, subjectId);

    const response = await session.command(M50Command.SetUserData, {
      UserID: mapping.terminalUserId,
      Type: 'Delete',
    });
    this.assertOk(response, M50Command.SetUserData);

    await this.audit.run({
      action: 'TERMINAL_REMOVE_USER',
      targetType: 'TerminalUser',
      targetId: mapping.id,
      actor,
      tenantId: context.tenantId,
      siteId: context.siteId,
      payloadFrom: () => ({ subjectType, subjectId, terminalUserId: mapping.terminalUserId }),
      run: (tx) => tx.terminalUser.delete({ where: { id: mapping.id } }),
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private requireSession(deviceId: string): { session: M50Session; context: ReturnType<M50Session['requireContext']> } {
    let session: M50Session;
    try {
      session = this.sessions.require(deviceId);
    } catch {
      // Terminals dial out and are pinned to one instance; an offline device
      // simply cannot be commanded until it reconnects.
      throw new ServiceUnavailableException(`Terminal ${deviceId} is not currently connected`);
    }
    return { session, context: session.requireContext() };
  }

  private async requireMapping(deviceId: string, subjectType: string, subjectId: string) {
    const mapping = await this.prisma.terminalUser.findUnique({
      where: { deviceId_subjectType_subjectId: { deviceId, subjectType, subjectId } },
    });
    if (!mapping) {
      throw new NotFoundException(`${subjectType} ${subjectId} is not provisioned on this terminal`);
    }
    return mapping;
  }

  /**
   * Give a slot a photo a human can look at.
   *
   * Best-effort throughout: the enrolment itself has already succeeded by the
   * time this runs, and a device that will not keep photos is a nuisance, not a
   * failure. Losing the picture must never roll back a face that is on the
   * hardware and working.
   */
  private async storeUserPhoto(
    session: M50Session,
    terminalUserId: number,
    jpeg: Buffer,
    serialNo: string,
  ): Promise<boolean> {
    if (jpeg.byteLength > MAX_PHOTO_BYTES) {
      this.logger.warn(
        `Not storing a ${jpeg.byteLength}-byte photo on ${serialNo}; the limit is ${MAX_PHOTO_BYTES}`,
      );
      return false;
    }
    try {
      const response = await session.command(M50Command.SetUserPhoto, {
        UserID: terminalUserId,
        // Byte length of the JPEG itself, not of its base64 encoding.
        PhotoSize: jpeg.byteLength,
        PhotoData: jpeg.toString('base64'),
      });
      if (response.Result !== 'OK') {
        this.logger.warn(
          `${serialNo} would not keep a photo for slot ${terminalUserId}: ${response.Result ?? 'no result'}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `Could not store the photo for slot ${terminalUserId} on ${serialNo}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Move the enrolment photo from the terminal a subject enrolled at onto one
   * that has only just received their template.
   *
   * Needs the source terminal online, since the photo lives nowhere else — we
   * store the template centrally but not the picture. Silently does nothing
   * when the source is unreachable or never kept one; the replicated face still
   * opens the gate either way.
   */
  private async copyUserPhotoFrom(
    sourceDeviceId: string | null,
    subjectType: string,
    subjectId: string,
    targetSession: M50Session,
    targetUserId: number,
    targetSerialNo: string,
  ): Promise<void> {
    if (!sourceDeviceId) return;

    try {
      const sourceSession = this.sessions.require(sourceDeviceId);
      const sourceMapping = await this.prisma.terminalUser.findUnique({
        where: {
          deviceId_subjectType_subjectId: { deviceId: sourceDeviceId, subjectType, subjectId },
        },
      });
      if (!sourceMapping) return;

      const fields = await sourceSession.command(M50Command.GetUserPhoto, {
        UserID: sourceMapping.terminalUserId,
      });
      if (fields.Result === 'Fail' || !fields.PhotoData) return;

      await this.storeUserPhoto(
        targetSession,
        targetUserId,
        Buffer.from(fields.PhotoData, 'base64'),
        targetSerialNo,
      );
    } catch (err) {
      this.logger.warn(
        `Could not carry the enrolment photo onto ${targetSerialNo}: ${(err as Error).message}`,
      );
    }
  }

  private async markEnrolled(deviceId: string, subjectType: string, subjectId: string): Promise<void> {
    await this.prisma.terminalUser.update({
      where: { deviceId_subjectType_subjectId: { deviceId, subjectType, subjectId } },
      data: { faceEnrolled: true, enrolledAt: new Date() },
    });
  }

  private async resolveEmployee(employeeId: string, tenantId: string): Promise<Employee> {
    const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, tenantId } });
    if (!employee) throw new NotFoundException(`Employee ${employeeId} not found`);
    return employee;
  }

  /**
   * UNKNOWN punches from this slot since it was enrolled on the device (the
   * keypad enrolment in the admin log; without one, since the device was
   * provisioned) become the employee's, and their days are recomputed.
   */
  private async retroAttribute(deviceId: string, terminalUserId: number, employee: Employee): Promise<number> {
    const device = await this.prisma.device.findUniqueOrThrow({ where: { id: deviceId }, include: { site: true } });
    const logs = await this.prisma.auditLog.findMany({
      where: { targetType: 'Device', targetId: deviceId, actorType: 'device', action: { startsWith: 'TERMINAL_' } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const enrolled = logs.find((l) => {
      const p = (l.payload ?? {}) as Record<string, unknown>;
      return Number(p.terminalUserId) === terminalUserId && adminActionCategory(String(p.action ?? '')) === 'enrollment';
    });
    const since = enrolled ? new Date(String((enrolled.payload as any).occurredAt ?? enrolled.createdAt)) : device.createdAt;

    const orphans = await this.prisma.punch.findMany({
      where: { deviceId, terminalUserId, employeeId: null, punchedAt: { gte: since } },
      select: { punchedAt: true },
    });
    if (!orphans.length) return 0;
    const { count } = await this.prisma.punch.updateMany({
      where: { deviceId, terminalUserId, employeeId: null, punchedAt: { gte: since } },
      data: { employeeId: employee.id },
    });
    const dates = new Set(orphans.map((p) => localYmd(p.punchedAt, device.site.timezone)));
    for (const d of dates) {
      // The recompute re-attributes work dates; a night shift may own yesterday's window.
      await this.recompute.day(employee.id, addDays(d, -1), 500);
      await this.recompute.day(employee.id, d, 500);
    }
    return count;
  }

  /**
   * Offboarding on one terminal (§4.3): delete the user from the device, keep
   * the mapping soft-released so the slot number is never reused. Offline
   * devices are retried by the terminal-offboard-retry job.
   */
  async offboard(deviceId: string, employeeId: string, actor: AuditActor): Promise<'deleted' | 'device-offline' | 'not-on-device'> {
    const mapping = await this.prisma.terminalUser.findUnique({
      where: { deviceId_subjectType_subjectId: { deviceId, subjectType: 'EMPLOYEE', subjectId: employeeId } },
    });
    if (!mapping || mapping.releasedAt) return 'not-on-device';
    if (!this.sessions.isOnline(deviceId)) return 'device-offline';
    const { session, context } = this.requireSession(deviceId);
    const response = await session.command(M50Command.SetUserData, { UserID: mapping.terminalUserId, Type: 'Delete' });
    // "Fail" for a user already gone from the device is as good as a delete.
    if (response.Result !== 'OK') {
      const probe = await session.command(M50Command.GetUserData, { UserID: mapping.terminalUserId });
      if (probe.Result !== 'Fail') this.assertOk(response, M50Command.SetUserData);
    }
    await this.audit.run({
      action: 'TERMINAL_OFFBOARD_USER',
      targetType: 'TerminalUser',
      targetId: mapping.id,
      actor,
      tenantId: context.tenantId,
      siteId: context.siteId,
      payloadFrom: () => ({ employeeId, terminalUserId: mapping.terminalUserId, serialNo: context.serialNo }),
      run: (tx) => tx.terminalUser.update({ where: { id: mapping.id }, data: { releasedAt: new Date(), faceEnrolled: false } }),
    });
    return 'deleted';
  }

  /** Push a changed joining/exit date to the device's validity window. Best effort. */
  async syncUserPeriod(deviceId: string, employee: Employee): Promise<boolean> {
    const mapping = await this.prisma.terminalUser.findUnique({
      where: { deviceId_subjectType_subjectId: { deviceId, subjectType: 'EMPLOYEE', subjectId: employee.id } },
    });
    if (!mapping || mapping.releasedAt || !this.sessions.isOnline(deviceId)) return false;
    const { session } = this.requireSession(deviceId);
    const response = await session.command(M50Command.SetUserData, { UserID: mapping.terminalUserId, Type: 'Set', ...this.userFields(employee) });
    return response.Result === 'OK';
  }

  /** Treat anything other than an explicit OK as a failure, surfacing the device's reason. */
  private assertOk(response: M50Fields, command: string): void {
    if (response.Result === 'OK') return;
    const detail = response.Reason || response.Error || response.Result || 'no result returned';
    throw new ConflictException(`${command} failed on terminal: ${detail}`);
  }
}

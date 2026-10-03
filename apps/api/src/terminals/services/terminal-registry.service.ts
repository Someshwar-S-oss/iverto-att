import { Injectable, Logger } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'crypto';
import { AuditableActionService } from '../../audit/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { LiveGateway } from '../../live/live.gateway';
import type { M50DeviceContext, M50Session } from '../m50-session';
import { M50Fields } from '../protocol/m50-protocol';

/** Constant-time compare that tolerates differing lengths without leaking them. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Register/Login handshake and device provisioning (copied from hostel).
 *
 * Security note: the vendor's reference implementation issues a token to *any*
 * device that asks. This implementation requires the serial to have been
 * provisioned (POST /v1/terminals) and optionally checks a shared CloudId,
 * before any token is minted.
 *
 * Changes vs hostel: the clock timezone comes from the device row (§4.3, no
 * global M50_CLOCK_TZ), and a suspended tenant's terminals are refused Login so
 * they keep buffering and are backfilled on reactivation (§13.1).
 */
@Injectable()
export class TerminalRegistryService {
  private readonly logger = new Logger(TerminalRegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly live: LiveGateway,
  ) {}

  /** A device re-registers after a factory reset or when it lost its token, so re-registration rotates. */
  async handleRegister(session: M50Session, fields: M50Fields): Promise<void> {
    const serialNo = fields.DeviceSerialNo?.trim();
    const cloudId = fields.CloudId?.trim() ?? '';
    const terminalType = fields.TerminalType?.trim() || null;
    session.claimedSerialNo = serialNo ?? null;

    if (!serialNo) {
      this.logger.warn(`Register from ${session.remoteAddress} carried no DeviceSerialNo`);
      session.send({ Response: 'Register', Result: 'Fail' });
      return;
    }

    const expectedCloudId = process.env.M50_CLOUD_ID;
    if (expectedCloudId && !secretsMatch(cloudId, expectedCloudId)) {
      this.logger.warn(`Register rejected for ${serialNo}: CloudId mismatch`);
      session.send({ Response: 'Register', DeviceSerialNo: serialNo, Result: 'Fail' });
      return;
    }

    const device = await this.prisma.device.findUnique({ where: { serialNo } });
    if (!device) {
      // Refuse to self-provision: the device row is what binds a terminal to a tenant and site.
      this.logger.warn(`Register rejected for unknown serial ${serialNo} from ${session.remoteAddress}`);
      session.send({ Response: 'Register', DeviceSerialNo: serialNo, Result: 'Fail' });
      return;
    }

    const token = randomUUID();
    await this.audit.run({
      action: 'TERMINAL_REGISTER',
      targetType: 'Device',
      targetId: device.id,
      actor: { type: 'device', deviceId: device.id },
      tenantId: device.tenantId,
      siteId: device.siteId,
      payloadFrom: () => ({ serialNo, terminalType, rotated: Boolean(device.terminalToken) }),
      run: (tx) =>
        tx.device.update({
          where: { id: device.id },
          data: { terminalToken: token, terminalType, status: 'registered', lastSeenAt: new Date() },
        }),
    });

    this.logger.log(`Registered terminal ${serialNo} (${terminalType ?? 'unknown type'})`);
    session.send({ Response: 'Register', DeviceSerialNo: serialNo, Token: token, Result: 'OK' });
  }

  /** @returns the authenticated context, or null when login was refused. */
  async handleLogin(session: M50Session, fields: M50Fields): Promise<M50DeviceContext | null> {
    const serialNo = fields.DeviceSerialNo?.trim();
    const token = fields.Token?.trim() ?? '';
    session.claimedSerialNo = serialNo ?? null;

    const refuse = (result: 'Fail' | 'FailUnknownToken', reason: string) => {
      this.logger.warn(`Login refused for ${serialNo ?? session.remoteAddress}: ${reason}`);
      session.send({ Response: 'Login', DeviceSerialNo: serialNo, Result: result });
      return null;
    };

    if (!serialNo) return refuse('Fail', 'no DeviceSerialNo');

    const device = await this.prisma.device.findUnique({ where: { serialNo }, include: { site: true } });
    if (!device) return refuse('Fail', 'unknown serial');

    // FailUnknownToken tells the firmware to discard its credential and re-Register.
    if (!device.terminalToken) return refuse('FailUnknownToken', 'device has no token on record');
    if (!token || !secretsMatch(token, device.terminalToken)) return refuse('FailUnknownToken', 'token mismatch');

    // Plain Fail (not FailUnknownToken): the device keeps its token and its buffered scans.
    const tenant = await this.prisma.tenant.findUnique({ where: { id: device.tenantId }, select: { status: true } });
    if (tenant?.status !== 'ACTIVE') return refuse('Fail', `tenant is ${tenant?.status ?? 'missing'}`);

    const now = new Date();
    await this.prisma.device.update({ where: { id: device.id }, data: { status: 'online', lastSeenAt: now } });

    const context: M50DeviceContext = {
      deviceId: device.id,
      tenantId: device.tenantId,
      siteId: device.siteId,
      serialNo,
      // The protocol's trailing "Z" is a lie; see parseDeviceTime.
      timeZone: device.clockTimezone || device.site.timezone,
      direction: device.direction as M50DeviceContext['direction'],
      gateName: device.gateName,
      terminalType: device.terminalType,
      lastLogId: device.lastLogId,
    };

    session.authenticate(context);
    session.send({ Response: 'Login', DeviceSerialNo: serialNo, Result: 'OK' });
    this.live.emitToTenantSite('device.status', device.tenantId, device.siteId, { deviceId: device.id, status: 'online', lastSeenAt: now });
    this.logger.log(`Terminal ${serialNo} logged in (site ${device.siteId}, clock ${context.timeZone})`);
    return context;
  }

  async markOffline(context: M50DeviceContext): Promise<void> {
    const now = new Date();
    await this.prisma.device
      .update({ where: { id: context.deviceId }, data: { status: 'offline', lastSeenAt: now } })
      .then(() =>
        this.live.emitToTenantSite('device.status', context.tenantId, context.siteId, {
          deviceId: context.deviceId,
          status: 'offline',
          lastSeenAt: now,
        }),
      )
      .catch((err) => this.logger.warn(`Could not mark ${context.deviceId} offline: ${err.message}`));
  }

  async touch(deviceId: string): Promise<void> {
    await this.prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
}

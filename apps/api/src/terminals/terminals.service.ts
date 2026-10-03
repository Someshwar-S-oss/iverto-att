import { Injectable } from '@nestjs/common';
import { AuditableActionService } from '../audit/audit.service';
import type { AuditActor } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import type { ProvisionTerminalDto, UpdateTerminalDto } from './dto/terminal.dto';
import { TerminalSessionRegistry } from './services/terminal-session.registry';

@Injectable()
export class TerminalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly sessions: TerminalSessionRegistry,
  ) {}

  async findAll(tenantId: string, siteIds: string[] = []) {
    const devices = await this.prisma.device.findMany({
      where: { tenantId, ...(siteIds.length ? { siteId: { in: siteIds } } : {}) },
      orderBy: [{ siteId: 'asc' }, { gateName: 'asc' }, { serialNo: 'asc' }],
      include: { _count: { select: { terminalUsers: { where: { releasedAt: null } } } } },
    });
    const unknown = await this.prisma.punch.groupBy({
      by: ['deviceId'],
      where: { tenantId, employeeId: null, terminalUserId: { not: null } },
      _count: { _all: true },
    });
    return devices.map(({ terminalToken, _count, ...device }) => ({
      ...device,
      // Never expose the shared secret over the API.
      registered: Boolean(terminalToken),
      online: this.sessions.isOnline(device.id),
      mappedUsers: _count.terminalUsers,
      unknownPunches: unknown.find((u) => u.deviceId === device.id)?._count._all ?? 0,
    }));
  }

  /**
   * Pre-register a terminal so it may complete the SDK handshake. This is the
   * gate that stops an unknown device minting itself a token (§4.2).
   */
  async provision(tenantId: string, dto: ProvisionTerminalDto, actor: AuditActor) {
    const site = await this.prisma.site.findFirst({ where: { id: dto.siteId, tenantId } });
    if (!site) throw new AppError(404, 'SITE_NOT_FOUND', 'Site not found');
    // Serials are globally unique; look across tenants without revealing whose it is.
    const clash = await runAsSystem(() => this.prisma.device.findUnique({ where: { serialNo: dto.serialNo }, select: { tenantId: true } }));
    if (clash) {
      throw new AppError(409, clash.tenantId === tenantId ? 'DUPLICATE' : 'SERIAL_IN_USE', `Serial ${dto.serialNo} is already provisioned`);
    }
    return this.audit.run({
      action: 'TERMINAL_PROVISION',
      targetType: 'Device',
      actor,
      tenantId,
      siteId: dto.siteId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) =>
        tx.device.create({
          data: { ...dto, tenantId, status: 'provisioned' },
          omit: { terminalToken: true },
        }),
    });
  }

  async update(tenantId: string, deviceId: string, dto: UpdateTerminalDto, actor: AuditActor) {
    if (dto.siteId && !(await this.prisma.site.findFirst({ where: { id: dto.siteId, tenantId } }))) {
      throw new AppError(404, 'SITE_NOT_FOUND', 'Site not found');
    }
    const device = await this.audit.run({
      action: 'TERMINAL_UPDATE',
      targetType: 'Device',
      targetId: deviceId,
      actor,
      tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => tx.device.update({ where: { id: deviceId }, data: dto, omit: { terminalToken: true } }),
    });
    // The live session caches direction/timezone; make it pick up the change on reconnect.
    this.sessions.get(deviceId)?.close(1012, 'configuration changed');
    return device;
  }

  /** Only a terminal that never recorded a punch can be deleted; otherwise it is history. */
  async remove(tenantId: string, deviceId: string, actor: AuditActor) {
    if (await this.prisma.punch.count({ where: { deviceId } })) {
      throw new AppError(409, 'DEVICE_HAS_HISTORY', 'This terminal has recorded punches; it cannot be deleted');
    }
    await this.audit.run({
      action: 'TERMINAL_DELETED',
      targetType: 'Device',
      targetId: deviceId,
      actor,
      tenantId,
      run: (tx) => tx.device.delete({ where: { id: deviceId } }),
    });
    this.sessions.get(deviceId)?.close(1000, 'terminal deleted');
    return { deleted: true };
  }

  async listUsers(deviceId: string) {
    const rows = await this.prisma.terminalUser.findMany({ where: { deviceId }, orderBy: { terminalUserId: 'asc' } });
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: rows.map((r) => r.subjectId) } },
      select: { id: true, fullName: true, employeeCode: true },
    });
    const byId = new Map(employees.map((e) => [e.id, e]));
    return rows.map((r) => ({ ...r, employee: byId.get(r.subjectId) ?? null }));
  }
}

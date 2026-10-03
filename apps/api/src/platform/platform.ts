import { Body, Controller, Get, Injectable, Logger, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuditActor, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { IsTimeZone } from '../common/validators';
import { UsersModule } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { TENANT_DEFAULTS } from './tenant-defaults';

class NewSiteDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsTimeZone() timezone: string;
}

class NewAdminDto {
  @IsString() @MinLength(1) @MaxLength(120) fullName: string;
  @IsEmail() email: string;
}

export class CreateTenantDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @Matches(/^[a-z0-9][a-z0-9-]{1,40}$/, { message: 'slug must be lowercase letters, digits and dashes' }) slug: string;
  @ValidateNested() @Type(() => NewSiteDto) site: NewSiteDto;
  @ValidateNested() @Type(() => NewAdminDto) admin: NewAdminDto;
}

export class UpdateTenantDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @Matches(/^[a-z0-9][a-z0-9-]{1,40}$/) slug?: string;
}

export class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

type TenantSettings = typeof TENANT_DEFAULTS.settings & {
  timezone?: string;
  adminUserId?: string;
  pendingAdmin?: { fullName: string; email: string };
};

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly audit: AuditableActionService,
  ) {}

  async list() {
    const tenants = await this.prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });
    const stats = await this.prisma.$transaction(
      (tx) => tx.$queryRaw<Array<{ tenant_id: string; employees: bigint; terminals: bigint; online: bigint; last_punch: Date | null }>>`
        SELECT t.id AS tenant_id,
               (SELECT count(*) FROM employees e WHERE e.tenant_id = t.id AND e.status = 'ACTIVE') AS employees,
               (SELECT count(*) FROM devices d WHERE d.tenant_id = t.id) AS terminals,
               (SELECT count(*) FROM devices d WHERE d.tenant_id = t.id AND d.status = 'online') AS online,
               (SELECT max(p.received_at) FROM punches p WHERE p.tenant_id = t.id) AS last_punch
        FROM tenants t`,
    );
    const byId = new Map(stats.map((s) => [s.tenant_id, s]));
    return tenants.map((t) => {
      const s = byId.get(t.id);
      return {
        ...t,
        employeeCount: Number(s?.employees ?? 0),
        terminalCount: Number(s?.terminals ?? 0),
        terminalsOnline: Number(s?.online ?? 0),
        lastPunchAt: s?.last_punch ?? null,
      };
    });
  }

  async get(id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    const [sites, audit] = await Promise.all([
      this.prisma.site.findMany({ where: { tenantId: id } }),
      this.prisma.auditLog.findMany({
        where: { tenantId: id, action: { startsWith: 'TENANT_' } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    return { ...tenant, sites, audit };
  }

  /** §13.1: defaults in one transaction, then the admin login outside it. */
  async create(dto: CreateTenantDto, actor: AuditActor) {
    const d = TENANT_DEFAULTS;
    const tenant = await this.prisma.$transaction(async (tx) => {
      const settings: TenantSettings = { ...d.settings, timezone: dto.site.timezone, pendingAdmin: dto.admin };
      const t = await tx.tenant.create({
        data: { name: dto.name, slug: dto.slug, status: 'PROVISIONING', createdBy: actor.userId, settings: settings as any },
      });
      const calendar = await tx.holidayCalendar.create({ data: { tenantId: t.id, name: `${dto.site.name} holidays` } });
      await tx.site.create({
        data: { tenantId: t.id, name: dto.site.name, timezone: dto.site.timezone, holidayCalendarId: calendar.id },
      });
      await tx.attendancePolicy.create({ data: { tenantId: t.id, ...d.policy } });
      await tx.shift.create({ data: { tenantId: t.id, ...d.shift } });
      await tx.leaveType.createMany({ data: d.leaveTypes.map((lt) => ({ tenantId: t.id, active: false, ...lt })) });
      return t;
    });
    return this.finishProvisioning(tenant.id, actor);
  }

  async retryAdmin(id: string, actor: AuditActor) {
    const tenant = await this.get(id);
    if (tenant.status !== 'PROVISIONING') {
      throw new AppError(409, 'NOT_PROVISIONING', 'Tenant is already provisioned');
    }
    return this.finishProvisioning(id, actor);
  }

  private async finishProvisioning(id: string, actor: AuditActor) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id } });
    const settings = tenant.settings as TenantSettings;
    const admin = settings.pendingAdmin;
    if (!admin) throw new AppError(409, 'NO_PENDING_ADMIN', 'No pending admin to create');

    const site = await this.prisma.site.findFirst({ where: { tenantId: id } });
    const { userId, temporaryPassword } = await this.users.createLogin(
      { tenantId: id, email: admin.email, displayName: admin.fullName, role: 'ADMIN', siteIds: [] },
      actor,
    );

    const { pendingAdmin, ...rest } = settings;
    await this.audit.run({
      action: 'TENANT_CREATED',
      targetType: 'Tenant',
      targetId: id,
      actor,
      tenantId: id,
      payloadFrom: () => ({ name: tenant.name, slug: tenant.slug, site: site?.name, adminEmail: admin.email }),
      run: (tx) =>
        tx.tenant.update({
          where: { id },
          data: { status: 'ACTIVE', settings: { ...rest, adminUserId: userId } as any },
        }),
    });
    const fresh = await this.prisma.tenant.findUniqueOrThrow({ where: { id } });
    return { tenant: fresh, admin: { userId, email: admin.email, temporaryPassword } };
  }

  update(id: string, dto: UpdateTenantDto, actor: AuditActor) {
    return this.audit.run({
      action: 'TENANT_UPDATED',
      targetType: 'Tenant',
      targetId: id,
      actor,
      tenantId: id,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => tx.tenant.update({ where: { id }, data: dto }),
    });
  }

  /** Users are locked out within 60 s; terminals are refused Login and keep buffering (§13.1). */
  setSuspended(id: string, suspended: boolean, reason: string | null, actor: AuditActor) {
    return this.audit.run({
      action: suspended ? 'TENANT_SUSPENDED' : 'TENANT_REACTIVATED',
      targetType: 'Tenant',
      targetId: id,
      actor,
      tenantId: id,
      payloadFrom: () => ({ reason }),
      run: async (tx) => {
        const tenant = await tx.tenant.findUnique({ where: { id } });
        if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
        if (tenant.status === 'PROVISIONING') throw new AppError(409, 'NOT_PROVISIONED', 'Finish provisioning first');
        return tx.tenant.update({
          where: { id },
          data: suspended
            ? { status: 'SUSPENDED', suspendedAt: new Date(), suspendedReason: reason }
            : { status: 'ACTIVE', suspendedAt: null, suspendedReason: null },
        });
      },
    });
  }

  async resetAdminPassword(id: string, actor: AuditActor) {
    const tenant = await this.get(id);
    const adminUserId = (tenant.settings as TenantSettings).adminUserId;
    if (!adminUserId) throw new AppError(409, 'NO_ADMIN', 'Tenant has no admin login yet');
    return this.users.resetPassword(null, adminUserId, actor);
  }
}

@ApiTags('platform')
@Controller('platform/tenants')
@Roles('PLATFORM_ADMIN')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  list() {
    return this.platform.list();
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTenantDto) {
    return this.platform.create(dto, actorOf(user)).catch((err) => {
      if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new AppError(409, 'SLUG_TAKEN', 'That slug is already used');
      }
      throw err;
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.platform.get(id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.platform.update(id, dto, actorOf(user));
  }

  @Post(':id/suspend')
  suspend(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.platform.setSuspended(id, true, dto.reason, actorOf(user));
  }

  @Post(':id/reactivate')
  reactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.platform.setSuspended(id, false, null, actorOf(user));
  }

  @Post(':id/retry-admin')
  retryAdmin(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.platform.retryAdmin(id, actorOf(user));
  }

  @Post(':id/admin/reset-password')
  resetAdminPassword(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.platform.resetAdminPassword(id, actorOf(user));
  }
}

@Module({
  imports: [UsersModule],
  controllers: [PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}

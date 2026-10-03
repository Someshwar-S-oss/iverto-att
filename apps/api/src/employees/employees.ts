import { Body, Controller, Get, Injectable, Logger, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Employee, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { RecomputeQueue } from '../attendance/recompute.service';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuditActor, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { addDays, dbDate, localYmd, ymdOf } from '../common/time';
import { IsYmd } from '../common/validators';
import { TerminalEnrollmentService } from '../terminals/services/terminal-enrollment.service';
import { TerminalsModule } from '../terminals/terminals.module';
import { UsersModule } from '../users/users.controller';
import { UsersService } from '../users/users.service';

const MOBILE_PUNCH = ['NEVER', 'REMOTE_DAYS', 'ALWAYS'] as const;
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'];

/** YYYY-MM-DD that is also a calendar date (rejects 2026-02-30). */
export const isRealYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export class EmployeeDto {
  @IsString() @MinLength(1) @MaxLength(40) employeeCode: string;
  @IsString() @MinLength(1) @MaxLength(120) fullName: string;
  @IsString() siteId: string;
  @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsString() managerId?: string | null;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(80) designation?: string | null;
  @IsOptional() @IsIn(EMPLOYMENT_TYPES) employmentType?: string;
  @IsYmd() joinedOn: string;
  @IsOptional() @IsIn(MOBILE_PUNCH) mobilePunch?: (typeof MOBILE_PUNCH)[number];
  /** HR confirms the employee consented to face enrolment (§17). */
  @IsOptional() @IsBoolean() biometricConsent?: boolean;
  /** Schedule to start with; defaults to the tenant's default shift. */
  @IsOptional() @IsString() shiftId?: string;
}

export class UpdateEmployeeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) employeeCode?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsString() managerId?: string | null;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(80) designation?: string | null;
  @IsOptional() @IsIn(EMPLOYMENT_TYPES) employmentType?: string;
  @IsOptional() @IsYmd() joinedOn?: string;
  @IsOptional() @IsYmd() exitOn?: string | null;
  @IsOptional() @IsIn(MOBILE_PUNCH) mobilePunch?: (typeof MOBILE_PUNCH)[number];
  @IsOptional() @IsBoolean() biometricConsent?: boolean;
}

export class EmployeeQuery {
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() managerId?: string;
  @IsOptional() @IsIn(['ACTIVE', 'EXITED']) status?: string;
  /** Name, code or email contains. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) size?: number;
}

export class ImportDto {
  /**
   * CSV with a header row: employeeCode,fullName,siteName,departmentName,managerCode,email,phone,designation,employmentType,joinedOn,mobilePunch.
   * siteName is not needed when siteId is given.
   */
  @IsString() @MaxLength(5_000_000) csv: string;
  /** Every row joins this site (the import wizard's location step); overrides siteName. */
  @IsOptional() @IsString() siteId?: string;
  /** false (default) = validate and preview only. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() commit?: boolean;
  @IsOptional() @IsBoolean() biometricConsent?: boolean;
}

export class OffboardDto {
  @IsYmd() exitOn: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** RFC 4180-ish CSV parse (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly scope: ScopeService,
    private readonly queue: RecomputeQueue,
    private readonly users: UsersService,
    private readonly enrollment: TerminalEnrollmentService,
  ) {}

  private async validateRefs(tenantId: string, d: { siteId?: string; departmentId?: string | null; managerId?: string | null }, selfId?: string) {
    if (d.siteId && !(await this.prisma.site.count({ where: { id: d.siteId, tenantId } }))) throw new AppError(400, 'SITE_NOT_FOUND', 'Unknown site');
    if (d.departmentId && !(await this.prisma.department.count({ where: { id: d.departmentId, tenantId } }))) {
      throw new AppError(400, 'DEPARTMENT_NOT_FOUND', 'Unknown department');
    }
    if (d.managerId) {
      if (d.managerId === selfId) throw new AppError(400, 'SELF_MANAGER', 'An employee cannot manage themselves');
      if (!(await this.prisma.employee.count({ where: { id: d.managerId, tenantId } }))) throw new AppError(400, 'MANAGER_NOT_FOUND', 'Unknown manager');
    }
  }

  async create(user: AuthUser, dto: EmployeeDto, actor: AuditActor = actorOf(user)) {
    await this.validateRefs(user.tenantId, dto);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
    const shift = dto.shiftId
      ? await this.prisma.shift.findFirst({ where: { id: dto.shiftId, tenantId: user.tenantId } })
      : await this.prisma.shift.findFirst({ where: { tenantId: user.tenantId, isDefault: true, active: true } });
    if (dto.shiftId && !shift) throw new AppError(400, 'UNKNOWN_SHIFT', 'Unknown shift');
    const { biometricConsent, shiftId: _s, ...data } = dto;

    const employee = await this.audit.run({
      action: 'EMPLOYEE_CREATED',
      targetType: 'Employee',
      actor,
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeCode: dto.employeeCode, fullName: dto.fullName, siteId: dto.siteId }),
      run: async (tx) => {
        const e = await tx.employee.create({
          data: {
            ...data,
            email: data.email?.toLowerCase() ?? null,
            tenantId: user.tenantId,
            joinedOn: dbDate(dto.joinedOn),
            ...(biometricConsent ? { biometricConsentAt: new Date(), biometricConsentBy: user.sub } : {}),
          },
        });
        // Everyone starts on a schedule, so the engine always has something to judge against.
        if (shift) {
          await tx.employeeSchedule.create({
            data: {
              tenantId: user.tenantId,
              employeeId: e.id,
              effectiveFrom: dbDate(dto.joinedOn),
              shiftId: shift.id,
              weeklyOffs: ((tenant.settings as any)?.defaultWeeklyOffs as number[]) ?? [0],
              createdBy: user.sub,
            },
          });
        }
        return e;
      },
    });
    const today = localYmd(new Date(), 'UTC');
    await this.queue.bulk({ tenantId: user.tenantId, employeeIds: [employee.id], from: addDays(today, -1), to: addDays(today, 14), rematerialise: true });
    return this.present(employee);
  }

  present(e: Employee & Record<string, any>) {
    return { ...e, joinedOn: ymdOf(e.joinedOn), exitOn: e.exitOn ? ymdOf(e.exitOn) : null };
  }

  async list(user: AuthUser, q: EmployeeQuery) {
    const page = q.page ?? 1;
    const size = q.size ?? 50;
    const where: Prisma.EmployeeWhereInput = {
      AND: [
        await this.scope.employeeWhere(user),
        q.siteId ? { siteId: q.siteId } : {},
        q.departmentId ? { departmentId: q.departmentId } : {},
        q.managerId ? { managerId: q.managerId } : {},
        q.projectId ? { projects: { some: { projectId: q.projectId } } } : {},
        { status: q.status ?? 'ACTIVE' },
        q.q
          ? {
              OR: [
                { fullName: { contains: q.q, mode: 'insensitive' } },
                { employeeCode: { contains: q.q, mode: 'insensitive' } },
                { email: { contains: q.q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [items, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        include: { site: { select: { id: true, name: true } }, department: { select: { id: true, name: true } }, manager: { select: { id: true, fullName: true } } },
        orderBy: { fullName: 'asc' },
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.employee.count({ where }),
    ]);
    return { items: items.map((e) => this.present(e)), total, page, size };
  }

  async get(user: AuthUser, id: string) {
    await this.scope.assertEmployee(user, id);
    const e = await this.prisma.employee.findUniqueOrThrow({
      where: { id },
      include: {
        site: true,
        department: true,
        manager: { select: { id: true, fullName: true, employeeCode: true } },
        projects: { include: { project: { select: { id: true, name: true } } } },
      },
    });
    const [profile, schedules, slots, template] = await Promise.all([
      e.userId ? this.prisma.userProfile.findUnique({ where: { userId: e.userId } }) : null,
      this.prisma.employeeSchedule.findMany({ where: { employeeId: id }, orderBy: { effectiveFrom: 'desc' }, take: 5 }),
      this.prisma.terminalUser.findMany({ where: { subjectId: id }, include: { device: { select: { id: true, name: true, serialNo: true, gateName: true } } } }),
      this.prisma.terminalFaceTemplate.findFirst({ where: { subjectId: id, status: 'active' }, select: { updatedAt: true, sourceDeviceId: true } }),
    ]);
    return {
      ...this.present(e),
      login: profile ? { userId: profile.userId, role: profile.role, status: profile.status, mustChangePassword: profile.mustChangePassword } : null,
      schedules: schedules.map((s) => ({ ...s, effectiveFrom: ymdOf(s.effectiveFrom), effectiveTo: s.effectiveTo ? ymdOf(s.effectiveTo) : null, anchorDate: s.anchorDate ? ymdOf(s.anchorDate) : null })),
      faces: { template, terminals: slots },
    };
  }

  async update(user: AuthUser, id: string, dto: UpdateEmployeeDto) {
    const before = await this.scope.assertEmployee(user, id);
    await this.validateRefs(user.tenantId, dto, id);
    const { biometricConsent, joinedOn, exitOn, ...rest } = dto;
    const after = await this.audit.run({
      action: 'EMPLOYEE_UPDATED',
      targetType: 'Employee',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) =>
        tx.employee.update({
          where: { id },
          data: {
            ...rest,
            ...(rest.email !== undefined ? { email: rest.email?.toLowerCase() ?? null } : {}),
            ...(joinedOn ? { joinedOn: dbDate(joinedOn) } : {}),
            ...(exitOn !== undefined ? { exitOn: exitOn ? dbDate(exitOn) : null } : {}),
            ...(biometricConsent === true && !before.biometricConsentAt ? { biometricConsentAt: new Date(), biometricConsentBy: user.sub } : {}),
            ...(biometricConsent === false ? { biometricConsentAt: null, biometricConsentBy: null } : {}),
          },
        }),
    });

    // Validity window on every terminal holding a slot (§4.3). Best effort; offline devices catch up on re-enrolment.
    if (joinedOn || exitOn !== undefined) {
      const slots = await this.prisma.terminalUser.findMany({ where: { subjectId: id, releasedAt: null } });
      for (const s of slots) await this.enrollment.syncUserPeriod(s.deviceId, after).catch(() => false);
    }
    if (dto.siteId || dto.departmentId !== undefined || joinedOn || exitOn !== undefined) {
      const today = localYmd(new Date(), 'UTC');
      await this.queue.bulk({ tenantId: user.tenantId, employeeIds: [id], from: addDays(today, -1), to: addDays(today, 14), rematerialise: true });
    }
    return this.present(after);
  }

  /**
   * Validate → preview → commit. Rows reference sites/departments by name and
   * managers by code, so HR can fill the sheet without looking up ids.
   */
  async import(user: AuthUser, dto: ImportDto) {
    const rows = parseCsv(dto.csv);
    if (rows.length < 2) throw new AppError(400, 'EMPTY_CSV', 'CSV needs a header row and at least one employee');
    if (rows.length > 5001) throw new AppError(400, 'CSV_TOO_LARGE', 'At most 5000 employees per import');
    const header = rows[0].map((h) => h.trim());
    const col = (name: string) => header.indexOf(name);
    for (const required of ['employeeCode', 'fullName', 'joinedOn', ...(dto.siteId ? [] : ['siteName'])]) {
      if (col(required) < 0) throw new AppError(400, 'MISSING_COLUMN', `Missing column ${required}`);
    }
    const [sites, departments, existing] = await Promise.all([
      this.prisma.site.findMany({ where: { tenantId: user.tenantId } }),
      this.prisma.department.findMany({ where: { tenantId: user.tenantId } }),
      this.prisma.employee.findMany({ where: { tenantId: user.tenantId }, select: { id: true, employeeCode: true } }),
    ]);
    const fixedSite = dto.siteId ? sites.find((s) => s.id === dto.siteId) : undefined;
    if (dto.siteId && !fixedSite) throw new AppError(400, 'SITE_NOT_FOUND', 'Unknown site');
    const codes = new Map(existing.map((e) => [e.employeeCode.toLowerCase(), e.id]));
    const seen = new Set<string>();

    const parsed = rows.slice(1).map((r, i) => {
      const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');
      // field = the CSV column at fault, so the import wizard can highlight the cell.
      const errors: { field: string; message: string }[] = [];
      const fail = (field: string, message: string) => errors.push({ field, message });
      const code = get('employeeCode');
      const site = fixedSite ?? sites.find((s) => s.name.toLowerCase() === get('siteName').toLowerCase());
      const dept = get('departmentName') ? departments.find((d) => d.name.toLowerCase() === get('departmentName').toLowerCase()) : null;
      const joinedOn = get('joinedOn');
      const mobilePunch = (get('mobilePunch') || 'NEVER').toUpperCase();
      const employmentType = (get('employmentType') || 'FULL_TIME').toUpperCase().replace(/[\s-]+/g, '_');
      if (!code) fail('employeeCode', 'employeeCode is required');
      else if (code.length > 40) fail('employeeCode', 'employeeCode is longer than 40 characters');
      if (codes.has(code.toLowerCase())) fail('employeeCode', 'employeeCode already exists');
      if (code && seen.has(code.toLowerCase())) fail('employeeCode', 'employeeCode repeated in this file');
      seen.add(code.toLowerCase());
      if (!get('fullName')) fail('fullName', 'fullName is required');
      if (!site) fail('siteName', `unknown site "${get('siteName')}"`);
      if (get('departmentName') && !dept) fail('departmentName', `unknown department "${get('departmentName')}"`);
      if (!isRealYmd(joinedOn)) fail('joinedOn', 'joinedOn must be a real date as YYYY-MM-DD');
      if (!(MOBILE_PUNCH as readonly string[]).includes(mobilePunch)) fail('mobilePunch', 'mobilePunch must be NEVER, REMOTE_DAYS or ALWAYS');
      if (!EMPLOYMENT_TYPES.includes(employmentType)) fail('employmentType', `employmentType must be ${EMPLOYMENT_TYPES.join(', ')}`);
      if (get('email') && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(get('email'))) fail('email', 'invalid email');
      if (get('phone').length > 30) fail('phone', 'phone is longer than 30 characters');
      return {
        line: i + 2,
        errors,
        managerCode: get('managerCode'),
        employee: {
          employeeCode: code,
          fullName: get('fullName'),
          siteId: site?.id ?? '',
          departmentId: dept?.id ?? null,
          email: get('email') || null,
          phone: get('phone') || null,
          designation: get('designation') || null,
          employmentType,
          joinedOn,
          mobilePunch: mobilePunch as EmployeeDto['mobilePunch'],
          biometricConsent: dto.biometricConsent,
        } as EmployeeDto,
      };
    });
    // Managers may be existing employees or rows in this same file.
    const fileCodes = new Set(parsed.map((p) => p.employee.employeeCode.toLowerCase()));
    for (const p of parsed) {
      if (p.managerCode && !codes.has(p.managerCode.toLowerCase()) && !fileCodes.has(p.managerCode.toLowerCase())) {
        p.errors.push({ field: 'managerCode', message: `unknown managerCode "${p.managerCode}"` });
      } else if (p.managerCode && p.managerCode.toLowerCase() === p.employee.employeeCode.toLowerCase()) {
        p.errors.push({ field: 'managerCode', message: 'an employee cannot manage themselves' });
      }
    }
    const invalid = parsed.filter((p) => p.errors.length);
    const preview = { total: parsed.length, valid: parsed.length - invalid.length, invalid: invalid.length, errors: invalid.map((p) => ({ line: p.line, errors: p.errors })) };
    if (!dto.commit) return { committed: false, ...preview, sample: parsed.slice(0, 20).map((p) => ({ line: p.line, ...p.employee, managerCode: p.managerCode })) };
    if (invalid.length) throw new AppError(400, 'IMPORT_INVALID', 'Fix the invalid rows before committing', preview.errors);

    const created: string[] = [];
    for (const p of parsed) {
      const e = await this.create(user, p.employee);
      codes.set(p.employee.employeeCode.toLowerCase(), e.id);
      created.push(e.id);
    }
    for (const p of parsed.filter((x) => x.managerCode)) {
      await this.prisma.employee.update({
        where: { id: codes.get(p.employee.employeeCode.toLowerCase())! },
        data: { managerId: codes.get(p.managerCode.toLowerCase())! },
      });
    }
    await this.audit.log({ tenantId: user.tenantId, actor: actorOf(user), action: 'EMPLOYEES_IMPORTED', targetType: 'Employee', payload: { count: created.length } });
    return { committed: true, ...preview, createdIds: created };
  }

  /**
   * Exit (§4.3, §13.2): exit date, device cleanup on every terminal holding a
   * slot (never aborting the batch; offline ones retried hourly), templates
   * deleted, login removed so the email is free again.
   */
  async offboard(user: AuthUser, id: string, dto: OffboardDto) {
    const employee = await this.scope.assertEmployee(user, id);
    if (employee.status === 'EXITED') throw new AppError(409, 'ALREADY_EXITED', 'Employee has already exited');
    if (dto.exitOn < ymdOf(employee.joinedOn)) throw new AppError(400, 'BAD_EXIT_DATE', 'Exit date is before the joining date');
    const actor = actorOf(user);

    const exited = await this.audit.run({
      action: 'EMPLOYEE_OFFBOARDED',
      targetType: 'Employee',
      targetId: id,
      actor,
      tenantId: user.tenantId,
      payloadFrom: () => ({ exitOn: dto.exitOn, reason: dto.reason ?? null }),
      run: async (tx) => {
        await tx.attendanceDay.deleteMany({ where: { employeeId: id, workDate: { gt: dbDate(dto.exitOn) } } });
        await tx.terminalFaceTemplate.deleteMany({ where: { subjectId: id } });
        await tx.leaveRequest.updateMany({ where: { employeeId: id, status: 'PENDING' }, data: { status: 'CANCELLED', decisionNote: 'Employee exited' } });
        await tx.remoteWorkRequest.updateMany({ where: { employeeId: id, status: 'PENDING' }, data: { status: 'CANCELLED', decisionNote: 'Employee exited' } });
        return tx.employee.update({ where: { id }, data: { exitOn: dbDate(dto.exitOn), status: 'EXITED' } });
      },
    });

    const devices = await this.offboardDevices(id, actor);
    if (employee.userId) await this.users.removeLogin(user.tenantId, employee.userId, actor);
    return { employee: this.present(exited), devices, loginRemoved: Boolean(employee.userId) };
  }

  /** Also used by the hourly terminal-offboard-retry job. */
  async offboardDevices(employeeId: string, actor: AuditActor) {
    const slots = await this.prisma.terminalUser.findMany({
      where: { subjectId: employeeId, releasedAt: null },
      include: { device: { select: { serialNo: true } } },
    });
    const results: Array<{ deviceId: string; serialNo: string; status: string; error?: string }> = [];
    for (const s of slots) {
      try {
        results.push({ deviceId: s.deviceId, serialNo: s.device.serialNo, status: await this.enrollment.offboard(s.deviceId, employeeId, actor) });
      } catch (err) {
        results.push({ deviceId: s.deviceId, serialNo: s.device.serialNo, status: 'failed', error: (err as Error).message });
      }
    }
    return results;
  }

  /** Hourly: retry DeleteUser on terminals that were offline at exit. */
  async retryPendingOffboarding() {
    return runAsSystem(async () => {
      const pending = await this.prisma.terminalUser.findMany({ where: { releasedAt: null }, select: { subjectId: true } });
      const exited = await this.prisma.employee.findMany({
        where: { id: { in: [...new Set(pending.map((p) => p.subjectId))] }, status: 'EXITED' },
        select: { id: true },
      });
      for (const e of exited) await this.offboardDevices(e.id, { type: 'system' });
      return exited.length;
    });
  }
}

@ApiTags('employees')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: EmployeeQuery) {
    return this.employees.list(user, q);
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: EmployeeDto) {
    return this.employees.create(user, dto);
  }

  @Post('import')
  @Roles('ADMIN', 'HR')
  import(@CurrentUser() user: AuthUser, @Body() dto: ImportDto) {
    return this.employees.import(user, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.employees.get(user, id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employees.update(user, id, dto);
  }

  @Post(':id/offboard')
  @Roles('ADMIN', 'HR')
  offboard(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: OffboardDto) {
    return this.employees.offboard(user, id, dto);
  }
}

@Module({
  imports: [TerminalsModule, UsersModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}

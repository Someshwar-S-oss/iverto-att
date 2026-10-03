import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { actorOf, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import {
  asSubjects,
  CaptureTemplatesBody,
  ClaimSlotDto,
  DistributeTemplatesBody,
  EmployeeRefDto,
  EnrollByPhotoDto,
  ProvisionTerminalDto,
  RemoteEnrollDto,
  UpdateTerminalDto,
} from './dto/terminal.dto';
import type { AdminLogCategory } from './protocol/m50-protocol';
import { TerminalEnrollmentService } from './services/terminal-enrollment.service';
import { TerminalInspectionService } from './services/terminal-inspection.service';
import { TerminalTemplateService } from './services/terminal-template.service';
import { TerminalsService } from './terminals.service';

const EMPLOYEE = 'EMPLOYEE';

/**
 * Device commands go to an in-memory session keyed by device id, which RLS
 * cannot see — so every `:deviceId` route checks the device belongs to the
 * caller's tenant (and allowed sites) before anything is sent to hardware.
 */
@Injectable()
export class DeviceTenantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const deviceId: string | undefined = req.params?.deviceId;
    if (!deviceId) return true;
    const user = req.user as AuthUser;
    // Guards run before the RLS interceptor, so this lookup filters by tenant itself.
    const device = await runAsSystem(() =>
      this.prisma.device.findFirst({
        where: { id: deviceId, tenantId: user.tenantId, ...(user.siteIds.length ? { siteId: { in: user.siteIds } } : {}) },
        select: { id: true },
      }),
    );
    if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', 'Terminal not found');
    return true;
  }
}

/**
 * Control plane for M50 terminals (copied from hostel; tenant from the JWT).
 * Terminals never speak HTTP — every command here is relayed over the device's
 * open WebSocket, so an offline terminal answers 503 rather than queuing.
 */
@ApiTags('terminals')
@Controller('terminals')
@Roles('ADMIN', 'HR')
@UseGuards(DeviceTenantGuard)
export class TerminalsController {
  constructor(
    private readonly terminals: TerminalsService,
    private readonly enrollment: TerminalEnrollmentService,
    private readonly inspection: TerminalInspectionService,
    private readonly templates: TerminalTemplateService,
  ) {}

  // ── Fleet ───────────────────────────────────────────────────────────────
  // Literal segments before `:deviceId` so "templates" is never read as an id.

  @Get()
  @ApiOperation({ summary: 'Terminals with live connection status, mapped users and UNKNOWN punch counts' })
  findAll(@CurrentUser() user: AuthUser) {
    return this.terminals.findAll(user.tenantId, user.siteIds);
  }

  @Post()
  @ApiOperation({ summary: 'Provision a terminal by serial (required before it can register)' })
  provision(@CurrentUser() user: AuthUser, @Body() body: ProvisionTerminalDto) {
    return this.terminals.provision(user.tenantId, body, actorOf(user));
  }

  @Get('templates/coverage')
  @ApiOperation({ summary: 'Who has a stored template and which terminals hold their face (from our tables)' })
  coverage(@CurrentUser() user: AuthUser) {
    return this.templates.coverage(user.tenantId);
  }

  @Post('templates/capture')
  @ApiOperation({ summary: 'Harvest templates for several employees off one terminal' })
  captureMany(@CurrentUser() user: AuthUser, @Body() body: CaptureTemplatesBody) {
    return this.templates.captureMany(
      user.tenantId,
      { sourceDeviceId: body.sourceDeviceId, subjects: asSubjects(body.employeeIds), refresh: body.refresh },
      actorOf(user),
    );
  }

  @Post('templates/distribute')
  @ApiOperation({ summary: 'Push stored templates onto several terminals (optionally capturing from a source first)' })
  distribute(@CurrentUser() user: AuthUser, @Body() body: DistributeTemplatesBody) {
    return this.templates.distribute(
      user.tenantId,
      { subjects: asSubjects(body.employeeIds), deviceIds: body.deviceIds, sourceDeviceId: body.sourceDeviceId, skipEnrolled: body.skipEnrolled },
      actorOf(user),
    );
  }

  @Patch(':deviceId')
  @ApiOperation({ summary: 'Edit name, site, gate, direction or clock timezone (the terminal reconnects to pick it up)' })
  update(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string, @Body() body: UpdateTerminalDto) {
    return this.terminals.update(user.tenantId, deviceId, body, actorOf(user));
  }

  @Delete(':deviceId')
  @Roles('ADMIN')
  remove(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string) {
    return this.terminals.remove(user.tenantId, deviceId, actorOf(user));
  }

  // ── Slots & enrolment ───────────────────────────────────────────────────

  @Get(':deviceId/users')
  @ApiOperation({ summary: 'Slot mappings on this terminal (our mirror)' })
  listUsers(@Param('deviceId') deviceId: string) {
    return this.terminals.listUsers(deviceId);
  }

  @Post(':deviceId/users')
  @ApiOperation({
    summary: 'Reserve a numbered slot for an employee',
    description: 'Creates the named user on the device with its validity window; the person then enrols at the keypad against that number, then POST templates/capture.',
  })
  reserve(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string, @Body() body: EmployeeRefDto) {
    return this.enrollment.provisionSubject(deviceId, EMPLOYEE, body.employeeId, actorOf(user));
  }

  @Post(':deviceId/users/:terminalUserId/claim')
  @ApiOperation({
    summary: 'Bind a keypad enrolment to an employee (+ retro-attribute its UNKNOWN punches)',
    description: 'Identify the slot first with GET device/unclaimed and GET device/users/{slot}/photo.',
  })
  claim(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
    @Param('terminalUserId', ParseIntPipe) terminalUserId: number,
    @Body() body: ClaimSlotDto,
  ) {
    return this.enrollment.claimSlot(
      deviceId,
      terminalUserId,
      EMPLOYEE,
      body.employeeId,
      { renameOnDevice: body.renameOnDevice ?? true, captureTemplate: body.captureTemplate ?? true },
      actorOf(user),
    );
  }

  @Delete(':deviceId/users/:terminalUserId/claim')
  @ApiOperation({ summary: 'Undo a claim; the face stays on the device and the slot returns to the unclaimed queue' })
  release(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string, @Param('terminalUserId', ParseIntPipe) terminalUserId: number) {
    return this.enrollment.releaseSlot(deviceId, terminalUserId, actorOf(user));
  }

  @Delete(':deviceId/employees/:employeeId')
  @ApiOperation({ summary: 'Delete an employee from this terminal (device and mapping)' })
  async removeEmployee(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string, @Param('employeeId') employeeId: string) {
    await this.enrollment.removeSubject(deviceId, EMPLOYEE, employeeId, actorOf(user));
    return { status: 'removed' };
  }

  @Post(':deviceId/enroll/photo')
  @ApiOperation({ summary: 'Enrol a face from a JPEG under 32KB (no one needed at the device)' })
  async enrollByPhoto(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string, @Body() body: EnrollByPhotoDto) {
    await this.enrollment.enrollFromPhoto(deviceId, EMPLOYEE, body.employeeId, Buffer.from(body.photoBase64, 'base64'), actorOf(user));
    return { status: 'enrolled' };
  }

  @Post(':deviceId/enroll/remote')
  @ApiOperation({
    summary: 'Diagnostic only: RemoteEnroll carries no UserID; real hardware answers EnrollNumberError',
    description: 'Returns the device ResultCode, what it means and what to do instead.',
  })
  remoteEnroll(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string, @Body() body: RemoteEnrollDto) {
    return this.enrollment.startRemoteEnroll(deviceId, EMPLOYEE, body.employeeId, body.backup ?? 'RemoteEnrollFace', actorOf(user));
  }

  @Post(':deviceId/enroll/cancel')
  @ApiOperation({ summary: 'Exit enrolment mode; wasActive=false means it never entered one' })
  cancelEnroll(@Param('deviceId') deviceId: string) {
    return this.enrollment.cancelRemoteEnroll(deviceId);
  }

  @Post(':deviceId/templates/capture')
  @ApiOperation({ summary: 'Harvest one employee’s vendor template into the cloud' })
  capture(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string, @Body() body: EmployeeRefDto) {
    return this.enrollment.captureTemplate(deviceId, EMPLOYEE, body.employeeId, actorOf(user));
  }

  @Post(':deviceId/templates/replicate')
  @ApiOperation({ summary: 'Push a stored template onto this terminal' })
  async replicate(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string, @Body() body: EmployeeRefDto) {
    await this.enrollment.replicateTemplate(deviceId, EMPLOYEE, body.employeeId, actorOf(user));
    return { status: 'replicated' };
  }

  // ── Reading the device itself ─────────────────────────────────────────────

  @Post(':deviceId/device/sync-enrolment')
  @ApiOperation({ summary: '"Check the device": adopt the hardware’s FaceEnrolled flags, both directions' })
  sync(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string) {
    return this.enrollment.syncEnrolmentState(deviceId, actorOf(user));
  }

  @Get(':deviceId/device/status')
  status(@Param('deviceId') deviceId: string) {
    return this.inspection.deviceStatus(deviceId);
  }

  @Get(':deviceId/device/logs')
  @ApiOperation({ summary: 'Attendance log stored on the device (from/nextFrom are positions, not LogIDs)' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'limit', required: false })
  logs(@Param('deviceId') deviceId: string, @Query('from') from?: string, @Query('limit') limit?: string) {
    return this.inspection.deviceLogs(deviceId, {
      from: from ? Number.parseInt(from, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @Get(':deviceId/device/users')
  @ApiOperation({ summary: 'Reconcile every slot on the device against our mapping' })
  deviceUsers(@Param('deviceId') deviceId: string) {
    return this.inspection.deviceUsers(deviceId);
  }

  @Get(':deviceId/device/users/:terminalUserId/photo')
  photo(@Param('deviceId') deviceId: string, @Param('terminalUserId', ParseIntPipe) terminalUserId: number) {
    return this.inspection.deviceUserPhoto(deviceId, terminalUserId);
  }

  @Get(':deviceId/device/users/:terminalUserId')
  deviceUser(@Param('deviceId') deviceId: string, @Param('terminalUserId', ParseIntPipe) terminalUserId: number) {
    return this.inspection.deviceUser(deviceId, terminalUserId);
  }

  @Get(':deviceId/device/unclaimed')
  @ApiOperation({ summary: '"Waiting to be linked": slots on the device bound to nobody' })
  unclaimed(@Param('deviceId') deviceId: string) {
    return this.inspection.unclaimedSlots(deviceId);
  }

  @Get(':deviceId/device/admin-logs')
  @ApiQuery({ name: 'category', required: false, enum: ['enrollment', 'deletion', 'configuration', 'session', 'other'] })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'skip', required: false })
  adminLogs(
    @Param('deviceId') deviceId: string,
    @Query('category') category?: AdminLogCategory,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.inspection.adminLogs(deviceId, {
      category,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      skip: skip ? Number.parseInt(skip, 10) : undefined,
    });
  }
}

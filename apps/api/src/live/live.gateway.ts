import { Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';

const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : true;

export interface EmployeeRooms {
  tenantId: string;
  siteId: string;
  departmentId?: string | null;
  managerId?: string | null;
  userId?: string | null;
}

/**
 * Real-time monitoring (§10, §14.3): snapshot over REST, deltas here.
 * Rooms by scope: tenant: (admin/HR), site: (site-restricted HR/admins),
 * dept: / mgr: (managers), user: (everyone, personal events).
 * No replay: on reconnect the client refetches the snapshot.
 */
@WebSocketGateway({ namespace: '/live', cors: { origin: corsOrigin, credentials: true } })
export class LiveGateway implements OnGatewayConnection {
  private readonly logger = new Logger(LiveGateway.name);
  @WebSocketServer() server: Namespace;

  constructor(
    private readonly auth: JwtAuthGuard,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(socket: Socket) {
    const raw = (socket.handshake.auth?.token as string) || (socket.handshake.headers.authorization ?? '').replace(/^Bearer /, '');
    let user: AuthUser;
    try {
      user = await this.auth.verify(raw);
    } catch {
      socket.emit('error', { code: 'UNAUTHORIZED' });
      return socket.disconnect(true);
    }
    if (!user.tenantId || user.mustChangePassword || (await this.auth.statusOf(user.tenantId)) !== 'ACTIVE') {
      socket.emit('error', { code: 'FORBIDDEN' });
      return socket.disconnect(true);
    }
    socket.join(await this.roomsFor(user));
  }

  private async roomsFor(user: AuthUser): Promise<string[]> {
    const rooms = [`user:${user.sub}`];
    if (user.role === 'ADMIN' || user.role === 'HR') {
      if (user.siteIds.length) rooms.push(...user.siteIds.map((s) => `site:${s}`));
      else rooms.push(`tenant:${user.tenantId}`);
    } else if (user.role === 'MANAGER' && user.employeeId) {
      rooms.push(`mgr:${user.employeeId}`);
      const headed = await runAsSystem(() =>
        this.prisma.department.findMany({ where: { tenantId: user.tenantId, headEmployeeId: user.employeeId }, select: { id: true } }),
      );
      rooms.push(...headed.map((d) => `dept:${d.id}`));
    }
    return rooms;
  }

  private employeeRooms(e: EmployeeRooms): string[] {
    return [
      `tenant:${e.tenantId}`,
      `site:${e.siteId}`,
      ...(e.departmentId ? [`dept:${e.departmentId}`] : []),
      ...(e.managerId ? [`mgr:${e.managerId}`] : []),
      ...(e.userId ? [`user:${e.userId}`] : []),
    ];
  }

  /** attendance.updated / punch.created — to everyone whose scope includes the employee. */
  emitForEmployee(event: 'attendance.updated' | 'punch.created', employee: EmployeeRooms, payload: unknown) {
    this.server?.to(this.employeeRooms(employee)).emit(event, payload);
  }

  emitToTenantSite(event: 'device.status', tenantId: string, siteId: string, payload: unknown) {
    this.server?.to([`tenant:${tenantId}`, `site:${siteId}`]).emit(event, payload);
  }

  emitToUser(event: 'report.ready' | 'report.failed' | 'approval.pending' | 'notification.new', userId: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
}

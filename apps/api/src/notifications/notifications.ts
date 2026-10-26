import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { LiveGateway } from '../live/live.gateway';

export interface NotificationInput {
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * In-app inbox + FCM push (copied from hostel, trimmed). Push is optional:
 * without FIREBASE_SERVICE_ACCOUNT the inbox still fills and pushes are only logged.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private fcm: ReturnType<typeof getMessaging> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveGateway,
  ) {
    const account = process.env.FIREBASE_SERVICE_ACCOUNT;
    try {
      if (account) {
        const json = JSON.parse(account.trim().startsWith('{') ? account : Buffer.from(account, 'base64').toString('utf8'));
        // The app's tokens are issued for iverto-attend only; any other project fails every send.
        if (json.project_id !== 'iverto-attend') throw new Error(`service account is for ${json.project_id}, expected iverto-attend`);
        if (!getApps().length) initializeApp({ credential: cert(json) });
        this.fcm = getMessaging();
      }
    } catch (err) {
      this.logger.error(`FCM disabled: ${(err as Error).message}`);
    }
    this.logger.log(this.fcm ? 'push: FCM (iverto-attend)' : 'push: NoOp');
  }

  /** Never throws: a failed notification must not fail the action that caused it. */
  async notify(tenantId: string, userIds: Array<string | null | undefined>, n: NotificationInput): Promise<void> {
    const ids = [...new Set(userIds.filter((u): u is string => Boolean(u)))];
    if (!ids.length) return;
    try {
      await runAsSystem(async () => {
        for (const userId of ids) {
          const row = await this.prisma.appNotification.create({
            data: { tenantId, userId, type: n.type, title: n.title, body: n.body, data: (n.data ?? {}) as Prisma.InputJsonValue },
          });
          this.live.emitToUser('notification.new', userId, row);
          // Inbox first; a failed push never undoes the row or the action.
          await this.push(tenantId, userId, row.id, n).catch((err) => this.logger.warn(`Push ${n.type} failed: ${(err as Error).message}`));
        }
      });
    } catch (err) {
      this.logger.warn(`Notification ${n.type} failed: ${(err as Error).message}`);
    }
  }

  /** One user's devices (≤500 per user in practice, so one multicast). See docs/fcm_server_changes.md §5–7. */
  private async push(tenantId: string, userId: string, notificationId: string, n: NotificationInput) {
    const devices = await this.prisma.pushDevice.findMany({ where: { tenantId, userId, active: true } });
    if (!devices.length) return;
    if (!this.fcm) {
      this.logger.debug(`[no FCM] ${n.type} → ${devices.length} device(s)`);
      return;
    }
    const tokens = devices.map((d) => d.token);
    // ponytail: no retry queue for transient FCM errors; the inbox row is the fallback.
    const res = await this.fcm.sendEachForMulticast({
      tokens,
      notification: { title: n.title, body: n.body },
      data: { ...(n.data ?? {}), type: n.type, notificationId },
      android: { priority: 'high', ttl: pushTtl(n.type), notification: { channelId: 'default', tag: notificationId } },
    });
    const dead: string[] = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code ?? '';
      if (DEAD_TOKEN.has(code)) dead.push(tokens[i]);
      else this.logger.warn(`Push ${n.type} failed: ${code} ${r.error?.message ?? ''}`);
    });
    if (dead.length) await this.prisma.pushDevice.updateMany({ where: { token: { in: dead } }, data: { active: false } });
  }

  /** Who decides a request for this employee: their manager, else HR and admins. */
  async approversFor(tenantId: string, employeeId: string, hrOnly = false): Promise<string[]> {
    return runAsSystem(async () => {
      if (!hrOnly) {
        const employee = await this.prisma.employee.findUnique({
          where: { id: employeeId },
          select: { manager: { select: { userId: true } } },
        });
        if (employee?.manager?.userId) return [employee.manager.userId];
      }
      const hr = await this.prisma.userProfile.findMany({
        where: { tenantId, role: { in: ['HR', 'ADMIN'] }, status: 'ACTIVE' },
        select: { userId: true },
      });
      return hr.map((h) => h.userId);
    });
  }

  async approvalPending(tenantId: string, employeeId: string, type: 'leave' | 'correction' | 'remote', id: string, who: string, hrOnly = false) {
    const approvers = await this.approversFor(tenantId, employeeId, hrOnly);
    for (const userId of approvers) this.live.emitToUser('approval.pending', userId, { type, id });
    await this.notify(tenantId, approvers, {
      // The app opens LEAVE_/CORRECTION_/REMOTE_…_SUBMITTED in the approver view.
      type: `${type.toUpperCase()}_SUBMITTED`,
      title: `New ${type} request`,
      body: `${who} is waiting for your decision`,
      data: { requestType: type, id },
    });
  }

  async userIdOfEmployee(employeeId: string): Promise<string | null> {
    const e = await runAsSystem(() => this.prisma.employee.findUnique({ where: { id: employeeId }, select: { userId: true } }));
    return e?.userId ?? null;
  }

  /** Inbox (cursor = id of the last item received). */
  async inbox(userId: string, cursor?: string, limit = 20) {
    const items = await this.prisma.appNotification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const unread = await this.prisma.appNotification.count({ where: { userId, readAt: null } });
    const hasMore = items.length > limit;
    const data = items.slice(0, limit);
    return { data, nextCursor: hasMore ? data[data.length - 1].id : null, unreadCount: unread };
  }

  markRead(userId: string, ids: string[] | 'all') {
    return this.prisma.appNotification.updateMany({
      where: { userId, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
  }

  /**
   * Upsert on the token: a handed-over phone moves to the caller. As system, because
   * a row still owned by another tenant is invisible under RLS and the insert would
   * hit the unique index.
   */
  async registerDevice(tenantId: string, userId: string, platform: string, token: string) {
    await runAsSystem(() =>
      this.prisma.pushDevice.upsert({
        where: { token },
        update: { tenantId, userId, platform, active: true, lastSeenAt: new Date() },
        create: { tenantId, userId, platform, token },
      }),
    );
    return { status: 'registered' };
  }

  unregisterDevice(userId: string, token: string) {
    return this.prisma.pushDevice.updateMany({ where: { userId, token }, data: { active: false } });
  }
}

const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/mismatched-credential',
]);

const HOUR = 3_600_000;
/** Reminders are pointless the next day; requests and outcomes keep for 3 days. */
function pushTtl(type: string): number {
  if (/MISSED|LATE|ABSENT/.test(type)) return 12 * HOUR;
  if (/REPORT|DEVICE/.test(type)) return 24 * HOUR;
  return 72 * HOUR;
}

@Global()
@Module({ providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}

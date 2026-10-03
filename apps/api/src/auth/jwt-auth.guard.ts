import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jose from 'jose';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { ALLOW_PENDING_PASSWORD, AuthUser, IS_PUBLIC, ROLES, ROLES_KEY, Role } from './auth.types';

const TENANT_STATUS_TTL_MS = 60_000;

/**
 * Verifies Supabase access tokens against the project JWKS (asymmetric keys
 * only — the hostel HS256 fallback, and its secret-leaking log line, are gone),
 * then enforces tenant suspension, forced password change and roles.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private jwks?: jose.JWTVerifyGetKey;
  private readonly tenantStatus = new Map<string, { status: string; at: number }>();

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const meta = <T>(key: string) =>
      this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
    if (meta<boolean>(IS_PUBLIC)) return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED', 'Missing bearer token');

    let user: AuthUser;
    try {
      user = await this.verify(header.slice(7).trim());
    } catch (err) {
      this.logger.debug(`JWT rejected: ${(err as Error).message}`);
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
    }

    // Platform admins troubleshoot inside a tenant through an explicit, audited header.
    const override = request.headers['x-tenant-id'] as string | undefined;
    if (override && user.isSuperAdmin) {
      user = { ...user, tenantId: override, role: 'ADMIN' };
      await runAsSystem(async () =>
        this.prisma.auditLog.create({
          data: {
            tenantId: override,
            actorUserId: user.sub,
            actorType: 'user',
            action: 'PLATFORM_TENANT_OVERRIDE',
            payload: { method: request.method, url: request.url },
          },
        }),
      );
    }
    request.user = user;

    if (user.tenantId && !user.isSuperAdmin) {
      const status = await this.statusOf(user.tenantId);
      if (status !== 'ACTIVE') {
        throw new AppError(403, 'TENANT_SUSPENDED', 'This organisation is not active');
      }
    }

    if (user.mustChangePassword && !meta<boolean>(ALLOW_PENDING_PASSWORD)) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Set a new password before continuing');
    }

    const required = meta<Role[]>(ROLES_KEY);
    if (required?.includes('PLATFORM_ADMIN')) {
      if (!user.isSuperAdmin) throw new AppError(403, 'FORBIDDEN', 'Platform administrators only');
      return true;
    }
    // Own-account routes (password change, /me) work for platform admins too.
    if (!user.tenantId && !meta<boolean>(ALLOW_PENDING_PASSWORD)) {
      throw new AppError(403, 'NO_TENANT', 'Pass X-Tenant-Id to act inside a tenant');
    }
    if (required?.length && !required.includes(user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Your role does not allow this');
    }
    return true;
  }

  async verify(token: string): Promise<AuthUser> {
    const url = process.env.SUPABASE_JWKS_URL;
    if (!url) throw new Error('SUPABASE_JWKS_URL is not configured');
    this.jwks ??= jose.createRemoteJWKSet(new URL(url));
    const { payload } = await jose.jwtVerify(token, this.jwks);
    const app = (payload.app_metadata ?? {}) as Record<string, any>;
    const isSuperAdmin = app.is_super_admin === true;
    const role = (ROLES as readonly string[]).includes(app.role) ? (app.role as Role) : 'EMPLOYEE';
    return {
      sub: payload.sub ?? '',
      email: (payload.email as string) ?? '',
      tenantId: isSuperAdmin ? '' : (app.tenant_id ?? ''),
      role: isSuperAdmin ? 'PLATFORM_ADMIN' : role,
      employeeId: app.employee_id ?? null,
      siteIds: Array.isArray(app.site_ids) ? app.site_ids : [],
      isSuperAdmin,
      mustChangePassword: app.must_change_password === true,
    };
  }

  /** Cached for a minute, so a suspension bites within 60 s (§13.1). */
  async statusOf(tenantId: string): Promise<string> {
    const hit = this.tenantStatus.get(tenantId);
    if (hit && Date.now() - hit.at < TENANT_STATUS_TTL_MS) return hit.status;
    const tenant = await runAsSystem(async () =>
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
    );
    const status = tenant?.status ?? 'MISSING';
    this.tenantStatus.set(tenantId, { status, at: Date.now() });
    return status;
  }
}

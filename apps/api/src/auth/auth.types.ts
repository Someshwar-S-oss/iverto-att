import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const ROLES = ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'] as const;
export type Role = (typeof ROLES)[number] | 'PLATFORM_ADMIN';

/** The caller, from verified Supabase JWT claims (app_metadata cannot be self-edited). */
export interface AuthUser {
  sub: string;
  email: string;
  /** Empty for platform admins not acting inside a tenant. */
  tenantId: string;
  role: Role;
  employeeId: string | null;
  siteIds: string[];
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
}

export interface AuditActor {
  type: 'user' | 'system' | 'device';
  userId?: string;
  deviceId?: string;
}

export const actorOf = (user: AuthUser): AuditActor => ({ type: 'user', userId: user.sub });

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
/** Omitted = any authenticated tenant user. `PLATFORM_ADMIN` = Iverto staff only. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Reachable while the account still has to replace its temporary password. */
export const ALLOW_PENDING_PASSWORD = 'allowPendingPassword';
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

export const isHrOrAdmin = (user: AuthUser) => user.role === 'ADMIN' || user.role === 'HR';

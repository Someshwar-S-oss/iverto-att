import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { AuditableActionService } from '../audit/audit.service';
import { AuditActor, AuthUser, Role } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { SupabaseService } from '../common/supabase.service';

const PASSWORD_ALPHABET = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digit: '23456789',
  symbol: '!@#$%&*?',
};

/** 14 random characters, at least one of each class, no look-alikes. Never derived from user data (§13). */
export function temporaryPassword(): string {
  const all = Object.values(PASSWORD_ALPHABET).join('');
  const chars = Object.values(PASSWORD_ALPHABET).map((set) => set[randomInt(set.length)]);
  while (chars.length < 14) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export interface NewLogin {
  tenantId: string;
  email: string;
  displayName: string;
  role: Role;
  employeeId?: string | null;
  siteIds?: string[];
}

/**
 * Supabase auth accounts. Claims live in app_metadata, which the user cannot
 * edit; `user_profiles` mirrors them for listing and for audit references.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly audit: AuditableActionService,
  ) {}

  private claims(p: { tenantId: string | null; role: string; employeeId?: string | null; siteIds?: string[] }, mustChange: boolean) {
    return {
      tenant_id: p.tenantId,
      role: p.role,
      employee_id: p.employeeId ?? null,
      site_ids: p.siteIds ?? [],
      must_change_password: mustChange,
      ...(p.role === 'PLATFORM_ADMIN' ? { is_super_admin: true } : {}),
    };
  }

  /**
   * One email is one login in one tenant (§13.2). A clash with another tenant
   * is reported without saying which tenant holds it.
   */
  async createLogin(input: NewLogin, actor: AuditActor): Promise<{ userId: string; temporaryPassword: string }> {
    const email = input.email.trim().toLowerCase();
    const clash = await runAsSystem(() =>
      this.prisma.userProfile.findFirst({ where: { email, status: { not: 'EXITED' } }, select: { tenantId: true } }),
    );
    if (clash) {
      if (clash.tenantId === input.tenantId) throw new AppError(409, 'DUPLICATE', 'A login with this email already exists');
      throw new AppError(409, 'EMAIL_IN_USE', 'This email is already used by another account');
    }

    const password = temporaryPassword();
    let authUser: { id: string };
    try {
      authUser = await this.supabase.createUser(email, password, this.claims(input, true));
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (/already|registered|exists/i.test(message)) {
        throw new AppError(409, 'EMAIL_IN_USE', 'This email is already used by another account');
      }
      throw err;
    }

    try {
      await this.audit.run({
        action: 'USER_CREATED',
        targetType: 'UserProfile',
        targetId: authUser.id,
        actor,
        tenantId: input.tenantId,
        payloadFrom: () => ({ email, role: input.role, employeeId: input.employeeId ?? null }),
        run: async (tx) => {
          const profile = await tx.userProfile.create({
            data: {
              userId: authUser.id,
              tenantId: input.tenantId,
              employeeId: input.employeeId ?? null,
              role: input.role,
              displayName: input.displayName,
              email,
              siteIds: input.siteIds ?? [],
              mustChangePassword: true,
            },
          });
          if (input.employeeId) {
            await tx.employee.update({ where: { id: input.employeeId }, data: { userId: authUser.id, email } });
          }
          return profile;
        },
      });
    } catch (err) {
      // Do not leave an auth user nobody can see or manage.
      await this.supabase.deleteUser(authUser.id).catch(() => undefined);
      throw err;
    }
    return { userId: authUser.id, temporaryPassword: password };
  }

  async list(tenantId: string) {
    return this.prisma.userProfile.findMany({ where: { tenantId }, orderBy: { displayName: 'asc' } });
  }

  async get(tenantId: string, userId: string) {
    const profile = await this.prisma.userProfile.findFirst({ where: { tenantId, userId } });
    if (!profile) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    return profile;
  }

  async update(tenantId: string, userId: string, patch: { role?: Role; siteIds?: string[]; displayName?: string }, actor: AuditActor) {
    const profile = await this.get(tenantId, userId);
    const next = { ...profile, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    await this.supabase.updateUser(userId, { app_metadata: this.claims(next, profile.mustChangePassword) });
    return this.audit.run({
      action: patch.role && patch.role !== profile.role ? 'USER_ROLE_CHANGED' : 'USER_UPDATED',
      targetType: 'UserProfile',
      targetId: userId,
      actor,
      tenantId,
      payloadFrom: () => ({ before: { role: profile.role, siteIds: profile.siteIds }, after: patch }),
      run: (tx) =>
        tx.userProfile.update({
          where: { userId },
          data: { role: next.role, siteIds: next.siteIds, displayName: next.displayName },
        }),
    });
  }

  /** HR/Admin issues a fresh temporary password (§13, no reset e-mails). */
  async resetPassword(tenantId: string | null, userId: string, actor: AuditActor) {
    const profile = await runAsSystem(() => this.prisma.userProfile.findUnique({ where: { userId } }));
    if (!profile || (tenantId !== null && profile.tenantId !== tenantId) || profile.status === 'EXITED') {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    const password = temporaryPassword();
    await this.supabase.updateUser(userId, { password, app_metadata: this.claims(profile, true) });
    await this.audit.run({
      action: 'USER_PASSWORD_RESET',
      targetType: 'UserProfile',
      targetId: userId,
      actor,
      tenantId: profile.tenantId,
      run: (tx) => tx.userProfile.update({ where: { userId }, data: { mustChangePassword: true } }),
    });
    return { userId, temporaryPassword: password };
  }

  /** Ban keeps the email reserved; exit (removeLogin) frees it (§13.2). */
  async setActive(tenantId: string, userId: string, active: boolean, actor: AuditActor) {
    await this.get(tenantId, userId);
    await this.supabase.updateUser(userId, { ban_duration: active ? 'none' : '876000h' });
    return this.audit.run({
      action: active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
      targetType: 'UserProfile',
      targetId: userId,
      actor,
      tenantId,
      run: (tx) => tx.userProfile.update({ where: { userId }, data: { status: active ? 'ACTIVE' : 'DISABLED' } }),
    });
  }

  /** Offboarding: delete the auth user, keep the profile for audit references. */
  async removeLogin(tenantId: string, userId: string, actor: AuditActor) {
    await this.supabase.deleteUser(userId).catch((err) => {
      if (!/not found/i.test((err as Error).message)) throw err;
    });
    await this.audit.run({
      action: 'USER_EXITED',
      targetType: 'UserProfile',
      targetId: userId,
      actor,
      tenantId,
      run: (tx) => tx.userProfile.updateMany({ where: { userId }, data: { status: 'EXITED' } }),
    });
  }

  /** First-login and voluntary password change; clears must_change_password. */
  async changeOwnPassword(user: AuthUser, currentPassword: string, newPassword: string) {
    if (currentPassword === newPassword) {
      throw new AppError(400, 'PASSWORD_UNCHANGED', 'The new password must differ from the current one');
    }
    if (!(await this.supabase.verifyPassword(user.email, currentPassword))) {
      throw new AppError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
    }
    const profile = await runAsSystem(() => this.prisma.userProfile.findUnique({ where: { userId: user.sub } }));
    try {
      await this.supabase.updateUser(user.sub, {
        password: newPassword,
        app_metadata: profile
          ? this.claims(profile, false)
          : { must_change_password: false },
      });
    } catch (err) {
      // Supabase enforces the password policy (length, breached list).
      throw new AppError(400, 'WEAK_PASSWORD', (err as Error).message);
    }
    if (profile) {
      await runAsSystem(() =>
        this.audit.run({
          action: 'USER_PASSWORD_CHANGED',
          targetType: 'UserProfile',
          targetId: user.sub,
          actor: { type: 'user', userId: user.sub },
          tenantId: profile.tenantId,
          run: (tx) => tx.userProfile.update({ where: { userId: user.sub }, data: { mustChangePassword: false } }),
        }),
      );
    }
    // The client must refresh its session to receive a token without the flag.
    return { ok: true, refreshSession: true };
  }
}

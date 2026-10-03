import { AsyncLocalStorage } from 'async_hooks';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthUser } from '../auth/auth.types';

/** What PrismaService copies into the transaction-local GUCs read by post-init/003-rls.sql. */
export interface RlsContext {
  tenantId: string;
  siteIds?: string[];
  isSuperAdmin?: boolean;
  userId?: string;
}

export const rlsContext = new AsyncLocalStorage<RlsContext>();

/**
 * Background work (terminal ingest, workers, crons) runs as "system": it sees
 * every tenant, and is itself responsible for filtering by tenantId. Without a
 * context the RLS policies deny everything, so a job that forgets this fails
 * closed rather than leaking.
 */
export async function runAsSystem<T>(fn: () => PromiseLike<T> | T): Promise<T> {
  return rlsContext.run({ tenantId: '', isSuperAdmin: true }, async () => {
    return await fn();
  });
}

export function rlsFromUser(user: AuthUser): RlsContext {
  return {
    tenantId: user.tenantId ?? '',
    siteIds: user.siteIds,
    isSuperAdmin: user.isSuperAdmin && !user.tenantId,
    userId: user.sub,
  };
}

/**
 * Runs the handler inside the caller's RLS context. Wrapping the subscription
 * (not just `next.handle()`) is what makes the context reach the handler: Nest
 * invokes it lazily on subscribe.
 */
@Injectable()
export class RlsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user) return next.handle();
    const ctx = rlsFromUser(user);
    return new Observable((subscriber) =>
      rlsContext.run(ctx, () => {
        const sub = next.handle().subscribe(subscriber);
        return () => sub.unsubscribe();
      }),
    );
  }
}

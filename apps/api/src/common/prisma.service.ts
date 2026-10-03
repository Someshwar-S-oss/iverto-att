import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { AsyncLocalStorage } from 'async_hooks';
import { setDefaultResultOrder } from 'dns';
import { Pool } from 'pg';
import { RlsContext, rlsContext } from './rls';

// Supabase's pooler resolves AAAA too; hosts without IPv6 egress need IPv4 first.
setDefaultResultOrder('ipv4first');

/** Set while inside an interactive transaction whose GUCs are already set. */
const inTx = new AsyncLocalStorage<true>();

const setConfig = (ctx: RlsContext) =>
  Prisma.sql`SELECT set_config('app.current_tenant_id', ${ctx.tenantId ?? ''}, true),
                    set_config('app.current_site_ids', ${ctx.siteIds?.join(',') ?? ''}, true),
                    set_config('app.is_super_admin', ${ctx.isSuperAdmin ? 'true' : 'false'}, true),
                    set_config('app.current_user_id', ${ctx.userId ?? ''}, true)`;

/**
 * Prisma with the RLS context applied (hostel pattern, D3).
 *
 * - A model operation outside a transaction runs as a two-statement batch:
 *   `set_config(...)` then the query, so the GUCs are transaction-local.
 * - `$transaction(async tx => …)` sets the GUCs once at the start; operations
 *   inside skip the per-query wrapper.
 * - Raw SQL must run inside `$transaction(async tx => …)` to see any rows.
 * - Array-form `$transaction([...])` is not supported (it would nest batches).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;

  constructor() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX || 10) });
    super({ adapter: new PrismaPg(pool) });
    this.pool = pool;

    const base = this as PrismaClient;
    const baseTx = base.$transaction.bind(base);

    const extended = base.$extends({
      query: {
        async $allOperations({ model, operation, args, query }: any) {
          const ctx = rlsContext.getStore();
          if (ctx && (ctx.tenantId || ctx.isSuperAdmin)) {
            if (inTx.getStore()) {
              return query(args);
            }
            return inTx.run(true, () =>
              base.$transaction(async (tx: any) => {
                await tx.$executeRaw(setConfig(ctx));
                const m = model ? (tx[model] || tx[model.charAt(0).toLowerCase() + model.slice(1)]) : null;
                if (m && m[operation]) return m[operation](args);
                return tx[operation](args);
              })
            );
          }
          return query(args);
        },
      },
    }) as unknown as PrismaService;

    const extTx = (extended as any).$transaction.bind(extended);
    (extended as any).$transaction = (arg: any, options?: any) => {
      if (typeof arg !== 'function') {
        throw new Error('Array-form $transaction is not supported; use $transaction(async tx => …)');
      }
      return extTx(async (tx: Prisma.TransactionClient) => {
        return inTx.run(true, async () => {
          const ctx = rlsContext.getStore();
          if (ctx && (ctx.tenantId || ctx.isSuperAdmin)) {
            await tx.$executeRaw(setConfig(ctx));
          }
          return arg(tx);
        });
      }, options);
    };
    (extended as any).onModuleInit = async () => {
      await PrismaClient.prototype.$connect.call(base);
      this.logger.log('Prisma connected');
    };
    (extended as any).onModuleDestroy = async () => {
      await PrismaClient.prototype.$disconnect.call(base);
      await pool.end();
    };
    return extended;
  }

  async onModuleInit() {
    /* replaced in the constructor */
  }

  async onModuleDestroy() {
    /* replaced in the constructor */
  }
}

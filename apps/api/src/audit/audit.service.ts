import { Controller, Get, Injectable, Module, Global, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { AuditActor, AuthUser, CurrentUser, Roles } from '../auth/auth.types';

export interface AuditableActionSpec<T> {
  action: string;
  targetType: string;
  targetId?: string;
  actor: AuditActor;
  tenantId: string | null;
  siteId?: string;
  payloadFrom?: (result: NoInfer<T>) => Record<string, unknown>;
  run: (tx: Prisma.TransactionClient) => PromiseLike<T>;
}

/** Mutation + its audit row in one transaction (copied from hostel). */
@Injectable()
export class AuditableActionService {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(spec: AuditableActionSpec<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await spec.run(tx);
      await tx.auditLog.create({
        data: {
          tenantId: spec.tenantId,
          siteId: spec.siteId ?? null,
          actorUserId: spec.actor.userId ?? null,
          actorType: spec.actor.type,
          action: spec.action,
          targetType: spec.targetType,
          targetId: spec.targetId ?? (result as { id?: string })?.id ?? null,
          payload: (spec.payloadFrom?.(result) ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      return result;
    });
  }

  /** A standalone audit row, for actions whose mutation lives elsewhere. */
  log(entry: {
    tenantId: string | null;
    actor: AuditActor;
    action: string;
    targetType?: string;
    targetId?: string;
    siteId?: string;
    payload?: Record<string, unknown>;
  }) {
    return this.prisma.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        siteId: entry.siteId ?? null,
        actorUserId: entry.actor.userId ?? null,
        actorType: entry.actor.type,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        payload: (entry.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
  }
}

class AuditQuery {
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() actorUserId?: string;
  @IsOptional() @IsString() targetType?: string;
  @IsOptional() @IsString() targetId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) size?: number;
}

@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('ADMIN')
  async list(@CurrentUser() user: AuthUser, @Query() q: AuditQuery) {
    const page = q.page ?? 1;
    const size = q.size ?? 50;
    const where: Prisma.AuditLogWhereInput = {
      tenantId: user.tenantId,
      action: q.action,
      actorUserId: q.actorUserId,
      targetType: q.targetType,
      targetId: q.targetId,
      createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page, size };
  }
}

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditableActionService],
  exports: [AuditableActionService],
})
export class AuditModule {}

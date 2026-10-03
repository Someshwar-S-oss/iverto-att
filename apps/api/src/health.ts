import { Controller, Get, Module } from '@nestjs/common';
import { Public } from './auth/auth.types';
import { AppError } from './common/errors';
import { PrismaService } from './common/prisma.service';
import { RedisService } from './common/redis.service';
import { runAsSystem } from './common/rls';
import { M50Server } from './terminals/m50.server';
import { TerminalsModule } from './terminals/terminals.module';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly m50: M50Server,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  /** Ready = DB + Redis + terminal server attached (§14.1). */
  @Public()
  @Get('ready')
  async ready() {
    const checks = {
      database: await runAsSystem(() => this.prisma.$transaction((tx) => tx.$queryRaw`SELECT 1`)).then(() => true, () => false),
      redis: await this.redis.client.ping().then((r) => r === 'PONG', () => false),
      terminalServer: this.m50.isAttached,
    };
    if (!Object.values(checks).every(Boolean)) throw new AppError(503, 'NOT_READY', 'Not ready', checks);
    return { status: 'ok', ...checks };
  }
}

@Module({ imports: [TerminalsModule], controllers: [HealthController] })
export class HealthModule {}

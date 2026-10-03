import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AttendanceCoreModule } from './attendance/attendance-core.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/errors';
import { redisOptions } from './common/redis.service';
import { EmployeesModule } from './employees/employees';
import { HealthModule } from './health';
import { JobsModule } from './jobs/jobs';
import { LeaveModule } from './leave/leave';
import { LiveModule } from './live/live.module';
import { MobileModule } from './mobile/mobile';
import { NotificationsModule } from './notifications/notifications';
import { OrgModule } from './org/org';
import { PlatformModule } from './platform/platform';
import { PunchesModule } from './punches/punches';
import { RemoteModule } from './remote/remote';
import { ReportsModule } from './reports/reports';
import { ScheduleModule } from './schedule/schedule';
import { TerminalsModule } from './terminals/terminals.module';
import { UsersModule } from './users/users.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({ connection: redisOptions() }),
    // Infrastructure (global)
    CommonModule,
    AuthModule,
    AuditModule,
    LiveModule,
    NotificationsModule,
    AttendanceCoreModule,
    // Domain
    PlatformModule,
    UsersModule,
    OrgModule,
    EmployeesModule,
    TerminalsModule,
    PunchesModule,
    ScheduleModule,
    AttendanceModule,
    LeaveModule,
    RemoteModule,
    ReportsModule,
    MobileModule,
    JobsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}

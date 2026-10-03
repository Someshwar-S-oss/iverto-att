import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { RECOMPUTE_QUEUE, RecomputeProcessor, RecomputeQueue, RecomputeService } from './recompute.service';
import { RosterService } from './roster.service';

/** Materialiser + recompute pipeline, shared by every module that changes an input of the engine. */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: RECOMPUTE_QUEUE })],
  providers: [RosterService, RecomputeService, RecomputeQueue, RecomputeProcessor],
  exports: [RosterService, RecomputeService, RecomputeQueue],
})
export class AttendanceCoreModule {}

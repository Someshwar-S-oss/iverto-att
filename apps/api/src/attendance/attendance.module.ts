import { Module } from '@nestjs/common';
import { PunchesModule } from '../punches/punches';
import { AttendanceController } from './attendance.controller';
import { CorrectionsController, CorrectionsService } from './corrections';

@Module({
  imports: [PunchesModule],
  controllers: [AttendanceController, CorrectionsController],
  providers: [CorrectionsService],
  exports: [CorrectionsService],
})
export class AttendanceModule {}

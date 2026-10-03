import { Module } from '@nestjs/common';
import { PunchesModule } from '../punches/punches';
import { M50Server } from './m50.server';
import { DeviceTenantGuard, TerminalsController } from './terminals.controller';
import { TerminalsService } from './terminals.service';
import { TerminalBackfillService } from './services/terminal-backfill.service';
import { TerminalEnrollmentService } from './services/terminal-enrollment.service';
import { TerminalIngestService } from './services/terminal-ingest.service';
import { TerminalInspectionService } from './services/terminal-inspection.service';
import { TerminalRegistryService } from './services/terminal-registry.service';
import { TerminalRouterService } from './services/terminal-router.service';
import { TerminalSessionRegistry } from './services/terminal-session.registry';
import { TerminalTemplateService } from './services/terminal-template.service';

/**
 * M50 terminal integration, copied from hostel (§4). Terminals speak raw
 * WebSocket XML, so M50Server is attached to the HTTP server in main.ts.
 *
 * Scaling caveat: a terminal socket is pinned to the process it dialled and
 * TerminalSessionRegistry is in-process — `sessions.require()` is the seam for
 * the edge/api split in §2.3. Do not run more than one replica until then.
 */
@Module({
  imports: [PunchesModule],
  controllers: [TerminalsController],
  providers: [
    M50Server,
    DeviceTenantGuard,
    TerminalsService,
    TerminalSessionRegistry,
    TerminalRegistryService,
    TerminalRouterService,
    TerminalIngestService,
    TerminalBackfillService,
    TerminalEnrollmentService,
    TerminalInspectionService,
    TerminalTemplateService,
  ],
  exports: [M50Server, TerminalSessionRegistry, TerminalEnrollmentService],
})
export class TerminalsModule {}

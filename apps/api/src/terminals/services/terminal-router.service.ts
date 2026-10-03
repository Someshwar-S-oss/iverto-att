import { Injectable, Logger } from '@nestjs/common';
import type { M50Message } from '../protocol/m50-protocol';
import {
  M50Command,
  M50Event,
  M50Request,
  formatDeviceTime,
  parseAdminLog,
  parseTimeLog,
} from '../protocol/m50-protocol';
import type { M50Session } from '../m50-session';
import { TerminalBackfillService } from './terminal-backfill.service';
import { TerminalIngestService } from './terminal-ingest.service';
import { TerminalRegistryService } from './terminal-registry.service';
import { TerminalSessionRegistry } from './terminal-session.registry';

/**
 * Dispatches decoded device frames to the right handler.
 *
 * Only Request and Event frames reach here — Response frames are consumed by
 * whichever command is awaiting them, inside M50Session.
 */
@Injectable()
export class TerminalRouterService {
  private readonly logger = new Logger(TerminalRouterService.name);

  constructor(
    private readonly registryService: TerminalRegistryService,
    private readonly sessions: TerminalSessionRegistry,
    private readonly ingest: TerminalIngestService,
    private readonly backfill: TerminalBackfillService,
  ) {}

  async dispatch(session: M50Session, message: M50Message): Promise<void> {
    if (message.kind === 'request') {
      await this.handleRequest(session, message);
      return;
    }
    await this.handleEvent(session, message);
  }

  private async handleRequest(session: M50Session, message: M50Message): Promise<void> {
    switch (message.name) {
      case M50Request.Register:
        await this.registryService.handleRegister(session, message.fields);
        return;

      case M50Request.Login: {
        const context = await this.registryService.handleLogin(session, message.fields);
        if (!context) return;

        this.sessions.add(context.deviceId, session);

        // A drifting clock silently shifts late marks, and KeepAlive's ServerTime
        // echo does not correct it on every firmware (§4.3). Queued ahead of the
        // backfill on the session's one-at-a-time command queue.
        void session
          .command(M50Command.SetTime, { Time: formatDeviceTime(new Date(), context.timeZone) })
          .then((r) => r.Result !== 'OK' && this.logger.warn(`SetTime refused by ${context.serialNo}: ${r.Result}`))
          .catch((err) => this.logger.warn(`SetTime on ${context.serialNo} failed: ${(err as Error).message}`));

        // Close any gap the terminal buffered while it was offline. Detached
        // deliberately: the device is free to stream live logs meanwhile, and a
        // slow backfill must not stall the connection.
        void this.backfill.run(session).catch((err) =>
          this.logger.error(`Backfill for ${context.serialNo} failed: ${(err as Error).message}`),
        );
        return;
      }

      default:
        this.logger.warn(`Unhandled device request ${message.name}`);
    }
  }

  private async handleEvent(session: M50Session, message: M50Message): Promise<void> {
    if (!session.isAuthenticated) {
      // The SDK requires Login before normal traffic; anything else is either a
      // confused device or someone probing the endpoint.
      this.logger.warn(
        `Ignoring ${message.name} from unauthenticated ${session.remoteAddress}`,
      );
      return;
    }
    const context = session.requireContext();

    switch (message.name) {
      case M50Event.KeepAlive: {
        // Echo the device clock alongside ours so the terminal can correct drift,
        // and so operators can spot a badly-set clock in the logs.
        session.send({
          Response: M50Event.KeepAlive,
          Result: 'OK',
          DevTime: message.fields.DevTime,
          ServerTime: formatDeviceTime(new Date(), context.timeZone),
        });
        await this.registryService.touch(context.deviceId);
        return;
      }

      case M50Event.TimeLog:
      case M50Event.TimeLogV2: {
        let transId: string | undefined;
        try {
          const log = parseTimeLog(message.fields);
          transId = log.transId;
          await this.ingest.ingestTimeLog(context, log);
          // Only acknowledge once the job is durably queued. A Fail keeps the
          // record on the device, where backfill can still retrieve it.
          session.ack(message.name, 'OK', transId);
        } catch (err) {
          this.logger.error(
            `Failed to ingest ${message.name} from ${context.serialNo}: ${(err as Error).message}`,
          );
          session.ack(message.name, 'Fail', transId);
        }
        return;
      }

      case M50Event.AdminLog:
      case M50Event.AdminLogV2: {
        let transId: string | undefined;
        try {
          const log = parseAdminLog(message.fields);
          transId = log.transId;
          await this.ingest.ingestAdminLog(context, log);
          session.ack(message.name, 'OK', transId);
        } catch (err) {
          this.logger.error(
            `Failed to ingest ${message.name} from ${context.serialNo}: ${(err as Error).message}`,
          );
          session.ack(message.name, 'Fail', transId);
        }
        return;
      }

      default:
        this.logger.warn(`Unhandled device event ${message.name} from ${context.serialNo}`);
    }
  }

  async onDisconnect(session: M50Session): Promise<void> {
    const context = session.context;
    if (!context) return;
    await this.registryService.markOffline(context);
  }
}

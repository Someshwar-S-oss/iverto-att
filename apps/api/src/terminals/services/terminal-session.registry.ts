import { Injectable, Logger } from '@nestjs/common';
import { M50Session } from '../m50-session';

/**
 * Live terminal connections, keyed by SiteDevice id.
 *
 * Deliberately separate from M50Server so that services which need to *send* to
 * a terminal (enrollment, backfill) can depend on the registry without creating
 * a cycle back through the server that owns the listening socket.
 *
 * Single-process only: unlike EventsGateway, which fans out through the
 * Socket.IO Redis adapter, a raw terminal socket is pinned to whichever
 * instance it dialled. Commands must therefore originate on that instance —
 * see the note in TerminalsModule before scaling this service horizontally.
 */
@Injectable()
export class TerminalSessionRegistry {
  private readonly logger = new Logger(TerminalSessionRegistry.name);
  private readonly sessions = new Map<string, M50Session>();

  add(deviceId: string, session: M50Session): void {
    const existing = this.sessions.get(deviceId);
    if (existing && existing !== session) {
      // A terminal that lost its uplink without a clean FIN reconnects while the
      // stale socket is still half-open; the newest connection wins.
      this.logger.warn(`Replacing stale session for device ${deviceId}`);
      existing.close(1012, 'superseded by new connection');
    }
    this.sessions.set(deviceId, session);
  }

  remove(deviceId: string, session: M50Session): void {
    // Guard against a stale socket's close handler evicting its replacement.
    if (this.sessions.get(deviceId) === session) {
      this.sessions.delete(deviceId);
    }
  }

  get(deviceId: string): M50Session | undefined {
    return this.sessions.get(deviceId);
  }

  /** @throws when the terminal is not currently connected. */
  require(deviceId: string): M50Session {
    const session = this.sessions.get(deviceId);
    if (!session || !session.isAuthenticated) {
      throw new Error(`terminal ${deviceId} is not connected`);
    }
    return session;
  }

  isOnline(deviceId: string): boolean {
    return this.sessions.get(deviceId)?.isAuthenticated ?? false;
  }

  onlineDeviceIds(): string[] {
    return [...this.sessions.keys()];
  }

  all(): M50Session[] {
    return [...this.sessions.values()];
  }
}

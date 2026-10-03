import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { runAsSystem } from '../common/rls';
import { M50Session } from './m50-session';
import { M50ProtocolError, decodeMessage } from './protocol/m50-protocol';
import { TerminalRouterService } from './services/terminal-router.service';
import { TerminalSessionRegistry } from './services/terminal-session.registry';

/** Terminals dial this path; override with M50_WS_PATH if the proxy rewrites it. */
export const m50WsPath = (): string => process.env.M50_WS_PATH || '/m50';

const PING_INTERVAL_MS = 30_000;
/** Terminals reconnect every 10s, so a generous idle window costs little. */
const IDLE_TIMEOUT_MS = 150_000;
/** A terminal photo frame is base64 JPEG; the SDK caps enrolment photos at 32KB. */
const MAX_FRAME_BYTES = 512 * 1024;
/**
 * Grace period before an upgrade nobody claimed is destroyed. Matches
 * Engine.IO's own `destroyUpgradeTimeout`, whose job this takes over.
 */
const UNCLAIMED_UPGRADE_TIMEOUT_MS = 1_000;

/**
 * Raw-WebSocket listener for M50 biometric terminals.
 *
 * These devices are not Socket.IO clients: they open a plain WebSocket and
 * exchange bare XML documents, so they cannot be served by EventsGateway. This
 * server shares the application's HTTP listener and claims only its own path.
 */
@Injectable()
export class M50Server implements OnApplicationShutdown {
  private readonly logger = new Logger(M50Server.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private heartbeat?: NodeJS.Timeout;
  private attached = false;

  constructor(
    private readonly router: TerminalRouterService,
    private readonly registry: TerminalSessionRegistry,
  ) {}

  get isAttached(): boolean {
    return this.attached;
  }

  /**
   * Bind to the running HTTP server.
   *
   * Socket.IO listens for `upgrade` on this same server. Its Engine.IO layer
   * would normally reap upgrades it does not recognise after ~1s, which is a
   * hazard for us: our sockets survive only because the handshake writes a 101
   * before that timer fires. SharedHttpIoAdapter disables that reaper, so this
   * server takes over the duty — claiming its own path and destroying anything
   * no listener picked up, which would otherwise dangle for ever.
   */
  attach(server: HttpServer): void {
    if (this.attached) return;
    this.attached = true;

    const path = m50WsPath();
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
      } catch {
        pathname = '';
      }

      if (pathname === path) {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
        return;
      }

      // Someone else's upgrade — most likely Socket.IO's. Give the other
      // listeners a beat to answer it, then reap it if none did. A claimed
      // socket has written its 101 by then, which is what bytesWritten checks.
      // `upgrade` hands over a net.Socket, which the Duplex typing hides.
      const raw = socket as Duplex & { bytesWritten?: number };
      const reaper = setTimeout(() => {
        if (!raw.destroyed && raw.writable && (raw.bytesWritten ?? 0) === 0) {
          raw.destroy();
        }
      }, UNCLAIMED_UPGRADE_TIMEOUT_MS);
      reaper.unref?.();
    });

    this.heartbeat = setInterval(() => this.sweep(), PING_INTERVAL_MS);
    this.heartbeat.unref?.();

    this.logger.log(`M50 terminal server listening on ${path}`);
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    // Behind Caddy every peer is 127.0.0.1, so prefer the forwarded address for
    // anything an operator will read in a log line.
    const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    const remote = forwarded || req.socket.remoteAddress || 'unknown';
    const session = new M50Session(socket, remote);

    this.logger.log(`Terminal connected from ${remote}`);

    socket.on('message', (data) => {
      session.lastMessageAt = Date.now();
      // Terminal traffic has no user: it runs as system and filters by the device's tenant itself.
      void runAsSystem(() => this.onMessage(session, data.toString()));
    });

    socket.on('pong', () => {
      session.lastMessageAt = Date.now();
    });

    socket.on('error', (err) => {
      this.logger.warn(`Socket error from ${session.context?.serialNo ?? remote}: ${err.message}`);
    });

    socket.on('close', (code) => {
      session.destroy(`connection closed (${code})`);
      if (session.context) {
        this.registry.remove(session.context.deviceId, session);
        void runAsSystem(() => this.router.onDisconnect(session)).catch((err) => {
          this.logger.error(`Disconnect handling failed: ${(err as Error).message}`);
        });
      }
      this.logger.log(`Terminal ${session.context?.serialNo ?? remote} disconnected (${code})`);
    });
  }

  private async onMessage(session: M50Session, raw: string): Promise<void> {
    let message;
    try {
      message = decodeMessage(raw);
    } catch (err) {
      if (err instanceof M50ProtocolError) {
        // Truncate: a frame carrying a base64 photo would otherwise flood the log.
        this.logger.warn(`Undecodable frame from ${session.context?.serialNo ?? session.remoteAddress}: ` +
          `${err.message} — ${raw.slice(0, 200)}`);
        return;
      }
      throw err;
    }

    // Command replies belong to whoever is awaiting them, never to the router.
    if (message.kind === 'response') {
      session.resolveResponse(message);
      return;
    }

    try {
      await this.router.dispatch(session, message);
    } catch (err) {
      this.logger.error(
        `Handling ${message.kind} ${message.name} from ${session.context?.serialNo ?? session.remoteAddress} failed: ` +
          `${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /** Ping idle sockets and reap ones that have stopped answering entirely. */
  private sweep(): void {
    const now = Date.now();
    for (const session of this.registry.all()) {
      if (now - session.lastMessageAt > IDLE_TIMEOUT_MS) {
        this.logger.warn(`Terminating unresponsive terminal ${session.context?.serialNo}`);
        session.destroy('idle timeout');
        session.socket.terminate();
        continue;
      }
      try {
        session.socket.ping();
      } catch {
        /* the close handler will clean up */
      }
    }
  }

  onApplicationShutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const session of this.registry.all()) {
      session.close(1001, 'server shutting down');
    }
    this.wss.close();
  }
}

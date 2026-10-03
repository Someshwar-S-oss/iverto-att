import { Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import {
  M50Fields,
  M50Message,
  M50ProtocolError,
  encodeAck,
  encodeMessage,
} from './protocol/m50-protocol';

/**
 * Handshake position of a terminal connection.
 *
 * The SDK requires a device to Login before normal traffic is honoured. A
 * freshly flashed terminal Registers first to obtain a token, then Logins with
 * it; a provisioned one goes straight to Login on every reconnect.
 */
export type M50SessionState = 'connected' | 'authenticated';

/** Site-scoped context resolved once the terminal has authenticated. */
export interface M50DeviceContext {
  deviceId: string;
  tenantId: string;
  siteId: string;
  serialNo: string;
  /** Timezone the terminal's clock is set to (devices.clock_timezone, else the site's) — see parseDeviceTime. */
  timeZone: string;
  /** Configured per gate (§4.3). BOTH ⇒ punches are stored with direction "unknown". */
  direction: 'IN' | 'OUT' | 'BOTH';
  gateName: string;
  terminalType: string | null;
  lastLogId: number | null;
}

export class M50CommandError extends Error {}

interface PendingCommand {
  name: string;
  resolve: (fields: M50Fields) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

/**
 * One live terminal connection.
 *
 * Command correlation is the awkward part of this protocol. A device reply
 * carries only `<Response>CommandName</Response>` — there is no request id, and
 * the only `TransID` in the SDK travels on device-initiated logs. Two
 * concurrent `GetNextGlog` calls would therefore be indistinguishable, so
 * commands are strictly serialised: one in flight per device, the next dequeued
 * only once the previous settles or times out.
 */
export class M50Session {
  private readonly logger = new Logger(M50Session.name);

  state: M50SessionState = 'connected';
  context: M50DeviceContext | null = null;
  /** Serial claimed by the device, known from its first frame. Unverified until authenticated. */
  claimedSerialNo: string | null = null;
  lastMessageAt = Date.now();

  private pending: PendingCommand | null = null;
  private readonly queue: Array<{ run: () => void; reject: (err: Error) => void }> = [];
  private closed = false;

  constructor(
    readonly socket: WebSocket,
    readonly remoteAddress: string,
  ) {}

  get isAuthenticated(): boolean {
    return this.state === 'authenticated' && this.context !== null;
  }

  /** Context accessor for paths that have already checked authentication. */
  requireContext(): M50DeviceContext {
    if (!this.context) {
      throw new M50CommandError('session is not authenticated');
    }
    return this.context;
  }

  authenticate(context: M50DeviceContext): void {
    this.context = context;
    this.state = 'authenticated';
  }

  private get label(): string {
    return this.context?.serialNo ?? this.claimedSerialNo ?? this.remoteAddress;
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  send(fields: Record<string, string | number | undefined>): void {
    this.sendRaw(encodeMessage(fields));
  }

  ack(name: string, result: 'OK' | 'Fail', transId?: string): void {
    this.sendRaw(encodeAck(name, result, transId));
  }

  private sendRaw(xml: string): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      this.logger.warn(`Dropping frame to ${this.label}: socket not open`);
      return;
    }
    this.socket.send(xml);
  }

  /**
   * Issue a server-initiated command and await the matching `<Response>`.
   *
   * Resolves with the response fields — including a `Result` of `Fail`, which
   * is a legitimate protocol answer (`GetNextGlog` uses it to signal "no more
   * logs"). Only transport faults and timeouts reject.
   */
  command(
    name: string,
    fields: Record<string, string | number | undefined> = {},
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<M50Fields> {
    return new Promise<M50Fields>((resolve, reject) => {
      const run = () => {
        if (this.closed) {
          reject(new M50CommandError(`connection to ${this.label} closed before ${name} was sent`));
          this.dequeue();
          return;
        }

        const timer = setTimeout(() => {
          const timedOut = this.pending;
          this.pending = null;
          timedOut?.reject(new M50CommandError(`${name} timed out after ${timeoutMs}ms`));
          this.dequeue();
        }, timeoutMs);
        // Do not hold the event loop open on a terminal that has gone quiet.
        timer.unref?.();

        this.pending = {
          name,
          timer,
          resolve: (value) => {
            resolve(value);
            this.dequeue();
          },
          reject: (err) => {
            reject(err);
            this.dequeue();
          },
        };

        this.send({ Request: name, ...fields });
      };

      if (this.pending) {
        this.queue.push({ run, reject });
      } else {
        run();
      }
    });
  }

  private dequeue(): void {
    const next = this.queue.shift();
    if (next) next.run();
  }

  /**
   * Route a `<Response>` frame to the waiting command.
   *
   * @returns true when the frame was consumed by a pending command.
   */
  resolveResponse(message: M50Message): boolean {
    const pending = this.pending;
    if (!pending) {
      this.logger.warn(`Unsolicited ${message.name} response from ${this.label}; ignoring`);
      return false;
    }
    if (pending.name !== message.name) {
      // Names are the only correlation the protocol offers, so a mismatch means
      // the device is answering something we did not ask for. Leave the pending
      // command to time out rather than resolving it with the wrong payload.
      this.logger.warn(
        `Response ${message.name} from ${this.label} does not match in-flight ${pending.name}; ignoring`,
      );
      return false;
    }

    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(message.fields);
    return true;
  }

  /** Fail the in-flight command and drain the queue — used on socket teardown. */
  destroy(reason: string): void {
    this.closed = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new M50CommandError(reason));
    }
    for (const queued of this.queue.splice(0)) {
      queued.reject(new M50CommandError(reason));
    }
  }

  close(code = 1000, reason = 'server closing'): void {
    this.destroy(reason);
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }
}

export { M50ProtocolError };

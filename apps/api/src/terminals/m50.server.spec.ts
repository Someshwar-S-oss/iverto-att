import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket as IOClientSocket } from 'socket.io-client';
import { WebSocket } from 'ws';
import { M50Server } from './m50.server';
import { TerminalSessionRegistry } from './services/terminal-session.registry';
import type { TerminalRouterService } from './services/terminal-router.service';
import { decodeMessage, encodeMessage } from './protocol/m50-protocol';

/**
 * Coexistence tests for the raw terminal listener and Socket.IO on one port.
 *
 * Engine.IO reaps upgrades it does not recognise after `destroyUpgradeTimeout`
 * (1s). These tests assert empirically that a terminal socket outlives that
 * window and that both stacks keep working side by side, rather than trusting
 * that our handshake happens to write bytes fast enough.
 */
describe('M50Server alongside Socket.IO', () => {
  let http: HttpServer;
  let io: IOServer;
  let server: M50Server;
  let registry: TerminalSessionRegistry;
  let dispatched: Array<{ name: string; kind: string }>;
  let clients: WebSocket[];
  let ioClients: IOClientSocket[];
  let port: number;

  const router = {
    dispatch: jest.fn(async (_session, message) => {
      dispatched.push({ name: message.name, kind: message.kind });
    }),
    onDisconnect: jest.fn(async () => undefined),
  } as unknown as TerminalRouterService;

  /** Open a raw terminal connection and resolve once the handshake completes. */
  const connectTerminal = (path = '/m50') =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      clients.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

  const nextFrame = (ws: WebSocket) =>
    new Promise<string>((resolve) => ws.once('message', (d) => resolve(d.toString())));

  beforeEach(async () => {
    dispatched = [];
    clients = [];
    ioClients = [];
    (router.dispatch as jest.Mock).mockClear();

    http = createServer();
    // Mirrors SharedHttpIoAdapter: leave upgrades on other paths alone.
    io = new IOServer(http, { path: '/socket.io', destroyUpgrade: false } as any);
    io.on('connection', (socket) => socket.emit('welcome', { ok: true }));

    registry = new TerminalSessionRegistry();
    server = new M50Server(router, registry);
    server.attach(http);

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });

  afterEach(async () => {
    // terminate() rather than close(): a graceful close waits for a handshake
    // the far end may never complete, which leaves the worker hanging.
    for (const c of clients) c.terminate();
    for (const c of ioClients) c.disconnect();
    server.onApplicationShutdown();
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    http.closeAllConnections?.();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it('accepts a raw WebSocket handshake on its own path', async () => {
    const ws = await connectTerminal();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('keeps the terminal socket open past the Engine.IO destroyUpgrade window', async () => {
    // The crux: Engine.IO's reaper fires ~1s after an unrecognised upgrade.
    const ws = await connectTerminal();
    await new Promise((r) => setTimeout(r, 1500));

    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Still functional, not merely un-closed.
    ws.send(encodeMessage({ Event: 'KeepAlive', DevTime: '2026-08-12-T14:34:54Z' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(dispatched).toContainEqual({ name: 'KeepAlive', kind: 'event' });
  }, 15_000);

  it('routes decoded device frames to the router', async () => {
    const ws = await connectTerminal();
    ws.send(
      encodeMessage({
        Request: 'Register',
        TerminalType: 'F500',
        DeviceSerialNo: 'DJ20250307014',
        CloudId: 'secret',
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    expect(dispatched).toEqual([{ name: 'Register', kind: 'request' }]);
  });

  it('survives an undecodable frame without dropping the connection', async () => {
    const ws = await connectTerminal();
    ws.send('this is not xml at all');
    ws.send(encodeMessage({ Event: 'KeepAlive', DevTime: '2026-08-12-T14:34:54Z' }));
    await new Promise((r) => setTimeout(r, 100));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(dispatched).toEqual([{ name: 'KeepAlive', kind: 'event' }]);
  });

  it('does not hand Response frames to the router', async () => {
    // They belong to whichever command is awaiting them, inside M50Session.
    const ws = await connectTerminal();
    ws.send(encodeMessage({ Response: 'GetFaceData', Result: 'OK' }));
    await new Promise((r) => setTimeout(r, 100));

    expect(dispatched).toEqual([]);
  });

  it('reaps an upgrade that no listener claimed', async () => {
    // Engine.IO's reaper is disabled, so this server owns the cleanup. Without
    // it, any request to an unrouted path would leak a half-open socket.
    await expect(connectTerminal('/somewhere-else')).rejects.toThrow();
  }, 15_000);

  it('still serves Socket.IO clients on the same port', async () => {
    const terminal = await connectTerminal();

    const socket = ioClient(`http://127.0.0.1:${port}`, {
      path: '/socket.io',
      transports: ['websocket'],
      // Otherwise the client keeps a reconnect timer alive past teardown.
      reconnection: false,
    });
    ioClients.push(socket);

    const welcome = await new Promise<any>((resolve, reject) => {
      socket.once('welcome', resolve);
      socket.once('connect_error', reject);
      setTimeout(() => reject(new Error('Socket.IO client never connected')), 5000);
    });

    expect(welcome).toEqual({ ok: true });
    // And the terminal is unaffected by the Socket.IO traffic.
    expect(terminal.readyState).toBe(WebSocket.OPEN);
  }, 15_000);

  it('lets a session reply on the wire', async () => {
    const ws = await connectTerminal();
    // Reach into the live session the way a handler would.
    ws.send(encodeMessage({ Request: 'Login', DeviceSerialNo: 'DJ20250307014' }));
    await new Promise((r) => setTimeout(r, 100));

    const session = (router.dispatch as jest.Mock).mock.calls[0][0];
    const frame = nextFrame(ws);
    session.send({ Response: 'Login', Result: 'OK' });

    expect(decodeMessage(await frame).fields).toMatchObject({ Response: 'Login', Result: 'OK' });
  });
});

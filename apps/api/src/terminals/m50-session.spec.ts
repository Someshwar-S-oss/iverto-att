import { M50CommandError, M50Session } from './m50-session';
import { decodeMessage } from './protocol/m50-protocol';

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  terminate() {
    this.readyState = 3;
  }
}

const makeSession = () => {
  const socket = new FakeSocket();
  return { socket, session: new M50Session(socket as any, '10.0.0.5') };
};

/** Feed a `<Response>` back to the session as the device would. */
const respond = (session: M50Session, name: string, extra: Record<string, string> = {}) =>
  session.resolveResponse(
    decodeMessage(
      `<Message><Response>${name}</Response>` +
        Object.entries(extra)
          .map(([k, v]) => `<${k}>${v}</${k}>`)
          .join('') +
        `</Message>`,
    ),
  );

describe('M50Session', () => {
  it('starts unauthenticated', () => {
    const { session } = makeSession();
    expect(session.isAuthenticated).toBe(false);
    expect(() => session.requireContext()).toThrow(M50CommandError);
  });

  it('sends a command and resolves with the response fields', async () => {
    const { socket, session } = makeSession();

    const pending = session.command('GetFaceData', { UserID: 7 });
    expect(decodeMessage(socket.sent[0])).toMatchObject({ kind: 'request', name: 'GetFaceData' });

    respond(session, 'GetFaceData', { FaceEnrolled: 'Yes', FaceData: 'abc', Result: 'OK' });
    await expect(pending).resolves.toMatchObject({ FaceData: 'abc', Result: 'OK' });
  });

  it('resolves rather than rejects on a Fail result, which GetNextGlog uses as "no more logs"', async () => {
    const { session } = makeSession();
    const pending = session.command('GetNextGlog', { BeginLogPos: 5 });
    respond(session, 'GetNextGlog', { Result: 'Fail' });
    await expect(pending).resolves.toMatchObject({ Result: 'Fail' });
  });

  describe('serialisation', () => {
    it('holds the second command until the first settles', async () => {
      // The protocol correlates replies by command name alone, so two in-flight
      // commands would be indistinguishable.
      const { socket, session } = makeSession();

      const first = session.command('GetGlogPosInfo');
      const second = session.command('GetFirstGlog', { BeginLogPos: 0 });

      expect(socket.sent).toHaveLength(1);

      respond(session, 'GetGlogPosInfo', { LogCount: '5', Result: 'OK' });
      await first;

      expect(socket.sent).toHaveLength(2);
      expect(decodeMessage(socket.sent[1]).name).toBe('GetFirstGlog');

      respond(session, 'GetFirstGlog', { LogID: '1', Result: 'OK' });
      await expect(second).resolves.toMatchObject({ LogID: '1' });
    });

    it('runs queued commands in order', async () => {
      const { socket, session } = makeSession();
      const results: string[] = [];

      const a = session.command('GetGlogPosInfo').then(() => results.push('a'));
      const b = session.command('GetFirstGlog').then(() => results.push('b'));
      const c = session.command('GetNextGlog').then(() => results.push('c'));

      respond(session, 'GetGlogPosInfo');
      await a;
      respond(session, 'GetFirstGlog');
      await b;
      respond(session, 'GetNextGlog');
      await c;

      expect(results).toEqual(['a', 'b', 'c']);
      expect(socket.sent.map((x) => decodeMessage(x).name)).toEqual([
        'GetGlogPosInfo',
        'GetFirstGlog',
        'GetNextGlog',
      ]);
    });
  });

  describe('mismatched responses', () => {
    it('ignores a response that does not match the in-flight command', async () => {
      const { session } = makeSession();
      const pending = session.command('GetFaceData', {}, 50);

      // Answering the wrong command must not resolve the wrong promise.
      expect(respond(session, 'SetUserData', { Result: 'OK' })).toBe(false);
      await expect(pending).rejects.toThrow(/timed out/);
    });

    it('ignores an unsolicited response', () => {
      const { session } = makeSession();
      expect(respond(session, 'KeepAlive')).toBe(false);
    });
  });

  describe('timeouts', () => {
    it('rejects a command the device never answers', async () => {
      const { session } = makeSession();
      await expect(session.command('GetUserData', {}, 20)).rejects.toThrow(M50CommandError);
    });

    it('starts the next queued command after a timeout', async () => {
      const { socket, session } = makeSession();
      const first = session.command('GetUserData', {}, 20);
      const second = session.command('GetFaceData', {}, 20);

      await expect(first).rejects.toThrow(/timed out/);
      expect(socket.sent.map((x) => decodeMessage(x).name)).toEqual(['GetUserData', 'GetFaceData']);

      respond(session, 'GetFaceData', { Result: 'OK' });
      await expect(second).resolves.toMatchObject({ Result: 'OK' });
    });
  });

  describe('teardown', () => {
    it('rejects the in-flight command when the socket closes', async () => {
      const { session } = makeSession();
      const pending = session.command('GetFaceData');
      session.destroy('connection closed (1006)');
      await expect(pending).rejects.toThrow(/connection closed/);
    });

    it('rejects queued commands too, without sending them', async () => {
      const { socket, session } = makeSession();
      const first = session.command('GetGlogPosInfo');
      const queued = session.command('GetFirstGlog');

      session.destroy('connection closed (1006)');

      await expect(first).rejects.toThrow(M50CommandError);
      await expect(queued).rejects.toThrow(M50CommandError);
      expect(socket.sent).toHaveLength(1);
    });

    it('drops frames once the socket is no longer open', () => {
      const { socket, session } = makeSession();
      socket.readyState = 3;
      session.send({ Response: 'Login', Result: 'OK' });
      expect(socket.sent).toHaveLength(0);
    });
  });

  it('acks with the TransID the device supplied', () => {
    const { socket, session } = makeSession();
    session.ack('TimeLog_v2', 'OK', 'abc123');
    expect(decodeMessage(socket.sent[0]).fields).toMatchObject({
      Response: 'TimeLog_v2',
      TransID: 'abc123',
      Result: 'OK',
    });
  });
});

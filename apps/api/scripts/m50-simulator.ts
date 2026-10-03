/**
 * Pretends to be an M50 terminal so the server side can be exercised without
 * the hardware present.
 *
 * Speaks the real wire protocol: raw WebSocket carrying XML, Register to obtain
 * a token, Login with it, then KeepAlive plus attendance logs. Useful both
 * before the device arrives and, when it does arrive and does not work, to
 * establish which end is at fault.
 *
 * It also answers server-initiated commands from a small in-memory user table,
 * which is what makes enrolment, template capture and the reconciliation view
 * testable end to end. `--preload` is the interesting knob: it seeds slots the
 * cloud has no mapping for, which is the state a real commissioned terminal
 * arrives in and the one that used to cause enrolments to land on top of an
 * existing person.
 *
 *   npm run m50:simulate -- --url ws://localhost:8031/m50 --serial DJ20250307014
 *   npm run m50:simulate -- --preload 3          # device already holds users 1-3
 *   npm run m50:simulate -- --admin-log EnrollUserFP --admin-user 2
 *   npm run m50:simulate -- --keypad-enroll 3    # three faces to bind to students
 *
 * Options:
 *   --url      WebSocket endpoint                  (default ws://localhost:8031/m50)
 *   --serial   DeviceSerialNo to claim             (default DJ20250307014)
 *   --cloud-id CloudId, if M50_CLOUD_ID is set     (default empty)
 *   --user     terminal UserID to scan as          (default 1)
 *   --token    skip Register and Login with this token
 *   --scan-interval  seconds between scans, 0 for one scan  (default 0)
 *   --preload  pre-existing users on the device, as a real unit would have (default 0)
 *   --admin-log   emit one AdminLog_v2 with this Action after login, then idle
 *   --admin-user  UserID that admin log refers to  (default 1)
 *   --keypad-enroll N  simulate N enrolments done at the device menu: the device
 *                      picks the numbers and announces them only via AdminLog_v2,
 *                      which is what device/unclaimed is for
 *   --remote-enroll-result  what RemoteEnroll answers (default EnrollNumberError,
 *                           which is what real hardware returns)
 *   --stay     keep the connection open after the one-shot work is done
 */
import { WebSocket } from 'ws';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

const arg = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const URL_ = arg('url', 'ws://localhost:8031/m50');
const SERIAL = arg('serial', 'DJ20250307014');
const CLOUD_ID = arg('cloud-id');
const USER_ID = arg('user', '1');
const SCAN_INTERVAL = Number(arg('scan-interval', '0'));
const PRELOAD = Number(arg('preload', '0'));
const ADMIN_LOG = arg('admin-log');
const KEYPAD_ENROLL = Number(arg('keypad-enroll', '0'));
const ADMIN_USER = arg('admin-user', '1');
const REMOTE_ENROLL_RESULT = arg('remote-enroll-result', 'EnrollNumberError');
const STAY = flag('stay') || SCAN_INTERVAL > 0 || Boolean(ADMIN_LOG) || KEYPAD_ENROLL > 0;
let token = arg('token');

const parser = new XMLParser({ ignoreAttributes: true, ignoreDeclaration: true, trimValues: true, parseTagValue: false });
const builder = new XMLBuilder({ ignoreAttributes: true, suppressEmptyNode: false });

/** The SDK's timestamp format: note the stray hyphen before the T. */
const deviceTime = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}Z`;
};

/** Names travel as base64 UTF-16LE, not UTF-8. */
const encodeName = (name: string) => Buffer.from(name, 'utf16le').toString('base64');
const decodeName = (b64: string) => Buffer.from(b64, 'base64').toString('utf16le').replace(/\0+$/, '');

const send = (ws: WebSocket, fields: Record<string, string | number>) => {
  const xml = `<?xml version="1.0"?>${builder.build({ Message: fields })}`;
  console.log(`\n→ ${xml}`);
  ws.send(xml);
};

/** Every response the device sends carries its identity. */
const identity = { TerminalType: 'F500', TerminalID: 1, DeviceSerialNo: SERIAL };

// ─────────────────────────────────────────────────────────────────────────────
// The device's own state
// ─────────────────────────────────────────────────────────────────────────────

interface DeviceUser {
  userId: number;
  name: string;
  privilege: string;
  faceData: string | null;
  /** What GetUserPhoto returns: the enrolment JPEG, not the matching template. */
  photo: string | null;
}

const users = new Map<number, DeviceUser>();

// Users the device already holds and the cloud knows nothing about — exactly
// what a terminal commissioned at the factory or configured at the keypad looks
// like. Enrolling over one of these is how a scan ends up attributed to the
// wrong person, so it is worth being able to reproduce.
for (let i = 1; i <= PRELOAD; i++) {
  users.set(i, {
    userId: i,
    name: `Pre-existing ${i}`,
    privilege: 'User',
    faceData: Buffer.from(`face-template-${i}`).toString('base64'),
    photo: Buffer.from(`photo-of-user-${i}`).toString('base64'),
  });
}
if (PRELOAD > 0) {
  console.log(`Device pre-loaded with users 1-${PRELOAD}, none of them mapped in the cloud.`);
}

/** Cursor for GetFirstUserData/GetNextUserData, which lives on the device. */
let userCursor = 0;
let remoteEnrollActive = false;

let logId = Math.floor(Date.now() / 1000) % 100000;
const glog: Array<Record<string, string | number>> = [];

const sendScan = (ws: WebSocket) => {
  logId += 1;
  const record = {
    ...identity,
    Event: 'TimeLog_v2',
    LogID: logId,
    Time: deviceTime(),
    UserID: USER_ID,
    Action: 'FACE',
    // Matches what the real unit emits in the field: a fixed attend status.
    AttendStat: 'DutyOff',
    APStat: 'None',
    JobCode: 0,
    Photo: 'No',
    TransID: `sim-${logId}`,
  };
  glog.push(record);
  send(ws, record);
};

const sendAdminLog = (ws: WebSocket, action: string, userId: string | number) => {
  logId += 1;
  send(ws, {
    ...identity,
    Event: 'AdminLog_v2',
    LogID: logId,
    Time: deviceTime(),
    AdminID: 0,
    UserID: userId,
    Action: action,
    Stat: 0,
    TransID: `sim-admin-${logId}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Answering server commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns the response fields, or null when this command is not simulated —
 * in which case the server's command times out, which is itself worth seeing.
 */
function handleRequest(ws: WebSocket, name: string, msg: Record<string, string>) {
  const userId = Number(msg.UserID);

  switch (name) {
    case 'GetDeviceStatus':
      return { UserCount: users.size, GlogCount: glog.length, FirmwareVersion: 'sim-1.0', Result: 'OK' };

    case 'GetGlogPosInfo':
      return { LogCount: glog.length, FirstPos: 0, LastPos: glog.length, Result: 'OK' };

    case 'GetFirstGlog':
    case 'GetNextGlog': {
      const from = Number(msg.BeginLogPos ?? 0);
      const record = glog.find((r) => Number(r.LogID) >= from);
      return record ? { ...record, Result: 'OK' } : { Result: 'Fail' };
    }

    case 'GetUserData': {
      const user = users.get(userId);
      if (!user) return { UserID: userId, Result: 'Fail' };
      return {
        UserID: user.userId,
        Name: encodeName(user.name),
        Privilege: user.privilege,
        Enabled: 'Yes',
        FaceEnrolled: user.faceData ? 'Yes' : 'No',
        Result: 'OK',
      };
    }

    case 'SetUserData': {
      if (msg.Type === 'Delete') {
        users.delete(userId);
        return { UserID: userId, Action: 'Delete', Result: 'OK' };
      }
      const existing = users.get(userId);
      if (existing) {
        // Real firmware keeps the biometric when only the record is rewritten.
        // That is precisely why overwriting an occupied slot is dangerous: the
        // name changes, the face does not, and the device keeps reporting the
        // old person under a number that now means somebody else.
        console.log(
          `\n!! SetUserData overwrote occupied slot ${userId} ("${existing.name}" -> ` +
            `"${decodeName(String(msg.Name ?? ''))}"); its face template is unchanged.`,
        );
        existing.name = decodeName(String(msg.Name ?? ''));
        return { UserID: userId, Action: 'Update', Result: 'OK' };
      }
      users.set(userId, {
        userId,
        name: decodeName(String(msg.Name ?? '')),
        privilege: String(msg.Privilege ?? 'User'),
        faceData: null,
        photo: null,
      });
      return { UserID: userId, Action: 'Update', Result: 'OK' };
    }

    case 'GetFirstUserData':
    case 'GetNextUserData': {
      // The cursor takes no position argument: GetFirstUserData rewinds it.
      if (name === 'GetFirstUserData') userCursor = 0;
      const ordered = [...users.values()].sort((a, b) => a.userId - b.userId);
      const user = ordered[userCursor];
      if (!user) return { Result: 'Fail' };
      userCursor += 1;
      return {
        UserID: user.userId,
        Name: encodeName(user.name),
        Privilege: user.privilege,
        FaceEnrolled: user.faceData ? 'Yes' : 'No',
        More: userCursor < ordered.length ? 'Yes' : 'No',
        Result: 'OK',
      };
    }

    case 'GetFaceData': {
      const user = users.get(userId);
      if (!user?.faceData) return { UserID: userId, FaceEnrolled: 'No', Result: 'OK' };
      return { UserID: userId, FaceEnrolled: 'Yes', FaceData: user.faceData, Result: 'OK' };
    }

    case 'GetUserPhoto': {
      const user = users.get(userId);
      if (!user?.photo) return { UserID: userId, Result: 'Fail' };
      return { UserID: userId, PhotoData: user.photo, Result: 'OK' };
    }

    case 'SetUserPhoto': {
      const user = users.get(userId);
      if (!user) return { UserID: userId, Result: 'Fail', Reason: 'UserNotFound' };
      user.photo = String(msg.PhotoData ?? '');
      return { UserID: userId, Result: 'OK' };
    }

    case 'SetFaceData': {
      const user = users.get(userId) ?? {
        userId,
        name: `Slot ${userId}`,
        privilege: 'User',
        faceData: null,
        photo: null,
      };
      user.faceData = String(msg.FaceData ?? '');
      users.set(userId, user);
      return { UserID: userId, Result: 'OK' };
    }

    case 'EnrollFaceByPhoto': {
      const size = Number(msg.PhotoSize ?? 0);
      if (size > 32 * 1024) return { UserID: userId, Result: 'Fail', Reason: 'PhotoTooLarge' };
      const user = users.get(userId);
      if (!user) return { UserID: userId, Result: 'Fail', Reason: 'UserNotFound' };
      user.faceData = Buffer.from(`photo-template-${userId}`).toString('base64');
      user.photo = String(msg.PhotoData ?? '');
      // A face changing hands is an administration event; the real unit logs it.
      setTimeout(() => sendAdminLog(ws, 'EnrollUserFace', userId), 200);
      return { UserID: userId, Result: 'OK' };
    }

    case 'RemoteEnroll': {
      // Defaults to what the real terminal answers: the command carries no
      // UserID, so the device cannot tell which slot to enrol into.
      if (REMOTE_ENROLL_RESULT === 'Success') remoteEnrollActive = true;
      return { ...identity, ResultCode: REMOTE_ENROLL_RESULT };
    }

    case 'ExitRemoteEnroll': {
      const code = remoteEnrollActive ? 'SuccessExitRemoteEnroll' : 'NotStartedRemoteEnroll';
      remoteEnrollActive = false;
      return { ...identity, ResultCode: code };
    }

    case 'SetTime':
      return { Result: 'OK' };

    default:
      console.log(`\n?? No simulation for ${name}; the server's command will time out.`);
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const ws = new WebSocket(URL_);

ws.on('open', () => {
  console.log(`Connected to ${URL_} as ${SERIAL}`);
  if (token) {
    send(ws, { Request: 'Login', DeviceSerialNo: SERIAL, Token: token });
  } else {
    send(ws, { Request: 'Register', TerminalType: 'F500', DeviceSerialNo: SERIAL, CloudId: CLOUD_ID });
  }
});

ws.on('message', (data) => {
  const raw = data.toString();
  console.log(`← ${raw}`);
  const msg = (parser.parse(raw)?.Message ?? {}) as Record<string, string>;

  // Server-initiated command: answer it from the device's own state.
  const request = String(msg.Request ?? '').trim();
  if (request) {
    const response = handleRequest(ws, request, msg);
    if (response) send(ws, { ...response, Response: request } as Record<string, string | number>);
    return;
  }

  const name = String(msg.Response ?? '').trim();
  const result = String(msg.Result ?? '').trim();

  if (name === 'Register') {
    if (result !== 'OK') {
      console.error(
        `\nRegister refused. The serial must be provisioned first:\n` +
          `  POST /v1/tenants/{tenantId}/terminals {"serialNo":"${SERIAL}", ...}\n` +
          `and CloudId must match M50_CLOUD_ID if that is set.`,
      );
      return ws.close();
    }
    token = String(msg.Token ?? '').trim();
    console.log(`\nGot token ${token} — logging in`);
    return send(ws, { Request: 'Login', DeviceSerialNo: SERIAL, Token: token });
  }

  if (name === 'Login') {
    if (result !== 'OK') {
      console.error(`\nLogin refused (${result}). FailUnknownToken means re-run without --token.`);
      return ws.close();
    }
    console.log('\nLogged in. Sending KeepAlive, then a scan.');
    send(ws, { TerminalType: 'F500', DeviceSerialNo: SERIAL, Event: 'KeepAlive', DevTime: deviceTime() });
    setTimeout(() => sendScan(ws), 500);

    if (ADMIN_LOG) {
      setTimeout(() => sendAdminLog(ws, ADMIN_LOG, ADMIN_USER), 1000);
    }
    if (KEYPAD_ENROLL > 0) {
      // What actually happens when somebody enrols at the terminal: the device
      // picks its own number, keeps whatever name was typed, and announces it
      // only through the admin log. Those slots land in device/unclaimed.
      setTimeout(() => {
        for (let i = 0; i < KEYPAD_ENROLL; i++) {
          const userId = Math.max(0, ...users.keys()) + 1;
          users.set(userId, {
            userId,
            name: `${userId}`,
            privilege: 'User',
            faceData: Buffer.from(`keypad-template-${userId}`).toString('base64'),
            photo: Buffer.from(`keypad-photo-${userId}`).toString('base64'),
          });
          sendAdminLog(ws, 'EnrollUserFace', userId);
        }
        console.log(
          `\nEnrolled ${KEYPAD_ENROLL} user(s) at the "keypad". They are unmapped — ` +
            `GET .../device/unclaimed should list them.`,
        );
      }, 1500);
    }
    if (SCAN_INTERVAL > 0) {
      setInterval(() => sendScan(ws), SCAN_INTERVAL * 1000);
    } else if (!STAY) {
      // One-shot mode: give the ack time to land, then leave.
      setTimeout(() => ws.close(), 2500);
    } else {
      console.log('\nStaying connected — drive it with the terminals API.');
    }
    return;
  }

  if (name === 'TimeLog_v2') {
    console.log(
      result === 'OK'
        ? '\nScan acknowledged — it reached the auth-event-ingest queue.'
        : `\nScan REJECTED (${result}). Check the server log; the device would retain this record.`,
    );
  }

  if (name === 'AdminLog_v2') {
    console.log(
      result === 'OK'
        ? '\nAdmin log acknowledged — it is in the audit trail (GET device/admin-logs).'
        : `\nAdmin log REJECTED (${result}). Unlike attendance, this one cannot be re-pulled.`,
    );
  }
});

ws.on('error', (err) => console.error(`\nSocket error: ${err.message}`));
ws.on('close', (code) => {
  console.log(`\nDisconnected (${code})`);
  process.exit(0);
});

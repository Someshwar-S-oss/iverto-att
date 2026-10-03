/**
 * Wire codec for the M50 WebSocket SDK ("M50 WebSocket SDK Communication
 * Protocol", reference copy at `docs/websocket_sdk_protocol.txt`).
 *
 * The terminal speaks raw WebSocket frames carrying XML documents — it is not a
 * Socket.IO client and cannot talk to EventsGateway. Every frame is a
 * `<Message>` whose first child discriminates the direction:
 *
 *   <Request>  device asks us something   (Register, Login)
 *   <Event>    device reports something   (TimeLog_v2, AdminLog_v2, KeepAlive)
 *   <Response> device answers a command we sent
 *
 * The published spec is loose in ways real firmware tends to inherit, so the
 * decoder is deliberately forgiving: values arrive padded with whitespace
 * (`<Response> TimeLog_v2 </Response>`), enum spellings vary between the doc
 * and the wire (`Duty Off` vs `DutyOff`), and timestamps use a non-standard
 * `YYYY-MM-DD-THH:MM:SSZ` shape with a stray hyphen before the `T`.
 */
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { format as formatDate } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

const parser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  trimValues: true,
  // Keep every value a string. Terminal fields are routinely zero-padded
  // (`<PWD>012345</PWD>`) or base64, both of which numeric coercion corrupts.
  parseTagValue: false,
  processEntities: true,
});

const builder = new XMLBuilder({
  ignoreAttributes: true,
  suppressEmptyNode: false,
  processEntities: true,
});

const XML_DECLARATION = '<?xml version="1.0"?>';

/** Raw `<Message>` body: every child tag flattened to a trimmed string. */
export type M50Fields = Record<string, string>;

export type M50MessageKind = 'request' | 'event' | 'response';

export interface M50Message {
  kind: M50MessageKind;
  /** Command/event name, trimmed — e.g. `Login`, `TimeLog_v2`. */
  name: string;
  fields: M50Fields;
}

export class M50ProtocolError extends Error {}

/** Device-initiated events we act on. */
export const M50Event = {
  TimeLog: 'TimeLog',
  TimeLogV2: 'TimeLog_v2',
  AdminLog: 'AdminLog',
  AdminLogV2: 'AdminLog_v2',
  KeepAlive: 'KeepAlive',
} as const;

/** Device-initiated requests that make up the connection handshake. */
export const M50Request = {
  Register: 'Register',
  Login: 'Login',
} as const;

/** Server-initiated commands this integration issues. */
export const M50Command = {
  GetUserData: 'GetUserData',
  SetUserData: 'SetUserData',
  GetFirstUserData: 'GetFirstUserData',
  GetNextUserData: 'GetNextUserData',
  /**
   * The enrolment photo the device kept for a slot — distinct from GetFaceData,
   * which returns the opaque matching template. This one is a JPEG a human can
   * look at, which is what makes an unmapped slot identifiable after the fact.
   */
  GetUserPhoto: 'GetUserPhoto',
  SetUserPhoto: 'SetUserPhoto',
  GetFaceData: 'GetFaceData',
  SetFaceData: 'SetFaceData',
  EnrollFaceByPhoto: 'EnrollFaceByPhoto',
  RemoteEnroll: 'RemoteEnroll',
  ExitRemoteEnroll: 'ExitRemoteEnroll',
  GetGlogPosInfo: 'GetGlogPosInfo',
  GetFirstGlog: 'GetFirstGlog',
  GetNextGlog: 'GetNextGlog',
  GetDeviceStatus: 'GetDeviceStatus',
  SetTime: 'SetTime',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse one inbound frame.
 *
 * @throws {M50ProtocolError} if the frame is not a `<Message>` or carries no
 * Request/Event/Response discriminator.
 */
export function decodeMessage(xml: string): M50Message {
  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new M50ProtocolError(`malformed XML: ${(err as Error).message}`);
  }

  const message = parsed?.Message;
  if (!message || typeof message !== 'object') {
    throw new M50ProtocolError('frame has no <Message> root');
  }

  const fields: M50Fields = {};
  for (const [key, value] of Object.entries(message)) {
    // Repeated tags parse to arrays; the protocol has no legitimate repeats, so
    // keep the last occurrence rather than rejecting the frame outright.
    const scalar = Array.isArray(value) ? value[value.length - 1] : value;
    if (scalar === null || scalar === undefined) {
      fields[key] = '';
    } else if (typeof scalar === 'object') {
      // An empty element such as <Card></Card> parses to {}.
      fields[key] = '';
    } else {
      fields[key] = String(scalar).trim();
    }
  }

  // Firmware has been observed echoing the misspelling `<Reuqest>` that appears
  // in the vendor document; accept it so a typo cannot wedge the handshake.
  const discriminators: Array<[M50MessageKind, string]> = [
    ['request', 'Request'],
    ['request', 'Reuqest'],
    ['event', 'Event'],
    ['response', 'Response'],
  ];

  for (const [kind, tag] of discriminators) {
    const name = fields[tag];
    if (name) {
      return { kind, name, fields };
    }
  }

  throw new M50ProtocolError('frame has no <Request>, <Event> or <Response>');
}

/**
 * Serialise an outbound frame. Keys are emitted in insertion order; `undefined`
 * values are dropped so optional tags can be passed through conditionally.
 */
export function encodeMessage(fields: Record<string, string | number | undefined>): string {
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    body[key] = String(value);
  }
  return `${XML_DECLARATION}${builder.build({ Message: body })}`;
}

/** Acknowledge a device event. `TransID` is echoed back when the device sent one. */
export function encodeAck(name: string, result: 'OK' | 'Fail', transId?: string): string {
  return encodeMessage({ Response: name, TransID: transId, Result: result });
}

// ─────────────────────────────────────────────────────────────────────────────
// Field codecs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Terminal names travel as base64-encoded UTF-16LE, not UTF-8 — decoding as
 * UTF-8 yields NUL-interleaved mojibake for ASCII and garbage for anything else.
 */
export function decodeTerminalName(base64: string): string {
  if (!base64) return '';
  // `swap16` would be needed for UTF-16BE; the SDK specifies LE, which Node's
  // 'utf16le' encoding reads natively.
  return Buffer.from(base64, 'base64').toString('utf16le').replace(/\0+$/, '');
}

export function encodeTerminalName(name: string): string {
  return Buffer.from(name, 'utf16le').toString('base64');
}

/**
 * UserPeriod dates are packed into a single integer:
 *   (Year - 2000) << 16 | Month << 8 | Day
 */
export function decodeUserPeriod(packed: string | number): { year: number; month: number; day: number } | null {
  const value = typeof packed === 'number' ? packed : Number.parseInt(packed, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return {
    year: 2000 + (value >> 16),
    month: (value >> 8) & 0xff,
    day: value & 0xff,
  };
}

export function encodeUserPeriod(year: number, month: number, day: number): number {
  return ((year - 2000) << 16) | (month << 8) | day;
}

const DEVICE_TIME_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})-?T(\d{1,2}):(\d{2}):(\d{2})Z?$/;

/**
 * Parse a terminal timestamp.
 *
 * The wire format is `2013-05-06-T11:09:30Z` — note the hyphen before `T`,
 * which makes it invalid ISO 8601, so `new Date(...)` cannot be used.
 *
 * The trailing `Z` is not trustworthy: these terminals are configured to local
 * wall-clock time and stamp `Z` regardless. Interpreting it as UTC would shift
 * every attendance record by the site's offset (5h30m for Asia/Kolkata), so the
 * caller supplies the timezone the device's clock is actually set to.
 */
export function parseDeviceTime(value: string, timeZone: string): Date {
  const match = DEVICE_TIME_RE.exec(value.trim());
  if (!match) {
    throw new M50ProtocolError(`unparseable device timestamp: "${value}"`);
  }
  const [, year, month, day, hour, minute, second] = match;
  const pad = (s: string) => s.padStart(2, '0');
  const naive = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${second}`;
  const parsed = fromZonedTime(naive, timeZone);
  if (Number.isNaN(parsed.getTime())) {
    throw new M50ProtocolError(`unparseable device timestamp: "${value}"`);
  }
  return parsed;
}

/** Render a timestamp in the device's own format, in the device's timezone. */
export function formatDeviceTime(date: Date, timeZone: string): string {
  return formatDate(toZonedTime(date, timeZone), "yyyy-MM-dd'-T'HH:mm:ss'Z'");
}

// ─────────────────────────────────────────────────────────────────────────────
// Enum normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collapse an AttendStat to a canonical key. The document spells these with
 * spaces ("Duty On"); observed firmware omits them ("DutyOff").
 */
export function normalizeAttendStat(value: string): string {
  return value.replace(/[\s_-]+/g, '').toLowerCase();
}

/**
 * Derive travel direction from AttendStat, or `null` when the value does not
 * imply one.
 *
 * In practice most deployments leave the terminal pinned to a single attend
 * status — every row in the field sample reads `DutyOff` — so callers treat
 * this as an override on top of the gate's configured direction rather than as
 * the primary signal.
 */
export function attendStatToDirection(value: string): 'in' | 'out' | null {
  switch (normalizeAttendStat(value)) {
    case 'in':
    case 'dutyon':
    case 'overtimeon':
    case 'gooutoff': // returning from a "go out" excursion
      return 'in';
    case 'out':
    case 'dutyoff':
    case 'overtimeoff':
    case 'goouton':
      return 'out';
    default:
      return null;
  }
}

/**
 * Verification methods that represent a successful identification. Everything
 * else in the Action enum is a door/tamper condition or a failure, not a person
 * being recognised.
 */
const GRANTING_ACTIONS = new Set([
  'face',
  'fp',
  'pwd',
  'cd',
  'fp+cd',
  'fp+pwd',
  'cd+pwd',
  'fp+cd+pwd',
]);

const DENYING_ACTIONS = new Set(['verifyfail', 'invalidtz', 'ilgopen', 'tamper', 'duress']);

/** Map a TimeLog Action onto the AuthEvent.outcome vocabulary. */
export function actionToOutcome(action: string): 'GRANTED' | 'DENIED' | 'UNKNOWN' {
  const key = action.trim().toLowerCase();
  if (GRANTING_ACTIONS.has(key)) return 'GRANTED';
  if (DENYING_ACTIONS.has(key)) return 'DENIED';
  return 'UNKNOWN';
}

/**
 * Actions that describe the door/enclosure rather than a person. These carry a
 * UserID of 0 and must not be resolved to a subject.
 */
export function isSubjectlessAction(action: string): boolean {
  const key = action.trim().toLowerCase();
  return ['tamper', 'handlock', 'proglock', 'progopen', 'progclose', 'autorecover', 'lockover', 'ilgopen'].includes(
    key,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed views over specific messages
// ─────────────────────────────────────────────────────────────────────────────

export interface TimeLogPayload {
  logId: number;
  /** Device-local user number; 0 denotes the terminal administrator, not a person. */
  terminalUserId: number;
  rawTime: string;
  action: string;
  attendStat: string;
  apStat: string;
  jobCode: string;
  /** Base64 JPEG captured at verification, when the terminal is set to send photos. */
  logImage?: string;
  transId?: string;
}

export function parseTimeLog(fields: M50Fields): TimeLogPayload {
  const logId = Number.parseInt(fields.LogID ?? '', 10);
  if (!Number.isFinite(logId)) {
    throw new M50ProtocolError(`TimeLog missing numeric <LogID> (got "${fields.LogID}")`);
  }
  const terminalUserId = Number.parseInt(fields.UserID ?? '', 10);
  if (!Number.isFinite(terminalUserId)) {
    throw new M50ProtocolError(`TimeLog missing numeric <UserID> (got "${fields.UserID}")`);
  }
  return {
    logId,
    terminalUserId,
    rawTime: fields.Time ?? '',
    action: fields.Action ?? '',
    attendStat: fields.AttendStat ?? '',
    apStat: fields.APStat ?? '',
    jobCode: fields.JobCode ?? '',
    logImage: fields.LogImage || undefined,
    transId: fields.TransID || undefined,
  };
}

/**
 * What an AdminLog action was actually about.
 *
 * The vendor's enum is fingerprint-era (`EnrollUserFP`, `DeleteFP`, …) and
 * predates face terminals, so an M50 enrolling a face has no documented action
 * name of its own — observed firmware reuses a neighbouring spelling or falls
 * back to `Unknown`. Matching on the verb rather than the exact literal is
 * therefore deliberate: the alternative is silently mis-filing the one event
 * that tells us somebody enrolled at the keypad.
 */
export type AdminLogCategory = 'enrollment' | 'deletion' | 'configuration' | 'session' | 'other';

export function adminActionCategory(action: string): AdminLogCategory {
  const key = action.trim().toLowerCase();
  // Order matters: "DeleteAllEnoll" (sic, the vendor's own typo) is a deletion
  // even though it contains an enrolment verb.
  if (key.startsWith('delete') || key === 'restore') return 'deletion';
  if (key.startsWith('enroll')) return 'enrollment';
  if (['settingchanged', 'settime', 'tzset', 'modifyperiod'].includes(key)) return 'configuration';
  if (key.startsWith('entermenu') || key.startsWith('exitmenu')) return 'session';
  return 'other';
}

/**
 * True when the action changed who the device can recognise.
 *
 * These are the events that put the hardware and `TerminalUser` out of step,
 * because they happen at the keypad where the cloud has no say.
 */
export function mutatesEnrolment(action: string): boolean {
  const category = adminActionCategory(action);
  return category === 'enrollment' || category === 'deletion';
}

export interface AdminLogPayload {
  logId: number;
  adminId: number;
  terminalUserId: number;
  rawTime: string;
  action: string;
  stat: string;
  transId?: string;
}

export function parseAdminLog(fields: M50Fields): AdminLogPayload {
  const toInt = (raw: string | undefined) => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) ? n : 0;
  };
  const logId = Number.parseInt(fields.LogID ?? '', 10);
  if (!Number.isFinite(logId)) {
    throw new M50ProtocolError(`AdminLog missing numeric <LogID> (got "${fields.LogID}")`);
  }
  return {
    logId,
    adminId: toInt(fields.AdminID),
    terminalUserId: toInt(fields.UserID),
    rawTime: fields.Time ?? '',
    action: fields.Action ?? '',
    stat: fields.Stat ?? '',
    transId: fields.TransID || undefined,
  };
}

import {
  M50ProtocolError,
  actionToOutcome,
  adminActionCategory,
  mutatesEnrolment,
  attendStatToDirection,
  decodeMessage,
  decodeTerminalName,
  decodeUserPeriod,
  encodeAck,
  encodeMessage,
  encodeTerminalName,
  encodeUserPeriod,
  formatDeviceTime,
  isSubjectlessAction,
  parseAdminLog,
  parseDeviceTime,
  parseTimeLog,
} from './m50-protocol';

const SITE_TZ = 'Asia/Kolkata';

describe('decodeMessage', () => {
  it('decodes a TimeLog_v2 event', () => {
    const msg = decodeMessage(`<?xml version="1.0"?>
      <Message>
        <TerminalType>F500</TerminalType>
        <TerminalID>1</TerminalID>
        <DeviceSerialNo>DJ20250307014</DeviceSerialNo>
        <Event>TimeLog_v2</Event>
        <LogID>24</LogID>
        <Time>2026-08-12-T14:34:54Z</Time>
        <UserID>2</UserID>
        <Action>FACE</Action>
        <AttendStat>DutyOff</AttendStat>
        <APStat>None</APStat>
        <TransID>abc123</TransID>
      </Message>`);

    expect(msg.kind).toBe('event');
    expect(msg.name).toBe('TimeLog_v2');
    expect(msg.fields.DeviceSerialNo).toBe('DJ20250307014');
  });

  it('discriminates request, event and response frames', () => {
    const req = decodeMessage('<Message><Request>Login</Request></Message>');
    const evt = decodeMessage('<Message><Event>KeepAlive</Event></Message>');
    const res = decodeMessage('<Message><Response>SetUserData</Response></Message>');

    expect([req.kind, evt.kind, res.kind]).toEqual(['request', 'event', 'response']);
    expect([req.name, evt.name, res.name]).toEqual(['Login', 'KeepAlive', 'SetUserData']);
  });

  it('trims padded values, which the vendor doc shows verbatim', () => {
    const msg = decodeMessage('<Message><Response> TimeLog_v2 </Response><Result> OK </Result></Message>');
    expect(msg.name).toBe('TimeLog_v2');
    expect(msg.fields.Result).toBe('OK');
  });

  it('accepts the <Reuqest> misspelling carried in the vendor doc', () => {
    const msg = decodeMessage('<Message><Reuqest>GetUserData</Reuqest></Message>');
    expect(msg.kind).toBe('request');
    expect(msg.name).toBe('GetUserData');
  });

  it('preserves zero-padded values instead of coercing them to numbers', () => {
    const msg = decodeMessage('<Message><Event>TimeLog_v2</Event><PWD>012345</PWD></Message>');
    expect(msg.fields.PWD).toBe('012345');
  });

  it('represents an empty element as an empty string', () => {
    const msg = decodeMessage('<Message><Request>Login</Request><Card></Card></Message>');
    expect(msg.fields.Card).toBe('');
  });

  it('rejects frames with no discriminator', () => {
    expect(() => decodeMessage('<Message><Result>OK</Result></Message>')).toThrow(M50ProtocolError);
  });

  it('rejects frames with no <Message> root', () => {
    expect(() => decodeMessage('<Other><Event>KeepAlive</Event></Other>')).toThrow(M50ProtocolError);
  });
});

describe('encodeMessage', () => {
  it('emits a declaration and preserves key order', () => {
    const xml = encodeMessage({ Response: 'Login', DeviceSerialNo: 'DJ20250307014', Result: 'OK' });
    expect(xml).toBe(
      '<?xml version="1.0"?><Message><Response>Login</Response>' +
        '<DeviceSerialNo>DJ20250307014</DeviceSerialNo><Result>OK</Result></Message>',
    );
  });

  it('omits undefined fields so optional tags can be passed through', () => {
    expect(encodeMessage({ Response: 'Login', Token: undefined })).not.toContain('Token');
  });

  it('round-trips through the decoder', () => {
    const xml = encodeMessage({ Request: 'GetFaceData', UserID: 7 });
    const decoded = decodeMessage(xml);
    expect(decoded).toMatchObject({ kind: 'request', name: 'GetFaceData' });
    expect(decoded.fields.UserID).toBe('7');
  });

  it('escapes characters that would otherwise break the document', () => {
    const xml = encodeMessage({ Response: 'SetUserData', Error: 'a & b <c>' });
    expect(xml).not.toContain('a & b <c>');
    expect(decodeMessage(xml).fields.Error).toBe('a & b <c>');
  });
});

describe('encodeAck', () => {
  it('echoes TransID when the device supplied one', () => {
    expect(encodeAck('TimeLog_v2', 'OK', 'abc123')).toContain('<TransID>abc123</TransID>');
  });

  it('omits TransID for events that carry none', () => {
    expect(encodeAck('KeepAlive', 'OK')).not.toContain('TransID');
  });
});

describe('terminal name codec', () => {
  it('decodes base64 UTF-16LE rather than UTF-8', () => {
    const base64 = Buffer.from('Ravi Kumar', 'utf16le').toString('base64');
    expect(decodeTerminalName(base64)).toBe('Ravi Kumar');
  });

  it('round-trips non-ASCII names', () => {
    const name = 'ரவி குமார்';
    expect(decodeTerminalName(encodeTerminalName(name))).toBe(name);
  });

  it('strips trailing NUL padding written by the terminal', () => {
    const padded = Buffer.from('Ravi\0\0', 'utf16le').toString('base64');
    expect(decodeTerminalName(padded)).toBe('Ravi');
  });

  it('returns empty string for an absent name', () => {
    expect(decodeTerminalName('')).toBe('');
  });
});

describe('UserPeriod packing', () => {
  it('packs and unpacks a date', () => {
    const packed = encodeUserPeriod(2026, 8, 12);
    expect(decodeUserPeriod(packed)).toEqual({ year: 2026, month: 8, day: 12 });
  });

  it('matches the formula in the specification', () => {
    // (2026-2000) << 16 | 8 << 8 | 12
    expect(encodeUserPeriod(2026, 8, 12)).toBe((26 << 16) | (8 << 8) | 12);
  });

  it('treats zero and non-numeric input as unset', () => {
    expect(decodeUserPeriod('0')).toBeNull();
    expect(decodeUserPeriod('')).toBeNull();
  });
});

describe('parseDeviceTime', () => {
  it('parses the non-ISO hyphen-T format', () => {
    // 14:34:54 IST == 09:04:54 UTC
    expect(parseDeviceTime('2026-08-12-T14:34:54Z', SITE_TZ).toISOString()).toBe('2026-08-12T09:04:54.000Z');
  });

  it('interprets the clock in the site timezone, not as UTC', () => {
    // The trailing Z is cargo-cult: taking it literally would shift attendance
    // by the site's offset and put evening exits on the wrong day.
    const parsed = parseDeviceTime('2026-08-12-T14:34:54Z', SITE_TZ);
    expect(parsed.toISOString()).not.toBe('2026-08-12T14:34:54.000Z');
  });

  it('also accepts a well-formed ISO separator', () => {
    expect(parseDeviceTime('2026-08-12T14:34:54Z', SITE_TZ).toISOString()).toBe('2026-08-12T09:04:54.000Z');
  });

  it('accepts unpadded month, day and hour components', () => {
    expect(parseDeviceTime('2026-8-2-T9:04:54Z', SITE_TZ).toISOString()).toBe('2026-08-02T03:34:54.000Z');
  });

  it('rejects unparseable input rather than yielding an Invalid Date', () => {
    expect(() => parseDeviceTime('not-a-time', SITE_TZ)).toThrow(M50ProtocolError);
  });
});

describe('formatDeviceTime', () => {
  it('renders the device format in the device timezone', () => {
    const date = new Date('2026-08-12T09:04:54.000Z');
    expect(formatDeviceTime(date, SITE_TZ)).toBe('2026-08-12-T14:34:54Z');
  });

  it('round-trips with parseDeviceTime', () => {
    const wire = '2026-08-12-T14:34:54Z';
    expect(formatDeviceTime(parseDeviceTime(wire, SITE_TZ), SITE_TZ)).toBe(wire);
  });
});

describe('attendStatToDirection', () => {
  it('accepts both the spaced and unspaced spellings', () => {
    expect(attendStatToDirection('Duty On')).toBe('in');
    expect(attendStatToDirection('DutyOn')).toBe('in');
    expect(attendStatToDirection('DutyOff')).toBe('out');
  });

  it('maps the plain In/Out statuses', () => {
    expect(attendStatToDirection('In')).toBe('in');
    expect(attendStatToDirection('Out')).toBe('out');
  });

  it('treats a GoOut return as an inbound movement', () => {
    expect(attendStatToDirection('Go Out On')).toBe('out');
    expect(attendStatToDirection('Go Out Off')).toBe('in');
  });

  it('returns null for statuses that imply no direction', () => {
    expect(attendStatToDirection('None')).toBeNull();
    expect(attendStatToDirection('')).toBeNull();
  });
});

describe('actionToOutcome', () => {
  it('treats verification methods as granted', () => {
    expect(actionToOutcome('FACE')).toBe('GRANTED');
    expect(actionToOutcome('FP')).toBe('GRANTED');
    expect(actionToOutcome('FP+CD')).toBe('GRANTED');
  });

  it('treats failures and tampering as denied', () => {
    expect(actionToOutcome('VerifyFail')).toBe('DENIED');
    expect(actionToOutcome('Tamper')).toBe('DENIED');
    expect(actionToOutcome('InvalidTZ')).toBe('DENIED');
  });

  it('falls back to UNKNOWN for unrecognised actions', () => {
    expect(actionToOutcome('SomethingNew')).toBe('UNKNOWN');
  });
});

describe('isSubjectlessAction', () => {
  it('flags door and enclosure events', () => {
    expect(isSubjectlessAction('Tamper')).toBe(true);
    expect(isSubjectlessAction('ProgOpen')).toBe(true);
  });

  it('does not flag person verifications', () => {
    expect(isSubjectlessAction('FACE')).toBe(false);
  });
});

describe('parseTimeLog', () => {
  const fields = {
    Event: 'TimeLog_v2',
    LogID: '24',
    Time: '2026-08-12-T14:34:54Z',
    UserID: '2',
    Action: 'FACE',
    AttendStat: 'DutyOff',
    APStat: 'None',
    JobCode: '0',
    TransID: 'abc123',
  };

  it('extracts the payload', () => {
    expect(parseTimeLog(fields)).toEqual({
      logId: 24,
      terminalUserId: 2,
      rawTime: '2026-08-12-T14:34:54Z',
      action: 'FACE',
      attendStat: 'DutyOff',
      apStat: 'None',
      jobCode: '0',
      logImage: undefined,
      transId: 'abc123',
    });
  });

  it('retains UserID 0, which denotes the terminal administrator', () => {
    expect(parseTimeLog({ ...fields, UserID: '0' }).terminalUserId).toBe(0);
  });

  it('rejects a log with no usable LogID, since it is the dedupe key', () => {
    expect(() => parseTimeLog({ ...fields, LogID: '' })).toThrow(M50ProtocolError);
  });

  it('rejects a log with a non-numeric UserID', () => {
    expect(() => parseTimeLog({ ...fields, UserID: 'x' })).toThrow(M50ProtocolError);
  });
});

describe('parseAdminLog', () => {
  it('extracts the payload from a real-world DeleteUser row', () => {
    expect(
      parseAdminLog({
        Event: 'AdminLog_v2',
        LogID: '31',
        Time: '2026-08-12-T14:30:58Z',
        AdminID: '0',
        UserID: '1',
        Action: 'DeleteUser',
        Stat: '0',
      }),
    ).toEqual({
      logId: 31,
      adminId: 0,
      terminalUserId: 1,
      rawTime: '2026-08-12-T14:30:58Z',
      action: 'DeleteUser',
      stat: '0',
      transId: undefined,
    });
  });

  it('defaults absent id fields to zero rather than NaN', () => {
    const parsed = parseAdminLog({ LogID: '1', Action: 'EnterMenu' });
    expect(parsed.adminId).toBe(0);
    expect(parsed.terminalUserId).toBe(0);
  });
});

describe('adminActionCategory', () => {
  it.each(['EnrollUserFP', 'EnrollUserCard', 'EnrollMgrPWD', 'EnrollUserFace'])(
    'files %s as an enrolment',
    (action) => {
      // EnrollUserFace is not in the vendor's enum at all — that list predates
      // face terminals — so matching the verb is what keeps an M50's own
      // spelling from being filed as "other" and going unnoticed.
      expect(adminActionCategory(action)).toBe('enrollment');
    },
  );

  it.each(['DeleteUser', 'DeleteFP', 'DeleteAll', 'Restore'])('files %s as a deletion', (action) => {
    expect(adminActionCategory(action)).toBe('deletion');
  });

  it('files DeleteAllEnoll as a deletion despite the enrolment verb in the vendor typo', () => {
    expect(adminActionCategory('DeleteAllEnoll')).toBe('deletion');
  });

  it.each(['SettingChanged', 'SetTime', 'TZSet', 'ModifyPeriod'])(
    'files %s as configuration',
    (action) => {
      expect(adminActionCategory(action)).toBe('configuration');
    },
  );

  it('files menu navigation separately from anything that changed state', () => {
    expect(adminActionCategory('EnterMenu')).toBe('session');
  });

  it('tolerates the whitespace padding real frames carry', () => {
    expect(adminActionCategory(' DeleteUser ')).toBe('deletion');
  });

  it('falls back to other for an action it does not recognise', () => {
    expect(adminActionCategory('Unknown')).toBe('other');
  });

  it('treats exactly the enrolment-changing actions as drift', () => {
    expect(mutatesEnrolment('EnrollUserFP')).toBe(true);
    expect(mutatesEnrolment('DeleteUser')).toBe(true);
    expect(mutatesEnrolment('EnterMenu')).toBe(false);
    expect(mutatesEnrolment('SetTime')).toBe(false);
  });
});

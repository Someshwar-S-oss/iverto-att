import { describe, expect, it } from 'vitest';
import { actionLabel, actionTone, auditFields, auditSentence, humanize, pageOf, readableFields, SUPPORT_ACCESS, type AuditEntry } from './audit';

describe('audit formatting', () => {
  it('humanizes codes and camelCase', () => {
    expect(humanize('LEAVE_APPROVED')).toBe('Leave approved');
    expect(humanize('LeaveRequest')).toBe('Leave request');
    expect(actionTone('MOBILE_PUNCH_REJECTED')).toBe('danger');
  });

  it('flattens payloads into readable rows', () => {
    expect(auditFields({ name: 'Acme', branding: { logoUrl: 'https://x/l.png' }, weeklyOffs: [0, 6], storePhotos: false, items: [{ a: 1 }], note: null })).toEqual([
      { term: 'Name', value: 'Acme' },
      { term: 'Branding · Logo url', value: 'https://x/l.png' },
      { term: 'Weekly offs', value: '0, 6' },
      { term: 'Store photos', value: 'No' },
      { term: 'Items', value: '1 item' },
      { term: 'Note', value: '—' },
    ]);
    expect(auditFields(null)).toEqual([]);
  });
});

describe('plain-language audit', () => {
  const names: Record<string, string> = { e1: 'Pooja', cl: 'Casual leave' };
  const nameOf = (_k: string, id: string) => names[id];
  const entry = (action: string, payload: unknown, extra: Partial<AuditEntry> = {}): AuditEntry =>
    ({ action, payload, actorUserId: 'u1', actorType: 'user', targetType: null, targetId: null, createdAt: '2026-11-06T17:00:00Z', ...extra });

  it('says what happened, with names instead of ids', () => {
    expect(auditSentence(entry('LEAVE_APPROVED', { employeeId: 'e1', leaveTypeId: 'cl', from: '2026-12-02', to: '2026-12-03' }), nameOf))
      .toBe('approved Pooja’s Casual leave (2 Dec 2026 – 3 Dec 2026)');
    expect(auditSentence(entry('LEAVE_REJECTED', { note: 'Busy' }), nameOf)).toBe('rejected a leave');
    expect(auditSentence(entry('EMPLOYEE_UPDATED', {}, { targetType: 'Employee', targetId: 'e1' }), nameOf)).toBe('changed Pooja’s details');
    expect(actionLabel('LEAVE_MANAGER_APPROVED')).toBe('Leave approved by manager');
    expect(actionLabel('SOMETHING_NEW')).toBe('Something new');
  });

  it('turns support access URLs into page names', () => {
    expect(auditSentence(entry(SUPPORT_ACCESS, { method: 'GET', url: '/v1/audit-logs?page=1&size=50' }), nameOf)).toBe('viewed Audit log');
    expect(auditSentence(entry(SUPPORT_ACCESS, { method: 'PATCH', url: '/v1/attendance-policies/x' }), nameOf)).toBe('edited something in Attendance policies');
    expect(pageOf('/v1/employees?size=500')).toBe('Employees');
    expect(pageOf('/v1/something-else')).toBe('Something else');
  });

  it('details show names, hide unknown ids, and read dates', () => {
    expect(readableFields({ employeeId: 'e1', requestId: 'zz', from: '2026-12-02', note: 'ok' }, nameOf)).toEqual([
      { term: 'Employee', value: 'Pooja' },
      { term: 'From', value: '2 Dec 2026' },
      { term: 'Note', value: 'ok' },
    ]);
  });

  it('describes terminal keypad events in plain words', () => {
    const p = { serialNo: 'DJ1', logId: 301, adminId: 0, terminalUserId: 0, action: 'EnterMenu', category: 'session', stat: '0', occurredAt: '2026-11-02T12:57:00Z' };
    const e = entry('TERMINAL_ENTERMENU', p, { actorType: 'device', actorUserId: null });
    expect(actionLabel(e.action)).toBe('Terminal menu opened');
    expect(auditSentence(e, nameOf)).toBe('had its admin menu opened at the keypad');
    expect(auditSentence(entry('TERMINAL_ENROLLUSERFACE', { ...p, terminalUserId: 7 }), nameOf)).toBe('had terminal user 7 enrolled at the keypad');
    expect(auditSentence(entry('TERMINAL_UNKNOWN', { ...p, action: 'Unknown' }), nameOf)).toBe('reported “Unknown” at the keypad');
    expect(actionLabel('TERMINAL_DELETED')).toBe('Attendance terminal removed');
    expect(readableFields(p, nameOf, e.action).map((f) => f.term)).toEqual(['Terminal', 'Time on the terminal’s clock']);
  });
});

import { describe, expect, it } from 'vitest';
import { actionTone, auditFields, humanize } from './audit';

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

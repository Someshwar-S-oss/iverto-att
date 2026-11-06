import { approvalTrack } from './approval';

const at = new Date('2026-11-05T05:00:00Z');
const names = new Map([['emp', 'Asha'], ['mgr', 'Manoj'], ['hr', 'Priya']]);
const base = { createdAt: at, createdBy: 'emp' };
const states = (r: Parameters<typeof approvalTrack>[0], two: boolean) => approvalTrack(r, two, names).steps.map((s) => `${s.key}:${s.state}`).join(' ');

describe('approvalTrack', () => {
  it('two levels: pending at the manager, then at HR, then approved', () => {
    expect(states({ ...base, status: 'PENDING' }, true)).toBe('SUBMITTED:done MANAGER:current HR:upcoming APPROVED:upcoming');
    const atHr = approvalTrack({ ...base, status: 'PENDING', managerApproverId: 'mgr', managerDecidedAt: at }, true, names);
    expect(atHr.stage).toBe('HR');
    expect(atHr.steps[1]).toMatchObject({ state: 'done', by: 'Manoj' });
    expect(states({ ...base, status: 'APPROVED', managerApproverId: 'mgr', approverId: 'hr', decidedAt: at }, true)).toBe('SUBMITTED:done MANAGER:done HR:done APPROVED:done');
  });
  it('a rejection stops at its level and carries the reason', () => {
    const r = approvalTrack({ ...base, status: 'REJECTED', managerApproverId: 'mgr', approverId: 'hr', decidedAt: at, decisionNote: 'Peak season' }, true, names);
    expect(r.steps.map((s) => s.state)).toEqual(['done', 'done', 'rejected', 'rejected']);
    expect(r.steps[2]).toMatchObject({ by: 'Priya', note: 'Peak season' });
    expect(states({ ...base, status: 'REJECTED', approverId: 'mgr', decisionNote: 'No' }, true)).toBe('SUBMITTED:done MANAGER:rejected HR:upcoming APPROVED:rejected');
  });
  it('one level: the manager decision is final; HR approving directly skips the manager in two-level', () => {
    expect(states({ ...base, status: 'APPROVED', approverId: 'mgr' }, false)).toBe('SUBMITTED:done MANAGER:done APPROVED:done');
    expect(states({ ...base, status: 'APPROVED', approverId: 'hr' }, true)).toBe('SUBMITTED:done MANAGER:skipped HR:done APPROVED:done');
  });
  it('cancelled while pending, or after approval', () => {
    expect(states({ ...base, status: 'CANCELLED' }, false)).toBe('SUBMITTED:done MANAGER:cancelled APPROVED:cancelled');
    expect(states({ ...base, status: 'CANCELLED', approverId: 'mgr' }, false)).toBe('SUBMITTED:done MANAGER:done APPROVED:cancelled');
  });
});

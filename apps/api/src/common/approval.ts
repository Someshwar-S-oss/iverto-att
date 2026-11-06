import { PrismaService } from './prisma.service';

/** Where a request stands, as the steps an employee sees in the tracker (web modal, mobile). */
export type StepState = 'done' | 'current' | 'upcoming' | 'rejected' | 'cancelled' | 'skipped';

export interface TrackStep {
  key: 'SUBMITTED' | 'MANAGER' | 'HR' | 'APPROVED';
  label: string;
  state: StepState;
  at: Date | null;
  by: string | null;
  note: string | null;
}

export interface Trackable {
  status: string; // PENDING | APPROVED | REJECTED | CANCELLED
  createdAt: Date;
  createdBy?: string | null;
  managerApproverId?: string | null;
  managerDecidedAt?: Date | null;
  approverId?: string | null;
  decidedAt?: Date | null;
  decisionNote?: string | null;
}

/**
 * Submitted → Manager → (HR, when two-level) → Approved. A rejection or
 * cancellation stops the track at the step it happened on. HR/Admin approval is
 * always final, so with no manager decision the manager step shows as skipped.
 * `names` maps user ids to display names.
 */
export function approvalTrack(r: Trackable, twoLevel: boolean, names: Map<string, string> = new Map()) {
  const who = (id?: string | null) => (id ? (names.get(id) ?? null) : null);
  const { status } = r;
  const managerDone = Boolean(r.managerApproverId);
  // The step a decision or cancellation landed on.
  const atHr = twoLevel && managerDone;
  const stop = (state: 'rejected' | 'cancelled'): Partial<TrackStep> => ({ state, at: r.decidedAt ?? null, by: who(r.approverId), note: r.decisionNote ?? null });

  const manager: TrackStep = { key: 'MANAGER', label: 'Manager approval', state: 'upcoming', at: null, by: null, note: null };
  const hr: TrackStep = { key: 'HR', label: 'HR / admin approval', state: 'upcoming', at: null, by: null, note: null };
  const final: TrackStep = { key: 'APPROVED', label: 'Approved', state: 'upcoming', at: null, by: null, note: null };

  if (managerDone) Object.assign(manager, { state: 'done', at: r.managerDecidedAt ?? null, by: who(r.managerApproverId) });
  if (status === 'PENDING') {
    (atHr ? hr : manager).state = 'current';
  } else if (status === 'APPROVED') {
    const decided = { state: 'done' as const, at: r.decidedAt ?? null, by: who(r.approverId), note: r.decisionNote ?? null };
    if (twoLevel) {
      if (!managerDone) manager.state = 'skipped';
      Object.assign(hr, decided);
    } else Object.assign(manager, decided);
    Object.assign(final, { state: 'done', at: r.decidedAt ?? null });
  } else if (status === 'REJECTED') {
    Object.assign(atHr ? hr : manager, stop('rejected'));
    Object.assign(final, { label: 'Rejected', state: 'rejected' });
  } else {
    // Cancelled: after full approval (approverId is only set by the final approval), or while pending.
    if (r.approverId) Object.assign(twoLevel ? hr : manager, { state: 'done', by: who(r.approverId) });
    else (atHr ? hr : manager).state = 'cancelled';
    Object.assign(final, { label: 'Cancelled', state: 'cancelled', at: r.decidedAt ?? null, note: r.decisionNote ?? null });
  }
  const steps: TrackStep[] = [
    { key: 'SUBMITTED', label: 'Submitted', state: 'done', at: r.createdAt, by: who(r.createdBy), note: null },
    manager,
    ...(twoLevel ? [hr] : []),
    final,
  ];
  return { levels: twoLevel ? 2 : 1, stage: steps.find((s) => s.state === 'current')?.key ?? (status === 'APPROVED' ? 'APPROVED' : status), steps };
}

/** Display names for the user ids on a page of requests, in one query. */
export async function approverNames(prisma: PrismaService, rows: Trackable[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.managerApproverId, r.approverId]).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return new Map<string, string>();
  const profiles = await prisma.userProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, displayName: true } });
  return new Map(profiles.map((p) => [p.userId, p.displayName]));
}

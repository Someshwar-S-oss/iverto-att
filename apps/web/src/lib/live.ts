import { toast } from '@iverto-org/core-ui';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { downloadExport, queryClient } from './api';
import { supabase } from './auth';

/** The one attendance-day shape: REST lists, the live board and socket deltas all send it. */
export interface Day {
  id: string;
  employeeId: string;
  employee?: { id: string; fullName: string; employeeCode: string; departmentId: string | null; siteId: string };
  siteId: string;
  workDate: string;
  timezone: string;
  dayType: string;
  holidayName: string | null;
  shiftId: string | null;
  schedStart: string | null;
  schedEnd: string | null;
  firstIn: string | null;
  lastOut: string | null;
  local: { schedStart: string | null; schedEnd: string | null; firstIn: string | null; lastOut: string | null; offset: string };
  status: string;
  liveState: string;
  requiredMinutes: number;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  punchCount: number;
  isLate: boolean;
  isEarlyExit: boolean;
  missedPunch: boolean;
  workedOnOffDay: boolean;
  hasLeaveConflict: boolean;
  leavePortion: number;
  remote: boolean;
  corrected: boolean;
  segments: { in: string; out: string | null; credited?: boolean }[];
  finalizedAt: string | null;
}

export interface Punch {
  id: string;
  punchedAt: string;
  local: string;
  offset: string;
  timezone: string;
  employeeId: string | null;
  employee: { fullName: string; employeeCode: string } | null;
  device: { name: string | null; serialNo: string; gateName: string } | null;
  terminalUserId: number | null;
  source: string;
  direction: string;
  workDate: string | null;
  reason: string | null;
}

export interface Device { id: string; name: string | null; serialNo: string; gateName: string; direction: string; siteId: string; status: string; lastSeenAt: string | null; online: boolean }

export interface Board {
  generatedAt: string;
  counts: Record<string, number>;
  summary: { present: number; late: number; absent: number; notYetIn: number; onLeave: number; remote: number; off: number; scheduled: number };
  rows: Day[];
  devices: Device[];
  recentPunches: Punch[];
}

/** Recount exactly as the API's LiveService.board does, so a patched board matches a fresh snapshot. */
export function summarise(rows: Day[]): Pick<Board, 'counts' | 'summary'> {
  const counts: Record<string, number> = Object.fromEntries(
    ['OFF', 'ON_LEAVE', 'NOT_YET_IN', 'LATE_NOT_IN', 'IN', 'IN_LATE', 'REMOTE', 'ON_BREAK', 'LEFT', 'ABSENT'].map((s) => [s, 0]),
  );
  for (const d of rows) counts[d.liveState] = (counts[d.liveState] ?? 0) + 1;
  return {
    counts,
    summary: {
      present: counts.IN + counts.IN_LATE + counts.ON_BREAK + counts.LEFT,
      late: rows.filter((d) => d.isLate).length,
      absent: counts.ABSENT,
      notYetIn: counts.NOT_YET_IN + counts.LATE_NOT_IN,
      onLeave: counts.ON_LEAVE,
      remote: counts.REMOTE,
      off: counts.OFF,
      scheduled: rows.filter((d) => d.dayType === 'WORKING').length,
    },
  };
}

/** attendance.updated: replace today's row for that employee. Rows outside this board's filter are ignored. */
export function applyDay(board: Board, day: Day): Board {
  const i = board.rows.findIndex((r) => r.employeeId === day.employeeId && r.workDate === day.workDate);
  if (i < 0) return board;
  const rows = board.rows.slice();
  rows[i] = { ...day, employee: day.employee ?? rows[i].employee };
  return { ...board, rows, ...summarise(rows) };
}

export function applyPunch(board: Board, punch: Punch): Board {
  if (board.recentPunches.some((p) => p.id === punch.id)) return board;
  return { ...board, recentPunches: [punch, ...board.recentPunches].slice(0, 30) };
}

export function applyDevice(board: Board, d: { deviceId: string; status: string; lastSeenAt: string | null }): Board {
  return { ...board, devices: board.devices.map((x) => (x.id === d.deviceId ? { ...x, status: d.status, lastSeenAt: d.lastSeenAt, online: d.status === 'online' } : x)) };
}

/** Export jobs this tab asked for: auto-download when report.ready arrives (§11.2). */
export const awaitingDownload = new Set<string>();

const patchBoards = (fn: (b: Board) => Board) =>
  queryClient.setQueriesData<Board>({ queryKey: ['live', 'board'] }, (b) => (b ? fn(b) : b));
// Mark stale without refetching: a burst of punches must not trigger a burst of list reloads.
const stale = (...key: string[]) => queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' });

/**
 * Socket.IO /live (§10, §14.3): snapshot over REST, deltas here patched straight
 * into the query cache. On reconnect the snapshot is refetched — no replay protocol.
 */
export function useLiveSocket(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const socket = io(`${import.meta.env.VITE_WS_URL ?? ''}/live`, {
      path: import.meta.env.VITE_WS_PATH ?? '/socket.io',
      transports: ['websocket'],
      // A function, so every reconnect sends the current (refreshed) token.
      auth: (cb) => void supabase.auth.getSession().then(({ data }) => cb({ token: data.session?.access_token })),
    });
    let connectedOnce = false;
    socket.on('connect', () => {
      if (connectedOnce) void queryClient.invalidateQueries({ queryKey: ['live', 'board'] });
      connectedOnce = true;
    });
    socket.on('attendance.updated', (day: Day) => {
      patchBoards((b) => applyDay(b, day));
      void stale('attendance');
    });
    socket.on('punch.created', (p: Punch) => {
      patchBoards((b) => applyPunch(b, p));
      void stale('punches');
    });
    socket.on('device.status', (d) => {
      patchBoards((b) => applyDevice(b, d));
      void stale('terminals');
    });
    socket.on('report.ready', ({ jobId }: { jobId: string }) => {
      void queryClient.invalidateQueries({ queryKey: ['reports', 'exports'] });
      if (awaitingDownload.delete(jobId)) void downloadExport(jobId);
      else toast.success('Report ready', 'Download it from Reports → Export history');
    });
    socket.on('report.failed', ({ jobId }: { jobId: string }) => {
      awaitingDownload.delete(jobId);
      void queryClient.invalidateQueries({ queryKey: ['reports', 'exports'] });
      toast.error('Report failed', 'Try again, or narrow the filters');
    });
    socket.on('approval.pending', ({ type }: { type: string }) => {
      void queryClient.invalidateQueries({ queryKey: [type === 'leave' ? 'leave' : type === 'remote' ? 'remote-work' : 'attendance'] });
      toast.info('New request to review', `A ${type} request is waiting for you`);
    });
    return () => void socket.disconnect();
  }, [enabled]);
}

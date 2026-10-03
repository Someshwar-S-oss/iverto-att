import { AppShell, Kbd, type NavGroup } from '@iverto-org/core-ui';
import {
  Activity, BarChart3, CalendarDays, CalendarRange, ClipboardCheck, Clock, Cpu, Home, LogOut, Plane, ScanFace, Search,
  Settings, Sun, TableProperties, Users, Building2, ArrowLeftRight, Repeat,
} from 'lucide-react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { isHr, isManager, useAuth, useMe } from '../lib/auth';
import { clearCache } from '../lib/api';
import { ROLE_LABEL } from '../lib/format';
import { useLiveSocket } from '../lib/live';
import { CommandPalette, SHORTCUT, useCommandPalette } from './CommandPalette';

const icon = (I: typeof Home) => <I size={19} />;
/** Fake href for the Search nav row; never a real route. */
const SEARCH = '#search';

export function Layout() {
  const me = useMe();
  const { signOut, override, setOverride } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useLiveSocket(true);
  const [searching, setSearching] = useCommandPalette();

  const mgr = isManager(me);
  const hr = isHr(me);
  const groups: NavGroup[] = [
    {
      label: 'Attendance',
      items: [
        ...(mgr ? [{ label: 'Live board', hint: 'Who is in right now', icon: icon(Activity), href: '/live' }] : []),
        { label: 'Daily status', hint: 'Attendance by day', icon: icon(CalendarDays), href: '/attendance/daily' },
        { label: 'Daily logs', hint: 'Every punch', icon: icon(Clock), href: '/attendance/logs' },
        ...(mgr ? [{ label: 'Overview', hint: 'Month & muster roll', icon: icon(TableProperties), href: '/attendance/overview' }] : []),
        { label: 'Corrections', hint: 'Missed punches', icon: icon(ClipboardCheck), href: '/attendance/corrections' },
      ],
    },
    {
      label: 'Time off',
      items: [
        { label: 'Leave', hint: 'Requests & balances', icon: icon(Plane), href: '/leave/requests' },
        { label: 'Remote work', hint: 'Working away from site', icon: icon(Home), href: '/remote-work' },
      ],
    },
    ...(mgr
      ? [{
          label: 'Planning',
          items: [
            { label: 'Roster', hint: 'Who works when', icon: icon(CalendarRange), href: '/schedule/roster' },
            ...(hr
              ? [
                  { label: 'Shifts', hint: 'Shift definitions', icon: icon(Sun), href: '/schedule/shifts' },
                  { label: 'Patterns', hint: 'Rotations', icon: icon(Repeat), href: '/schedule/patterns' },
                  { label: 'Holidays', hint: 'Holiday calendars', icon: icon(CalendarDays), href: '/schedule/holidays' },
                ]
              : []),
          ],
        }]
      : []),
    {
      label: 'Organisation',
      items: [
        ...(mgr ? [{ label: 'Employees', hint: 'Directory & profiles', icon: icon(Users), href: '/employees' }] : []),
        ...(hr
          ? [
              { label: 'Terminals', hint: 'M50 devices', icon: icon(Cpu), href: '/terminals' },
              { label: 'Face enrolment', hint: 'Who can scan where', icon: icon(ScanFace), href: '/enrollment' },
            ]
          : []),
        { label: 'Reports', hint: 'Exports & schedules', icon: icon(BarChart3), href: '/reports' },
        { label: 'Settings', icon: icon(Settings), href: '/settings' },
      ],
    },
  ];

  const leaveTenant = () => {
    setOverride(null);
    clearCache();
    navigate('/platform');
  };

  return (
    <AppShell
      navGroups={[{ label: '', items: [{ label: 'Search', icon: icon(Search), href: SEARCH, badge: <Kbd>{SHORTCUT}</Kbd> }] }, ...groups]}
      activeHref={pathname}
      onNavigate={(item, e) => {
        e.preventDefault();
        if (item.href === SEARCH) setSearching(true);
        else navigate(item.href);
      }}
      user={{ name: me.name, role: ROLE_LABEL[me.role] }}
      banner={
        override ? (
          <div className="flex items-center justify-center gap-3 bg-warning-soft px-4 py-2 text-sm text-warning-fg">
            <Building2 size={16} /> Acting inside a tenant as platform admin — every request is audited.
            <button className="font-semibold underline" onClick={leaveTenant}>Back to platform</button>
          </div>
        ) : undefined
      }
      accountActions={[
        { label: 'Settings', icon: <Settings size={16} />, onSelect: () => navigate('/settings') },
        ...(me.isSuperAdmin && override ? [{ label: 'Back to platform', icon: <ArrowLeftRight size={16} />, onSelect: leaveTenant }] : []),
        { label: 'Sign out', icon: <LogOut size={16} />, onSelect: () => void signOut(), tone: 'danger' as const },
      ]}
    >
      <Outlet />
      <CommandPalette open={searching} onClose={() => setSearching(false)} navGroups={groups} />
    </AppShell>
  );
}

export function PlatformLayout() {
  const me = useMe();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <AppShell
      navGroups={[{ label: 'Platform', items: [{ label: 'Tenants', hint: 'Organisations', icon: icon(Building2), href: '/platform' }] }]}
      activeHref={pathname}
      onNavigate={(item, e) => {
        e.preventDefault();
        navigate(item.href);
      }}
      user={{ name: me.name, role: ROLE_LABEL.PLATFORM_ADMIN }}
      accountActions={[{ label: 'Sign out', icon: <LogOut size={16} />, onSelect: () => void signOut(), tone: 'danger' }]}
    >
      <Outlet />
    </AppShell>
  );
}

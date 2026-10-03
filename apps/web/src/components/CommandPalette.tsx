import { Avatar, Kbd, Overlay, Spinner, type NavGroup } from '@iverto-org/core-ui';
import { ArrowRight, CornerDownLeft, KeyRound, Layers, MapPin, Palette, Plane, Search, Upload, UserPlus, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useApi, useSites, type EmployeeLite, type Page } from '../lib/api';
import { isHr, isManager, useMe } from '../lib/auth';

interface Item { id: string; group: string; label: string; hint?: string; icon: ReactNode; href: string; keywords?: string }

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const SHORTCUT = isMac ? '⌘K' : 'Ctrl K';

/** Opens on ⌘K / Ctrl+K from anywhere (and from the header button). */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [open, setOpen] as const;
}

/** "Rao" in "Asha Rao" → Asha <mark>Rao</mark>. */
function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark className="rounded bg-brand-soft px-0.5 text-brand">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

/** Debounced copy of a value. */
function useSettled<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Global search: pages, quick actions, people and locations, all from the keyboard. */
export function CommandPalette({ open, onClose, navGroups }: { open: boolean; onClose: () => void; navGroups: NavGroup[] }) {
  const me = useMe();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const term = q.trim();
  const settled = useSettled(term, 150);
  const hr = isHr(me);
  const people = useApi<Page<EmployeeLite & { designation?: string | null; site?: { name: string } }>>(
    open && isManager(me) && settled.length >= 2 ? '/employees' : null, { q: settled, size: 6 }, { staleTime: 30_000 });
  const sites = useSites().data ?? [];

  useEffect(() => { if (open) { setQ(''); setAt(0); } }, [open]);

  const items = useMemo(() => {
    const t = term.toLowerCase();
    const match = (i: Item) => !t || [i.label, i.hint, i.keywords, i.group].some((s) => s?.toLowerCase().includes(t));
    const rank = (i: Item) => (i.label.toLowerCase().startsWith(t) ? 0 : i.label.toLowerCase().includes(t) ? 1 : 2);
    const pages: Item[] = navGroups.flatMap((g) => g.items.map((n) => ({ id: `page:${n.href}`, group: 'Go to', label: n.label, hint: n.hint ?? g.label, icon: n.icon, href: n.href, keywords: g.label })));
    const extra: Item[] = [
      { id: 'act:leave', group: 'Actions', label: 'Apply for leave', hint: 'Leave requests', icon: <Plane size={18} />, href: '/leave/requests?apply=1', keywords: 'time off vacation holiday request' },
      ...(hr ? [
        { id: 'act:add', group: 'Actions', label: 'Add employee', hint: 'Employees', icon: <UserPlus size={18} />, href: '/employees?add=1', keywords: 'new hire onboard' },
        { id: 'act:import', group: 'Actions', label: 'Import employees from CSV', hint: 'Employees', icon: <Upload size={18} />, href: '/employees?import=1', keywords: 'bulk upload directory spreadsheet excel' },
        { id: 'set:sites', group: 'Settings', label: 'Office locations', hint: 'Sites, timezones, holiday calendars', icon: <MapPin size={18} />, href: '/settings/sites', keywords: 'site branch office' },
        { id: 'set:depts', group: 'Settings', label: 'Departments', hint: 'Settings', icon: <Layers size={18} />, href: '/settings/departments' },
        { id: 'set:users', group: 'Settings', label: 'Users & roles', hint: 'Settings', icon: <Users size={18} />, href: '/settings/users', keywords: 'login access admin' },
      ] : []),
      { id: 'set:password', group: 'Settings', label: 'Change password', hint: 'Settings', icon: <KeyRound size={18} />, href: '/settings/password' },
      { id: 'set:appearance', group: 'Settings', label: 'Appearance', hint: 'Light, dark, system', icon: <Palette size={18} />, href: '/settings/appearance', keywords: 'theme dark mode' },
    ];
    const statics = [...pages, ...extra].filter(match).sort((a, b) => (t ? rank(a) - rank(b) : 0));
    const locs: Item[] = hr && t ? sites.filter((s) => s.name.toLowerCase().includes(t)).slice(0, 4).map((s) => ({
      id: `site:${s.id}`, group: 'Locations', label: s.name, hint: s.timezone, icon: <MapPin size={18} />, href: '/settings/sites',
    })) : [];
    const ppl: Item[] = settled === term ? (people.data?.items ?? []).map((e) => ({
      id: `emp:${e.id}`, group: 'People', label: e.fullName, hint: [e.employeeCode, e.designation, e.site?.name].filter(Boolean).join(' · '),
      icon: <Avatar name={e.fullName} size="sm" tone="soft" />, href: `/employees/${e.id}`,
    })) : [];
    // People first when searching: names are what you type most.
    return t ? [...ppl, ...statics.slice(0, 8), ...locs] : statics;
  }, [term, settled, navGroups, hr, people.data, sites]);

  useEffect(() => setAt(0), [term]);
  useEffect(() => { listRef.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' }); }, [at]);

  if (!open) return null;
  const go = (i: Item | undefined) => { if (!i) return; onClose(); navigate(i.href); };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[at]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  const loading = people.isFetching || (term.length >= 2 && settled !== term && isManager(me));

  let last = '';
  return (
    <Overlay tier="modal" className="flex items-start justify-center bg-backdrop px-4 pt-[10vh] backdrop-blur-sm animate-overlay-in" onBackdropClick={onClose} role="dialog" aria-modal aria-label="Search">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-glass-border bg-surface-raised shadow-lift animate-scale-in">
        <div className="flex items-center gap-3 border-b border-line-soft px-5">
          <Search size={20} className="shrink-0 text-brand" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} role="combobox" aria-expanded aria-controls="palette-list"
            aria-activedescendant={items[at] ? `palette-${at}` : undefined}
            placeholder={isManager(me) ? 'Search people, pages and actions…' : 'Search pages and actions…'}
            className="h-16 w-full bg-transparent text-lg text-fg outline-none placeholder:text-fg-subtle" />
          {loading ? <Spinner size="sm" /> : <Kbd>Esc</Kbd>}
        </div>
        <div ref={listRef} id="palette-list" role="listbox" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
          {!items.length && (
            <div className="px-4 py-12 text-center">
              <p className="font-semibold text-fg">{loading ? 'Searching…' : `Nothing matches “${term}”`}</p>
              {!loading && <p className="mt-1 text-sm text-fg-muted">Try a name, an employee code or a page like “roster”.</p>}
            </div>
          )}
          {items.map((i, n) => {
            const header = i.group !== last ? (last = i.group) : null;
            return (
              <div key={i.id}>
                {header && <p className="px-3 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{header}</p>}
                <div id={`palette-${n}`} data-index={n} role="option" aria-selected={n === at} onMouseMove={() => setAt(n)} onClick={() => go(i)}
                  className={`flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors ${n === at ? 'bg-brand-soft' : ''}`}>
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${n === at ? 'bg-surface-raised text-brand shadow-soft' : 'bg-surface-subtle text-fg-muted'}`}>{i.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-fg"><Highlight text={i.label} q={term} /></p>
                    {i.hint && <p className="truncate text-xs text-fg-muted">{i.hint}</p>}
                  </div>
                  {n === at ? <CornerDownLeft size={16} className="shrink-0 text-brand" /> : <ArrowRight size={16} className="shrink-0 text-fg-subtle opacity-0" />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-line-soft bg-surface-subtle px-5 py-2.5 text-xs text-fg-muted">
          <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> open</span>
          <span className="flex items-center gap-1.5"><Kbd>Esc</Kbd> close</span>
          <span className="ml-auto flex items-center gap-1.5"><Kbd>{SHORTCUT}</Kbd> anywhere</span>
        </div>
      </div>
    </Overlay>
  );
}

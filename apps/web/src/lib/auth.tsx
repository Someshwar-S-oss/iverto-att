import { createClient, type Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

// Supabase is used for the session only (§15); all data goes through the API.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy apps/web/.env.example to apps/web/.env and fill them in, then restart the dev server.',
  );
}
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Role = 'ADMIN' | 'HR' | 'MANAGER' | 'EMPLOYEE' | 'PLATFORM_ADMIN';

/** The caller, read from the JWT's app_metadata — the same claims the API trusts (§13). */
export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string;
  employeeId: string | null;
  siteIds: string[];
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
}

function meOf(session: Session): Me {
  const app = session.user.app_metadata ?? {};
  const isSuperAdmin = app.is_super_admin === true;
  return {
    id: session.user.id,
    email: session.user.email ?? '',
    name: session.user.user_metadata?.display_name ?? session.user.user_metadata?.full_name ?? session.user.email ?? '',
    role: isSuperAdmin ? 'PLATFORM_ADMIN' : (app.role ?? 'EMPLOYEE'),
    tenantId: app.tenant_id ?? '',
    employeeId: app.employee_id ?? null,
    siteIds: Array.isArray(app.site_ids) ? app.site_ids : [],
    isSuperAdmin,
    mustChangePassword: app.must_change_password === true,
  };
}

// Platform admins act inside a tenant with the audited X-Tenant-Id header (§13.1). Per tab, never persisted.
const OVERRIDE_KEY = 'iverto-tenant-override';
export const tenantOverride = () => sessionStorage.getItem(OVERRIDE_KEY);

interface AuthState {
  session: Session | null | undefined; // undefined = still loading
  me: Me | null;
  override: string | null;
  suspended: boolean;
  setOverride: (tenantId: string | null) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children, onSignOut }: { children: ReactNode; onSignOut: () => void }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [override, setOverrideState] = useState(tenantOverride);
  const [suspended, setSuspended] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    // The API client reports auth-level error codes here (see lib/api.ts).
    const onProblem = (e: Event) => {
      const code = (e as CustomEvent<string>).detail;
      if (code === 'UNAUTHORIZED') void supabase.auth.signOut();
      if (code === 'TENANT_SUSPENDED') setSuspended(true);
      if (code === 'PASSWORD_CHANGE_REQUIRED') void supabase.auth.refreshSession();
    };
    window.addEventListener('iverto:auth', onProblem);
    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener('iverto:auth', onProblem);
    };
  }, []);

  const value: AuthState = {
    session,
    me: session ? meOf(session) : null,
    override,
    suspended,
    setOverride: (id) => {
      if (id) sessionStorage.setItem(OVERRIDE_KEY, id);
      else sessionStorage.removeItem(OVERRIDE_KEY);
      setOverrideState(id);
    },
    signOut: async () => {
      sessionStorage.removeItem(OVERRIDE_KEY);
      setOverrideState(null);
      setSuspended(false);
      onSignOut();
      await supabase.auth.signOut();
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** The signed-in user; only call inside the authenticated app. */
export function useMe(): Me {
  const { me, override } = useAuth();
  // A platform admin inside a tenant acts as ADMIN there, as the API does.
  return override && me ? { ...me, role: 'ADMIN', tenantId: override } : me!;
}

export const isHr = (me: Me) => me.role === 'ADMIN' || me.role === 'HR';
export const isManager = (me: Me) => isHr(me) || me.role === 'MANAGER';

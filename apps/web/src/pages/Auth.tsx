import { AuthHighlights, AuthShell, Button, Callout, IconButton, PasswordStrength, TextField } from '@iverto-org/core-ui';
import { Activity, CalendarRange, Eye, EyeOff, Lock, Mail, ScanFace } from 'lucide-react';
import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { changeOwnPassword } from '../lib/api';
import { supabase, useAuth } from '../lib/auth';

/** Password input with a show/hide toggle and a caps-lock warning. */
function PasswordField({ label, autoComplete, value, onChange, minLength, leadingIcon }: {
  label: string; autoComplete: string; value: string; onChange: (v: string) => void; minLength?: number; leadingIcon?: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') ?? false);
  return (
    <TextField label={label} type={shown ? 'text' : 'password'} autoComplete={autoComplete} required minLength={minLength} leadingIcon={leadingIcon}
      value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onKeyUp={onKey} hint={caps ? 'Caps Lock is on' : undefined}
      trailing={<IconButton label={shown ? 'Hide password' : 'Show password'} icon={shown ? <EyeOff size={16} /> : <Eye size={16} />} onClick={() => setShown(!shown)} />} />
  );
}

const HIGHLIGHTS = [
  { icon: ScanFace, title: 'Face-recognition terminals', body: 'Every scan lands in seconds — no cards, no buddy punching.' },
  { icon: Activity, title: 'Live board', body: 'See who is in, late, on break or remote, right now, across every site.' },
  { icon: CalendarRange, title: 'Shifts, leave & holidays', body: 'Rosters, location holiday calendars and leave balances that add up on their own.' },
];

/** Email + password straight to Supabase; the tenant comes from the account, so there is no tenant picker (§13.2). */
export function Login() {
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (session) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'That email and password don’t match. Ask HR to reset your password if you’ve forgotten it.' : error.message);
  };

  return (
    <AuthShell
      aside={<AuthHighlights headline="Attendance that" accent="runs itself." lede="Iverto Attendance turns terminal scans, schedules and leave into payroll-ready days — automatically." highlights={HIGHLIGHTS} />}
      footer={<p className="mt-6 text-xs text-fg-subtle">© {new Date().getFullYear()} Iverto AI · Iverto Attendance</p>}>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-fg">Welcome back</h1>
          <p className="text-sm text-fg-muted">Sign in with the email your HR team set up for you.</p>
        </div>
        {error && <Callout tone="danger" title="Couldn’t sign you in">{error}</Callout>}
        <TextField label="Email" type="email" autoComplete="username" autoFocus required placeholder="you@company.com" leadingIcon={<Mail size={18} />} value={email} onChange={(e) => setEmail(e.target.value)} />
        <PasswordField label="Password" autoComplete="current-password" leadingIcon={<Lock size={18} />} value={password} onChange={setPassword} />
        <Button type="submit" fullWidth loading={busy}>Sign in</Button>
        <p className="text-center text-xs text-fg-subtle">Forgot your password? HR can issue you a new temporary one.</p>
      </form>
    </AuthShell>
  );
}

/** First login: the API refuses everything but this until the temporary password is replaced (§13). */
export function SetPassword() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('The two new passwords don’t match.');
    setBusy(true);
    setError('');
    try {
      await changeOwnPassword(me!.email, current, next);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-fg">Set a new password</h1>
          <p className="text-sm text-fg-muted">Replace the temporary password HR gave you. You’ll stay signed in.</p>
        </div>
        {error && <Callout tone="danger" title="Password not changed">{error}</Callout>}
        <PasswordField label="Temporary password" autoComplete="current-password" value={current} onChange={setCurrent} />
        <PasswordField label="New password" autoComplete="new-password" minLength={10} value={next} onChange={setNext} />
        <PasswordStrength password={next} email={me?.email} />
        <PasswordField label="Confirm new password" autoComplete="new-password" minLength={10} value={confirm} onChange={setConfirm} />
        <Button type="submit" fullWidth loading={busy}>Save and continue</Button>
        <Button variant="ghost" fullWidth onClick={() => void signOut()}>Sign out</Button>
      </form>
    </AuthShell>
  );
}

export function Suspended() {
  const { signOut } = useAuth();
  return (
    <AuthShell>
      <div className="space-y-5">
        <Callout tone="warning" title="Your organisation’s account is paused">
          Nothing is lost — terminals keep recording scans and everything syncs when the account is reactivated. Contact your administrator or Iverto support.
        </Callout>
        <Button variant="secondary" fullWidth onClick={() => void signOut()}>Sign out</Button>
      </div>
    </AuthShell>
  );
}

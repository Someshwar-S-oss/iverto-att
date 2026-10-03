import './index.css';
import { CenteredSpinner, ConfirmHost, ReasonDialogHost, ThemeProvider, Toaster } from '@iverto-org/core-ui';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { Layout, PlatformLayout } from './components/Layout';
import { CACHE_MAX_AGE, clearCache, persister, queryClient } from './lib/api';
import { AuthProvider, isManager, useAuth, useMe } from './lib/auth';
import { Login, SetPassword, Suspended } from './pages/Auth';
import { Corrections, Daily, Logs, Overview } from './pages/Attendance';
import { EmployeeDetail, Employees } from './pages/Employees';
import { Leave, RemoteWork } from './pages/Leave';
import { Live } from './pages/Live';
import { TenantDetail, Tenants } from './pages/Platform';
import { Reports } from './pages/Reports';
import { Holidays } from './pages/Holidays';
import { Patterns, Roster, Shifts } from './pages/Schedule';
import { Settings } from './pages/Settings';
import { Enrollment, Terminals } from './pages/Terminals';

/** Signed in → the persisted cache for *this* user (and tenant, for platform admins) is restored. */
function RequireAuth() {
  const { session, me, override, suspended } = useAuth();
  const { pathname } = useLocation();
  if (session === undefined) return <CenteredSpinner />;
  if (!session || !me) return <Navigate to="/login" replace />;
  if (me.mustChangePassword) return pathname === '/set-password' ? <SetPassword /> : <Navigate to="/set-password" replace />;
  if (suspended) return <Suspended />;
  if (me.isSuperAdmin && !override && !pathname.startsWith('/platform')) return <Navigate to="/platform" replace />;
  return (
    <PersistQueryClientProvider key={`${me.id}:${override ?? ''}`} client={queryClient}
      persistOptions={{ persister, maxAge: CACHE_MAX_AGE, buster: `${me.id}:${override ?? ''}` }}>
      <Outlet />
    </PersistQueryClientProvider>
  );
}

function Home() {
  return <Navigate to={isManager(useMe()) ? '/live' : '/attendance/daily'} replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/set-password', element: <SetPassword /> },
      { path: '/platform', element: <PlatformLayout />, children: [{ index: true, element: <Tenants /> }, { path: ':id', element: <TenantDetail /> }] },
      {
        element: <Layout />,
        children: [
          { index: true, element: <Home /> },
          { path: 'live', element: <Live /> },
          { path: 'attendance/daily', element: <Daily /> },
          { path: 'attendance/logs', element: <Logs /> },
          { path: 'attendance/overview', element: <Overview /> },
          { path: 'attendance/corrections', element: <Corrections /> },
          { path: 'employees', element: <Employees /> },
          { path: 'employees/:id', element: <EmployeeDetail /> },
          { path: 'schedule/shifts', element: <Shifts /> },
          { path: 'schedule/patterns', element: <Patterns /> },
          { path: 'schedule/roster', element: <Roster /> },
          { path: 'schedule/holidays', element: <Holidays /> },
          { path: 'leave/:tab', element: <Leave /> },
          { path: 'leave', element: <Navigate to="/leave/requests" replace /> },
          { path: 'remote-work', element: <RemoteWork /> },
          { path: 'reports', element: <Reports /> },
          { path: 'terminals', element: <Terminals /> },
          { path: 'enrollment', element: <Enrollment /> },
          { path: 'settings/:section?', element: <Settings /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultPreference="light">
      <AuthProvider onSignOut={clearCache}>
        <RouterProvider router={router} />
      </AuthProvider>
      <Toaster />
      <ConfirmHost />
      <ReasonDialogHost />
    </ThemeProvider>
  </StrictMode>,
);

-- Row-level security: defence in depth behind app-level scoping (D3).
--
-- The API sets these transaction-local GUCs before every query (PrismaService):
--   app.current_tenant_id  tenant of the caller
--   app.current_site_ids   comma-separated site restriction; '' = all sites
--   app.is_super_admin     'true' for platform admins and background jobs
--
-- The app must connect as a role WITHOUT BYPASSRLS; migrations run as one with it.
-- With no GUCs set, every policy denies — background work that forgets its
-- context fails closed instead of reading across tenants.

CREATE OR REPLACE FUNCTION public.rls_is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.is_super_admin', true), '') = 'true'
$$;

CREATE OR REPLACE FUNCTION public.rls_tenant_allowed(p_tenant_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT public.rls_is_system()
      OR p_tenant_id = nullif(current_setting('app.current_tenant_id', true), '')
$$;

CREATE OR REPLACE FUNCTION public.rls_site_allowed(p_site_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT public.rls_is_system()
      OR coalesce(current_setting('app.current_site_ids', true), '') = ''
      OR p_site_id = ANY (string_to_array(current_setting('app.current_site_ids', true), ','))
$$;

DO $$
DECLARE
  t text;
BEGIN
  -- Tenant isolation on every tenant-owned table.
  FOREACH t IN ARRAY ARRAY[
    'sites','departments','projects','employee_projects','holiday_calendars','holidays',
    'attendance_policies','user_profiles','employees','devices','terminal_users',
    'terminal_face_templates','punches','attendance_days','attendance_corrections','shifts',
    'shift_patterns','employee_schedules','roster_overrides','leave_types','leave_ledger',
    'leave_requests','remote_work_requests','report_jobs','report_schedules','push_devices',
    'app_notifications'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY rls_tenant_isolation ON public.%I USING (public.rls_tenant_allowed(tenant_id)) WITH CHECK (public.rls_tenant_allowed(tenant_id))',
      t);
  END LOOP;

  -- Site scoping narrows further. RESTRICTIVE so it is ANDed with tenant isolation
  -- (two permissive policies would be ORed).
  FOREACH t IN ARRAY ARRAY['employees','devices','punches','attendance_days'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS rls_site_scope ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY rls_site_scope ON public.%I AS RESTRICTIVE USING (public.rls_site_allowed(site_id)) WITH CHECK (public.rls_site_allowed(site_id))',
      t);
  END LOOP;
END $$;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation ON public.tenants;
CREATE POLICY rls_tenant_isolation ON public.tenants
  USING (public.rls_tenant_allowed(id)) WITH CHECK (public.rls_is_system());

-- Audit: INSERT and SELECT only; the trigger in 002 rejects UPDATE/DELETE even for owners.
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_audit_select ON public.audit_logs;
DROP POLICY IF EXISTS rls_audit_insert ON public.audit_logs;
CREATE POLICY rls_audit_select ON public.audit_logs FOR SELECT USING (public.rls_tenant_allowed(tenant_id));
CREATE POLICY rls_audit_insert ON public.audit_logs FOR INSERT WITH CHECK (public.rls_tenant_allowed(tenant_id));

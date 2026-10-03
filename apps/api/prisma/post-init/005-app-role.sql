-- Privileges for the runtime role (no BYPASSRLS, so 003's policies apply).
-- Create it once per environment:  CREATE ROLE app_user LOGIN PASSWORD '…' NOBYPASSRLS;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;
    REVOKE UPDATE, DELETE ON audit_logs FROM app_user;
  END IF;
END $$;

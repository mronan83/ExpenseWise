-- Supabase hardening (ADR-0013). Supabase's Data API (PostgREST) connects as anon,
-- authenticated and service_role, and Supabase's default privileges grant those roles every
-- new table, sequence and function in public. ExpenseWise serves data only through its own
-- API as expensewise_app, so these roles get nothing here: a leaked publishable or secret key
-- must not reach tenant data. On plain Postgres the roles don't exist and this is a no-op.
DO $$
DECLARE
  data_api_role text;
BEGIN
  FOREACH data_api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = data_api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', data_api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', data_api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', data_api_role);
      -- Stop future objects created by the migrating role from being granted to them again.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', data_api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', data_api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', data_api_role);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

-- Functions are executable by PUBLIC by default. Grant them only to the roles that need them.
REVOKE EXECUTE ON FUNCTION app_current_org(), reject_audit_mutation() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_org() TO expensewise_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

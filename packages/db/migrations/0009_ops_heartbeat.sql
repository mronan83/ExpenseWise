-- Heartbeat (ADR-0014). The nightly backup writes one row here, so the Free plan never sees
-- the project as idle for 7 days. It holds no tenant data and nothing the app reads: only
-- the schema owner, which runs migrations and the backup, can reach it. The Supabase Data API
-- exposes `public` alone, and these grants keep its roles out regardless.
CREATE SCHEMA IF NOT EXISTS ops;
--> statement-breakpoint
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ops.heartbeat (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  beat_at timestamptz NOT NULL,
  source text NOT NULL
);
--> statement-breakpoint
ALTER TABLE ops.heartbeat ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON ops.heartbeat FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'expensewise_app', 'expensewise_relay']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ops FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

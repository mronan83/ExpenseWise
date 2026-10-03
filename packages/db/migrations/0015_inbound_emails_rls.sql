-- Email-in (FR-CAP-02, ADR-0026). Hand-written (drizzle-kit --custom).

-- Tenant data under the same forced row-level security as every other tenant table. A row
-- is kept once per message and never removed by the app.
GRANT SELECT, INSERT ON inbound_emails TO expensewise_app;
--> statement-breakpoint
ALTER TABLE inbound_emails ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inbound_emails FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON inbound_emails
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- An email arrives before anyone knows which organization it belongs to: only its sender,
-- checked by DKIM, says that. This answers one question, which member signs in with this
-- address, and returns their ids and that sign-in's user, nothing else. The oldest sign-in
-- wins, as it does for the API.
CREATE FUNCTION member_for_sign_in_email(sender text)
  RETURNS TABLE (org_id uuid, member_id uuid, user_id text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.org_id, s.member_id, s.user_id
      FROM member_sign_ins s
     WHERE lower(s.email) = lower(sender)
     ORDER BY s.created_at, s.id
     LIMIT 1
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION member_for_sign_in_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION member_for_sign_in_email(text) TO expensewise_app;

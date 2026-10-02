-- Several sign-ins per member (ADR-0016). Hand-written (drizzle-kit --custom).

-- Every existing member keeps the sign-in it was created with. Runs before row-level security
-- is enabled; the migration role bypasses it either way (superuser locally, BYPASSRLS on
-- Supabase). Backfilled ids are random UUIDs rather than the application's UUIDv7.
-- A user with members in several organizations keeps the oldest, which is the one the API
-- already resolved them to.
INSERT INTO member_sign_ins (id, org_id, member_id, user_id, email, created_at)
  SELECT DISTINCT ON (m.user_id) gen_random_uuid(), m.org_id, m.id, m.user_id, m.email, m.created_at
    FROM members m
   ORDER BY m.user_id, m.created_at, m.id;
--> statement-breakpoint

-- Sign-ins are tenant data. They are added and removed, never edited.
GRANT SELECT, INSERT, DELETE ON member_sign_ins TO expensewise_app;
--> statement-breakpoint
ALTER TABLE member_sign_ins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_sign_ins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON member_sign_ins
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- Before an organization is chosen, the API finds the caller by their sign-in. This read-only
-- policy shows a user their own sign-in rows, and nothing else.
CREATE POLICY own_sign_ins ON member_sign_ins FOR SELECT
  USING (user_id = app_current_user());
--> statement-breakpoint

-- A user now sees the member rows they sign in as, rather than the rows whose first sign-in
-- they were. The subquery runs under member_sign_ins' own policies, which own_sign_ins
-- satisfies. Still read-only.
DROP POLICY own_memberships ON members;
--> statement-breakpoint
CREATE POLICY own_memberships ON members FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM member_sign_ins s
     WHERE s.org_id = members.org_id
       AND s.member_id = members.id
       AND s.user_id = app_current_user()
  ));

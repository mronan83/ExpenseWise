-- Members see and change only their own records (GAP-20, #50), and invite links (#29).
-- ADR-0035. Hand-written (drizzle-kit --custom). Safe to run again.
--
-- Tenant isolation (migration 0001) keeps each organization to its own rows. Inside one
-- organization, withOrg() may now also name the member a transaction acts for and their role
-- (app.member_id, app.member_role). With a member named:
--   reads   a member or approver sees only their own receipts, expenses, trips, reports and
--           emails, and what hangs off them; owners, finance admins and auditors see everyone's.
--   writes  everyone changes only their own, and an auditor changes nothing. A refused change
--           raises an error, so it rolls back the whole transaction with its audit event.
-- With no member named the transaction acts for the system, as workflows and the release do,
-- and sees and changes every member's records in its organization, as before.

-- The member and role the current transaction acts for, set by withOrg() from the caller's
-- membership. No setting means the system.
CREATE OR REPLACE FUNCTION app_current_member() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.member_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_member_role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.member_role', true), '') $$;
--> statement-breakpoint

-- Whether the transaction sees every member's records: the system, owners, finance admins and
-- auditors. A member named without a role is held to their own.
CREATE OR REPLACE FUNCTION app_sees_every_member() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT app_current_member() IS NULL
            OR coalesce(app_current_member_role() IN ('owner', 'finance_admin', 'auditor'), false) $$;
--> statement-breakpoint
-- Whether it may change a record of member `owner`: the system, or the owner themselves
-- unless they are an auditor. Never null, so a record of no visible member is refused.
CREATE OR REPLACE FUNCTION app_changes_member(owner uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT app_current_member() IS NULL
            OR coalesce(owner = app_current_member()
                        AND app_current_member_role() IS DISTINCT FROM 'auditor', false) $$;
--> statement-breakpoint

-- The member a row belongs to: its own member_id, or its receipt's or expense's. The lookup
-- runs under the caller's row-level security, so a parent they can't see has no owner.
CREATE OR REPLACE FUNCTION app_record_owner(kind text, org uuid, rec jsonb) RETURNS uuid
  LANGUAGE plpgsql STABLE
  AS $$
BEGIN
  IF kind = 'member' THEN
    RETURN (rec->>'member_id')::uuid;
  ELSIF kind = 'receipt' THEN
    RETURN (SELECT r.member_id FROM receipts r
             WHERE r.org_id = org AND r.id = (rec->>'receipt_id')::uuid);
  ELSIF kind = 'expense' THEN
    RETURN (SELECT e.member_id FROM expenses e
             WHERE e.org_id = org AND e.id = (rec->>'expense_id')::uuid);
  END IF;
  RAISE EXCEPTION 'app_record_owner: unknown kind %', kind;
END
$$;
--> statement-breakpoint

-- Refuses a change to a record that is not the acting member's own, before it happens. An
-- error rather than row-level security's silent skip: a refused update must not leave an
-- audit event saying it happened.
CREATE OR REPLACE FUNCTION enforce_own_records() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean := true;
BEGIN
  IF app_current_member() IS NOT NULL THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      allowed := app_changes_member(app_record_owner(TG_ARGV[0], OLD.org_id, to_jsonb(OLD)));
    END IF;
    IF allowed AND TG_OP IN ('INSERT', 'UPDATE') THEN
      allowed := app_changes_member(app_record_owner(TG_ARGV[0], NEW.org_id, to_jsonb(NEW)));
    END IF;
    IF NOT allowed THEN
      RAISE EXCEPTION 'own_records: as %, this member may not change that % row',
        coalesce(app_current_member_role(), 'member'), TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_current_member(), app_current_member_role(), app_sees_every_member(),
  app_changes_member(uuid), app_record_owner(text, uuid, jsonb), enforce_own_records()
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_member(), app_current_member_role(), app_sees_every_member(),
  app_changes_member(uuid), app_record_owner(text, uuid, jsonb)
  TO expensewise_app;
--> statement-breakpoint

-- Reads. Restrictive, so each is ANDed with tenant_isolation: a row must be in the
-- organization and be one the acting member may see.
DROP POLICY IF EXISTS own_records ON receipts;
--> statement-breakpoint
CREATE POLICY own_records ON receipts AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON expenses;
--> statement-breakpoint
CREATE POLICY own_records ON expenses AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON trips;
--> statement-breakpoint
CREATE POLICY own_records ON trips AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON reports;
--> statement-breakpoint
CREATE POLICY own_records ON reports AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON inbound_emails;
--> statement-breakpoint
CREATE POLICY own_records ON inbound_emails AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR member_id = app_current_member());
--> statement-breakpoint
-- What hangs off a receipt or an expense is seen with it. The subquery runs under that
-- table's own policies.
DROP POLICY IF EXISTS own_records ON extraction_runs;
--> statement-breakpoint
CREATE POLICY own_records ON extraction_runs AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM receipts r WHERE r.org_id = extraction_runs.org_id AND r.id = extraction_runs.receipt_id));
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON receipt_reviews;
--> statement-breakpoint
CREATE POLICY own_records ON receipt_reviews AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM receipts r WHERE r.org_id = receipt_reviews.org_id AND r.id = receipt_reviews.receipt_id));
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON receipt_duplicates;
--> statement-breakpoint
CREATE POLICY own_records ON receipt_duplicates AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM receipts r WHERE r.org_id = receipt_duplicates.org_id AND r.id = receipt_duplicates.receipt_id));
--> statement-breakpoint
DROP POLICY IF EXISTS own_records ON mileage_logs;
--> statement-breakpoint
CREATE POLICY own_records ON mileage_logs AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member() OR EXISTS (
    SELECT 1 FROM expenses e WHERE e.org_id = mileage_logs.org_id AND e.id = mileage_logs.expense_id));
--> statement-breakpoint
-- An approval step is seen by its approver and by whoever sees its report. Nothing writes
-- approval steps yet; approval (#24) decides who may.
DROP POLICY IF EXISTS own_records ON approval_steps;
--> statement-breakpoint
CREATE POLICY own_records ON approval_steps AS RESTRICTIVE FOR SELECT
  USING (app_sees_every_member()
         OR approver_member_id = app_current_member()
         OR EXISTS (SELECT 1 FROM reports r
                     WHERE r.org_id = approval_steps.org_id AND r.id = approval_steps.report_id));
--> statement-breakpoint

-- Writes.
DROP TRIGGER IF EXISTS own_records ON receipts;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON expenses;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON trips;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON trips
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON reports;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON reports
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON inbound_emails;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON inbound_emails
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON extraction_runs;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON extraction_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('receipt');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON receipt_reviews;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON receipt_reviews
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('receipt');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON receipt_duplicates;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON receipt_duplicates
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('receipt');
--> statement-breakpoint
DROP TRIGGER IF EXISTS own_records ON mileage_logs;
--> statement-breakpoint
CREATE TRIGGER own_records BEFORE INSERT OR UPDATE OR DELETE ON mileage_logs
  FOR EACH ROW EXECUTE FUNCTION enforce_own_records('expense');
--> statement-breakpoint

-- Invite links (#29). Tenant data like every other table; an invite is accepted or revoked,
-- never deleted.
GRANT SELECT, INSERT, UPDATE ON member_invites TO expensewise_app;
--> statement-breakpoint
ALTER TABLE member_invites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_invites FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON member_invites;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON member_invites
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
-- Whoever holds a link sees that one invite, before they belong to its organization: the API
-- sets app.invite_hash to the SHA-256 of the token it was given. Read-only, and nothing else.
CREATE OR REPLACE FUNCTION app_invite_hash() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.invite_hash', true), '') $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_invite_hash() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_invite_hash() TO expensewise_app;
--> statement-breakpoint
DROP POLICY IF EXISTS invite_holder ON member_invites;
--> statement-breakpoint
CREATE POLICY invite_holder ON member_invites FOR SELECT
  USING (token_hash = app_invite_hash());

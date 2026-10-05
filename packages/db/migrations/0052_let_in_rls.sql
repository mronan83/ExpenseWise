-- Only an email a person lets in signs in, once they have an authenticator (#90, Q44,
-- ADR-0044). Hand-written (drizzle-kit --custom). Safe to run again.
--
-- A person may sign in with several emails (ADR-0016), each its own Supabase Auth user with its
-- own password and authenticators, and Supabase lets an email with none add one on its password
-- alone (GAP-36). So, while their organization has the second factor on and they have an
-- authenticator, only an email they let in opens the app. let_in_sign_ins records which, beside
-- member_sign_ins: the first of their emails to pass its code, let in then; and each they let in
-- from an email let in that passed its code, waiting until it passes its own, or lapses.

-- Tenant data under the same forced row-level security as every other tenant table. An email is
-- let in, passes its code, and is withdrawn; the app changes nothing else of a row.
GRANT SELECT, INSERT, DELETE ON let_in_sign_ins TO expensewise_app;
--> statement-breakpoint
GRANT UPDATE (passed_at, lapses_at) ON let_in_sign_ins TO expensewise_app;
--> statement-breakpoint
ALTER TABLE let_in_sign_ins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE let_in_sign_ins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON let_in_sign_ins;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON let_in_sign_ins
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- Whether a sign-in is let in, as the API asks beside sign_in_has_authenticator() in the query
-- that finds each request's caller: 'yes', let in and past its own code; 'waiting', let in from
-- another of the person's emails until it passes its own code or the time runs out; 'no',
-- lapsed included. Nothing else. It runs as its owner because, before an organization is
-- chosen, the app sees only the token's own sign-in and no let-in row; only the app may call it.
CREATE OR REPLACE FUNCTION sign_in_let_in(sign_in_user text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((
    SELECT CASE WHEN l.passed_at IS NOT NULL THEN 'yes' ELSE 'waiting' END
      FROM member_sign_ins s
      JOIN let_in_sign_ins l ON l.org_id = s.org_id AND l.sign_in_id = s.id
     WHERE s.user_id = sign_in_user
       AND (l.passed_at IS NOT NULL OR l.lapses_at > now())), 'no')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sign_in_let_in(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sign_in_let_in(text) TO expensewise_app;
--> statement-breakpoint

-- The emails the person a sign-in belongs to has let in: 'none'; 'without_authenticator', some,
-- none of which has a verified factor now; 'with_authenticator'. Supabase's record is read only
-- through sign_in_has_authenticator(), so removing an authenticator there takes effect on the
-- next request. Nothing else: not which email, how many, or any email. 'none' for a sign-in no
-- member has. Runs as its owner, as person_has_authenticator() does, for the same reason.
CREATE OR REPLACE FUNCTION person_let_in(sign_in_user text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
           WHEN count(*) = 0 THEN 'none'
           WHEN bool_or(sign_in_has_authenticator(theirs.user_id)) THEN 'with_authenticator'
           ELSE 'without_authenticator'
         END
    FROM member_sign_ins this
    JOIN member_sign_ins theirs
      ON theirs.org_id = this.org_id AND theirs.member_id = this.member_id
    JOIN let_in_sign_ins l ON l.org_id = theirs.org_id AND l.sign_in_id = theirs.id
   WHERE this.user_id = sign_in_user
     AND (l.passed_at IS NOT NULL OR l.lapses_at > now())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION person_let_in(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION person_let_in(text) TO expensewise_app;
--> statement-breakpoint

-- Who may change who is let in, held here as well as in the API, so no code path can forget
-- it: the person themselves, from a session of an email with a verified authenticator of its
-- own that passed the code (app.assurance_level 'aal2', which the API sets from the verified
-- token for that transaction only), never a password alone. The first of their emails to pass
-- its code lets itself in, past it, while none of theirs counts as let in; an email let in that
-- passed its code lets another in, to wait, or withdraws one, never itself; an email waiting
-- marks only itself passed, before it lapses. A lapsed one, which counts for nothing, may be
-- cleared. One change to a person's emails at a time, so two of them can't each be the first.
-- Only the app is held to it: the schema owner, as for the runbook's reset, and the cascade
-- when a sign-in is removed, act as the owner.
CREATE OR REPLACE FUNCTION enforce_let_in() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  changed let_in_sign_ins%ROWTYPE;
  person uuid;
  actor member_sign_ins%ROWTYPE;
  actor_passed boolean;
  why text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed := OLD;
  ELSE
    changed := NEW;
  END IF;
  IF current_user = 'expensewise_app' THEN
    SELECT s.member_id INTO person
      FROM member_sign_ins s
     WHERE s.org_id = changed.org_id AND s.id = changed.sign_in_id;
    SELECT * INTO actor
      FROM member_sign_ins s
     WHERE s.org_id = changed.org_id AND s.user_id = app_current_user();
    IF coalesce(current_setting('app.assurance_level', true), '') <> 'aal2' THEN
      why := 'it needs a session that passed the code';
    ELSIF actor.id IS NULL OR person IS NULL OR actor.member_id <> person THEN
      why := 'only the person themselves changes it';
    ELSIF NOT sign_in_has_authenticator(actor.user_id) THEN
      why := 'it needs an email with an authenticator of its own';
    END IF;
  END IF;
  IF current_user = 'expensewise_app' AND why IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('let_in:' || person::text, 0));
    SELECT EXISTS (
      SELECT 1 FROM let_in_sign_ins l
       WHERE l.org_id = actor.org_id AND l.sign_in_id = actor.id AND l.passed_at IS NOT NULL)
      INTO actor_passed;
    IF TG_OP = 'INSERT' THEN
      IF NEW.sign_in_id = actor.id THEN
        IF NEW.passed_at IS NULL OR EXISTS (
             SELECT 1
               FROM let_in_sign_ins l
               JOIN member_sign_ins s ON s.org_id = l.org_id AND s.id = l.sign_in_id
              WHERE s.org_id = actor.org_id AND s.member_id = person
                AND (l.passed_at IS NOT NULL OR l.lapses_at > now())) THEN
          why := 'an email lets itself in only as the first, past its code';
        END IF;
      ELSIF NOT actor_passed OR NEW.passed_at IS NOT NULL THEN
        why := 'only an email let in that passed its code lets another in, to pass its own';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.sign_in_id <> actor.id OR NEW.sign_in_id <> OLD.sign_in_id
         OR OLD.passed_at IS NOT NULL OR NEW.passed_at IS NULL
         OR NOT coalesce(OLD.lapses_at > now(), false) THEN
        why := 'an email waiting only marks itself passed, before it lapses';
      END IF;
    ELSIF (OLD.passed_at IS NOT NULL OR coalesce(OLD.lapses_at > now(), false))
          AND (OLD.sign_in_id = actor.id OR NOT actor_passed) THEN
      why := 'only an email let in that passed its code withdraws another';
    END IF;
  END IF;
  IF why IS NOT NULL THEN
    RAISE EXCEPTION 'let_in: %', why USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enforce_let_in() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS enforce_let_in ON let_in_sign_ins;
--> statement-breakpoint
CREATE TRIGGER enforce_let_in BEFORE INSERT OR UPDATE OR DELETE ON let_in_sign_ins
  FOR EACH ROW EXECUTE FUNCTION enforce_let_in();

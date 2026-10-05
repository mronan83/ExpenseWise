-- Only the email a person first signed in with is let in on its own (#91, Q45, ADR-0044).
-- Hand-written (drizzle-kit --custom). Safe to run again.
--
-- Since #90, while none of a person's emails is let in, the first of them to pass its code was let
-- in. Supabase Auth lets an email with no authenticator add one on its password alone, so whoever
-- held the password of another email linked to them could add theirs and be let in first
-- (GAP-37). Linking an email needs the passwords of both, and the code from someone with an
-- authenticator, so the email a person first signed in with is their own. It is the sign-in their
-- member was made with, members.user_id: on their first sign-in, or by accepting their invite.
-- Now only that email lets itself in, and any other waits to be let in from it.

-- The rules of 0052, and one more: an email lets itself in, as the first, only if it is the one
-- its person first signed in with. Otherwise unchanged.
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
        ELSIF NOT EXISTS (
             SELECT 1 FROM members m
              WHERE m.org_id = actor.org_id AND m.id = actor.member_id
                AND m.user_id = actor.user_id) THEN
          why := 'only the email the person first signed in with is let in first';
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

-- Which email a member first signed in with is set as the member is made and never changed by
-- the app, so no session, at aal1 or aal2, can make another email the one let in first. Only the
-- schema owner changes it, as the runbook's reset does for an email that can no longer be used.
CREATE OR REPLACE FUNCTION keep_first_sign_in() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user = 'expensewise_app' THEN
    RAISE EXCEPTION 'first_sign_in: only the schema owner changes which email a member first signed in with'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION keep_first_sign_in() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS keep_first_sign_in ON members;
--> statement-breakpoint
CREATE TRIGGER keep_first_sign_in BEFORE UPDATE OF user_id ON members
  FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION keep_first_sign_in();

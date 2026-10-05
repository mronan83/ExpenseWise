-- The second factor everywhere (#85, ADR-0044). Hand-written (drizzle-kit --custom). Safe to run
-- again.
--
-- Whether a sign-in (a Supabase Auth user: the access token's subject) has a verified second
-- factor, read from Supabase Auth's own record of factors at the moment it is asked: the same
-- fact that makes Supabase say its session's next level is aal2. One boolean for one user and
-- nothing else of Supabase's, no factor's id, name, type or secret. It runs as its owner, the
-- schema owner, which can read auth.mfa_factors on Supabase; the app holds no right on
-- Supabase's auth schema and never connects as its owner (ADR-0013).
--
-- On plain Postgres, as in the tests and local development, there is no Supabase Auth and so
-- no authenticator anyone could have added: it answers false. Neither is a user id that isn't
-- a UUID a Supabase Auth user. Nothing the app writes changes the answer, so a session that
-- skipped the code can't clear it, and removing an authenticator in Supabase, by its person or
-- by the owner for someone who lost theirs, takes effect on the next request.
CREATE OR REPLACE FUNCTION sign_in_has_authenticator(sign_in_user text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF sign_in_user IS NULL
     OR sign_in_user !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR to_regclass('auth.mfa_factors') IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM auth.mfa_factors f
     WHERE f.user_id = sign_in_user::uuid AND f.status::text = 'verified');
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sign_in_has_authenticator(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sign_in_has_authenticator(text) TO expensewise_app;
--> statement-breakpoint
-- On Supabase the schema owner must be able to read the factors, or the function above could
-- never answer and every request would fail. This fails the release here instead, before any
-- request does. Plain Postgres has no auth schema, and nothing to check.
DO $$
BEGIN
  IF to_regclass('auth.mfa_factors') IS NOT NULL THEN
    PERFORM 1 FROM auth.mfa_factors LIMIT 1;
  END IF;
END
$$;

-- A person's other emails, held until each adds its own authenticator (#88, Q43, ADR-0044).
-- Hand-written (drizzle-kit --custom). Safe to run again.
--
-- Whether the person a sign-in belongs to has a verified second factor on any of the emails
-- they sign in with: this sign-in, or another linked to the same member (ADR-0016). Asked
-- beside sign_in_has_authenticator() of the token's own sign-in, it tells the API that one of a
-- person's emails still needs its own: the person has one, this email hasn't. One boolean and
-- nothing else: not which email has it, how many there are, or any email or user id.
--
-- Supabase's record is read only through sign_in_has_authenticator(), so what counts as a
-- verified factor is decided in one place, and no right on Supabase's auth schema is added. It
-- runs as its owner because, before an organization is chosen, the app sees only the token's
-- own sign-in (own_sign_ins), not the member's others. A sign-in no member has has no person
-- here: false, as on plain Postgres, where no one has a factor. Removing an authenticator in
-- Supabase takes effect on the next request, so when a person's last one goes, their other
-- emails are free again at once; of ours it reads only which sign-ins a member has, which
-- only linking and unlinking change.
CREATE OR REPLACE FUNCTION person_has_authenticator(sign_in_user text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM member_sign_ins this
      JOIN member_sign_ins theirs
        ON theirs.org_id = this.org_id AND theirs.member_id = this.member_id
     WHERE this.user_id = sign_in_user
       AND sign_in_has_authenticator(theirs.user_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION person_has_authenticator(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION person_has_authenticator(text) TO expensewise_app;

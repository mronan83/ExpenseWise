-- Emails that filed nothing, shown in Needs you (#59, FR-CAP-02). Hand-written (drizzle-kit --custom).

-- Its member dismisses one from Needs you. The app may set when, and nothing else: the row is
-- otherwise as it arrived, and the own_records trigger lets only its member change it.
GRANT UPDATE (dismissed_at) ON inbound_emails TO expensewise_app;
--> statement-breakpoint

-- Dismissed once, for good: a dismissal is never cleared or moved.
CREATE OR REPLACE FUNCTION inbound_email_dismissed_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.dismissed_at IS NOT NULL AND NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at THEN
    RAISE EXCEPTION 'inbound_emails: email % was dismissed, and stays dismissed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION inbound_email_dismissed_once() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dismissed_once ON inbound_emails;
--> statement-breakpoint
CREATE TRIGGER dismissed_once BEFORE UPDATE OF dismissed_at ON inbound_emails
  FOR EACH ROW EXECUTE FUNCTION inbound_email_dismissed_once();

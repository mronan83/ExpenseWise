-- Role-level timeouts (ADR-0013). Supabase sets timeouts for its own API roles but not for
-- custom roles, which would otherwise only hit the platform's global cap. A runaway query or
-- a transaction left open by a crashed function must not hold connections behind the pooler.
ALTER ROLE expensewise_app SET statement_timeout = '15s';
--> statement-breakpoint
ALTER ROLE expensewise_app SET idle_in_transaction_session_timeout = '30s';
--> statement-breakpoint
ALTER ROLE expensewise_relay SET statement_timeout = '30s';
--> statement-breakpoint
ALTER ROLE expensewise_relay SET idle_in_transaction_session_timeout = '30s';

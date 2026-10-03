-- Receipt reviews (FR-INT-15, ADR-0021). Hand-written (drizzle-kit --custom).

-- Tenant data under the same forced row-level security as every other tenant table.
-- Append-only, like the audit trail it accompanies: a later confirmation adds a row.
GRANT SELECT, INSERT ON receipt_reviews TO expensewise_app;
--> statement-breakpoint
ALTER TABLE receipt_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE receipt_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON receipt_reviews
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

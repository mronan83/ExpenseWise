-- Categories and types an organization defines (FR-EXP-11, Q7, ADR-0036). Hand-written
-- (drizzle-kit --custom).

-- Tenant data under the same forced row-level security as every other tenant table. An unused
-- category or type can be deleted, and so can a category's allowance of a type; categories
-- already had these rights from 0001.
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_types, category_types TO expensewise_app;
--> statement-breakpoint
ALTER TABLE expense_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expense_types FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON expense_types
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE category_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE category_types FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON category_types
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- The ready-made set an organization starts with: five categories, nine types, and which types
-- each category allows. Its keys are what keyword suggestions look for (KEYWORD_RULES in
-- @expensewise/domain), so a renamed one keeps its suggestions. It seeds only an organization
-- that has no category or type yet, so calling it again adds nothing. It runs as the caller:
-- the app calls it inside withOrg() for a new organization, and row-level security keeps it to
-- that one. Seeded ids are random UUIDs rather than the application's UUIDv7, as in 0007.
CREATE OR REPLACE FUNCTION seed_starter_catalog(p_org_id uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM categories WHERE org_id = p_org_id)
     OR EXISTS (SELECT 1 FROM expense_types WHERE org_id = p_org_id) THEN
    RETURN;
  END IF;

  INSERT INTO categories (id, org_id, name, starter_key)
    SELECT gen_random_uuid(), p_org_id, c.name, c.key
      FROM (VALUES
        ('travel', 'Travel'),
        ('meals', 'Meals'),
        ('office', 'Office'),
        ('software', 'Software'),
        ('other', 'Other')
      ) AS c(key, name);

  INSERT INTO expense_types (id, org_id, name, starter_key)
    SELECT gen_random_uuid(), p_org_id, t.name, t.key
      FROM (VALUES
        ('airfare', 'Airfare'),
        ('lodging', 'Lodging'),
        ('ground_transport', 'Ground transport'),
        ('mileage', 'Mileage'),
        ('business_meal', 'Business meal'),
        ('per_diem_meal', 'Per-diem meal'),
        ('office_supplies', 'Office supplies'),
        ('software', 'Software'),
        ('other', 'Other')
      ) AS t(key, name);

  INSERT INTO category_types (id, org_id, category_id, type_id)
    SELECT gen_random_uuid(), p_org_id, c.id, t.id
      FROM (VALUES
        ('travel', 'airfare'),
        ('travel', 'lodging'),
        ('travel', 'ground_transport'),
        ('travel', 'mileage'),
        ('meals', 'business_meal'),
        ('meals', 'per_diem_meal'),
        ('office', 'office_supplies'),
        ('software', 'software'),
        ('other', 'other')
      ) AS a(category_key, type_key)
      JOIN categories c ON c.org_id = p_org_id AND c.starter_key = a.category_key
      JOIN expense_types t ON t.org_id = p_org_id AND t.starter_key = a.type_key;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION seed_starter_catalog(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION seed_starter_catalog(uuid) TO expensewise_app;
--> statement-breakpoint

-- Every organization that exists today starts from the same set; a new one gets it when it is
-- created (ensureOwnerOrganization). The migration role bypasses row-level security.
SELECT seed_starter_catalog(id) FROM organizations;

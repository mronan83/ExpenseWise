-- The time each receipt read before #32 first settled, from the audit trail: its first
-- receipt.read event, never earlier than its filing. Hand-written (drizzle-kit --custom). Safe to
-- run again: it fills only receipts with no time yet, as the schema owner, across organizations.
UPDATE receipts AS r
SET settled_at = greatest(s.first_read, r.created_at)
FROM (
  SELECT org_id, entity_id, min(occurred_at) AS first_read
  FROM audit_events
  WHERE entity_type = 'receipt' AND action = 'receipt.read'
  GROUP BY org_id, entity_id
) AS s
WHERE r.settled_at IS NULL AND s.org_id = r.org_id AND s.entity_id = r.id::text;

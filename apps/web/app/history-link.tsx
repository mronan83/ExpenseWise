'use client';

import Link from 'next/link';
import { recordName, trailHref, useAuditTrail } from '../lib/audit';

/**
 * Opens the audit trail at one record's history (FR-GOV-06). Shown only while the audit
 * trail is on and the caller is an owner, finance admin or auditor.
 */
export function HistoryLink({ entityType, entityId }: { entityType: string; entityId: string }) {
  const show = useAuditTrail();
  if (!show) return null;
  return (
    <Link
      href={trailHref(entityType, entityId)}
      aria-label={`History of this ${recordName(entityType).toLowerCase()}`}
      className="tap text-sm font-semibold text-carbon"
    >
      History
    </Link>
  );
}

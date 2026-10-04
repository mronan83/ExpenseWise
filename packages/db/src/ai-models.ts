import { asc, eq } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Transaction } from './client.ts';
import { orgAiModels } from './schema.ts';

/** One model, on or off, as the organization's owner or finance admin left it. */
export interface ModelSwitch {
  readonly model: string;
  readonly enabled: boolean;
}

/** The organization's saved choice of AI models (FR-INT-16). */
export interface StoredModelSettings {
  /** The model that reads every receipt; null when every model is off. */
  readonly primary: string | null;
  /** Each model saved, in the order back-ups are tried. */
  readonly models: readonly ModelSwitch[];
  readonly updatedAt: Date;
}

/**
 * The organization's choice of AI models, or undefined before anyone has saved one. Call
 * inside withOrg().
 */
export async function getModelSettings(tx: Transaction): Promise<StoredModelSettings | undefined> {
  const rows = await tx
    .select({
      model: orgAiModels.model,
      enabled: orgAiModels.enabled,
      isPrimary: orgAiModels.isPrimary,
      updatedAt: orgAiModels.updatedAt,
    })
    .from(orgAiModels)
    .orderBy(asc(orgAiModels.position), asc(orgAiModels.model));
  if (rows.length === 0) return undefined;
  return {
    primary: rows.find((r) => r.isPrimary)?.model ?? null,
    models: rows.map(({ model, enabled }) => ({ model, enabled })),
    updatedAt: new Date(Math.max(...rows.map((r) => r.updatedAt.getTime()))),
  };
}

const same = (
  a: Pick<StoredModelSettings, 'primary' | 'models'>,
  b: Pick<StoredModelSettings, 'primary' | 'models'>,
) =>
  a.primary === b.primary &&
  a.models.length === b.models.length &&
  a.models.every((m, i) => m.model === b.models[i]?.model && m.enabled === b.models[i]?.enabled);

const summary = (s: Pick<StoredModelSettings, 'primary' | 'models'>) => ({
  primary: s.primary,
  on: s.models.filter((m) => m.enabled).map((m) => m.model),
  off: s.models.filter((m) => !m.enabled).map((m) => m.model),
});

/**
 * Saves the organization's choice of AI models, with its audit event, and returns whether
 * anything changed; saving what is already saved records nothing. Which models exist, that
 * the primary is on, and who may choose are the caller's to check. Call inside withOrg().
 */
export async function saveModelSettings(
  tx: Transaction,
  orgId: string,
  settings: { readonly primary: string | null; readonly models: readonly ModelSwitch[] },
  memberId: string,
  actorUserId: string,
): Promise<'saved' | 'unchanged'> {
  // Locks the saved rows, so two saves at once apply one after the other.
  await tx.select({ id: orgAiModels.id }).from(orgAiModels).for('update');
  const before = await getModelSettings(tx);
  if (before && same(before, settings)) return 'unchanged';
  // One primary at most: clear it before the new one is set.
  await tx.update(orgAiModels).set({ isPrimary: false }).where(eq(orgAiModels.isPrimary, true));
  const now = new Date();
  for (const [position, { model, enabled }] of settings.models.entries()) {
    const values = {
      enabled,
      isPrimary: model === settings.primary,
      position,
      updatedByMemberId: memberId,
    };
    await tx
      .insert(orgAiModels)
      .values({ orgId, model, ...values })
      .onConflictDoUpdate({
        target: [orgAiModels.orgId, orgAiModels.model],
        set: { ...values, updatedAt: now },
      });
  }
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'ai_models',
    entityId: orgId,
    action: 'ai_models.changed',
    payload: { ...summary(settings), before: before ? summary(before) : null, memberId },
  });
  return 'saved';
}

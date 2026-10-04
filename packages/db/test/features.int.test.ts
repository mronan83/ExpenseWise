import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { listOrgFeatures, orgFeatureOn, setOrgFeature } from '../src/features.ts';
import { auditEvents, orgFeatures } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

describe('features an owner switches for their organization (Q5, NFR-DEL-05)', () => {
  it('is off until switched on, records each switch, and ignores a switch to what it is', async () => {
    const org = await seedOrg(app.db, 'features-switch');
    const inOrg = <T>(run: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, run);
    const flip = (enabled: boolean) =>
      inOrg((tx) =>
        setOrgFeature(
          tx,
          org.orgId,
          { flag: 'expenses.mileage', enabled, memberId: org.memberId },
          org.userId,
        ),
      );

    expect(await inOrg((tx) => orgFeatureOn(tx, org.orgId, 'expenses.mileage'))).toBe(false);
    expect(await flip(false)).toBe('unchanged');
    expect(await flip(true)).toBe('switched');
    expect(await flip(true)).toBe('unchanged');
    expect(await inOrg((tx) => orgFeatureOn(tx, org.orgId, 'expenses.mileage'))).toBe(true);
    expect(await flip(false)).toBe('switched');
    expect(await inOrg((tx) => listOrgFeatures(tx, org.orgId))).toMatchObject([
      { flag: 'expenses.mileage', enabled: false },
    ]);

    const events = await inOrg((tx) =>
      tx
        .select({ action: auditEvents.action, payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.entityType, 'feature')),
    );
    expect(events.map((e) => e.action)).toEqual(['feature.switched_on', 'feature.switched_off']);
  });

  it('keeps one organization’s switches from another, and refuses a malformed flag', async () => {
    const acme = await seedOrg(app.db, 'features-acme');
    const other = await seedOrg(app.db, 'features-other');
    await withOrg(app.db, acme.orgId, (tx) =>
      setOrgFeature(
        tx,
        acme.orgId,
        { flag: 'reports.export', enabled: true, memberId: acme.memberId },
        acme.userId,
      ),
    );
    expect(
      await withOrg(app.db, other.orgId, (tx) => orgFeatureOn(tx, other.orgId, 'reports.export')),
    ).toBe(false);
    expect(await withOrg(app.db, other.orgId, (tx) => tx.select().from(orgFeatures))).toEqual([]);
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.insert(orgFeatures).values({
          orgId: acme.orgId,
          flag: 'not a flag',
          enabled: true,
          updatedByMemberId: acme.memberId,
        }),
      ),
      /org_features_flag_format/,
    );
  });
});

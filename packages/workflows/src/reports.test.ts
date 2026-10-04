import type { ReportScheduleResult } from '@expensewise/db';
import { describe, expect, it, vi } from 'vitest';
import { scheduleReports, type ReportSchedulePorts } from './reports.ts';

const NOW = new Date('2026-10-04T12:07:00Z');
const result = (orgId: string): ReportScheduleResult => ({
  orgId,
  joined: { trips: 2, expenses: 1, opened: 1 },
  closed: { closed: 1, moved: 1, dropped: 0 },
});

function ports(due: string[], failing: string[] = []) {
  const ran: string[] = [];
  const asked: Date[] = [];
  const p: ReportSchedulePorts = {
    now: () => NOW,
    dueOrganizations: (now) => {
      asked.push(now);
      return Promise.resolve(due);
    },
    runFor: (orgId, now) => {
      expect(now).toBe(NOW);
      ran.push(orgId);
      return failing.includes(orgId)
        ? Promise.reject(new Error(`${orgId} broke`))
        : Promise.resolve(result(orgId));
    },
  };
  return { p, ran, asked };
}

describe('the hourly report schedule', () => {
  it('does each organization’s due work at one moment, and logs counts only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { p, ran, asked } = ports(['org-a', 'org-b']);
    expect(await scheduleReports(p)).toEqual({
      organizations: 2,
      joined: 6,
      opened: 2,
      closed: 2,
      moved: 2,
      dropped: 0,
      failed: 0,
    });
    expect(asked).toEqual([NOW]);
    expect(ran).toEqual(['org-a', 'org-b']);
    expect(log).toHaveBeenCalledWith('report-schedule', expect.objectContaining({ joined: 6 }));
    log.mockRestore();
  });

  it('does nothing when nothing is due', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { p, ran } = ports([]);
    expect(await scheduleReports(p)).toMatchObject({ organizations: 0, joined: 0 });
    expect(ran).toEqual([]);
    log.mockRestore();
  });

  it('carries on past an organization that fails, then fails the run so it is retried', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { p, ran } = ports(['org-a', 'org-b', 'org-c'], ['org-b']);
    await expect(scheduleReports(p)).rejects.toThrow(/failed for 1 organization/);
    expect(ran).toEqual(['org-a', 'org-b', 'org-c']);
    log.mockRestore();
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  REPORT_STATUSES,
  transitionReport,
  type ReportEvent,
  type ReportStatus,
} from './report.ts';

function run(from: ReportStatus, events: ReportEvent[]): ReportStatus {
  return events.reduce<ReportStatus>((status, event) => {
    const next = transitionReport(status, event);
    if (!next.ok) throw new Error(`${status} rejected ${event.type}: ${next.error.code}`);
    return next.value;
  }, from);
}

describe('report lifecycle', () => {
  it('walks the two-step approval path', () => {
    expect(
      run('open', [
        { type: 'close', itemCount: 8, blockers: 0 },
        { type: 'submit', itemCount: 8 },
        { type: 'route', steps: 2 },
        { type: 'step_approved', remainingSteps: 1 },
        { type: 'step_approved', remainingSteps: 0 },
        { type: 'settle' },
      ]),
    ).toBe('settled');
  });

  it('auto-approves straight from submitted', () => {
    expect(run('closed', [{ type: 'submit', itemCount: 1 }, { type: 'auto_approve' }])).toBe(
      'approved',
    );
  });

  it('closes only with nothing left to review, and reopens until submitted', () => {
    expect(run('open', [{ type: 'close', itemCount: 3, blockers: 0 }, { type: 'reopen' }])).toBe(
      'open',
    );
    const blocked = transitionReport('open', { type: 'close', itemCount: 3, blockers: 1 });
    expect(blocked.ok ? blocked.value : blocked.error.code).toBe('needs_attention');
    const submitted = transitionReport('submitted', { type: 'reopen' });
    expect(submitted.ok ? submitted.value : submitted.error.code).toBe('illegal_transition');
  });

  it('returns to open with a comment, and withdraws', () => {
    expect(run('in_approval', [{ type: 'return', comment: 'Add attendees for the dinner.' }])).toBe(
      'open',
    );
    expect(run('submitted', [{ type: 'withdraw' }])).toBe('open');
    expect(run('in_approval', [{ type: 'withdraw' }])).toBe('open');
  });

  it.each<[ReportStatus, ReportEvent, string]>([
    ['closed', { type: 'submit', itemCount: 0 }, 'empty_report'],
    ['open', { type: 'submit', itemCount: 2 }, 'illegal_transition'],
    ['open', { type: 'close', itemCount: 0, blockers: 0 }, 'empty_report'],
    ['closed', { type: 'close', itemCount: 1, blockers: 0 }, 'illegal_transition'],
    ['open', { type: 'reopen' }, 'illegal_transition'],
    ['submitted', { type: 'route', steps: 0 }, 'invalid_route'],
    ['submitted', { type: 'route', steps: 1.5 }, 'invalid_route'],
    ['in_approval', { type: 'return', comment: '   ' }, 'comment_required'],
    ['approved', { type: 'withdraw' }, 'illegal_transition'],
    ['open', { type: 'settle' }, 'illegal_transition'],
    ['open', { type: 'auto_approve' }, 'illegal_transition'],
    ['submitted', { type: 'submit', itemCount: 2 }, 'illegal_transition'],
    ['open', { type: 'route', steps: 1 }, 'illegal_transition'],
    ['open', { type: 'return', comment: 'x' }, 'illegal_transition'],
    ['submitted', { type: 'step_approved', remainingSteps: 0 }, 'illegal_transition'],
  ])('from %s rejects %j with %s', (from, event, code) => {
    const result = transitionReport(from, event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('stays within known states and treats settled as final', () => {
    const anyEvent = fc.oneof(
      fc.record({
        type: fc.constant('close' as const),
        itemCount: fc.nat(5),
        blockers: fc.nat(2),
      }),
      fc.constant({ type: 'reopen' as const }),
      fc.record({ type: fc.constant('submit' as const), itemCount: fc.nat(5) }),
      fc.record({ type: fc.constant('route' as const), steps: fc.nat(3) }),
      fc.constant({ type: 'auto_approve' as const }),
      fc.record({ type: fc.constant('step_approved' as const), remainingSteps: fc.nat(2) }),
      fc.record({ type: fc.constant('return' as const), comment: fc.string() }),
      fc.constant({ type: 'withdraw' as const }),
      fc.constant({ type: 'settle' as const }),
    );
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 40 }), (sequence) => {
        let status: ReportStatus = 'open';
        for (const event of sequence) {
          const next = transitionReport(status, event);
          if (status === 'settled') expect(next.ok).toBe(false);
          if (next.ok) status = next.value;
          expect(REPORT_STATUSES).toContain(status);
        }
      }),
    );
  });
});

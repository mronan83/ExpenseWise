import { err, ok, type Result } from '../result.ts';

export const REPORT_STATUSES = ['open', 'submitted', 'in_approval', 'approved', 'settled'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type ReportEvent =
  | { readonly type: 'submit'; readonly itemCount: number }
  | { readonly type: 'route'; readonly steps: number }
  | { readonly type: 'auto_approve' }
  | { readonly type: 'step_approved'; readonly remainingSteps: number }
  | { readonly type: 'return'; readonly comment: string }
  | { readonly type: 'withdraw' }
  | { readonly type: 'settle' };

export interface ReportTransitionError {
  readonly code: 'illegal_transition' | 'empty_report' | 'invalid_route' | 'comment_required';
  readonly from: ReportStatus;
  readonly event: ReportEvent['type'];
}

export function transitionReport(
  from: ReportStatus,
  event: ReportEvent,
): Result<ReportStatus, ReportTransitionError> {
  const fail = (code: ReportTransitionError['code']) => err({ code, from, event: event.type });

  switch (event.type) {
    case 'submit':
      if (from !== 'open') return fail('illegal_transition');
      return event.itemCount > 0 ? ok('submitted') : fail('empty_report');
    case 'route':
      if (from !== 'submitted') return fail('illegal_transition');
      return Number.isInteger(event.steps) && event.steps >= 1
        ? ok('in_approval')
        : fail('invalid_route');
    case 'auto_approve':
      return from === 'submitted' ? ok('approved') : fail('illegal_transition');
    case 'step_approved':
      if (from !== 'in_approval') return fail('illegal_transition');
      return event.remainingSteps > 0 ? ok('in_approval') : ok('approved');
    case 'return':
      if (from !== 'in_approval') return fail('illegal_transition');
      return event.comment.trim() === '' ? fail('comment_required') : ok('open');
    case 'withdraw':
      return from === 'submitted' || from === 'in_approval'
        ? ok('open')
        : fail('illegal_transition');
    case 'settle':
      return from === 'approved' ? ok('settled') : fail('illegal_transition');
  }
}

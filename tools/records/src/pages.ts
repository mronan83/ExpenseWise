/**
 * Where the two pages are published, so each release republishes to the same address and
 * the pages can link to each other. The backlog page is first published after the release
 * that ships these records.
 */
export const PAGE_URLS: { readonly traceability?: string; readonly backlog?: string } = {
  traceability: 'https://claude.ai/artifact/8VCWvpqvNVELSKUwQawoyN',
};

export const REPOSITORY = 'mronan83/ExpenseWise';
export const PRODUCTION_URL = 'https://expensewise-theta.vercel.app';

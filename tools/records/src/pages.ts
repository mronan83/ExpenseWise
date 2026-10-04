/**
 * Where the pages are published, so each release republishes to the same address and the
 * pages can link to each other.
 */
export const PAGE_URLS: {
  readonly traceability?: string;
  readonly backlog?: string;
  readonly architecture?: string;
  readonly dataModel?: string;
  readonly stories?: string;
} = {
  traceability: 'https://claude.ai/artifact/8VCWvpqvNVELSKUwQawoyN',
  backlog: 'https://claude.ai/artifact/MfctKLE69dRkcHzpYVt9TD',
  architecture: 'https://claude.ai/artifact/79tEK88Jr5ts2sP7Rqd5N4',
  dataModel: 'https://claude.ai/artifact/8nUFKrKYRNxB128Ems7432',
};

export const REPOSITORY = 'mronan83/ExpenseWise';
export const PRODUCTION_URL = 'https://expensewise-theta.vercel.app';

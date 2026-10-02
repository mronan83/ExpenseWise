import { createFlags, posthogSource } from '@expensewise/flags';

// Server-side feature flags (AP8). PostHog decides when its project key is set; until then
// every flag is off unless FLAG_OVERRIDES turns it on. Overrides also beat PostHog, which
// makes them the kill switch.
const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

export const flags = createFlags({
  source: posthogKey
    ? posthogSource({ apiKey: posthogKey, host: process.env.NEXT_PUBLIC_POSTHOG_HOST })
    : undefined,
  overrides: process.env.FLAG_OVERRIDES,
});

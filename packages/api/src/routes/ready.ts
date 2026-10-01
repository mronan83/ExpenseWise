import { createRoute } from '@hono/zod-openapi';
import { ReadinessSchema } from '../schemas.ts';

export const readyRoute = createRoute({
  method: 'get',
  path: '/v1/health/ready',
  tags: ['Platform'],
  summary: 'Readiness check',
  description:
    'Connects to the database the way tenant requests do and checks what tenant isolation ' +
    'depends on: the runtime role, verified TLS and enforced row-level security. Results are ' +
    'cached for a few seconds. Details are fixed messages, never raw errors.',
  responses: {
    200: {
      description: 'Ready to serve tenant data.',
      content: { 'application/json': { schema: ReadinessSchema } },
    },
    503: {
      description: 'Not ready; at least one check failed.',
      content: { 'application/json': { schema: ReadinessSchema } },
    },
  },
});

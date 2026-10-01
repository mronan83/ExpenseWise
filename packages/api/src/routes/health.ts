import { createRoute } from '@hono/zod-openapi';
import { HealthSchema } from '../schemas.ts';

export const healthRoute = createRoute({
  method: 'get',
  path: '/v1/health',
  tags: ['Platform'],
  summary: 'Liveness check',
  description: 'Returns 200 while the API can serve requests. Does not touch the database.',
  responses: {
    200: {
      description: 'The API is up.',
      content: { 'application/json': { schema: HealthSchema } },
    },
  },
});

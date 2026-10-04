import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateTripSchema,
  EditTripSchema,
  ProblemSchema,
  TripDetailSchema,
  TripListSchema,
  TripSearchSchema,
} from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

const tripParam = z.object({
  tripId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'tripId', in: 'path' } }),
});

const detail = (description: string) => ({
  description,
  content: { 'application/json': { schema: TripDetailSchema } },
});

export const listTripsRoute = createRoute({
  method: 'get',
  path: '/v1/trips',
  tags: ['Trips'],
  summary: 'Trips, latest first, or those that match a search',
  description: 'FR-EXP-04, FR-INS-02. Every search term given must match.',
  ...secured,
  request: { query: TripSearchSchema },
  responses: {
    200: {
      description: 'The latest 200 trips that match.',
      content: { 'application/json': { schema: TripListSchema } },
    },
    ...common,
    400: problem('A search term is not valid.'),
  },
});

export const createTripRoute = createRoute({
  method: 'post',
  path: '/v1/trips',
  tags: ['Trips'],
  summary: 'Make a trip',
  description:
    'FR-EXP-04, ADR-0023. A trip of the caller’s. Their expenses dated in it file to it, ' +
    'unless a person chose their trip or they are submitted or later.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: CreateTripSchema } }, required: true },
  },
  responses: {
    201: detail('The trip, with the expenses now on it.'),
    ...common,
    422: problem('A value is not valid; field names which.'),
  },
});

export const getTripRoute = createRoute({
  method: 'get',
  path: '/v1/trips/{tripId}',
  tags: ['Trips'],
  summary: 'One trip, with its expenses',
  ...secured,
  request: { params: tripParam },
  responses: {
    200: detail('The trip.'),
    ...common,
    404: problem('No such trip in this organization.'),
  },
});

export const editTripRoute = createRoute({
  method: 'patch',
  path: '/v1/trips/{tripId}',
  tags: ['Trips'],
  summary: 'Edit a trip',
  description:
    'Changes the fields sent and records who changed what. New dates file its owner’s ' +
    'expenses again: those now in it join, those now outside it leave.',
  ...secured,
  request: {
    params: tripParam,
    body: { content: { 'application/json': { schema: EditTripSchema } }, required: true },
  },
  responses: {
    200: detail('The trip as it is now.'),
    ...common,
    404: problem('No such trip in this organization.'),
    422: problem('A value is not valid; field names which.'),
  },
});

export const deleteTripRoute = createRoute({
  method: 'delete',
  path: '/v1/trips/{tripId}',
  tags: ['Trips'],
  summary: 'Delete a trip',
  description:
    'Its expenses file by date to any other trip that covers them, including ones a person ' +
    'had put on it.',
  ...secured,
  request: { params: tripParam },
  responses: {
    204: { description: 'Deleted.' },
    ...common,
    404: problem('No such trip in this organization.'),
    409: problem('A submitted expense rests on it.'),
  },
});

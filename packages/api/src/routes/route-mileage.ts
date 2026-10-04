import { createRoute, z } from '@hono/zod-openapi';
import {
  ChangePlaceSchema,
  ChangeRouteDriveSchema,
  ClaimRouteMilesSchema,
  LogRouteDriveSchema,
  RouteDriveSchema,
  RouteKeyStatusSchema,
  SavedPlaceListSchema,
  SavedPlaceSchema,
  SavePlaceSchema,
  SetRouteKeySchema,
} from '../route-mileage-schemas.ts';
import { ProblemSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const OFF = 'Route mileage is switched off for this organization (feature_off)';

const common = {
  401: problem('Sign in required.'),
  403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

const expenseParam = z.object({
  expenseId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'expenseId', in: 'path' } }),
});

const placeParam = z.object({
  placeId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'placeId', in: 'path' } }),
});

const drive = (description: string) => ({
  description,
  content: { 'application/json': { schema: RouteDriveSchema } },
});

export const logRouteDriveRoute = createRoute({
  method: 'post',
  path: '/v1/mileage/routes',
  tags: ['Mileage'],
  summary: 'Log a drive by its stops, to be measured',
  description:
    'FR-CAP-04, ADR-0039. A drive of the caller’s on its date, its stops as typed. It is ' +
    'measured after the answer, by the route-measuring workflow, and claims nothing until then: ' +
    'its expense is processing. Each address is sent to OpenRouteService as typed; the purpose ' +
    'never is (Q32).',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: LogRouteDriveSchema } }, required: true },
  },
  responses: {
    201: drive('The drive, Measuring….'),
    ...common,
    404: problem(`${OFF}.`),
    422: problem('A value is not valid, or no rate is known for the date; field names which.'),
  },
});

export const getRouteDriveRoute = createRoute({
  method: 'get',
  path: '/v1/mileage/{expenseId}/route',
  tags: ['Mileage'],
  summary: 'One of the caller’s route drives, with how it was measured',
  ...secured,
  request: { params: expenseParam },
  responses: {
    200: drive('The drive and its route.'),
    ...common,
    404: problem(`No such route drive of the caller’s, or ${OFF.toLowerCase()}.`),
  },
});

export const changeRouteDriveRoute = createRoute({
  method: 'patch',
  path: '/v1/mileage/{expenseId}/route',
  tags: ['Mileage'],
  summary: 'Change a route drive before it is submitted',
  description:
    'ADR-0039, Q33. New stops, or a round trip switched, measure it again; sending the stops ' +
    'unchanged measures again a drive that could not be measured. A measured drive is never ' +
    'measured again otherwise. A new date prices the miles claimed at that day’s rate.',
  ...secured,
  request: {
    params: expenseParam,
    body: { content: { 'application/json': { schema: ChangeRouteDriveSchema } }, required: true },
  },
  responses: {
    200: drive('The drive as it is now.'),
    ...common,
    404: problem(`No such route drive of the caller’s, or ${OFF.toLowerCase()}.`),
    409: problem('It is submitted or later. An approved drive is corrected by a reversal.'),
    422: problem('A value is not valid; field names which.'),
  },
});

export const claimRouteMilesRoute = createRoute({
  method: 'put',
  path: '/v1/mileage/{expenseId}/route/miles',
  tags: ['Mileage'],
  summary: 'The miles claimed for a route drive',
  description:
    'Q33. The miles measured, or others with a reason, or, when it could not be measured, ' +
    'miles entered by hand with a reason. Priced at the rate in force on its date; the drive ' +
    'is then Ready, and the measured miles stay beside the claimed ones. Audited.',
  ...secured,
  request: {
    params: expenseParam,
    body: { content: { 'application/json': { schema: ClaimRouteMilesSchema } }, required: true },
  },
  responses: {
    200: drive('The drive as it is now.'),
    ...common,
    404: problem(`No such route drive of the caller’s, or ${OFF.toLowerCase()}.`),
    409: problem('It is still being measured, or it is submitted or later.'),
    422: problem('The miles are not valid, or a reason is needed; field names which.'),
  },
});

export const listPlacesRoute = createRoute({
  method: 'get',
  path: '/v1/me/places',
  tags: ['Mileage'],
  summary: 'The caller’s saved places',
  ...secured,
  responses: {
    200: {
      description: 'By name.',
      content: { 'application/json': { schema: SavedPlaceListSchema } },
    },
    ...common,
    404: problem(`${OFF}.`),
  },
});

const place = (description: string) => ({
  description,
  content: { 'application/json': { schema: SavedPlaceSchema } },
});

export const addPlaceRoute = createRoute({
  method: 'post',
  path: '/v1/me/places',
  tags: ['Mileage'],
  summary: 'Save a place to pick for a drive’s stops',
  description: 'Its address is copied onto a stop when picked; its name is never sent (Q32).',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: SavePlaceSchema } }, required: true },
  },
  responses: {
    201: place('The place.'),
    ...common,
    404: problem(`${OFF}.`),
    409: problem('The caller keeps a place of that name already (name_taken).'),
    422: problem('The name or address is not valid; field names which.'),
  },
});

export const changePlaceRoute = createRoute({
  method: 'patch',
  path: '/v1/me/places/{placeId}',
  tags: ['Mileage'],
  summary: 'Rename a saved place or change its address',
  ...secured,
  request: {
    params: placeParam,
    body: { content: { 'application/json': { schema: ChangePlaceSchema } }, required: true },
  },
  responses: {
    200: place('The place as it is now.'),
    ...common,
    404: problem(`No such place of the caller’s, or ${OFF.toLowerCase()}.`),
    409: problem('The caller keeps a place of that name already (name_taken).'),
    422: problem('The name or address is not valid; field names which.'),
  },
});

export const removePlaceRoute = createRoute({
  method: 'delete',
  path: '/v1/me/places/{placeId}',
  tags: ['Mileage'],
  summary: 'Remove a saved place',
  description: 'Drives that used its address keep it.',
  ...secured,
  request: { params: placeParam },
  responses: {
    204: { description: 'Removed.' },
    ...common,
    404: problem(`No such place of the caller’s, or ${OFF.toLowerCase()}.`),
  },
});

const keyStatus = (description: string) => ({
  description,
  content: { 'application/json': { schema: RouteKeyStatusSchema } },
});

const managers = {
  403: problem('No organization yet, or the caller is not an owner or finance admin.'),
};

export const getRouteKeyRoute = createRoute({
  method: 'get',
  path: '/v1/settings/mileage/route-key',
  tags: ['Settings'],
  summary: 'Whether the organization has an OpenRouteService key',
  description: 'Q31. Its last four characters only, never the key. Owners and finance admins.',
  ...secured,
  responses: {
    200: keyStatus('The key’s status.'),
    ...common,
    ...managers,
    404: problem(`${OFF}.`),
  },
});

export const setRouteKeyRoute = createRoute({
  method: 'put',
  path: '/v1/settings/mileage/route-key',
  tags: ['Settings'],
  summary: 'Check an OpenRouteService key, then store it encrypted',
  description:
    'Q31, ADR-0039. Checked in the request with one short route (about a kilometre) as ' +
    'OpenRouteService’s answer, as AI keys are (ADR-0015); stored only when it works, ' +
    'encrypted and bound to the organization, and never returned. Audited.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: SetRouteKeySchema } }, required: true },
  },
  responses: {
    200: keyStatus('Accepted and stored.'),
    ...common,
    ...managers,
    404: problem(`${OFF}.`),
    422: problem('OpenRouteService refused the key, or it isn’t one; nothing was stored.'),
    502: problem('OpenRouteService is busy, used up or could not be reached; nothing was stored.'),
  },
});

export const deleteRouteKeyRoute = createRoute({
  method: 'delete',
  path: '/v1/settings/mileage/route-key',
  tags: ['Settings'],
  summary: 'Remove the OpenRouteService key',
  description: 'Drives already measured keep their measurement; new ones can’t be measured.',
  ...secured,
  responses: {
    204: { description: 'Removed.' },
    ...common,
    ...managers,
    404: problem(`No key is stored, or ${OFF.toLowerCase()}.`),
  },
});

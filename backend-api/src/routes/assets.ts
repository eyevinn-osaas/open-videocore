// Workspace-scoped assets router (issue #20 isolation + issue #3 lifecycle).
//
// Every route is protected by the `authenticate` preHandler, so each handler
// runs with a validated request.workspaceId. All repository calls pass that
// workspaceId, so a caller can only ever see or mutate their own workspace's
// assets. Cross-workspace ids resolve to 404 (existence is not leaked) and the
// guard layer rejects any forged ownership with 403.
//
// Lifecycle (issue #3): assets move uploading -> processing -> ready ->
// archived. Invalid transitions are rejected with 422. DELETE is a SOFT delete
// (status -> archived); deleting an asset that still has children returns 409.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ASSET_STATUSES,
  HasChildrenError,
  InMemoryAssetRepository,
  InvalidStateTransitionError,
  ParentNotFoundError,
  type AssetRepository
} from '../data/asset-repo.js';
import { WorkspaceAccessError } from '../data/guard.js';

const statusSchema = z.enum(ASSET_STATUSES);

const createSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
  parentId: z.string().min(1).optional(),
  objectKey: z.string().min(1).max(1024).optional()
});

// PATCH: all fields optional; at least one is required. `status` is checked
// against the state machine in the repository layer.
const updateSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    description: z.string().max(2048).optional(),
    objectKey: z.string().min(1).max(1024).optional(),
    status: statusSchema.optional()
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no updatable fields provided' });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: statusSchema.optional(),
  parentId: z.string().min(1).optional()
});

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const transitionSchema = z.object({
  at: z.string(),
  from: statusSchema.nullable(),
  to: statusSchema
});

const assetSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: statusSchema,
  parentId: z.string().optional(),
  objectKey: z.string().optional(),
  statusHistory: z.array(transitionSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});

const listSchema = z.object({
  items: z.array(assetSchema),
  limit: z.number(),
  offset: z.number(),
  total: z.number()
});

type AssetsRouterOptions = {
  // Injectable for tests; defaults to the in-memory repository.
  repository?: AssetRepository;
};

export const assetsRouter: FastifyPluginAsync<AssetsRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository ?? new InMemoryAssetRepository();

  // Map domain errors to HTTP status codes for this router.
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    if (err instanceof InvalidStateTransitionError) {
      return reply.code(422).send({ error: 'invalid_state_transition', message: err.message });
    }
    if (err instanceof ParentNotFoundError) {
      return reply.code(422).send({ error: 'parent_not_found', message: err.message });
    }
    if (err instanceof HasChildrenError) {
      return reply.code(409).send({ error: 'has_children', message: err.message });
    }
    throw err;
  });

  const guarded = { onRequest: app.authenticate };

  app.post(
    '/',
    { ...guarded, schema: { body: createSchema, response: { 201: assetSchema } } },
    async (request, reply) => {
      const asset = await repo.create(request.workspaceId, request.body);
      return reply.code(201).send(asset);
    }
  );

  app.get(
    '/',
    { ...guarded, schema: { querystring: listQuerySchema, response: { 200: listSchema } } },
    async (request) => {
      return repo.list(request.workspaceId, request.query);
    }
  );

  app.get(
    '/search',
    {
      ...guarded,
      schema: {
        querystring: z.object({ q: z.string().min(1) }),
        response: { 200: z.object({ items: z.array(assetSchema) }) }
      }
    },
    async (request) => {
      const items = await repo.search(request.workspaceId, request.query.q);
      return { items };
    }
  );

  app.get(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(asset);
    }
  );

  app.patch(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        body: updateSchema,
        response: { 200: assetSchema, 404: errorSchema, 422: errorSchema }
      }
    },
    async (request, reply) => {
      const updated = await repo.update(request.workspaceId, request.params.id, request.body);
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
    }
  );

  app.delete(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null(), 404: errorSchema, 409: errorSchema }
      }
    },
    async (request, reply) => {
      // Block deletion while children (renditions) still reference this asset.
      const childCount = await repo.countChildren(request.workspaceId, request.params.id);
      if (childCount > 0) {
        throw new HasChildrenError(request.params.id);
      }
      // Soft delete: archive rather than destroy (see asset-repo / couch-asset-repo).
      const removed = await repo.remove(request.workspaceId, request.params.id);
      if (!removed) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(204).send(null);
    }
  );
};

// Workspace-scoped bucket / object-storage management router.
//
// Lets an operator browse and prune the objects a workspace has stored in its
// two MinIO buckets (the shared `source` and `packaged` buckets, see ADR-001 /
// provision). Every route is behind `authenticate`, so each handler runs with a
// validated request.workspaceId and the per-request `request.connections`
// resolved by the global preHandler hook.
//
// Isolation: objects live under a hard `<workspaceId>/` key prefix inside the
// shared buckets (see data/storage.ts + guard.objectPrefix). This router forces
// every listing under the caller's prefix and strips it from the keys handed
// back, so a workspace can neither enumerate nor delete another workspace's
// objects. Bucket names are validated against the workspace's own configured
// source + packaged buckets (403 otherwise) — there is no way to address an
// arbitrary bucket.
//
// Graceful degradation: when the resolved stack has no object storage (the
// in-memory fallback, no MinIO) every route responds 501.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { BucketItem } from 'minio';
import { z } from 'zod';
import { objectPrefix } from '../data/guard.js';
import type { WorkspaceStackResolver } from '../services/workspace-stack.js';

// Hard cap on objects returned by a single listing call. Bounds the response
// size regardless of how many objects a prefix holds.
const MAX_OBJECTS = 200;

export type StorageRouterOptions = {
  stackResolver: WorkspaceStackResolver;
};

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const bucketSchema = z.object({
  name: z.string(),
  role: z.enum(['source', 'packaged'])
});

const bucketsSchema = z.array(bucketSchema);

const objectSchema = z.object({
  key: z.string(),
  size: z.number(),
  lastModified: z.string().optional(),
  isPrefix: z.boolean()
});

const objectListSchema = z.object({
  objects: z.array(objectSchema),
  prefix: z.string(),
  bucket: z.string()
});

const listQuerySchema = z.object({
  prefix: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_OBJECTS).optional()
});

export const storageRouter: FastifyPluginAsync<StorageRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { stackResolver } = opts;

  const guarded = { onRequest: app.authenticate };

  // List the two configured buckets for the caller's workspace.
  //   200 — [{ name, role }, ...]
  //   501 — object storage not configured on this workspace's stack
  app.get(
    '/buckets',
    { ...guarded, schema: { response: { 200: bucketsSchema, 501: errorSchema } } },
    async (request, reply) => {
      const conns = request.connections;
      if (!conns?.storageClient) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'object storage is not configured' });
      }
      return reply.code(200).send([
        { name: conns.sourceBucket, role: 'source' as const },
        { name: conns.packagedBucket, role: 'packaged' as const }
      ]);
    }
  );

  // List objects in one of the workspace's buckets, scoped to the workspace's
  // `<workspaceId>/` key prefix. Non-recursive: directory-like CommonPrefixes
  // are returned as `isPrefix` entries so the UI can present a folder tree. The
  // caller-supplied `prefix` is a workspace-local prefix (without the workspace
  // namespace); it is forced under the namespace before hitting MinIO and
  // stripped from the keys handed back.
  //   200 — { objects, prefix, bucket }
  //   403 — bucket name is not one of the workspace's own buckets
  //   501 — object storage not configured
  app.get(
    '/buckets/:bucket/objects',
    {
      ...guarded,
      schema: {
        params: z.object({ bucket: z.string().min(1).max(256) }),
        querystring: listQuerySchema,
        response: { 200: objectListSchema, 403: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      const conns = request.connections;
      if (!conns?.storageClient) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'object storage is not configured' });
      }
      const { bucket } = request.params;
      if (bucket !== conns.sourceBucket && bucket !== conns.packagedBucket) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'bucket is not owned by this workspace' });
      }

      const wsPrefix = objectPrefix(request.workspaceId);
      const localPrefix = request.query.prefix ?? '';
      const limit = request.query.limit ?? MAX_OBJECTS;
      // Force the listing under the workspace namespace so a workspace can only
      // ever enumerate its own objects.
      const scopedPrefix = `${wsPrefix}${localPrefix}`;

      const objects = await listBounded(
        conns.storageClient,
        bucket,
        scopedPrefix,
        wsPrefix,
        limit
      );

      return reply.code(200).send({ objects, prefix: localPrefix, bucket });
    }
  );

  // Delete a single object by its workspace-local key. The key is forced under
  // the workspace namespace, so a workspace can only delete its own objects.
  //   204 — deleted
  //   403 — bucket not owned by this workspace, or key escapes the namespace
  //   501 — object storage not configured
  app.delete(
    '/buckets/:bucket/objects/*',
    {
      ...guarded,
      schema: {
        params: z.object({ bucket: z.string().min(1).max(256), '*': z.string().min(1).max(1024) }),
        response: { 204: z.null(), 403: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      const conns = request.connections;
      if (!conns?.storageClient) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'object storage is not configured' });
      }
      const { bucket } = request.params;
      if (bucket !== conns.sourceBucket && bucket !== conns.packagedBucket) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'bucket is not owned by this workspace' });
      }

      const localKey = request.params['*'].replace(/^\/+/, '');
      if (localKey.includes('..')) {
        return reply.code(403).send({ error: 'forbidden', message: 'invalid object key' });
      }
      const scopedKey = `${objectPrefix(request.workspaceId)}${localKey}`;
      await conns.storageClient.removeObject(bucket, scopedKey);
      return reply.code(204).send(null);
    }
  );
};

// List up to `limit` objects under `scopedPrefix` non-recursively, returning
// workspace-local keys (the `wsPrefix` namespace stripped). CommonPrefixes are
// surfaced as `isPrefix` entries. Bounds the stream to `limit` results then
// destroys it so a huge bucket cannot stream unbounded.
function listBounded(
  client: import('minio').Client,
  bucket: string,
  scopedPrefix: string,
  wsPrefix: string,
  limit: number
): Promise<Array<z.infer<typeof objectSchema>>> {
  const out: Array<z.infer<typeof objectSchema>> = [];
  const stream = client.listObjectsV2(bucket, scopedPrefix, false);
  return new Promise((resolve, reject) => {
    const finish = () => resolve(out);
    stream.on('data', (item: BucketItem) => {
      if (out.length >= limit) {
        stream.destroy();
        finish();
        return;
      }
      // CommonPrefix entries carry `prefix`; real objects carry `name`.
      const rawKey = item.prefix ?? item.name;
      if (!rawKey || !rawKey.startsWith(wsPrefix)) {
        return;
      }
      out.push({
        key: rawKey.slice(wsPrefix.length),
        size: item.size ?? 0,
        lastModified: item.lastModified ? item.lastModified.toISOString() : undefined,
        isPrefix: Boolean(item.prefix)
      });
    });
    stream.on('end', finish);
    stream.on('error', reject);
  });
}

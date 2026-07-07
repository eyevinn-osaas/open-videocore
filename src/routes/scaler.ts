// Encore auto-scaler status router.
//
// Exposes read-only introspection of the per-workspace Encore auto-scaler pool
// so an ops UI can visualise queue depth, in-flight jobs, and live instances.
// Intentionally NOT behind the `authenticate` preHandler — like the admin
// status endpoints it reports aggregate operational state, not workspace data,
// so an operator or probe can read it without a workspace token.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Valkey key schema: src/encore-scaler/types.ts `keys` object
//       queue:    encore:queue:{workspaceId}    (Redis list — LLEN for depth)
//       inflight: encore:inflight:{workspaceId} (Redis list — LLEN for depth)
//       pool:     encore:pool:{workspaceId}     (Redis hash of EncoreInstanceRecord)
//   - EncoreInstanceRecord shape: src/encore-scaler/types.ts:37-42
//       { instanceId, url, activeJobs, lastIdleAt }
//   - listInstances(redis, workspaceId): src/encore-scaler/instance-pool.ts:46
//   - ioredis Redis.scan / .llen: ioredis type definitions.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { keys } from '../encore-scaler/types.js';
import { listInstances } from '../encore-scaler/instance-pool.js';

type ScalerRouterOptions = {
  // The shared Valkey connection used by the scaler. Undefined when the scaler
  // is off (no REDIS_URL); the status endpoint then reports scalerActive:false.
  redis?: Redis;
  // Upper bound on instances per workspace pool (ENCORE_MAX_INSTANCES).
  maxInstances: number;
  // Minimum instances to keep warm (0 = scale to zero when idle). Default 0.
  minInstances?: number;
  // Callback to update the live scaler config at runtime.
  onConfigChange?: (cfg: { maxInstances: number; minInstances: number }) => void;
};

const instanceSchema = z.object({
  instanceId: z.string(),
  url: z.string(),
  activeJobs: z.number(),
  lastIdleAt: z.number()
});

const workspaceSchema = z.object({
  workspaceId: z.string(),
  queueDepth: z.number(),
  inflightDepth: z.number(),
  instances: z.array(instanceSchema)
});

const scalerStatusSchema = z.object({
  workspaces: z.array(workspaceSchema),
  maxInstances: z.number(),
  scalerActive: z.boolean()
});

// Scan for every pool hash key and extract the workspaceId. Uses SCAN (cursor
// paging) rather than KEYS so it does not block Valkey on large keyspaces.
const POOL_PREFIX = keys.pool('');
async function scanWorkspaceIds(redis: Redis): Promise<string[]> {
  const pattern = `${POOL_PREFIX}*`;
  const found = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    for (const key of batch) {
      if (key.startsWith(POOL_PREFIX)) {
        found.add(key.slice(POOL_PREFIX.length));
      }
    }
  } while (cursor !== '0');
  return [...found];
}

export const scalerRouter: FastifyPluginAsync<ScalerRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Mutable runtime config — updated by PATCH /config.
  let liveMaxInstances = opts.maxInstances;
  let liveMinInstances = opts.minInstances ?? 0;

  const scalerConfigSchema = z.object({
    maxInstances: z.number().int().min(1).max(20),
    minInstances: z.number().int().min(0).max(10)
  });

  app.get(
    '/status',
    { schema: { tags: ['admin'], response: { 200: scalerStatusSchema } } },
    async () => {
      const redis = opts.redis;
      if (!redis) {
        return { workspaces: [], maxInstances: 0, scalerActive: false };
      }

      const workspaceIds = await scanWorkspaceIds(redis);
      const workspaces = await Promise.all(
        workspaceIds.map(async (workspaceId) => {
          const [queueDepth, inflightDepth, instances] = await Promise.all([
            redis.llen(keys.queue(workspaceId)),
            redis.llen(keys.inflight(workspaceId)),
            listInstances(redis, workspaceId)
          ]);
          return { workspaceId, queueDepth, inflightDepth, instances };
        })
      );

      return { workspaces, maxInstances: liveMaxInstances, scalerActive: true };
    }
  );

  app.patch(
    '/config',
    {
      schema: {
        tags: ['admin'],
        body: scalerConfigSchema.partial(),
        response: { 200: scalerConfigSchema }
      }
    },
    async (request) => {
      const { maxInstances, minInstances } = request.body;
      if (maxInstances !== undefined) liveMaxInstances = maxInstances;
      if (minInstances !== undefined) liveMinInstances = minInstances;
      opts.onConfigChange?.({ maxInstances: liveMaxInstances, minInstances: liveMinInstances });
      return { maxInstances: liveMaxInstances, minInstances: liveMinInstances };
    }
  );

  app.get(
    '/config',
    {
      schema: {
        tags: ['admin'],
        response: { 200: scalerConfigSchema }
      }
    },
    async () => ({ maxInstances: liveMaxInstances, minInstances: liveMinInstances })
  );
};

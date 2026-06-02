// Admin / operational status router (issue #16).
//
// Hosts unauthenticated operational status endpoints for liveness-style
// introspection of background services. These are intentionally NOT behind the
// `authenticate` preHandler (they expose no workspace data — only aggregate
// service state) so an operator or probe can read them without a workspace
// token, mirroring the /health endpoints in main.ts.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { WatchFolderService } from '../pipeline/watch-folder.js';

type AdminRouterOptions = {
  // The watch-folder service, when configured + enabled. Absent when MinIO is
  // not configured or WATCH_FOLDER_ENABLED is not 'true'; the status endpoint
  // then reports enabled:false.
  watchFolder?: WatchFolderService;
};

const watchFolderStatus = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  processedCount: z.number()
});

export const adminRouter: FastifyPluginAsync<AdminRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/watch-folder/status',
    { schema: { response: { 200: watchFolderStatus } } },
    async () => {
      const wf = opts.watchFolder;
      return {
        enabled: wf !== undefined,
        running: wf?.isRunning() ?? false,
        processedCount: wf?.processedCount() ?? 0
      };
    }
  );

  const notConfigured = z.object({ error: z.string() });

  app.post(
    '/watch-folder/start',
    { schema: { response: { 200: watchFolderStatus, 409: watchFolderStatus, 501: notConfigured } } },
    async (_req, reply) => {
      const wf = opts.watchFolder;
      if (!wf) return reply.code(501).send({ error: 'watch-folder not configured (set WATCH_FOLDER_ENABLED=true and MINIO_URL)' });
      if (!wf.isRunning()) wf.start();
      return reply.send({ enabled: true, running: wf.isRunning(), processedCount: wf.processedCount() });
    }
  );

  app.post(
    '/watch-folder/stop',
    { schema: { response: { 200: watchFolderStatus, 501: notConfigured } } },
    async (_req, reply) => {
      const wf = opts.watchFolder;
      if (!wf) return reply.code(501).send({ error: 'watch-folder not configured' });
      wf.stop();
      return reply.send({ enabled: true, running: wf.isRunning(), processedCount: wf.processedCount() });
    }
  );
};

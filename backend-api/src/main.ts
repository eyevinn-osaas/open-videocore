import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Context } from '@osaas/client-core';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import { provisionRouter } from './routes/provision.js';
import { registerAuth } from './auth/middleware.js';
import { assetsRouter } from './routes/assets.js';
import { couchServer, WorkspaceCouch } from './data/couchdb.js';
import { CouchAssetRepository } from './data/couch-asset-repo.js';
import { InMemoryAssetRepository, type AssetRepository } from './data/asset-repo.js';

const app = Fastify({ logger: true });

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await app.register(cors);
await app.register(helmet);

// OSC context — reads OSC_ACCESS_TOKEN from environment.
// On OSC this is injected at runtime; locally set it in .env.
const oscContext = new Context();

// Auth: decorate request.workspaceId and register the `authenticate`
// preHandler. Workspace-scoped routers attach it via { onRequest: app.authenticate }.
registerAuth(app);

// Health endpoints are intentionally unauthenticated for liveness probing.
app.get('/health', async () => ({ status: 'ok', service: 'open-videocore-api' }));
app.get('/healthz', async () => ({ status: 'ok' }));

await app.register(provisionRouter, { prefix: '/api/v1/provision', osc: oscContext });

// Asset persistence. In a live OSC deployment assets are stored in CouchDB
// (partitioned by workspace, issue #20 + #3). Connection details come from the
// environment per 12-factor. If COUCHDB_URL is unset (e.g. a bare local run)
// we fall back to the in-memory repository so the API still boots.
function buildAssetRepository(): AssetRepository {
  const couchUrl = process.env['COUCHDB_URL'];
  if (!couchUrl) {
    app.log.warn('COUCHDB_URL not set — using in-memory asset repository (non-durable)');
    return new InMemoryAssetRepository();
  }
  const dbName = process.env['COUCHDB_ASSETS_DB'] ?? 'assets';
  const server = couchServer(couchUrl);
  return new CouchAssetRepository((workspaceId) => new WorkspaceCouch(workspaceId, server, dbName));
}

// Workspace-scoped resource routers. All resources are namespaced by the
// workspaceId derived from the caller's OSC token (issue #20).
await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: buildAssetRepository() });
// TODO: register further routers here as surfaces are implemented, passing oscContext
// await app.register(jobsRouter,      { prefix: '/api/v1/jobs' });
// await app.register(searchRouter,    { prefix: '/api/v1/search' });

const port = parseInt(process.env['PORT'] ?? '3000', 10);
await app.listen({ port, host: '0.0.0.0' });

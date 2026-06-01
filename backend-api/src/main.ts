import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Context } from '@osaas/client-core';

const app = Fastify({ logger: true });

await app.register(cors);
await app.register(helmet);

// OSC context — reads OSC_ACCESS_TOKEN from environment.
// On OSC this is injected at runtime; locally set it in .env.
const oscContext = new Context();

app.get('/health', async () => ({ status: 'ok', service: 'open-videocore-api' }));
app.get('/healthz', async () => ({ status: 'ok' }));

// TODO: register routers here as surfaces are implemented, passing oscContext
// await app.register(provisionRouter, { prefix: '/api/v1/provision', osc: oscContext });
// await app.register(assetsRouter,    { prefix: '/api/v1/assets' });
// await app.register(jobsRouter,      { prefix: '/api/v1/jobs' });
// await app.register(searchRouter,    { prefix: '/api/v1/search' });

const port = parseInt(process.env['PORT'] ?? '3000', 10);
await app.listen({ port, host: '0.0.0.0' });

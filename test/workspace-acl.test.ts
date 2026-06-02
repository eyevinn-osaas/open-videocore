import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

// Mock the OSC token resolver so tests do not hit the network. Tokens map to
// workspaces: `token-a` -> workspace A, `token-b` -> workspace B, anything else
// is rejected.
vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = {
        'token-a': 'workspace-a',
        'token-b': 'workspace-b'
      };
      const ws = token ? map[token] : undefined;
      if (!ws) {
        throw new actual.AuthError('invalid token');
      }
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  // Shared repository instance so both workspaces hit the same store and we can
  // prove isolation is enforced by scoping, not by separate stores.
  const repository = new InMemoryAssetRepository();
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository });
  await app.ready();
  return app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('workspace-scoped access control (issue #20)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  it('rejects requests without a token (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/assets' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects requests with an invalid token (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: auth('bogus')
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid token and derives the workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth('token-a'),
      payload: { name: 'clip one' }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().workspaceId).toBe('workspace-a');
  });

  it('isolates list results to the caller workspace', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth('token-a'),
      payload: { name: 'a-asset' }
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth('token-b'),
      payload: { name: 'b-asset' }
    });

    const listA = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: auth('token-a')
    });
    const itemsA = listA.json().items;
    expect(itemsA).toHaveLength(1);
    expect(itemsA[0].name).toBe('a-asset');
    expect(itemsA.every((i: { workspaceId: string }) => i.workspaceId === 'workspace-a')).toBe(
      true
    );
  });

  it('isolates search results to the caller workspace', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth('token-a'),
      payload: { name: 'shared-name' }
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth('token-b'),
      payload: { name: 'shared-name' }
    });

    const searchB = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/search?q=shared',
      headers: auth('token-b')
    });
    const items = searchB.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].workspaceId).toBe('workspace-b');
  });

  it('rejects cross-workspace reads (404, no existence leak)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth('token-a'),
      payload: { name: 'private-a' }
    });
    const id = created.json().id;

    const crossRead = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}`,
      headers: auth('token-b')
    });
    expect(crossRead.statusCode).toBe(404);

    // Owner can still read it.
    const ownRead = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}`,
      headers: auth('token-a')
    });
    expect(ownRead.statusCode).toBe(200);
  });

  it('rejects cross-workspace deletes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth('token-a'),
      payload: { name: 'del-target' }
    });
    const id = created.json().id;

    const crossDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${id}`,
      headers: auth('token-b')
    });
    expect(crossDelete.statusCode).toBe(404);

    // Still present for the owner.
    const ownRead = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}`,
      headers: auth('token-a')
    });
    expect(ownRead.statusCode).toBe(200);
  });
});

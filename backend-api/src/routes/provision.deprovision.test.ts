import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

const getInstance = vi.fn();
const removeInstance = vi.fn();

// Mock the workspace resolver so a known bearer token maps to a workspace and
// anything else is rejected (mirrors the assets-router test harness).
vi.mock('../auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../auth/workspace.js')>(
    '../auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      if (token === 'token-a') return 'workspace-a';
      throw new actual.AuthError('invalid token');
    })
  };
});

vi.mock('@osaas/client-core', () => ({
  // createInstance/waitForInstanceReady are imported by provision.ts but the
  // DELETE path under test does not invoke them.
  createInstance: vi.fn(),
  getInstance: (...args: unknown[]) => getInstance(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  getPortsForInstance: vi.fn(),
  waitForInstanceReady: vi.fn(),
  saveSecret: vi.fn(),
  Context: class {}
}));

// Provisioning credentials are read from the environment at router
// registration time (ADR-002, issue #30); set them so the router can register.
process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { registerAuth } from '../auth/middleware.js';
import { provisionRouter } from './provision.js';
import type { ParamStore } from '../services/param-store.js';

const getServiceAccessToken = vi.fn(async () => 'test-sat');
const osc = { getServiceAccessToken } as never;

// Valid bearer header for the authenticated paths (issue #28).
const AUTH = { authorization: 'Bearer token-a' };

async function buildApp(paramStore?: ParamStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    paramStore
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  getInstance.mockReset();
  removeInstance.mockReset();
  getServiceAccessToken.mockClear();
});

describe('DELETE /api/v1/provision/:name', () => {
  it('returns 200 status=removed on full teardown', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/mystack',
      headers: AUTH
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('removed');
  });

  it('returns 404 status=not_found for an already-deleted stack', async () => {
    getInstance.mockResolvedValue(undefined);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/ghoststack',
      headers: AUTH
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().status).toBe('not_found');
  });

  it('returns 502 status=failed on partial failure', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'minio-minio') throw new Error('boom');
      return undefined;
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/mystack',
      headers: AUTH
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.status).toBe('failed');
    expect(
      body.services.find((s: { serviceId: string }) => s.serviceId === 'minio-minio')
        .status
    ).toBe('failed');
  });

  it('rejects an invalid stack name (400)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/Invalid_Name',
      headers: AUTH
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('provision/deprovision authentication (issue #28)', () => {
  it('rejects DELETE without a token (401 + WWW-Authenticate: Bearer)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/mystack'
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(getInstance).not.toHaveBeenCalled();
  });

  it('rejects DELETE with an invalid token (401)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/mystack',
      headers: { authorization: 'Bearer nope' }
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(getInstance).not.toHaveBeenCalled();
  });

  it('rejects POST without a token (401) before provisioning anything', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: { name: 'mystack' }
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(getServiceAccessToken).not.toHaveBeenCalled();
  });

  it('rejects POST with an invalid token (401)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      headers: { authorization: 'Bearer nope' },
      payload: { name: 'mystack', adminPassword: 'supersecret' }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/v1/provision/:name (issue #31)', () => {
  const storedConfig = {
    minioEndpoint: 'https://minio.example.osaas.io',
    couchdbUrl: 'https://couch.example.osaas.io',
    databaseUrl: 'postgresql://host.example.osaas.io:5432/openvideocore',
    redisUrl: 'redis://valkey.svc.cluster.local:6379',
    encoreUrl: 'https://encore.example.osaas.io',
    encoreCallbackUrl: 'https://callback.example.osaas.io',
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: [{ serviceId: 'minio-minio', instanceName: 'mystack' }]
  };

  it('returns 200 with stored coordinates, scoped to the workspace', async () => {
    const loadStackConfig = vi.fn(async () => storedConfig);
    const paramStore = {
      storeStackConfig: vi.fn(),
      loadStackConfig
    } as unknown as ParamStore;

    const app = await buildApp(paramStore);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack',
      headers: AUTH
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(storedConfig);
    expect(loadStackConfig).toHaveBeenCalledWith('workspace-a', 'mystack');
  });

  it('returns 404 when no config is stored for the stack', async () => {
    const paramStore = {
      storeStackConfig: vi.fn(),
      loadStackConfig: vi.fn(async () => undefined)
    } as unknown as ParamStore;

    const app = await buildApp(paramStore);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/ghoststack',
      headers: AUTH
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 501 when the parameter store is not configured', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack',
      headers: AUTH
    });

    expect(res.statusCode).toBe(501);
  });

  it('rejects GET without a token (401)', async () => {
    const paramStore = {
      storeStackConfig: vi.fn(),
      loadStackConfig: vi.fn()
    } as unknown as ParamStore;
    const app = await buildApp(paramStore);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack'
    });
    expect(res.statusCode).toBe(401);
  });
});

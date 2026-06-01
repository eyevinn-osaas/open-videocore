import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

const getInstance = vi.fn();
const removeInstance = vi.fn();

vi.mock('@osaas/client-core', () => ({
  // createInstance/waitForInstanceReady are imported by provision.ts but the
  // DELETE path under test does not invoke them.
  createInstance: vi.fn(),
  getInstance: (...args: unknown[]) => getInstance(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  getPortsForInstance: vi.fn(),
  waitForInstanceReady: vi.fn(),
  Context: class {}
}));

import { provisionRouter } from './provision.js';

const osc = {
  getServiceAccessToken: vi.fn(async () => 'test-sat')
} as never;

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(provisionRouter, { prefix: '/api/v1/provision', osc });
  return app;
}

beforeEach(() => {
  getInstance.mockReset();
  removeInstance.mockReset();
});

describe('DELETE /api/v1/provision/:name', () => {
  it('returns 200 status=removed on full teardown', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/mystack'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('removed');
  });

  it('returns 404 status=not_found for an already-deleted stack', async () => {
    getInstance.mockResolvedValue(undefined);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/ghoststack'
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
      url: '/api/v1/provision/mystack'
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
      url: '/api/v1/provision/Invalid_Name'
    });
    expect(res.statusCode).toBe(400);
  });
});

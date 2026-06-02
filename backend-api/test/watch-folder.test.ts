// Watch-folder ingest tests (issue #16).
//
// Exercises WatchFolderService against the in-memory asset repository with a
// fake MinIO client (listObjectsV2 + listenBucketNotification stubbed). Covers:
//   - polling detects a direct-drop object and creates an asset (processing)
//   - onObjectStored fires with the workspace-local key (ffprobe trigger)
//   - idempotency: a key already processed is not re-ingested
//   - API-managed `sources/` keys are ignored (no duplicate assets)
//   - a bad/unparseable key is skipped without crashing
//   - bucket-notification events ingest objects
//   - start/stop lifecycle + processedCount + the admin status endpoint
//
// The fake client uses an injectable setInterval so polling is driven manually.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import {
  WatchFolderService,
  parseObjectKey,
  extractKeyFromNotification
} from '../src/pipeline/watch-folder.js';
import { adminRouter } from '../src/routes/admin.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

// Minimal fake MinIO client. `objects` is the bucket contents (full keys).
// listObjectsV2 returns a stream emitting one record per key. An optional
// notification emitter models listenBucketNotification.
function fakeClient(objects: string[], notifier?: EventEmitter & { stop?: () => void }) {
  return {
    listObjectsV2: (_bucket: string, _prefix: string, _recursive: boolean) => {
      const stream = new EventEmitter();
      // Emit asynchronously so listeners are attached first.
      queueMicrotask(() => {
        for (const name of objects) stream.emit('data', { name });
        stream.emit('end');
      });
      return stream;
    },
    listenBucketNotification: notifier ? () => notifier : undefined
  } as unknown as import('minio').Client;
}

describe('parseObjectKey', () => {
  it('splits a namespaced key into workspaceId + localKey', () => {
    expect(parseObjectKey('workspace-a/clips/video.mp4')).toEqual({
      workspaceId: 'workspace-a',
      localKey: 'clips/video.mp4'
    });
  });

  it('rejects keys without a prefix, with a leading slash, or a trailing slash', () => {
    expect(parseObjectKey('video.mp4')).toBeUndefined();
    expect(parseObjectKey('/video.mp4')).toBeUndefined();
    expect(parseObjectKey('workspace-a/')).toBeUndefined();
  });

  it('rejects an invalid workspaceId', () => {
    expect(parseObjectKey('bad ws/video.mp4')).toBeUndefined();
  });
});

describe('extractKeyFromNotification', () => {
  it('reads the key from an S3 event record and decodes it', () => {
    const record = { s3: { object: { key: 'workspace-a/my+clip.mp4' } } };
    expect(extractKeyFromNotification(record)).toBe('workspace-a/my clip.mp4');
  });

  it('returns undefined for a malformed record', () => {
    expect(extractKeyFromNotification({})).toBeUndefined();
    expect(extractKeyFromNotification(null)).toBeUndefined();
  });
});

describe('WatchFolderService polling', () => {
  let repo: InMemoryAssetRepository;

  beforeEach(() => {
    repo = new InMemoryAssetRepository();
  });

  it('detects a direct-drop object and creates a processing asset', async () => {
    const stored: Array<[string, string, string]> = [];
    const svc = new WatchFolderService({
      client: fakeClient(['workspace-a/drop.mp4']),
      bucket: 'src',
      repository: repo,
      log: silentLog,
      onObjectStored: (ws, id, key) => stored.push([ws, id, key]),
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {}
    });

    await svc.poll();

    const { items } = await repo.list('workspace-a');
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe('drop.mp4');
    expect(items[0]?.objectKey).toBe('drop.mp4');
    expect(items[0]?.status).toBe('processing');
    expect(stored).toEqual([['workspace-a', items[0]!.id, 'drop.mp4']]);
    expect(svc.processedCount()).toBe(1);
  });

  it('is idempotent: a second poll does not re-ingest', async () => {
    const svc = new WatchFolderService({
      client: fakeClient(['workspace-a/drop.mp4']),
      bucket: 'src',
      repository: repo,
      log: silentLog
    });
    await svc.poll();
    await svc.poll();
    const { items } = await repo.list('workspace-a');
    expect(items).toHaveLength(1);
  });

  it('ignores API-managed sources/ keys', async () => {
    const svc = new WatchFolderService({
      client: fakeClient(['workspace-a/sources/asset-1']),
      bucket: 'src',
      repository: repo,
      log: silentLog
    });
    await svc.poll();
    const { items } = await repo.list('workspace-a');
    expect(items).toHaveLength(0);
    // It is still marked processed so it is not re-scanned each poll.
    expect(svc.processedCount()).toBe(1);
  });

  it('skips a bad object key without crashing', async () => {
    const svc = new WatchFolderService({
      client: fakeClient(['no-prefix.mp4', 'workspace-a/good.mp4']),
      bucket: 'src',
      repository: repo,
      log: silentLog
    });
    await svc.poll();
    const { items } = await repo.list('workspace-a');
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe('good.mp4');
  });
});

describe('WatchFolderService notifications', () => {
  it('ingests an object delivered via a bucket notification', async () => {
    const repo = new InMemoryAssetRepository();
    const notifier = new EventEmitter() as EventEmitter & { stop?: () => void };
    notifier.stop = vi.fn();
    const svc = new WatchFolderService({
      client: fakeClient([], notifier),
      bucket: 'src',
      repository: repo,
      log: silentLog,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {}
    });

    svc.start();
    notifier.emit('notification', { s3: { object: { key: 'workspace-b/live.mp4' } } });
    // Allow the detached ingestKey microtask to settle.
    await new Promise((r) => setImmediate(r));

    const { items } = await repo.list('workspace-b');
    expect(items).toHaveLength(1);
    expect(items[0]?.objectKey).toBe('live.mp4');

    svc.stop();
    expect(notifier.stop).toHaveBeenCalled();
    expect(svc.isRunning()).toBe(false);
  });
});

describe('WatchFolderService lifecycle', () => {
  it('start is idempotent and stop flips running', () => {
    const svc = new WatchFolderService({
      client: fakeClient([]),
      bucket: 'src',
      repository: new InMemoryAssetRepository(),
      log: silentLog,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {}
    });
    expect(svc.isRunning()).toBe(false);
    svc.start();
    expect(svc.isRunning()).toBe(true);
    svc.start(); // no-op
    expect(svc.isRunning()).toBe(true);
    svc.stop();
    expect(svc.isRunning()).toBe(false);
  });
});

describe('GET /api/v1/admin/watch-folder/status', () => {
  async function build(watchFolder?: WatchFolderService) {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(adminRouter, { prefix: '/api/v1/admin', watchFolder });
    await app.ready();
    return app;
  }

  it('reports disabled when no service is wired', async () => {
    const app = await build(undefined);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/watch-folder/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, running: false, processedCount: 0 });
    await app.close();
  });

  it('reports enabled + running + processedCount when wired', async () => {
    const repo = new InMemoryAssetRepository();
    const svc = new WatchFolderService({
      client: fakeClient(['workspace-a/drop.mp4']),
      bucket: 'src',
      repository: repo,
      log: silentLog,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {}
    });
    await svc.poll();
    svc.start();
    const app = await build(svc);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/watch-folder/status' });
    expect(res.json()).toEqual({ enabled: true, running: true, processedCount: 1 });
    svc.stop();
    await app.close();
  });
});

// Workspace-scoped object storage (MinIO).
//
// Partitioning strategy: a shared bucket with a per-workspace key prefix
// `<workspaceId>/`. Every object key handled by route logic is forced under the
// caller's prefix, and listings are bounded to that prefix, so one workspace
// can neither read, write, nor enumerate another workspace's objects.
//
// A shared-bucket-with-prefix model is preferred over a bucket-per-workspace
// model because it avoids per-tenant provisioning on OSC: the source and
// packaged buckets are created once at provision time and reused for all
// workspaces (see ADR-001 / provision route).

import type { Client as MinioClient } from 'minio';
import { assertValidWorkspaceId, objectPrefix } from './guard.js';

export class WorkspaceStorage {
  private readonly prefix: string;

  constructor(
    private readonly workspaceId: string,
    private readonly client: MinioClient,
    private readonly bucket: string
  ) {
    assertValidWorkspaceId(workspaceId);
    this.prefix = objectPrefix(workspaceId);
  }

  // Resolve a caller-supplied local key to its fully namespaced object key.
  // Reject inputs that try to escape the prefix (absolute keys, traversal).
  private scopedKey(localKey: string): string {
    const normalized = localKey.replace(/^\/+/, '');
    if (normalized.includes('..')) {
      throw new Error('invalid object key');
    }
    return `${this.prefix}${normalized}`;
  }

  // A presigned PUT URL for direct upload, scoped to this workspace's prefix.
  async presignedPut(localKey: string, expirySeconds = 3600): Promise<string> {
    return this.client.presignedPutObject(this.bucket, this.scopedKey(localKey), expirySeconds);
  }

  // A presigned GET URL, scoped to this workspace's prefix.
  async presignedGet(localKey: string, expirySeconds = 3600): Promise<string> {
    return this.client.presignedGetObject(this.bucket, this.scopedKey(localKey), expirySeconds);
  }

  async statObject(localKey: string): Promise<{ size: number; etag: string } | undefined> {
    try {
      const stat = await this.client.statObject(this.bucket, this.scopedKey(localKey));
      return { size: stat.size, etag: stat.etag };
    } catch (err) {
      if ((err as { code?: string }).code === 'NotFound') {
        return undefined;
      }
      throw err;
    }
  }

  async removeObject(localKey: string): Promise<void> {
    await this.client.removeObject(this.bucket, this.scopedKey(localKey));
  }

  // List object keys for this workspace only, returned WITHOUT the workspace
  // prefix so callers see workspace-local keys.
  async list(): Promise<string[]> {
    const keys: string[] = [];
    const stream = this.client.listObjectsV2(this.bucket, this.prefix, true);
    return await new Promise<string[]>((resolve, reject) => {
      stream.on('data', (obj) => {
        if (obj.name && obj.name.startsWith(this.prefix)) {
          keys.push(obj.name.slice(this.prefix.length));
        }
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }
}

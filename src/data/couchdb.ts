// Workspace-scoped CouchDB access.
//
// Partitioning strategy: CouchDB partitioned databases. Every document id is
// `<workspaceId>:<localId>`, which makes the workspace id the CouchDB partition
// key. Reads, writes, and queries are confined to the caller's partition, and
// every fetched document is re-checked through assertOwned so a forged id from
// another partition is rejected. We never use the full-database (`_all_docs`)
// path for workspace-facing reads.

import nano from 'nano';
import type { DocumentScope, ServerScope } from 'nano';
import { assertOwned, assertValidWorkspaceId, namespacedId } from './guard.js';

export type StoredDoc = {
  _id: string;
  _rev?: string;
  workspaceId: string;
  resourceType: string;
  [key: string]: unknown;
};

export class WorkspaceCouch {
  private readonly db: DocumentScope<StoredDoc>;

  constructor(
    private readonly workspaceId: string,
    server: ServerScope,
    dbName: string
  ) {
    assertValidWorkspaceId(workspaceId);
    this.db = server.use<StoredDoc>(dbName);
  }

  // Insert or update a document inside this workspace's partition. The stored
  // workspaceId is always forced to the caller's id; a body claiming another
  // workspace cannot escape its partition.
  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    const _id = namespacedId(this.workspaceId, localId);
    const doc: StoredDoc = {
      ...body,
      _id,
      workspaceId: this.workspaceId,
      resourceType: String(body['resourceType'] ?? 'asset')
    };
    const res = await this.db.insert(doc);
    return { id: res.id, rev: res.rev };
  }

  // Fetch one document by its local id. Returns undefined if it does not exist
  // in this workspace's partition. Cross-workspace ids resolve to undefined.
  async get(localId: string): Promise<StoredDoc | undefined> {
    const _id = namespacedId(this.workspaceId, localId);
    try {
      const doc = await this.db.get(_id);
      assertOwned(this.workspaceId, doc.workspaceId);
      return doc;
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  // List documents in this workspace only, using the partitioned query API so
  // CouchDB never scans other partitions.
  async list(opts: { limit?: number; skip?: number } = {}): Promise<StoredDoc[]> {
    const result = await this.db.partitionedList(this.workspaceId, {
      include_docs: true,
      limit: opts.limit ?? 50,
      skip: opts.skip ?? 0
    });
    const docs: StoredDoc[] = [];
    for (const row of result.rows) {
      const doc = row.doc as StoredDoc | undefined;
      if (doc && doc.workspaceId === this.workspaceId) {
        docs.push(doc);
      }
    }
    return docs;
  }

  // Run a partitioned Mango query confined to this workspace's partition. The
  // workspaceId predicate is always injected so a caller-supplied selector can
  // never reach another partition. Returns matching docs; pagination is the
  // caller's responsibility via limit/skip.
  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const result = await this.db.partitionedFind(this.workspaceId, {
      selector: { ...selector, workspaceId: this.workspaceId },
      limit: opts.limit ?? 50,
      skip: opts.skip ?? 0
    });
    return result.docs.filter((d) => d.workspaceId === this.workspaceId);
  }

  // Count documents matching a selector inside this workspace's partition.
  // Used for pagination totals and delete-blocking child counts. CouchDB Mango
  // has no native count, so we fetch ids only (fields projection) and length
  // them; bounded by a generous cap to avoid unbounded reads.
  async count(selector: Record<string, unknown>): Promise<number> {
    const result = await this.db.partitionedFind(this.workspaceId, {
      selector: { ...selector, workspaceId: this.workspaceId },
      fields: ['_id'],
      limit: COUNT_CAP
    });
    return result.docs.length;
  }

  async remove(localId: string): Promise<void> {
    const existing = await this.get(localId);
    if (!existing || !existing._rev) {
      return;
    }
    await this.db.destroy(existing._id, existing._rev);
  }
}

// Upper bound for count() reads. A workspace with more matching docs than this
// reports the cap; see OSC friction log for the lack of a native count API.
const COUNT_CAP = 10_000;

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { statusCode?: number }).statusCode === 404 ||
      (err as { status?: number }).status === 404)
  );
}

// Build a server scope from a CouchDB URL. Connection details come from the
// environment per 12-factor; no credentials are hardcoded.
export function couchServer(url: string): ServerScope {
  return nano(url);
}

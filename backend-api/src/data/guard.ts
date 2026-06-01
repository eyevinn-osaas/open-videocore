// Cross-workspace access guard.
//
// Central place to enforce that a resource belongs to the calling workspace.
// Every read or mutation of a stored resource is checked through assertOwned
// so that a guessed or leaked resource id from another tenant is rejected
// rather than silently returned.

export class WorkspaceAccessError extends Error {
  readonly statusCode = 403;
  constructor(message = 'cross-workspace access denied') {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

// A workspace id must be a non-empty, opaque token-derived string. We reject
// anything that could break the key/prefix namespacing (separators, slashes).
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]+$/;

export function assertValidWorkspaceId(workspaceId: string): void {
  if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId)) {
    throw new WorkspaceAccessError('invalid workspace id');
  }
}

// Throw unless the stored resource's workspace matches the caller's workspace.
// `resourceWorkspaceId` is undefined when a resource does not exist; we treat a
// miss the same as a foreign resource so existence is not leaked across
// workspaces.
export function assertOwned(
  callerWorkspaceId: string,
  resourceWorkspaceId: string | undefined
): void {
  if (!resourceWorkspaceId || resourceWorkspaceId !== callerWorkspaceId) {
    throw new WorkspaceAccessError();
  }
}

// Build the namespaced document/object id used in CouchDB and MinIO. The
// workspace id is a hard prefix so cross-workspace ids cannot collide.
export function namespacedId(workspaceId: string, localId: string): string {
  assertValidWorkspaceId(workspaceId);
  return `${workspaceId}:${localId}`;
}

// MinIO object key prefix for a workspace. All objects for a workspace live
// under `<workspaceId>/` inside the shared bucket.
export function objectPrefix(workspaceId: string): string {
  assertValidWorkspaceId(workspaceId);
  return `${workspaceId}/`;
}

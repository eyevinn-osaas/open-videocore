import { describe, it, expect } from 'vitest';
import {
  assertOwned,
  assertValidWorkspaceId,
  namespacedId,
  objectPrefix,
  WorkspaceAccessError
} from '../src/data/guard.js';

describe('workspace guard primitives', () => {
  it('namespaces ids with the workspace as a hard prefix', () => {
    expect(namespacedId('ws1', 'asset-9')).toBe('ws1:asset-9');
  });

  it('builds a per-workspace object prefix', () => {
    expect(objectPrefix('ws1')).toBe('ws1/');
  });

  it('rejects invalid workspace ids that could break namespacing', () => {
    expect(() => assertValidWorkspaceId('')).toThrow(WorkspaceAccessError);
    expect(() => assertValidWorkspaceId('a/b')).toThrow(WorkspaceAccessError);
    expect(() => assertValidWorkspaceId('a:b')).toThrow(WorkspaceAccessError);
    expect(() => assertValidWorkspaceId('ok-id_1.2')).not.toThrow();
  });

  it('allows a resource owned by the caller', () => {
    expect(() => assertOwned('ws1', 'ws1')).not.toThrow();
  });

  it('rejects a resource owned by another workspace', () => {
    expect(() => assertOwned('ws1', 'ws2')).toThrow(WorkspaceAccessError);
  });

  it('rejects a missing resource (no existence leak)', () => {
    expect(() => assertOwned('ws1', undefined)).toThrow(WorkspaceAccessError);
  });
});

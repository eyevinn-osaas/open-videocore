// Workspace-scoped PostgreSQL access.
//
// Partitioning strategy: a single shared schema where every workspace-owned
// table carries a `workspace_id` column. This layer is the ONLY sanctioned way
// for route handlers to query those tables: every method injects a
// `workspace_id = $n` predicate so no query can read or mutate another
// workspace's rows. Handlers never assemble raw SQL against these tables
// directly.
//
// PostgreSQL FTS (ADR-001, open question 3) is used for search; the search
// method applies the same workspace predicate alongside the text match.

import type { Pool, QueryResultRow } from 'pg';
import { assertValidWorkspaceId } from './guard.js';

// Identifier allow-list: table and column names are never taken from request
// input. Only known tables may be addressed through this layer.
const ALLOWED_TABLES = new Set(['assets', 'jobs', 'collections', 'webhooks']);

function assertTable(table: string): void {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`unknown table: ${table}`);
  }
}

export class WorkspacePg {
  constructor(
    private readonly workspaceId: string,
    private readonly pool: Pool
  ) {
    assertValidWorkspaceId(workspaceId);
  }

  // Insert a row, forcing workspace_id to the caller's workspace regardless of
  // anything in `values`.
  async insert<T extends QueryResultRow>(
    table: string,
    values: Record<string, unknown>
  ): Promise<T> {
    assertTable(table);
    const cols = Object.keys(values).filter((c) => c !== 'workspace_id');
    const allCols = ['workspace_id', ...cols];
    const params = [this.workspaceId, ...cols.map((c) => values[c])];
    const placeholders = allCols.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const res = await this.pool.query<T>(sql, params);
    return res.rows[0];
  }

  // Fetch one row by id, scoped to this workspace. Returns undefined for a row
  // that does not exist or belongs to another workspace.
  async getById<T extends QueryResultRow>(table: string, id: string): Promise<T | undefined> {
    assertTable(table);
    const sql = `SELECT * FROM ${table} WHERE id = $1 AND workspace_id = $2 LIMIT 1`;
    const res = await this.pool.query<T>(sql, [id, this.workspaceId]);
    return res.rows[0];
  }

  // List rows in this workspace only.
  async list<T extends QueryResultRow>(
    table: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<T[]> {
    assertTable(table);
    const sql = `SELECT * FROM ${table} WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
    const res = await this.pool.query<T>(sql, [
      this.workspaceId,
      opts.limit ?? 50,
      opts.offset ?? 0
    ]);
    return res.rows;
  }

  // Full-text search confined to this workspace. The workspace predicate is
  // applied in the same WHERE clause as the FTS match, so search never returns
  // another workspace's rows.
  async search<T extends QueryResultRow>(
    table: string,
    query: string,
    opts: { limit?: number } = {}
  ): Promise<T[]> {
    assertTable(table);
    const sql =
      `SELECT * FROM ${table} ` +
      `WHERE workspace_id = $1 AND search_vector @@ plainto_tsquery('english', $2) ` +
      `ORDER BY ts_rank(search_vector, plainto_tsquery('english', $2)) DESC LIMIT $3`;
    const res = await this.pool.query<T>(sql, [this.workspaceId, query, opts.limit ?? 50]);
    return res.rows;
  }

  // Delete a row, scoped to this workspace. A cross-workspace id deletes
  // nothing. Returns the number of rows removed.
  async deleteById(table: string, id: string): Promise<number> {
    assertTable(table);
    const sql = `DELETE FROM ${table} WHERE id = $1 AND workspace_id = $2`;
    const res = await this.pool.query(sql, [id, this.workspaceId]);
    return res.rowCount ?? 0;
  }
}

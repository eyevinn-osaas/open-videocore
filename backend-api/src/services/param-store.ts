// OSC parameter store client (issue #31, ADR-002).
//
// After a stack is provisioned we persist its non-secret connection
// coordinates to the OSC parameter store (the `eyevinn-app-config-svc`
// service) so the API can reconnect to a named stack at runtime without the
// caller re-supplying every endpoint. Deprovision (#29) also reads the stored
// `services` list to know what to tear down.
//
// The @osaas/client-core SDK does not (as of 2026-06-01) expose parameter-store
// helpers — the store is itself an OSC service instance exposing an HTTP
// key/value API guarded by an API key. We therefore talk to it over HTTP here,
// mirroring the narrow-interface + HTTP-impl pattern used by EncoreClient
// (pipeline/encore-client.ts). The friction is logged to
// docs/osc-feedback/incoming-issue31-param-store.md.
//
// SECURITY: only non-secret connection coordinates are stored. Passwords and
// password-bearing connection strings must never be written here — callers are
// responsible for stripping credentials before handing values to storeStackConfig
// (see stripCredentials).

// The connection coordinates persisted for a provisioned stack. Every value is
// a host/URL/endpoint or a bucket name — NO passwords, NO credential-bearing
// connection strings. See the storage list in issue #31.
export type StackConfig = {
  minioEndpoint: string;
  // CouchDB host/URL only — no embedded password.
  couchdbUrl: string;
  // PostgreSQL host/port/db only — credentials stripped.
  databaseUrl: string;
  redisUrl: string;
  encoreUrl: string;
  encoreCallbackUrl: string;
  sourceBucket: string;
  packagedBucket: string;
  // The OSC instances that make up the stack, for deprovision (#29).
  services: { serviceId: string; instanceName: string }[];
};

// Narrow interface so the provision/read routes can be tested without a live
// parameter store. The HTTP implementation is makeHttpParamStore.
export interface ParamStore {
  // Persist all coordinates for one named stack, scoped to a workspace.
  storeStackConfig(
    workspaceId: string,
    name: string,
    config: StackConfig
  ): Promise<void>;
  // Read back the coordinates for a named stack, or undefined if none stored.
  loadStackConfig(
    workspaceId: string,
    name: string
  ): Promise<StackConfig | undefined>;
  // Remove the stored coordinates for a named stack (deprovision, #29). Must be
  // idempotent: deleting an already-absent entry resolves without error.
  deleteStackConfig(workspaceId: string, name: string): Promise<void>;
}

// Key under which a stack's config blob is stored. Namespaced by workspace so
// two tenants may use the same stack name without collision, and prefixed with
// `openvideocore/` so open-videocore keys are distinguishable from any other
// consumer of a shared store.
export function stackConfigKey(workspaceId: string, name: string): string {
  return `openvideocore/${workspaceId}/${name}`;
}

// Strip any embedded userinfo (user:password@) from a URL-shaped connection
// string, leaving scheme://host[:port][/path]. Used to guarantee that no
// password is ever persisted. Non-URL strings are returned unchanged.
export function stripCredentials(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // Not a parseable URL — fall back to a regex strip of a userinfo segment.
    return connectionString.replace(/(^[a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  }
}

// True if a connection string carries embedded userinfo (user[:password]@).
// Distinct from stripCredentials' round-trip — that also normalises the URL
// (e.g. adds a trailing slash), which is not a credential leak.
export function hasCredentials(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return url.username !== '' || url.password !== '';
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^@/]*@/i.test(connectionString);
  }
}

// Defensive assertion: throw if any value in the config still carries an
// embedded credential. Called before writing so a regression upstream cannot
// silently leak a password into the store.
function assertNoCredentials(config: StackConfig): void {
  for (const key of [
    'couchdbUrl',
    'databaseUrl',
    'redisUrl',
    'minioEndpoint',
    'encoreUrl',
    'encoreCallbackUrl'
  ] as const) {
    if (hasCredentials(config[key])) {
      throw new Error(
        `refusing to store credential-bearing value for "${key}" in the parameter store`
      );
    }
  }
}

export type HttpParamStoreConfig = {
  // Base URL of the eyevinn-app-config-svc instance (PARAMETER_STORE_URL).
  baseUrl: string;
  // API key guarding the store (PARAMETER_STORE_API_KEY).
  apiKey: string;
  // Injectable fetch for tests; defaults to global fetch.
  fetch?: typeof globalThis.fetch;
  // Per-request timeout in milliseconds. All external OSC calls must be bounded.
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

// HTTP-backed parameter store. The store exposes a simple key/value REST API:
//   PUT  /api/v1/parameter/:key   { value: <string> }
//   GET  /api/v1/parameter/:key   -> { key, value }
// guarded by `Authorization: Bearer <apiKey>`. The stack config is serialised
// to a single JSON value under stackConfigKey so a read/write is one round-trip.
export function makeHttpParamStore(config: HttpParamStoreConfig): ParamStore {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = config.baseUrl.replace(/\/$/, '');

  function paramUrl(key: string): string {
    // Encode the key so the `/`-containing namespace survives as a single
    // path segment.
    return `${base}/api/v1/parameter/${encodeURIComponent(key)}`;
  }

  async function withTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  const authHeader = { authorization: `Bearer ${config.apiKey}` };

  return {
    async storeStackConfig(workspaceId, name, stackConfig) {
      assertNoCredentials(stackConfig);
      const key = stackConfigKey(workspaceId, name);
      const res = await withTimeout((signal) =>
        doFetch(paramUrl(key), {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify({ value: JSON.stringify(stackConfig) }),
          signal
        })
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `parameter store write failed: ${res.status} ${text}`.trim()
        );
      }
    },

    async loadStackConfig(workspaceId, name) {
      const key = stackConfigKey(workspaceId, name);
      const res = await withTimeout((signal) =>
        doFetch(paramUrl(key), { method: 'GET', headers: authHeader, signal })
      );
      if (res.status === 404) {
        return undefined;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `parameter store read failed: ${res.status} ${text}`.trim()
        );
      }
      const body = (await res.json().catch(() => ({}))) as { value?: string };
      if (typeof body.value !== 'string' || body.value.length === 0) {
        return undefined;
      }
      try {
        return JSON.parse(body.value) as StackConfig;
      } catch {
        throw new Error(
          `parameter store value for "${key}" is not valid JSON`
        );
      }
    },

    async deleteStackConfig(workspaceId, name) {
      const key = stackConfigKey(workspaceId, name);
      const res = await withTimeout((signal) =>
        doFetch(paramUrl(key), { method: 'DELETE', headers: authHeader, signal })
      );
      // 404 is success from an idempotency standpoint: the entry is already
      // gone, which is exactly the desired end state.
      if (res.status === 404 || res.ok) {
        return;
      }
      const text = await res.text().catch(() => '');
      throw new Error(
        `parameter store delete failed: ${res.status} ${text}`.trim()
      );
    }
  };
}

// Build a ParamStore from the environment, or return undefined when the store
// is not configured. PARAMETER_STORE_URL + PARAMETER_STORE_API_KEY must both be
// present; PARAMETER_STORE_NAME is the human-facing store name (logged, not
// required to construct the client). When undefined, the provision route must
// fail with a clear error rather than silently skipping persistence.
export function paramStoreFromEnv(): ParamStore | undefined {
  const baseUrl = process.env['PARAMETER_STORE_URL'];
  const apiKey = process.env['PARAMETER_STORE_API_KEY'];
  if (!baseUrl || !apiKey) {
    return undefined;
  }
  return makeHttpParamStore({ baseUrl, apiKey });
}

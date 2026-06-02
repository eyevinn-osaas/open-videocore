# OSC friction — parameter store SDK gap (issue #31)

**Date:** 2026-06-01
**Surface:** backend-api
**Service:** `eyevinn-app-config-svc` (OSC parameter store)

## What we needed

After provisioning a stack (issue #2/#30), the API persists the stack's
non-secret connection coordinates to the OSC parameter store so it (and
deprovision, #29) can rediscover a named stack at runtime — per ADR-002.

## Friction

The `@osaas/client-core` SDK (v0.24.0) exposes **no parameter-store helpers**.
Inspected `node_modules/@osaas/client-core/lib/index.d.ts`: the public surface
is instances (`createInstance`, `getInstance`, ...), jobs, admin, secrets
(`saveSecret`), and My App helpers. There is no `setParameter`,
`getParameter`, `bulkSetParameters`, or any `app-config` module. The MCP tools
`set-parameter` / `get-parameter` / `bulk-set-parameters` exist for agent/CLI
use but are not callable from the running service.

ADR-001's Day-1 plan (`mcp__osc__set-parameter`, `mcp__osc__get-parameter`)
likewise assumes MCP/CLI access, not a programmatic SDK path for the service
itself.

## Workaround

Implemented an HTTP-backed client (`backend-api/src/services/param-store.ts`)
that talks to the `eyevinn-app-config-svc` instance's key/value REST API
directly, mirroring the EncoreClient pattern. Configured via
`PARAMETER_STORE_URL` + `PARAMETER_STORE_API_KEY` env vars. The store is
treated as a convenience cache: provisioning still succeeds (and returns all
coordinates) if a write fails.

## Asks for OSC

1. Add first-class parameter-store helpers to `@osaas/client-core`
   (`getParameter`, `setParameter`, `bulkSetParameters`) so services do not
   each reinvent the HTTP client.
2. Confirm the `eyevinn-app-config-svc` REST contract (path shape, auth header,
   404 semantics on missing key). Our client assumes
   `PUT/GET /api/v1/parameter/:key` with `Authorization: Bearer <apiKey>` and a
   `{ value }` body — **FLAGGED FOR SMOKE-TEST VERIFICATION** against a live
   instance.

## Open questions

- Exact REST contract of `eyevinn-app-config-svc` (see ask #2).
- ADR-002 is referenced by the issue but not yet present in this repo
  (`docs/architecture/` has only ADR-001). The key-naming and workspace-scoping
  decisions here (`openvideocore/<workspaceId>/<name>`) should be ratified in
  ADR-002 when written.

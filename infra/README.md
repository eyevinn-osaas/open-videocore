# open-videocore — Infrastructure

open-videocore provisions OSC service instances on behalf of operators via its API. There is no separate infra provisioning step — deploying open-videocore itself is the setup.

## How it works

1. Deploy open-videocore to OSC (or run it locally with `pnpm dev` in `backend-api/`).
2. Supply your `OSC_ACCESS_TOKEN` — on OSC this is injected automatically at service creation time.
3. Call `POST /api/v1/provision` to provision a full stack (MinIO, CouchDB, PostgreSQL, Valkey, Encore, etc.) in your OSC workspace.

open-videocore uses `@osaas/client-core` (`Context`, `createInstance`, `removeInstance`) for all OSC API calls.

## OSC services provisioned by the API

See [../docs/architecture/ADR-001-osc-stack.md](../docs/architecture/ADR-001-osc-stack.md) for the full service list and rationale.

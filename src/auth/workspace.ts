// Request authentication gate.
//
// open-videocore is gated behind the OSC platform auth wall (ADR-003): every
// inbound request reaches the process only after the platform has authenticated
// the caller. The auth wall is treated as a PURE GATE — open-videocore does not
// read a per-request workspace/tenant identifier, because tenant isolation is
// structural: OSC provisions a separate set of backing resources (CouchDB,
// PostgreSQL, MinIO, Encore) per deploying tenant, so a deployed instance IS the
// tenant's workspace. There is no shared backing store across tenants and thus
// no in-app workspace scoping to perform.
//
// Previously this module called the OSC `mysubscriptions` endpoint to resolve a
// token to a tenant id used as a per-request workspace scope. That resolution is
// REMOVED (ADR-003 / issue #59): there is no tenant to resolve and nothing to
// scope. We only require a bearer token to be present so a deployment
// accidentally exposed without the wall (or an off-OSC deployment behind an
// equivalent proxy) rejects anonymous traffic rather than serving it.

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// The single, deployment-wide resource context. A deployed instance is one
// stack (ADR-003), so all data lives in one context. This constant is the stable
// token embedded in encoreJobIds (for the auto-scaler's Valkey pool keying) and
// the stack resolver's cache key; it is NOT a tenant/workspace identifier derived
// from the request.
export const DEPLOYMENT_CONTEXT = 'default';

// Gate an inbound request: resolve to true when a bearer token is present (the
// OSC auth wall has already authenticated it upstream); throw AuthError when no
// token is present so anonymous traffic is rejected. It is a pure presence gate —
// the token is intentionally not inspected for identity, and nothing is scoped.
export async function requireAuth(token: string | undefined): Promise<boolean> {
  if (!token || token.trim().length === 0) {
    throw new AuthError('missing access token');
  }
  return true;
}

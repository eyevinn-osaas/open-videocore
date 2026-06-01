import {
  Context,
  getInstance,
  removeInstance
} from '@osaas/client-core';
import { TEARDOWN_ORDER, type StackService } from './stack.js';

// Per-service outcome of a teardown attempt.
//   removed    — instance existed and was removed this call
//   not_found  — instance did not exist (already gone / never created) — this
//                is a success from an idempotency standpoint
//   failed     — the OSC call errored; the operation should be retried
export type TeardownStatus = 'removed' | 'not_found' | 'failed';

export type ServiceTeardownResult = {
  serviceId: string;
  role: string;
  status: TeardownStatus;
  error?: string;
};

// Aggregate stack-level status.
//   removed     — every service was removed this call
//   not_found   — every service was already absent (nothing to do)
//   partial     — a mix of removed/not_found, but at least one removal happened
//                 and no failures
//   failed      — at least one service failed to tear down (retryable)
export type StackTeardownStatus =
  | 'removed'
  | 'not_found'
  | 'partial'
  | 'failed';

export type StackTeardownResult = {
  name: string;
  status: StackTeardownStatus;
  services: ServiceTeardownResult[];
};

// Tear down a single OSC service instance, tolerating the already-removed case.
// We probe with getInstance first (returns undefined on 404) so a retry of a
// partially-completed teardown reports not_found rather than re-erroring.
async function teardownService(
  osc: Context,
  service: StackService,
  name: string
): Promise<ServiceTeardownResult> {
  const { serviceId, role } = service;
  try {
    const sat = await osc.getServiceAccessToken(serviceId);

    const existing = await getInstance(osc, serviceId, name, sat);
    if (!existing) {
      return { serviceId, role, status: 'not_found' };
    }

    await removeInstance(osc, serviceId, name, sat);
    return { serviceId, role, status: 'removed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { serviceId, role, status: 'failed', error: message };
  }
}

// Tear down an entire stack in dependency-safe order. Failures do not abort the
// run: every service is attempted so a single transient error does not strand
// the rest of the stack. Partial failures are accumulated and reported, and the
// whole operation is safe to retry (idempotent) because each step probes for
// existence first and treats a missing instance as success.
export async function deprovisionStack(
  osc: Context,
  name: string
): Promise<StackTeardownResult> {
  const services: ServiceTeardownResult[] = [];

  // Sequential teardown: respecting dependency order requires that a consumer
  // is fully removed before the producer it depends on, so we do not parallelise.
  for (const service of TEARDOWN_ORDER) {
    services.push(await teardownService(osc, service, name));
  }

  const anyFailed = services.some((s) => s.status === 'failed');
  const anyRemoved = services.some((s) => s.status === 'removed');

  let status: StackTeardownStatus;
  if (anyFailed) {
    status = 'failed';
  } else if (!anyRemoved) {
    status = 'not_found';
  } else if (services.every((s) => s.status === 'removed')) {
    status = 'removed';
  } else {
    status = 'partial';
  }

  return { name, status, services };
}

// Shared polling helper for OSC eyevinn-ffmpeg-s3 ephemeral jobs.
//
// The SDK's waitForJobToComplete polls for status === 'Complete', but
// eyevinn-ffmpeg-s3 uses 'SuccessCriteriaMet' as its terminal success status.
// This causes the SDK to loop all 1000 iterations (~16 min) before giving up.
//
// OSC FRICTION: logged in docs/osc-feedback/incoming-issue6-metadata.md

import type { getJob } from '@osaas/client-core';
import type { Context } from '@osaas/client-core';

const TERMINAL_STATUSES = new Set(['SuccessCriteriaMet', 'Complete', 'Failed', 'Error']);
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 120_000;

export type JobPoller = {
  context: Context;
  getJob: typeof getJob;
};

export async function pollOscJobUntilDone(
  api: JobPoller,
  serviceId: string,
  name: string,
  sat: string
): Promise<string> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    const job = (await api.getJob(api.context, serviceId, name, sat)) as { status?: string };
    const status = job?.status ?? '';
    if (TERMINAL_STATUSES.has(status)) return status;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`OSC job "${name}" did not complete within ${POLL_MAX_MS / 1000}s`);
}

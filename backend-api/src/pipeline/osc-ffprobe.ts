// Default ProbeRunner backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #6).
//
// eyevinn-ffmpeg-s3 is a `job`-type OSC service: createJob spins up an
// ephemeral container that runs an ffmpeg/ffprobe command line and exits. We
// drive ffprobe in JSON mode against a presigned MinIO object URL:
//
//   ffprobe -v quiet -print_format json -show_format -show_streams <url>
//
// then wait for the job to complete and read its logs to recover the JSON the
// process wrote to stdout.
//
// OSC FRICTION (logged): waitForJobToComplete() resolves void — the OSC job API
// does not return a job's stdout/output. The only channel to recover ffprobe's
// JSON is getLogsForInstance(), which returns the captured container log as a
// string (or string[]). We therefore scrape the JSON object out of the log
// text. This is brittle (log framing, truncation, interleaved stderr) and is
// recorded in docs/osc-feedback/incoming-issue6-metadata.md. If/when the job
// service exposes a structured result artifact (e.g. writing JSON back to S3),
// this runner should be reworked to read that instead of parsing logs.

import {
  createJob,
  getLogsForInstance,
  removeJob,
  waitForJobToComplete,
  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import type { FfprobeResult, ProbeRunner } from './metadata-extractor.js';

// Subset of the OSC SDK surface this runner needs. Declared structurally so the
// real SDK functions satisfy it and tests can pass lightweight fakes.
export type OscJobApi = {
  context: Context;
  createJob: typeof createJob;
  waitForJobToComplete: typeof waitForJobToComplete;
  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
};

// Build the ffprobe command line that runs inside the ephemeral container. JSON
// to stdout; quiet so stderr noise does not pollute the parseable log.
export function ffprobeCmdLine(presignedUrl: string): string {
  // The URL is quoted so query-string separators are not split by the shell.
  return `-v quiet -print_format json -show_format -show_streams "${presignedUrl}"`;
}

// Extract the first balanced top-level JSON object from a log blob. ffprobe
// writes a single JSON document to stdout; surrounding log lines (timestamps,
// container framing) are tolerated by scanning for the outermost braces.
export function parseFfprobeJsonFromLog(log: string): FfprobeResult {
  const start = log.indexOf('{');
  if (start === -1) {
    throw new Error('ffprobe produced no JSON output');
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < log.length; i++) {
    const ch = log[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const json = log.slice(start, i + 1);
        return JSON.parse(json) as FfprobeResult;
      }
    }
  }
  throw new Error('ffprobe output JSON was truncated or malformed');
}

// A unique, OSC-valid ephemeral job name. Lowercase alphanumeric, bounded
// length (OSC instance-name constraints, see provision.ts).
function probeJobName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `ffprobe${ts}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

// Construct the production ProbeRunner. Each invocation creates an ephemeral
// ffprobe job, waits for completion, scrapes the JSON from its logs, and
// best-effort removes the job so spent ephemeral instances do not accumulate.
export function makeOscProbeRunner(api: OscJobApi): ProbeRunner {
  return async (presignedUrl: string): Promise<FfprobeResult> => {
    const sat = await api.context.getServiceAccessToken(FFPROBE_SERVICE_ID);
    const name = probeJobName();
    await api.createJob(api.context, FFPROBE_SERVICE_ID, sat, {
      name,
      cmdLineArgs: ffprobeCmdLine(presignedUrl)
    });
    try {
      await api.waitForJobToComplete(api.context, FFPROBE_SERVICE_ID, name, sat);
      const log = await api.getLogsForInstance(api.context, FFPROBE_SERVICE_ID, name, sat);
      const text = Array.isArray(log) ? log.join('\n') : log;
      return parseFfprobeJsonFromLog(text);
    } finally {
      // Reclaim the ephemeral instance. Failure here is non-fatal: the probe
      // result (if any) has already been read.
      try {
        await api.removeJob(api.context, FFPROBE_SERVICE_ID, name, sat);
      } catch {
        // ignore cleanup failure
      }
    }
  };
}

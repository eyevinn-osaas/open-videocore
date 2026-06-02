// Default FrameExtractor backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #7).
//
// The same service used for ffprobe (issue #6) runs ffmpeg against a downloaded
// HTTPS source. For thumbnails we seek to each timecode and emit a single JPEG
// frame. eyevinn-ffmpeg-s3 downloads the `-i` source URL before running ffmpeg
// and uploads ffmpeg's output files back to S3; we hand it the destination as a
// presigned PUT URL per frame so each JPEG lands at the object key we chose.
//
// One ffmpeg invocation can write all frames in a single pass using one
// `-ss/-frames:v 1` output per timecode. Seeking BEFORE each `-i` (input-level
// seek) is fast and accurate enough for poster frames. We do one job per
// extraction request, then best-effort removeJob so spent ephemeral instances
// do not accumulate (same lifecycle as osc-ffprobe.ts).
//
// OSC FRICTION (logged, issue #6): eyevinn-ffmpeg-s3 exposes no structured job
// result and ffprobe is not accessible — see
// docs/osc-feedback/submitted-2026-06-02-issue6-metadata.md. For thumbnails the
// produced artifacts are the S3 objects themselves, so we do not need to scrape
// logs; the job either writes the frames or fails.

import {
  createJob,
  getLogsForInstance,
  removeJob,
  waitForJobToComplete,
  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import type { FrameExtractor, FrameTarget } from './thumbnail.js';

// Subset of the OSC SDK surface this runner needs. Declared structurally so the
// real SDK functions satisfy it and tests can pass lightweight fakes (mirrors
// OscJobApi in osc-ffprobe.ts).
export type OscJobApi = {
  context: Context;
  createJob: typeof createJob;
  waitForJobToComplete: typeof waitForJobToComplete;
  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
};

// Build a single ffmpeg command line that seeks to every frame's timecode and
// writes one JPEG per frame to its presigned PUT URL. Input-level `-ss` before
// each `-i` keeps seeks fast. `-frames:v 1` emits exactly one frame; `-f image2`
// + the `.jpg` URL forces the JPEG encoder. `-y` overwrites so re-runs are
// idempotent.
export function thumbnailCmdLine(sourceUrl: string, frames: FrameTarget[]): string {
  if (frames.length === 0) {
    throw new Error('no frames requested');
  }
  return frames
    .map(
      (f) =>
        `-y -ss ${f.timecodeSeconds} -i "${sourceUrl}" -frames:v 1 -f image2 "${f.putUrl}"`
    )
    .join(' ');
}

// A unique, OSC-valid ephemeral job name. Lowercase alphanumeric, bounded
// length (OSC instance-name constraints). Mirrors probeJobName in osc-ffprobe.ts.
function thumbnailJobName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `thumb${ts}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

// Construct the production FrameExtractor. Each invocation creates one ephemeral
// ffmpeg job that writes every requested frame, waits for completion, then
// best-effort removes the job.
export function makeOscThumbnailExtractor(api: OscJobApi): FrameExtractor {
  return async (sourceUrl: string, frames: FrameTarget[]): Promise<void> => {
    const sat = await api.context.getServiceAccessToken(FFPROBE_SERVICE_ID);
    const name = thumbnailJobName();
    await api.createJob(api.context, FFPROBE_SERVICE_ID, sat, {
      name,
      cmdLineArgs: thumbnailCmdLine(sourceUrl, frames)
    });
    try {
      await api.waitForJobToComplete(api.context, FFPROBE_SERVICE_ID, name, sat);
    } finally {
      try {
        await api.removeJob(api.context, FFPROBE_SERVICE_ID, name, sat);
      } catch {
        // ignore cleanup failure
      }
    }
  };
}

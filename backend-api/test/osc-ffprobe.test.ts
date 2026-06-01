// OSC ffprobe runner tests (issue #6).
//
// The runner drives eyevinn-ffmpeg-s3 via the OSC job API and recovers ffprobe
// JSON by scraping the job logs (see OSC friction note in osc-ffprobe.ts).
// These tests cover the log-scraping parser and the create/wait/log/cleanup
// orchestration against fake OSC job functions.

import { describe, it, expect, vi } from 'vitest';
import {
  ffprobeCmdLine,
  makeOscProbeRunner,
  parseFfprobeJsonFromLog,
  type OscJobApi
} from '../src/pipeline/osc-ffprobe.js';

describe('parseFfprobeJsonFromLog', () => {
  it('extracts a JSON object embedded in surrounding log lines', () => {
    const log = [
      '2026-06-01T00:00:00Z starting ffprobe',
      '{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"format_name":"mp4"}}',
      '2026-06-01T00:00:01Z done'
    ].join('\n');
    const parsed = parseFfprobeJsonFromLog(log);
    expect(parsed.streams?.[0].codec_name).toBe('h264');
    expect(parsed.format?.format_name).toBe('mp4');
  });

  it('handles braces inside string values', () => {
    const log = 'noise {"format":{"format_name":"a{b}c"}} trailing';
    expect(parseFfprobeJsonFromLog(log).format?.format_name).toBe('a{b}c');
  });

  it('throws when no JSON is present', () => {
    expect(() => parseFfprobeJsonFromLog('no json here')).toThrow(/no JSON/);
  });

  it('throws on truncated JSON', () => {
    expect(() => parseFfprobeJsonFromLog('{"format":{')).toThrow(/truncated|malformed/);
  });
});

describe('ffprobeCmdLine', () => {
  it('requests JSON output and quotes the URL', () => {
    const cmd = ffprobeCmdLine('https://minio/obj?sig=a&b=c');
    expect(cmd).toContain('-print_format json');
    expect(cmd).toContain('-show_streams');
    expect(cmd).toContain('"https://minio/obj?sig=a&b=c"');
  });
});

describe('makeOscProbeRunner', () => {
  function fakeApi(log: string): OscJobApi {
    const context = {
      getServiceAccessToken: vi.fn(async () => 'sat-token')
    } as unknown as OscJobApi['context'];
    return {
      context,
      createJob: vi.fn(async () => ({ name: 'x' })),
      waitForJobToComplete: vi.fn(async () => undefined),
      getLogsForInstance: vi.fn(async () => log),
      removeJob: vi.fn(async () => undefined)
    } as unknown as OscJobApi;
  }

  it('creates a job, waits, scrapes logs, and cleans up', async () => {
    const api = fakeApi('{"format":{"format_name":"mp4"},"streams":[]}');
    const run = makeOscProbeRunner(api);
    const result = await run('https://minio/obj?sig=a');
    expect(result.format?.format_name).toBe('mp4');
    expect(api.createJob).toHaveBeenCalledOnce();
    expect(api.waitForJobToComplete).toHaveBeenCalledOnce();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  it('joins string[] logs before parsing', async () => {
    const api = fakeApi('ignored');
    (api.getLogsForInstance as ReturnType<typeof vi.fn>).mockResolvedValue([
      'line1',
      '{"streams":[{"codec_type":"video","codec_name":"vp9"}]}'
    ]);
    const result = await makeOscProbeRunner(api)('https://minio/obj');
    expect(result.streams?.[0].codec_name).toBe('vp9');
  });

  it('still cleans up the job when log parsing fails', async () => {
    const api = fakeApi('no json at all');
    await expect(makeOscProbeRunner(api)('https://minio/obj')).rejects.toThrow();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });
});

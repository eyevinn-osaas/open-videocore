// ABR encoding presets + the Encore profile shape (issue #8).
//
// Encore is driven by an "encore profile": a named set of inputs/outputs that
// describe the ABR ladder to produce. open-videocore ships three built-in ABR
// presets (1080p, 720p, 480p) so a caller can transcode with a single
// `profile` name and never hand-author a ladder. A caller who needs something
// bespoke may instead pass a full `customProfile` that conforms to
// EncoreProfile, which is forwarded to Encore verbatim.
//
// Each preset's top rung names the resolution (1080p = a ladder topping out at
// 1920x1080, etc.) and each lower rung is a standard step down, so every preset
// is a genuine adaptive ladder rather than a single rendition.

// A single output rung of an Encore profile. These map to the fields Encore's
// transcode API expects per output rendition.
export type EncoreOutput = {
  // Human label for the rung; also used to name the produced child asset.
  label: string;
  width: number;
  height: number;
  // Target video bitrate in bits per second.
  videoBitrateBps: number;
  // Target audio bitrate in bits per second.
  audioBitrateBps: number;
  // Container/segment format Encore should emit (e.g. "mp4", "fmp4").
  format: string;
};

// An Encore profile. `inputs` are filled in per job (the source object), so a
// stored/preset profile carries only `name` + the `outputs` ladder; the worker
// injects the concrete input when it submits the job.
export type EncoreProfile = {
  name: string;
  inputs?: EncoreInput[];
  outputs: EncoreOutput[];
};

export type EncoreInput = {
  // S3 URI (or presigned URL) of the source object Encore should read.
  uri: string;
  type?: string;
};

export const PRESET_NAMES = ['1080p', '720p', '480p'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

// Standard audio rung shared by all rungs of every preset (128 kbps AAC).
const AUDIO_BITRATE_BPS = 128_000;

function rung(label: string, width: number, height: number, videoKbps: number): EncoreOutput {
  return {
    label,
    width,
    height,
    videoBitrateBps: videoKbps * 1000,
    audioBitrateBps: AUDIO_BITRATE_BPS,
    format: 'mp4'
  };
}

// The three built-in ABR ladders. Each is named by its top rung; lower rungs
// are conventional steps down so adaptive players can switch under bandwidth
// pressure.
export const PRESETS: Record<PresetName, EncoreProfile> = {
  '1080p': {
    name: 'abr-1080p',
    outputs: [
      rung('1080p', 1920, 1080, 5000),
      rung('720p', 1280, 720, 3000),
      rung('480p', 854, 480, 1500),
      rung('360p', 640, 360, 800)
    ]
  },
  '720p': {
    name: 'abr-720p',
    outputs: [
      rung('720p', 1280, 720, 3000),
      rung('480p', 854, 480, 1500),
      rung('360p', 640, 360, 800)
    ]
  },
  '480p': {
    name: 'abr-480p',
    outputs: [
      rung('480p', 854, 480, 1500),
      rung('360p', 640, 360, 800)
    ]
  }
};

// Resolve a request's profile selection into a concrete EncoreProfile. Exactly
// one of `preset` / `customProfile` should be supplied; a preset wins if both
// are given is NOT allowed by the route schema, so this assumes a clean input.
export function resolveProfile(
  preset: PresetName | undefined,
  customProfile: EncoreProfile | undefined
): EncoreProfile {
  if (customProfile) {
    return customProfile;
  }
  return PRESETS[preset ?? '1080p'];
}

// Encore transcoding profile catalogue.
//
// Encore loads its available transcoding profiles from a YAML index file whose
// URL is configured via `profilesUrl` on the OSC Encore service instance. The
// index is a flat map of profile name -> filename, e.g.:
//   program: program.yml
//   program-x265: program-x265.yml
//   archive: archive.yml
// The profile *names* (the keys) are what get submitted as `profile` in an
// Encore job, so this endpoint surfaces them to the UI for a picker.
//
// This is a public, read-only metadata endpoint (no authentication) that
// fetches + parses that index and returns the sorted profile names. It never
// breaks the UI: on any fetch/parse failure it returns an empty list plus an
// `error` field with HTTP 200.
//
// Contracts fetched before writing (CLAUDE.md rule 7):
//   - package.json — `js-yaml` is NOT a dependency, so the trivial `key: value`
//     index format is parsed line-by-line (keys before the first ':').
//   - src/routes/encore-compat.ts — structural template for a Fastify plugin
//     using the ZodTypeProvider and an `opts` object (FastifyPluginAsync<Opts>).

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

export type ProfilesRouterOptions = {
  // Full URL to the Encore YAML profile index (the `profilesUrl` value).
  profilesUrl: string;
};

const profilesResponseSchema = z.object({
  profiles: z.array(z.string()),
  error: z.string().optional()
});

// In-memory cache TTL. The index changes rarely and a stale-for-5-minutes view
// is fine for a picker; this keeps us from hitting GitHub on every page load.
const CACHE_TTL_MS = 5 * 60 * 1000;

// Timeout for the upstream fetch so a slow/hung index host can't block the UI.
const FETCH_TIMEOUT_MS = 5000;

// Parse the trivial Encore profile index: one `key: value` per line. We only
// need the keys (profile names). Comments (#...) and blank lines are skipped,
// as are nested/indented lines (the index is a flat map).
function parseProfileNames(yaml: string): string[] {
  const names: string[] = [];
  for (const rawLine of yaml.split(/\r?\n/)) {
    // Skip indented lines (not top-level keys), comments, and blanks.
    if (rawLine.length === 0 || /^\s/.test(rawLine)) continue;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('---')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (key.length > 0) names.push(key);
  }
  return names;
}

export const profilesRouter: FastifyPluginAsync<ProfilesRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  let cache: { profiles: string[]; at: number } | undefined;

  // List available Encore transcoding profile names.
  //   200 — { profiles: string[] } (sorted, "none" excluded), or on failure
  //         { profiles: [], error: "could not fetch profiles" }
  app.get(
    '/',
    {
      schema: {
        response: { 200: profilesResponseSchema }
      }
    },
    async (_request, reply) => {
      if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
        return reply.code(200).send({ profiles: cache.profiles });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(opts.profilesUrl, { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`profiles index responded ${res.status}`);
        }
        const body = await res.text();
        const profiles = parseProfileNames(body)
          .filter((name) => name !== 'none')
          .sort((a, b) => a.localeCompare(b));
        cache = { profiles, at: Date.now() };
        return reply.code(200).send({ profiles });
      } catch (err) {
        app.log.warn(
          { err, profilesUrl: opts.profilesUrl },
          'could not fetch Encore profiles index'
        );
        return reply.code(200).send({ profiles: [], error: 'could not fetch profiles' });
      } finally {
        clearTimeout(timeout);
      }
    }
  );
};

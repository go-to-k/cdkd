import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUSTOM_RESOURCE_RESPONSE_PREFIX } from '../../../src/state/state-prefix.js';
import { CUSTOM_RESOURCE_RESPONSE_PREFIX as VIA_STATE_FILE_KEYS } from '../../../src/cli/commands/state-file-keys.js';

/**
 * Issue #2052 — the PRODUCER and the COLLECTOR of
 * `custom-resource-responses/{requestId}.json` must agree on the prefix.
 *
 * `CustomResourceProvider` writes the objects; `cdkd gc` is the only thing that
 * collects them. Two spellings would make the sweeper silently stop covering
 * the family it exists for — a sweeper is the shape whose failure is
 * indistinguishable from success, since "found nothing" and "looked in the
 * wrong place" produce identical output.
 *
 * ## Why this file was rewritten before it ever shipped
 *
 * The first cut scanned a HAND-WRITTEN four-file list for the literal split on
 * `'custom-resource-responses'` — with both quote characters included. A review
 * probe showed two ways past it, and one of them is the spelling anybody would
 * actually write:
 *
 *   - `listRawObjects('custom-resource-responses/')` — the trailing slash sits
 *     before the closing quote, so the two-quote needle never matches;
 *   - a copy added to any file outside the hand list, e.g. `s3-state-backend.ts`.
 *
 * Both left the fence 3/3 green. It is the same defect this repo's own guidance
 * names — grep for the SHAPE, not for a NAME — committed by the fence written to
 * prevent it. So the population is now DERIVED (`git ls-files`) and the needle
 * is quoting-agnostic, with floors on both so a broken glob or a broken regex
 * fails loudly instead of reporting a clean tree.
 *
 * ## ...and why DERIVING it was not enough on its own
 *
 * The first derived spelling was a single `git ls-files 'src/**\/*.ts'`, which
 * returned 326 of the 328 tracked `src` TypeScript files: git's wildmatch
 * requires a literal `/` for the `**\/` segment, so a TOP-LEVEL file matches
 * neither `**\/` nor the rest of the pattern. The two it silently omitted are
 * `src/index.ts` — the library ENTRYPOINT, the single most likely place for a
 * re-exported constant — and `src/version.ts`. Adding
 * `export const STRAY_PREFIX = 'custom-resource-responses/'` to `src/index.ts`
 * left the fence green, and a `> 200` count floor cannot see a two-file hole.
 *
 * So the pathspec is now the pair `'src/*.ts' 'src/**\/*.ts'` (measured: 328,
 * the full tracked set), and the population floor names the two files the
 * broken glob dropped rather than only counting. A count floor answers "did the
 * glob break completely?"; a membership floor answers "is the file a copy would
 * land in actually being read?", which is the question that was being missed.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** The one file allowed to spell the literal. */
const DEFINITION_SITE = 'src/state/state-prefix.ts';

/**
 * Any quoting, with or without a trailing slash.
 *
 * Single quote, double quote and backtick all appear in this codebase, and the
 * trailing `/` is how the listing call spells it — the exact shape the previous
 * needle missed.
 */
const LITERAL = /['"`]custom-resource-responses\/?['"`]/g;

/**
 * Every tracked `.ts` file under `src/`, TOP-LEVEL ones included.
 *
 * Two pathspecs, not one: git wildmatch needs a literal `/` for the `**\/`
 * segment, so a lone `src/**\/*.ts` skips `src/index.ts` and `src/version.ts`.
 * See the header — that omission is what let a copy in the library entrypoint
 * pass the fence.
 */
function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src/*.ts', 'src/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean);
}

describe('custom-resource response prefix (issue #2052)', () => {
  it('is one binding, re-exported rather than re-spelled', () => {
    expect(VIA_STATE_FILE_KEYS).toBe(CUSTOM_RESOURCE_RESPONSE_PREFIX);
    expect(CUSTOM_RESOURCE_RESPONSE_PREFIX).toBe('custom-resource-responses');
  });

  it('appears as a bare literal ONLY where it is defined', () => {
    const files = sourceFiles();
    // Floor on the POPULATION: a glob that stopped matching would otherwise
    // report a clean tree, which is the failure this rewrite exists to end.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(DEFINITION_SITE);
    // ...and specifically on the TOP-LEVEL files, which are the ones the
    // previous single-pathspec glob dropped. A count floor cannot see a
    // two-file hole; naming them can, and `src/index.ts` is the library
    // entrypoint — the likeliest place of all for a re-exported copy.
    expect(files).toContain('src/index.ts');
    expect(files).toContain('src/version.ts');

    const offenders: string[] = [];
    let seenAtDefinition = 0;
    for (const rel of files) {
      const hits = (readFileSync(join(REPO_ROOT, rel), 'utf-8').match(LITERAL) ?? []).length;
      if (hits === 0) continue;
      if (rel === DEFINITION_SITE) {
        seenAtDefinition += hits;
        continue;
      }
      offenders.push(`${rel} (${hits})`);
    }
    // Floor on the NEEDLE: proves the regex can still see the literal at all.
    expect(seenAtDefinition).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('matches the literal in every quoting a copy could use', () => {
    // The regex is the fence's discriminator, so it is asserted directly rather
    // than trusted — the previous needle looked equally correct.
    for (const spelling of [
      `'custom-resource-responses'`,
      `"custom-resource-responses"`,
      '`custom-resource-responses`',
      `'custom-resource-responses/'`,
      `"custom-resource-responses/"`,
      '`custom-resource-responses/`',
    ]) {
      expect(spelling).toMatch(new RegExp(LITERAL.source));
    }
  });

  it('is the prefix the provider actually defaults to', () => {
    const provider = readFileSync(
      join(REPO_ROOT, 'src/provisioning/providers/custom-resource-provider.ts'),
      'utf-8'
    );
    expect(provider).toContain('config?.responsePrefix ?? CUSTOM_RESOURCE_RESPONSE_PREFIX');
  });
});

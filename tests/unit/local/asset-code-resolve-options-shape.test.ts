import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * The DECLARATION SHAPE of `resolveAssetCodeDirectory` (issue
 * go-to-k/cdkd#3549). Source properties only — three of them, each invisible
 * to a behavioural test.
 *
 * **What this file does NOT cover, stated first because the first revision of
 * it claimed the opposite.** It asserted that a wrong or dropped containment
 * bound "is invisible in every fixture that is not a Stage" and therefore
 * needed a source scan. That is false:
 * `local-asset-code-path-containment.test.ts` already drives BOTH call sites
 * through their public entry points against a STAGE manifest, expressly so a
 * dropped bound (fails closed, refusing every Stage asset) and a widened one
 * (fails open) each red. Its header says so, and it was written for exactly
 * this hazard on go-to-k/cdkd#3493.
 *
 * Measured rather than argued: transposing the VALUES at the invoke call site
 * (`{ manifestDir: assetOutdir, assetOutdir: manifestDir }`) reds three cases
 * there and passed every case this file used to carry. So the behavioural
 * fence is that suite, the member-by-member scanning this file used to do was
 * both redundant and weaker, and it is gone.
 *
 * It also follows that the bag does not make a transposition INEXPRESSIBLE,
 * only unorderable — a caller can still write the wrong value under the right
 * name. What the bag removes is the silent positional swap, which the compiler
 * now rejects; what remains is the named swap, which that suite catches.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');
const RESOLVER = 'src/local/lambda-resolver.ts';
const read = (p: string) => readFileSync(join(REPO, p), 'utf-8');

describe('resolveAssetCodeDirectory declaration shape', () => {
  it('takes exactly one parameter, the options bag', () => {
    // A pattern rather than the exact source line: renaming `opts` or
    // reflowing the signature would red an exact-string assertion for nothing,
    // and the property being pinned is the ARITY.
    expect(read(RESOLVER)).toMatch(
      /export function resolveAssetCodeDirectory\(\s*opts:\s*AssetCodeResolveOptions,?\s*\)/,
    );
  });

  it('declares AssetCodeResolveOptions IMMEDIATELY above it', () => {
    // The hazard is a doc block DETACHING from its declaration because an edit
    // inserted between the two — four times in this repo. Order alone does not
    // catch that: an insertion still leaves the interface above the function.
    // Adjacency does.
    const src = read(RESOLVER);
    const iface = src.indexOf('export interface AssetCodeResolveOptions');
    expect(iface).toBeGreaterThan(-1);
    const close = src.indexOf('\n}\n', iface);
    const between = src.slice(close + 3, src.indexOf('export function resolveAssetCodeDirectory'));
    // Only the function's own doc block may sit between them.
    expect(between.trimStart().startsWith('/**'), `unexpected code between: ${between}`).toBe(true);
    expect(between.split('*/').length - 1, 'more than one block between').toBe(1);
  });

  it('has no positional call anywhere in src/', () => {
    // Scans `src/**` rather than a hardcoded file list: a fence naming its own
    // call sites goes silently incomplete the day a third one is added. The
    // declaration is stripped first — the first revision of this case matched
    // it and reported the declaration as a violation.
    const files = listTs(join(REPO, 'src'));
    expect(files.length).toBeGreaterThan(50);
    for (const abs of files) {
      const src = readFileSync(abs, 'utf-8');
      if (!src.includes('resolveAssetCodeDirectory(')) continue;
      const scrubbed = src.replace(/export function resolveAssetCodeDirectory\([^)]*\)/g, '');
      // A bag literal or a variable holding one are both fine; a bare string
      // first argument is the positional spelling.
      expect(scrubbed, `${abs}: positional call`).not.toMatch(
        /resolveAssetCodeDirectory\(\s*['"`]/,
      );
    }
  });
});

function listTs(dir: string): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

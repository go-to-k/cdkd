import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import type {
  AssetCodeResolveOptions,
  resolveAssetCodeDirectory,
} from '../../../src/local/lambda-resolver.js';

/**
 * TWO properties of `resolveAssetCodeDirectory`'s declaration (issue
 * go-to-k/cdkd#3549), and this file is deliberately small.
 *
 * **What it does NOT cover, stated first because the first revision claimed
 * the opposite.** It asserted that a wrong or dropped containment bound "is
 * invisible in every fixture that is not a Stage" and therefore needed a
 * source scan. That is false:
 * `local-asset-code-path-containment.test.ts` already drives BOTH call sites
 * through their public entry points against a STAGE manifest, expressly so a
 * dropped bound (fails closed, refusing every Stage asset) and a widened one
 * (fails open) each red. Its header says so, and it was written for exactly
 * this hazard on go-to-k/cdkd#3493.
 *
 * Measured rather than argued: transposing the VALUES at the invoke call site
 * (`{ manifestDir: assetOutdir, assetOutdir: manifestDir }`) reds three cases
 * there and passed every case this file used to carry. So the behavioural
 * fence is that suite, and the member-by-member scanning this file used to do
 * was both redundant and weaker.
 *
 * It follows that the bag does not make a transposition INEXPRESSIBLE, only
 * unorderable — a caller can still write the wrong value under the right name.
 * What the bag removes is the silent positional swap, which the compiler now
 * rejects; what remains is the named swap, which that suite catches.
 *
 * **Why only two cases are left.** Three hand-rolled regexes lived here across
 * three review rounds and each was found to carry a false PASS: the member
 * scan, the positional-call scan, and the first adjacency check. The constant
 * was not any one case — it was the medium, a regex standing in for a parse.
 * The surviving pair is chosen on one test: WHEN THIS CASE MISSES, AM I WORSE
 * OFF THAN WITH NO CASE AT ALL?
 *
 * - A positional-call scan: yes, worse. `TS2554` already decides that exactly,
 *   on every build, and an approximation of it adds only a coverage claim that
 *   was twice untrue. Deleted; the arity check below subsumes its purpose.
 * - Arity: kept, as a TYPE assertion rather than a regex. The type system
 *   decides it precisely and cannot be fooled by a reflow, a renamed `opts` or
 *   a mention in a comment.
 * - Adjacency: kept, and it is the only property here with no other observer.
 *   Neither the compiler nor any behavioural test can see a doc block detach
 *   from its declaration, and it has happened four times in this repo. When it
 *   misses, that is the status quo rather than a false claim of coverage.
 */

/**
 * The arity, decided by the type system.
 *
 * **It fails under `vp run typecheck:test`, NOT under `vp run test`.** Vitest's
 * in-run typecheck covers `*.test-d.ts` only, so a `.test.ts` run prints
 * `Type Errors  no errors` whatever this says — measured, and it is why the
 * first probe of this assertion read as a false pass. CI runs both.
 *
 * Measured against the three mutations it claims:
 *
 * - an added REQUIRED parameter — reds here AND at both call sites (`TS2554`);
 * - an added OPTIONAL one — reds ONLY here. Every existing call still
 *   typechecks, so this line is the whole signal for that shape;
 * - a `...args` overload — its union `Parameters` fails the tuple check.
 */
type OneBagParameter =
  Parameters<typeof resolveAssetCodeDirectory> extends [AssetCodeResolveOptions] ? true : never;
const ARITY_IS_ONE_BAG: OneBagParameter = true;

const RESOLVER = 'src/local/lambda-resolver.ts';
const read = (p: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', '..', p), 'utf-8');

describe('resolveAssetCodeDirectory declaration shape', () => {
  it('takes exactly one parameter, the options bag', () => {
    // The assertion is the TYPE above; typecheck is where it fails. This case
    // exists so the constant is referenced — an unused type alias is erased
    // and would be checked by nothing.
    expect(ARITY_IS_ONE_BAG).toBe(true);
  });

  it('declares AssetCodeResolveOptions IMMEDIATELY above it', () => {
    // The hazard is a doc block DETACHING from its declaration because an edit
    // inserted between the two. Order alone does not catch it, and neither
    // does looking only BELOW the interface: the second revision asserted that
    // the gap starts with `/**` and holds one `*/`, which an UNDOCUMENTED
    // declaration inserted AFTER the doc block satisfies while the doc now
    // documents that declaration. My own probe had inserted BEFORE the doc, a
    // shape the order check already caught, so it proved nothing. Both halves
    // are needed.
    const src = read(RESOLVER);
    const iface = src.indexOf('export interface AssetCodeResolveOptions');
    expect(iface).toBeGreaterThan(-1);
    const close = src.indexOf('\n}\n', iface);
    // CRLF, or a reflow that loses the column-0 close, gives -1 and a slice
    // from index 2 — a confusing red rather than an honest one.
    expect(close, 'interface close brace not found at column 0').toBeGreaterThan(iface);
    const between = src.slice(close + 3, src.indexOf('export function resolveAssetCodeDirectory'));
    expect(between.trimStart().startsWith('/**'), `unexpected code between: ${between}`).toBe(true);
    expect(between.split('*/').length - 1, 'more than one block between').toBe(1);
    // The other half: the doc block must END immediately before the function,
    // so nothing can sit between the doc and what it documents.
    expect(src).toMatch(/\*\/\s*export function resolveAssetCodeDirectory\(/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * `resolveAssetCodeDirectory` takes every value in `AssetCodeResolveOptions`
 * (issue go-to-k/cdkd#3549). The BAG is what makes a transposition
 * inexpressible; these cases fence the half a type cannot.
 *
 * Why a source scan rather than a behavioural test: the two call sites pass
 * `manifestDir` and `assetOutdir` from `assetPathDirs(stack)`, and for a
 * TOP-LEVEL stack those two are the SAME directory — so a call site that
 * passed the wrong one, or dropped the bound, behaves identically in every
 * fixture that is not a Stage. The bound is only observable through a Stage,
 * `.claude/rules/layout-local.md` records that a wrong bound FAILS CLOSED
 * (refuses everything) rather than opening a hole, and neither direction looks
 * like a containment bug to a test that only checks refusals. What is worth
 * pinning is therefore the WIRING: that each site names the members at all.
 *
 * The behaviour itself is covered by `local-asset-code-path-containment.test.ts`,
 * including the Stage acceptance cases that distinguish the two directories.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');

/** Every site that calls the resolver, and the error class it must keep. */
const CALL_SITES = [
  ['src/local/lambda-resolver.ts', 'LocalInvokeResolutionError'],
  ['src/cli/commands/local-start-api.ts', 'Error'],
] as const;

const read = (p: string) => readFileSync(join(REPO, p), 'utf-8');

describe('resolveAssetCodeDirectory call sites pass the whole bag', () => {
  it.each(CALL_SITES)('%s names every member', (file) => {
    const src = read(file);
    const call = /resolveAssetCodeDirectory\(\{([\s\S]*?)\}\)/.exec(src);
    expect(call, `${file}: no options-bag call found`).not.toBeNull();
    const body = call![1]!;
    for (const member of ['manifestDir', 'assetPath', 'wrapError', 'assetOutdir', 'logicalId']) {
      expect(body, `${file} drops ${member}`).toContain(member);
    }
  });

  it.each(CALL_SITES)('%s keeps its own error class', (file, klass) => {
    const call = /resolveAssetCodeDirectory\(\{([\s\S]*?)\}\)/.exec(read(file))!;
    // The resolver throws through the CALLER's `wrapError` precisely so each
    // command names itself; a shared class would make one command's refusal
    // read as the other's.
    expect(call[1]!).toContain(`new ${klass}(`);
  });

  it('no positional call survives anywhere', () => {
    // A leftover positional call is a compile error today, but this states the
    // invariant so a future `...args` overload cannot quietly restore one.
    for (const [file] of CALL_SITES) {
      // `export function resolveAssetCodeDirectory(opts: ...)` is the
      // DECLARATION and lives in one of these files, so it has to be dropped
      // before the scan — the first revision of this case matched it and
      // reported the declaration as a positional call.
      const src = read(file).replace(/export function resolveAssetCodeDirectory\([^)]*\)/g, '');
      expect(src, `${file}: positional call`).not.toMatch(/resolveAssetCodeDirectory\(\s*[^{]/);
    }
  });

  it('the resolver takes exactly one parameter', () => {
    const src = read('src/local/lambda-resolver.ts');
    expect(src).toContain(
      'export function resolveAssetCodeDirectory(opts: AssetCodeResolveOptions): string {',
    );
  });

  it('the interface is declared ABOVE the function it documents', () => {
    // Four of these interfaces have had their doc block detach from the
    // declaration below them in this repo, each time by an edit inserting
    // between the two. Declaring the interface at the top of the region is the
    // structural answer, so its position is the thing to pin.
    const src = read('src/local/lambda-resolver.ts');
    const iface = src.indexOf('export interface AssetCodeResolveOptions');
    const fn = src.indexOf('export function resolveAssetCodeDirectory');
    expect(iface).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(iface);
  });
});

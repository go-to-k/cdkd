import { describe, it, expect } from 'vite-plus/test';
import {
  DEV_VERSION_SENTINEL,
  getCdkdVersion,
  isVersionOnlyInvocation,
} from '../../src/version.js';

describe('getCdkdVersion', () => {
  it('falls back to the dev sentinel when the build-time define has not run', () => {
    // tsdown's `define` only runs for `vp run build`, so under vitest the
    // identifier is genuinely absent — this asserts the guard, not a stub.
    expect(getCdkdVersion()).toBe(DEV_VERSION_SENTINEL);
  });
});

describe('isVersionOnlyInvocation', () => {
  // The fast path answers WITHOUT importing the command tree, so anything it
  // accepts is an invocation commander never sees. Each accepted case below is
  // therefore a claim that commander would have printed the version too.
  it.each([['--version'], ['-V']])('accepts a lone %s', (flag) => {
    expect(isVersionOnlyInvocation([flag])).toBe(true);
  });

  // The other direction: over-tightening is as much a defect as over-matching,
  // so the accepted set above is pinned by name rather than only by exclusion.
  it('accepts exactly the two flags commander registers, and no others', () => {
    const accepted = ['--version', '-V', '-v', '--Version', '--VERSION', 'version', '--ver'].filter(
      (flag) => isVersionOnlyInvocation([flag])
    );
    expect(accepted).toEqual(['--version', '-V']);
  });

  it.each([
    [[], 'no arguments at all — commander prints help'],
    [['deploy'], 'a bare subcommand'],
    [['deploy', '--version'], 'a version flag AFTER a subcommand'],
    [['--version', 'deploy'], 'a version flag BEFORE a subcommand'],
    [['--version', '--version'], 'the flag twice'],
    [['-c', 'note=--version'], 'the flag spelled inside an option argument'],
    [['deploy', '-c', 'msg=-V'], 'the short flag spelled inside an option argument'],
    [['--profile', '-V'], 'a version flag positioned where an option value would go'],
    [['-c', '--version'], 'a long version flag positioned where an option value would go'],
  ])('refuses %j (%s)', (argv) => {
    expect(isVersionOnlyInvocation(argv)).toBe(false);
  });

  it('refuses every shape whose answer belongs to commander, so those paths are unchanged', () => {
    // The load-bearing property: for anything the fast path refuses, cdkd's
    // behaviour is byte-identical to before the fast path existed, because the
    // full commander parse still runs.
    //
    // Note what this does NOT claim. Measured against commander 12.1.0,
    // `cdkd -c --version` / `cdkd --profile -V` DO print the version — so the
    // refusals below are conservative rather than corrections of a commander
    // disagreement. They are here because a wider predicate would be a second
    // spelling of commander's precedence, which is commander's behaviour and
    // not cdkd's; refusing costs only the slow path.
    expect(isVersionOnlyInvocation(['--profile', '-V'])).toBe(false);
    expect(isVersionOnlyInvocation(['-c', '--version'])).toBe(false);
    expect(isVersionOnlyInvocation(['--version'])).toBe(true);
  });
});

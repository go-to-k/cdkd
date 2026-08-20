import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Integ `verify.sh` scripts must run under the bash a contributor actually has.
 *
 * macOS still ships **bash 3.2** as `/bin/bash`, and these scripts are run by
 * hand far more often than in CI. A bash-4-only expansion does NOT fail a
 * syntax check -- `bash -n` accepts `${VAR,,}` and only the RUNTIME errors with
 * `bad substitution` -- so nothing in the existing lint suite or in a reviewer's
 * `bash -n` pass can see it.
 *
 * Found 2026-08-19 in `acm-certificate/verify.sh` (PR #2010): a `${STACK,,}`
 * inside the EXIT trap's leak sweep. Under 3.2 it would abort the trap's tail
 * and make the script exit on the substitution error instead of the run's real
 * status -- a passing integ reported as failed, or a failing one losing its
 * reason, in the one code path whose whole job is cleaning up after a real-AWS
 * run. It was the only such expansion in the tree, so nothing else established
 * a bash-4 floor for these scripts and no contributor had reason to expect one.
 *
 * Portable replacements: `$(printf '%s' "$V" | tr '[:upper:]' '[:lower:]')` for
 * case conversion; a plain indexed array or a `case` for an associative array;
 * a `while read` loop for `mapfile` / `readarray`.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

interface Bash4ism {
  /** What to look for. */
  readonly pattern: RegExp;
  /** Named in the failure so the fix is obvious without opening bash's manual. */
  readonly what: string;
  readonly instead: string;
}

const BASH4_ISMS: readonly Bash4ism[] = [
  {
    // ${V,,} ${V^^} ${V,} ${V^} -- case modification, bash 4.0+.
    pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(\^\^?|,,?)\}/,
    what: 'case-modifying parameter expansion (${VAR,,} / ${VAR^^})',
    instead: `\$(printf '%s' "\$VAR" | tr '[:upper:]' '[:lower:]')`,
  },
  {
    pattern: /\bdeclare\s+-A\b|\blocal\s+-A\b/,
    what: 'associative array (declare -A)',
    instead: 'an indexed array, or a `case` statement',
  },
  {
    pattern: /\b(mapfile|readarray)\b/,
    what: 'mapfile / readarray',
    instead: 'a `while IFS= read -r` loop',
  },
];

/**
 * Every fixture `verify.sh`, plus every SHARED helper sitting directly in
 * `tests/integration/` (e.g. `s3-versions.sh`, issue #2096, sourced by seven
 * fixtures).
 *
 * The shared helpers are scanned because that is where a bash-4-ism does the
 * MOST damage while being the least likely to be noticed: the file belongs to
 * no single fixture, and nobody debugging the fixture that broke would think to
 * open it.
 */
function readVerifyScripts(): { name: string; lines: string[] }[] {
  const entries = readdirSync(INTEG_ROOT, { withFileTypes: true });
  const fixtures = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: `${e.name}/verify.sh`, path: join(INTEG_ROOT, e.name, 'verify.sh') }));
  const shared = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sh'))
    .map((e) => ({ name: e.name, path: join(INTEG_ROOT, e.name) }));
  return [...fixtures, ...shared]
    .filter((f) => existsSync(f.path))
    .map((f) => ({ name: f.name, lines: readFileSync(f.path, 'utf8').split('\n') }));
}

/**
 * Comment-stripped scan. A bash-4-ism QUOTED in a comment is exactly what the
 * fix for one leaves behind ("`tr`, not `${STACK,,}`, because..."), and
 * flagging that would make the rule un-followable: you could not explain the
 * trap in the file where it happened.
 */
function findIsms(lines: string[]): string[] {
  const hits: string[] = [];
  lines.forEach((line, i) => {
    const code = line.replace(/(^|\s)#.*$/, '');
    for (const ism of BASH4_ISMS) {
      if (ism.pattern.test(code)) hits.push(`line ${i + 1}: ${ism.what} -- use ${ism.instead}`);
    }
  });
  return hits;
}

describe('integ verify.sh scripts stay bash 3.2 compatible', () => {
  const scripts = readVerifyScripts();

  it('finds the fixture tree', () => {
    // Guards the whole suite from passing by scanning nothing -- a wrong
    // INTEG_ROOT would otherwise report every fixture clean.
    expect(scripts.length).toBeGreaterThan(50);
  });

  it('also scans the shared helpers (per-SHAPE floor, not just a total)', () => {
    // An aggregate floor cannot tell "the shared helper is clean" from "it was
    // never read": 200+ fixtures swamp one file. Assert the shape separately.
    const shared = scripts.filter((s) => !s.name.includes('/'));
    expect(shared.length).toBeGreaterThanOrEqual(1);
    expect(shared.some((s) => s.name === 's3-versions.sh')).toBe(true);
  });

  it('detects each bash-4-ism it claims to (positive control)', () => {
    // The lint must prove it can SEE its input. Without this, a regex that
    // silently stopped matching would report the tree clean forever.
    expect(findIsms(['S=Foo', 'echo "${S,,}"'])).toHaveLength(1);
    expect(findIsms(['echo "${S^^}"'])).toHaveLength(1);
    expect(findIsms(['declare -A map'])).toHaveLength(1);
    expect(findIsms(['mapfile -t arr < f'])).toHaveLength(1);
  });

  it('does not flag a bash-4-ism quoted inside a comment', () => {
    expect(findIsms(['  # `tr`, not `${STACK,,}`: needs bash >= 4'])).toEqual([]);
  });

  it('does not flag the portable replacements', () => {
    expect(
      findIsms([`  x=$(printf '%s' "\${STACK}" | tr '[:upper:]' '[:lower:]')`])
    ).toEqual([]);
    expect(findIsms(['  while IFS= read -r l; do :; done < f'])).toEqual([]);
  });

  it('no fixture or shared helper uses a bash-4-only construct', () => {
    const offenders = scripts.flatMap((s) => findIsms(s.lines).map((h) => `${s.name} ${h}`)).sort();
    expect(offenders).toEqual([]);
  });
});

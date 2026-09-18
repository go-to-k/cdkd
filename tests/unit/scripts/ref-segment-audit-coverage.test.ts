import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Every `REF_RETURNS_SEGMENT_AFTER_PIPE` entry must be pinned by a unit test
 * that names the type literal.
 *
 * WHY. That Set lists Cloud-Control-provisioned resource types whose compound
 * physicalId (`<parent>|<child>`) must have its CloudFormation `Ref` resolved
 * to the trailing `<child>` segment. Getting an entry WRONG — or omitting a
 * sibling in the same service family — ships a latent bug where `Ref` leaks the
 * whole compound id and AWS rejects the downstream resource. That is what
 * happened to `AWS::Cognito::UserPoolResourceServer` (PR #930). The maintenance
 * comment above the Set already says to AUDIT THE WHOLE SERVICE FAMILY and pin
 * each addition with a unit test; the family audit is judgemental and cannot be
 * checked mechanically, but the unit-test half can, and this is it.
 *
 * "Pinned" is deliberately shallow: the type literal appears somewhere under
 * `tests/unit/deployment/`. A deeper assertion would have to know what the
 * right resolved value is for each type, which is the very thing the test it
 * demands exists to state.
 *
 * This replaces `.claude/hooks/ref-segment-audit-gate.sh`, which asserted the
 * same thing at `git commit` time against the staged diff. A tree scan is
 * strictly stronger — the hook only examined entries the current commit ADDED,
 * so an entry that slipped through once was never re-examined — and by the
 * repo's blocking criterion (`.claude/rules/hooks.md`) an unpinned Set entry is
 * not third-party harm completing at the moment of the action, so it belongs
 * in CI.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const RESOLVER = join(REPO_ROOT, 'src/deployment/intrinsic-function-resolver.ts');
const UNIT_DEPLOYMENT = join(REPO_ROOT, 'tests/unit/deployment');

/**
 * Anti-vacuity floors. The Set is parsed out of source text, so a rename or a
 * reshape of the declaration would silently yield an empty list and make the
 * coverage assertion pass over nothing. Both floors sit under today's counts
 * (25 entries, and well over a dozen test files) with room for churn.
 */
const MIN_ENTRIES = 15;
const MIN_TEST_FILES = 10;

/** Read the bracketed body of `new Set<string>([ ... ])` for a named const. */
const setEntriesOf = (src: string, name: string): string[] => {
  const start = src.indexOf(`const ${name} = new Set<string>([`);
  if (start === -1) return [];
  const end = src.indexOf('])', start);
  if (end === -1) return [];
  const body = src.slice(start, end);
  return [...body.matchAll(/'(AWS::[^']+)'/g)].map((m) => m[1]!);
};

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
};

describe('REF_RETURNS_SEGMENT_AFTER_PIPE entries are pinned by a unit test', () => {
  const entries = setEntriesOf(
    readFileSync(RESOLVER, 'utf8'),
    'REF_RETURNS_SEGMENT_AFTER_PIPE',
  );
  const testFiles = walk(UNIT_DEPLOYMENT);

  it('parses the Set and finds the deployment unit tests', () => {
    expect(entries.length, 'REF_RETURNS_SEGMENT_AFTER_PIPE parsed as empty or tiny — the declaration shape changed').toBeGreaterThanOrEqual(
      MIN_ENTRIES,
    );
    expect(testFiles.length).toBeGreaterThanOrEqual(MIN_TEST_FILES);
  });

  it('every entry is named by a file under tests/unit/deployment/', () => {
    const corpus = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    const missing = entries.filter((t) => !corpus.includes(t));
    expect(
      missing,
      [
        'These types are in REF_RETURNS_SEGMENT_AFTER_PIPE with no unit test naming them:',
        ...missing.map((t) => `  ${t}`),
        '',
        'Pin each one with a case under tests/unit/deployment/ asserting the Ref',
        'resolves to the segment AFTER the pipe — and audit the whole service',
        'family while you are there, which no test can do for you.',
      ].join('\n'),
    ).toEqual([]);
  });
});

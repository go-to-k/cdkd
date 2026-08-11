import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectStateDestroyInvocations,
  checkFixture,
} from '../../../scripts/check-integ-state-bucket.js';

/**
 * Regression guard for issue #1567: a fixture's `state destroy` sweep that
 * omits `--state-bucket` reads the STS-derived default bucket, not the
 * harness's `STATE_BUCKET`, and silently no-ops against any non-default bucket.
 * See `scripts/check-integ-state-bucket.ts` for the full rationale.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');
const CLI = 'node "${LOCAL_DIST}"';

/**
 * A deliberately CRUDE, independent prose stripper for the completeness audit
 * below — comment lines and `echo` lines only.
 *
 * It must NOT reuse the classifier's own normalizer: if that over-stripped,
 * both sides would agree and the audit would pass vacuously. Being cruder than
 * the classifier is the safe direction — it leaves MORE text in, so the audit
 * errs toward reporting a fixture rather than excusing one.
 */
function stripProseForAudit(script: string): string {
  return script
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*echo\b/.test(l))
    .map((l) => l.replace(/\s#.*$/, ''))
    .join('\n');
}

function readFixtures() {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => ({
      name: e.name,
      path: join(INTEG_ROOT, e.name, 'verify.sh'),
      ...checkFixture(readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8')),
    }));
}

/** Synthetic-shape helper: the parsed invocations only. */
const parse = (script: string) => collectStateDestroyInvocations(script).invocations;

describe('collectStateDestroyInvocations', () => {
  it('accepts the canonical form', () => {
    const inv = parse(
      `${CLI} state destroy "\${STACK}" --state-bucket "\${STATE_BUCKET:-}" --region "\${REGION}" --yes\n`,
    );
    expect(inv).toHaveLength(1);
    expect(inv[0]!.passesStateBucket).toBe(true);
  });

  it('flags an invocation that omits the flag', () => {
    const inv = parse(
      `${CLI} state destroy "\${STACK}" --region "\${REGION}" --yes\n`,
    );
    expect(inv).toHaveLength(1);
    expect(inv[0]!.passesStateBucket).toBe(false);
  });

  // Each shape below is a real spelling from the tree. A parser that misses one
  // silently exempts every fixture using it -- the #1097 lint shipped exactly
  // that defect twice, so every supported shape gets its own case.
  it.each([
    ['plain', `${CLI} state destroy "\${STACK}" --region "\${R}" --yes`],
    ['&&-guarded', `[ -x "\${LOCAL_DIST}" ] && ${CLI} state destroy "\${STACK}" --region "\${R}" --yes`],
    ['if-guarded', `if ${CLI} state destroy "\${STACK}" --region "\${R}" --yes; then :; fi`],
    ['env-prefixed', `CDKD_TEST_UPDATE=true ${CLI} state destroy "\${STACK}" --region "\${R}" --yes`],
    ['bare \${CLI} var', `\${CLI} state destroy "\${STACK}" --region "\${R}" --yes`],
    [
      'continuation-joined',
      `${CLI} state destroy "\${STACK}" \\\n  --region "\${R}" --yes`,
    ],
    ['indented in a function', `cleanup() {\n  ${CLI} state destroy "\${S}" --region "\${R}" --yes\n}`],
  ])('sees the %s shape', (_label, script) => {
    const inv = parse(`${script}\n`);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.passesStateBucket).toBe(false);
  });

  it('credits the flag when it lands on a continuation line', () => {
    // The 23 fixtures already on the reference multi-line shape carry the flag
    // on the SECOND physical line; a line-oriented scan would report them all.
    const inv = parse(
      `${CLI} state destroy "\${STACK}" --state-bucket "\${STATE_BUCKET:-}" \\\n  --region "\${R}" --yes\n`,
    );
    expect(inv[0]!.passesStateBucket).toBe(true);
  });

  it('accepts the --state-bucket=value spelling', () => {
    const inv = parse(
      `${CLI} state destroy "\${STACK}" --state-bucket="\${STATE_BUCKET:-}" --yes\n`,
    );
    expect(inv[0]!.passesStateBucket).toBe(true);
  });

  // Prose is not an invocation. Each of these exists verbatim in the tree and
  // was a false positive of the first hand-rolled grep.
  it.each([
    ['a comment', `# ${CLI} state destroy "\${STACK}" --yes`],
    ['a trailing comment', `echo hi  # then ${CLI} state destroy "\${S}" --yes`],
    ['an echo hint', `echo "    node \${LOCAL_DIST} state destroy \${STACK} --yes" >&2`],
    ['a heredoc body', `cat <<'EOF'\n${CLI} state destroy "\${S}" --yes\nEOF`],
    ['prose naming the command', `echo "destroying stack via cdkd state destroy"`],
  ])('ignores %s', (_label, script) => {
    expect(parse(`${script}\n`)).toEqual([]);
  });

  it('does not match a different subcommand', () => {
    expect(
      parse(`${CLI} state show "\${STACK}" --yes\n`),
    ).toEqual([]);
    // `destroy` is a DIFFERENT command from `state destroy` and already passes
    // the flag at all 228 call sites; matching it here would be a false report.
    expect(parse(`${CLI} destroy "\${STACK}" --yes\n`)).toEqual([]);
  });

  it('does not match a non-cdkd binary', () => {
    expect(
      parse(`terraform state destroy "\${STACK}" --yes\n`),
    ).toEqual([]);
  });

  it('finds both invocations when a line runs two', () => {
    const inv = parse(
      `${CLI} state destroy "\${A}" --yes; ${CLI} state destroy "\${B}" --state-bucket "\${SB}" --yes\n`,
    );
    expect(inv.map((i) => i.passesStateBucket)).toEqual([false, true]);
  });
});

describe('integ fixture state-bucket convention (#1567)', () => {
  const fixtures = readFixtures();
  const all = fixtures.flatMap((f) => f.invocations);

  it('finds the fixture tree', () => {
    expect(fixtures.length).toBeGreaterThan(100);
  });

  // Coverage floors: "0 offenders" and "parsed nothing" are the same green.
  // Measured 2026-08-11 at 171 invocations across 166 of 228 fixtures; floors
  // sit just under so a parser regression fails loudly rather than vacuously.
  it('parses the invocations it claims to', () => {
    expect(all.length).toBeGreaterThanOrEqual(165);
    expect(fixtures.filter((f) => f.invocations.length > 0).length).toBeGreaterThanOrEqual(160);
  });

  // This is the real completeness net, and it is stronger than a per-shape
  // floor: it needs no calibration, it cannot be satisfied vacuously, and it
  // catches an invocation SHAPE the parser has never seen rather than only a
  // regression in one it has. A per-shape floor was tried first and was both
  // brittle (`env-prefixed` and `guarded` ride on ONE fixture each, so an
  // unrelated edit reds the suite and invites deleting the floor) and blind to
  // exactly the case that matters — a NEW binary spelling, which produces zero
  // invocations in every shape at once.
  it('parses a state destroy out of every fixture whose code contains one', () => {
    const missed = fixtures
      .filter((f) => {
        // Same normalization the classifier uses, so prose does not count.
        const code = stripProseForAudit(readFileSync(f.path, 'utf8'));
        return code.includes('state destroy') && f.invocations.length === 0;
      })
      .map((f) => f.name);
    expect(missed).toEqual([]);
  });

  it('recognizes the binary in every state destroy it finds', () => {
    // An unknown spelling (`${CDKD}`, a literal `node dist/cli.js`, ...) would
    // otherwise exempt the fixture silently — the #1097 lint's failure mode.
    const unrecognized = fixtures
      .filter((f) => f.unrecognized.length > 0)
      .map((f) => `${f.name}: ${f.unrecognized[0]!.slice(0, 90)}`);
    expect(unrecognized).toEqual([]);
  });

  it('every state destroy passes --state-bucket explicitly', () => {
    const offenders = fixtures
      .filter((f) => f.offenders.length > 0)
      .map((f) => `${f.name}: ${f.offenders[0]!.command.slice(0, 90)}`);
    expect(offenders).toEqual([]);
  });

  it('uses the set -u-safe ${STATE_BUCKET:-} form', () => {
    // `cleanup` is trap-installed and can run BEFORE the script's own
    // `[ -z "${STATE_BUCKET:-}" ]` guard rejects an unset variable, so the
    // unguarded `"${STATE_BUCKET}"` would abort teardown mid-sweep under set -u.
    const bad = fixtures
      .flatMap((f) => f.invocations.map((i) => ({ name: f.name, ...i })))
      .filter((i) => isUnguardedStateBucket(i.command))
      .map((i) => i.name);
    expect(bad).toEqual([]);
  });
});

// This predicate is a second CI-blocking verdict whose pattern currently
// matches NOTHING in the tree, so a typo in it would be permanently green.
// These cases are what keep it honest.
function isUnguardedStateBucket(command: string): boolean {
  return /--state-bucket[= ]"?\$(?:\{STATE_BUCKET\}|STATE_BUCKET\b)/.test(command);
}

describe('isUnguardedStateBucket', () => {
  it.each([
    ['braced unguarded', '--state-bucket "${STATE_BUCKET}" --yes', true],
    ['unbraced unguarded', '--state-bucket "$STATE_BUCKET" --yes', true],
    ['unquoted unguarded', '--state-bucket ${STATE_BUCKET} --yes', true],
    ['equals form unguarded', '--state-bucket="${STATE_BUCKET}" --yes', true],
    ['guarded', '--state-bucket "${STATE_BUCKET:-}" --yes', false],
    ['guarded equals form', '--state-bucket="${STATE_BUCKET:-}" --yes', false],
    ['guarded with default', '--state-bucket "${STATE_BUCKET:-fallback}" --yes', false],
    ['a different variable', '--state-bucket "${OTHER_BUCKET}" --yes', false],
  ])('%s', (_label, command, expected) => {
    expect(isUnguardedStateBucket(command)).toBe(expected);
  });
});

describe('real-code fail probe', () => {
  // Coverage floors prove the checker SEES its input; they do not prove it
  // still REJECTS a violation. Re-introduce the real defect into a real
  // fixture's real text and require the checker to name it.
  it('reports a real fixture whose flag is removed again', () => {
    const path = join(INTEG_ROOT, 'apigateway/verify.sh');
    const original = readFileSync(path, 'utf8');
    expect(original).toContain('--state-bucket "${STATE_BUCKET:-}"');

    const regressed = original.replace(' --state-bucket "${STATE_BUCKET:-}"', '');
    expect(regressed).not.toEqual(original);

    const verdict = checkFixture(regressed);
    expect(verdict.offenders).toHaveLength(1);
    expect(verdict.offenders[0]!.command).toContain('state destroy');
    // The clean text must still pass, or the probe proves nothing.
    expect(checkFixture(original).offenders).toEqual([]);
  });

  it('reports a real fixture whose binary spelling is unrecognized', () => {
    // The other half of the net: an unknown binary must be REPORTED, never
    // silently dropped. Swapping in a spelling the whitelist lacks must not
    // reduce the fixture to "0 invocations, all clean".
    const original = readFileSync(join(INTEG_ROOT, 'apigateway/verify.sh'), 'utf8');
    const regressed = original.replaceAll('node "${LOCAL_DIST}"', 'node dist/cli.js');

    const verdict = checkFixture(regressed);
    expect(verdict.invocations).toEqual([]);
    expect(verdict.unrecognized.length).toBeGreaterThanOrEqual(1);
    expect(verdict.unrecognized[0]).toContain('state destroy');
  });
});

describe('the premise that makes the ${STATE_BUCKET:-} form safe', () => {
  // All 171 swept sites can pass an EMPTY value when the variable is unset.
  // That is only acceptable because the resolver treats '' as "not supplied"
  // and falls back exactly as omitting the flag does. Pin it here: if this
  // ever changes, the whole sweep silently starts targeting the wrong bucket.
  it('treats an empty --state-bucket as not-supplied', async () => {
    const { resolveStateBucketWithSource } = await import('../../../src/cli/config-loader.js');
    const saved = process.env['CDKD_STATE_BUCKET'];
    process.env['CDKD_STATE_BUCKET'] = 'env-bucket';
    try {
      // A real value wins; an empty string must fall through to the env var.
      expect(resolveStateBucketWithSource('real-bucket')?.bucket).toBe('real-bucket');
      expect(resolveStateBucketWithSource('')?.bucket).toBe('env-bucket');
      expect(resolveStateBucketWithSource(undefined)?.bucket).toBe('env-bucket');
    } finally {
      if (saved === undefined) delete process.env['CDKD_STATE_BUCKET'];
      else process.env['CDKD_STATE_BUCKET'] = saved;
    }
  });
});

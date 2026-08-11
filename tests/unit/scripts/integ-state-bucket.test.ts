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

function readFixtures() {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => ({
      name: e.name,
      path: join(INTEG_ROOT, e.name, 'verify.sh'),
      ...checkFixture(readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8')),
    }));
}

describe('collectStateDestroyInvocations', () => {
  it('accepts the canonical form', () => {
    const inv = collectStateDestroyInvocations(
      `${CLI} state destroy "\${STACK}" --state-bucket "\${STATE_BUCKET:-}" --region "\${REGION}" --yes\n`,
    );
    expect(inv).toHaveLength(1);
    expect(inv[0]!.passesStateBucket).toBe(true);
  });

  it('flags an invocation that omits the flag', () => {
    const inv = collectStateDestroyInvocations(
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
    const inv = collectStateDestroyInvocations(`${script}\n`);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.passesStateBucket).toBe(false);
  });

  it('credits the flag when it lands on a continuation line', () => {
    // The 23 fixtures already on the reference multi-line shape carry the flag
    // on the SECOND physical line; a line-oriented scan would report them all.
    const inv = collectStateDestroyInvocations(
      `${CLI} state destroy "\${STACK}" --state-bucket "\${STATE_BUCKET:-}" \\\n  --region "\${R}" --yes\n`,
    );
    expect(inv[0]!.passesStateBucket).toBe(true);
  });

  it('accepts the --state-bucket=value spelling', () => {
    const inv = collectStateDestroyInvocations(
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
    expect(collectStateDestroyInvocations(`${script}\n`)).toEqual([]);
  });

  it('does not match a different subcommand', () => {
    expect(
      collectStateDestroyInvocations(`${CLI} state show "\${STACK}" --yes\n`),
    ).toEqual([]);
    // `destroy` is a DIFFERENT command from `state destroy` and already passes
    // the flag at all 227 call sites; matching it here would be a false report.
    expect(collectStateDestroyInvocations(`${CLI} destroy "\${STACK}" --yes\n`)).toEqual([]);
  });

  it('does not match a non-cdkd binary', () => {
    expect(
      collectStateDestroyInvocations(`terraform state destroy "\${STACK}" --yes\n`),
    ).toEqual([]);
  });

  it('finds both invocations when a line runs two', () => {
    const inv = collectStateDestroyInvocations(
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

  it('still parses each shape it claims to handle', () => {
    // An aggregate floor hides a dead shape: `plain` is 169 of 171, so the
    // env-prefixed and guarded parsers could both regress to zero and the
    // total above would barely move. Real-tree counts 2026-08-11: 169/1/1.
    const perShape = (shape: string) => all.filter((i) => i.shape === shape).length;
    expect(perShape('plain')).toBeGreaterThanOrEqual(160);
    expect(perShape('env-prefixed')).toBeGreaterThanOrEqual(1);
    expect(perShape('guarded')).toBeGreaterThanOrEqual(1);
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
      .filter((i) => /--state-bucket[= ]"?\$\{STATE_BUCKET\}/.test(i.command))
      .map((i) => i.name);
    expect(bad).toEqual([]);
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

  it('leaves the real fixture untouched', () => {
    expect(readFileSync(join(INTEG_ROOT, 'apigateway/verify.sh'), 'utf8')).toContain(
      '--state-bucket "${STATE_BUCKET:-}"',
    );
  });
});

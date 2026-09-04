import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCdkCliUsage, checkFixture } from '../../../scripts/check-integ-cdk-cli-pins.js';

/**
 * Regression guard for issue 1485: fixtures that shell out to the upstream
 * `cdk` CLI must pin a fixture-local aws-cdk AND make the invocation resolve
 * it (PATH prepend or explicit node_modules/.bin path). See
 * `scripts/check-integ-cdk-cli-pins.ts` for the failure class
 * (schema-version mismatch against a stale global cdk — the
 * import-nested-stack failure on the 2026-08-10 sweep, and PR 1253's three
 * fixtures before it).
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

function readFixtures() {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => {
      const pkgPath = join(INTEG_ROOT, e.name, 'package.json');
      return {
        name: e.name,
        ...checkFixture(
          readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8'),
          existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : undefined,
        ),
      };
    });
}

describe('classifyCdkCliUsage — invocation shapes (issue 1485)', () => {
  it('sees a bare cdk deploy inside a (cd ... && ...) subshell', () => {
    const c = classifyCdkCliUsage('(cd "${TEST_DIR}" && cdk deploy "${STACK}" --require-approval never)\n');
    expect(c.bareInvocations).toBe(1);
    expect(c.npxInvocations).toBe(0);
  });

  it('sees an npx cdk diff inside a command substitution capture', () => {
    const c = classifyCdkCliUsage('CDK_DIFF_OUT=$(npx cdk diff "${STACK}" --region "${REGION}" 2>&1)\n');
    expect(c.npxInvocations).toBe(1);
    expect(c.bareInvocations).toBe(0);
  });

  it('sees an env-prefixed npx cdk synth', () => {
    const c = classifyCdkCliUsage('  CDK_DEBUG=true npx cdk synth --app "node bin/app.ts" 2>/dev/null || true\n');
    expect(c.npxInvocations).toBe(1);
  });

  it('sees a CDK_BIN-style invocation and resolves its local-bin definition', () => {
    const c = classifyCdkCliUsage(
      'CDK_BIN="${TEST_DIR}/node_modules/.bin/cdk"\n"${CDK_BIN}" migrate --from-path x.json\n',
    );
    expect(c.explicitBinInvocations).toBe(1);
    expect(c.cdkBinPointsAtLocalBin).toBe(true);
  });

  it('sees a backslash-continued cdk deploy', () => {
    const c = classifyCdkCliUsage('(cd "${TEST_DIR}" && cdk deploy "${STACK}" \\\n  --require-approval never)\n');
    expect(c.bareInvocations).toBe(1);
  });

  // Keyword / wrapper prefixes keep the rest of the segment in command
  // position; before the round-1 review these were silent false negatives.
  it.each([
    ['negated condition', 'if ! cdk deploy "${STACK}"; then exit 1; fi'],
    ['then-branch', 'if true; then cdk deploy "${STACK}"; fi'],
    ['loop body', 'for s in a b; do cdk deploy "$s"; done'],
    ['brace group', '(cd "${D}" && { cdk deploy X; })'],
    ['timeout wrapper', 'timeout 600 npx cdk deploy "${STACK}"'],
    ['quoted env value with space', 'FOO="a b" cdk deploy "${STACK}"'],
  ])('counts keyword/wrapper-prefixed invocations: %s', (_label, line) => {
    const c = classifyCdkCliUsage(`${line}\n`);
    expect(c.bareInvocations + c.npxInvocations).toBe(1);
  });

  // Package-runner spellings other than plain `npx`, and a global flag
  // sitting between `cdk` and its verb.
  it.each([
    ['pnpm exec', 'pnpm exec cdk synth'],
    ['npm exec', 'npm exec cdk deploy X'],
    ['yarn', 'yarn cdk deploy X'],
    ['npx with a pinned package', 'npx aws-cdk@2.1135.1 deploy X'],
    ['npx flag before the package', 'npx --yes cdk deploy X'],
  ])('counts runner spelling: %s', (_label, line) => {
    expect(classifyCdkCliUsage(`${line}\n`).npxInvocations).toBe(1);
  });

  it('counts a global flag placed before the verb', () => {
    expect(classifyCdkCliUsage('cdk --app "node bin/app.ts" synth\n').bareInvocations).toBe(1);
  });
});

describe('classifyCdkCliUsage — prose must never count (issue 1485)', () => {
  it.each([
    ['whole-line comment', '# this fixture used to run cdk deploy against the global CLI'],
    ['trailing comment', 'true # then cdk deploy "${STACK}" by hand'],
    ['echo prose', 'echo "[verify] step 4: cdk deploy parent + nested child"'],
    ['echo prose containing a separator', 'echo "[verify] FAIL (exit 1); cdk destroy attempted"'],
    ['echo prose with backticks', 'echo "run \\`cdk deploy\\` yourself"'],
    ['grep pattern with an alternation', 'grep -E "a|cdk deploy" out.log'],
    ['grep pattern with a separator', 'grep -q "foo; cdk deploy" out.log'],
    ['cdkd is a different binary', 'node "${LOCAL_DIST}" deploy --region us-east-1'],
    ['cdk-local is a different binary', 'cdk-local invoke MyFn'],
  ])('does not count: %s', (_label, line) => {
    const c = classifyCdkCliUsage(`${line}\n`);
    expect(c.bareInvocations + c.npxInvocations + c.explicitBinInvocations).toBe(0);
  });

  it('does not count a heredoc body', () => {
    const c = classifyCdkCliUsage("cat > run.sh <<'EOF'\ncdk deploy MyStack\nnpm install\nEOF\n");
    expect(c.bareInvocations).toBe(0);
    expect(c.hasFixtureInstall).toBe(false);
  });

  // Hermeticity signals are the other half: prose must not SATISFY them
  // either (the round-1 classifier matched them against comment-inclusive
  // text, so the canonical block's own explanation passed a gutted fixture).
  it.each([
    ['whole-line comments', '# npm install first\n# export PATH="${D}/node_modules/.bin:${PATH}"\n# [ -x "${D}/node_modules/.bin/cdk" ]\n'],
    ['echo prose', 'echo "run [ -x node_modules/.bin/cdk ], npm install, export PATH=x/node_modules/.bin:y"\n'],
  ])('does not accept install / prepend / guard signals from %s', (_label, script) => {
    const c = classifyCdkCliUsage(script);
    expect(c.hasFixtureInstall).toBe(false);
    expect(c.hasPathPrepend).toBe(false);
    expect(c.hasCdkBinGuard).toBe(false);
  });

  it('does not accept an install named only in a trailing comment', () => {
    // The guard on this line IS code and legitimately registers; the point is
    // that the `npm install` after the `#` does not.
    const c = classifyCdkCliUsage('[ -x node_modules/.bin/cdk ] || true # npm install\n');
    expect(c.hasCdkBinGuard).toBe(true);
    expect(c.hasFixtureInstall).toBe(false);
  });
});

describe('classifyCdkCliUsage — hermeticity signals (issue 1485)', () => {
  it('detects the canonical guard + install + prepend block', () => {
    const c = classifyCdkCliUsage(
      '[ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || (cd "${TEST_DIR}" && npm install)\nexport PATH="${TEST_DIR}/node_modules/.bin:${PATH}"\n',
    );
    expect(c.hasPathPrepend).toBe(true);
    expect(c.hasFixtureInstall).toBe(true);
    expect(c.installIsConditional).toBe(true);
    expect(c.hasCdkBinGuard).toBe(true);
  });

  it('detects a nested-quote guard and a variable-held bin directory', () => {
    const c = classifyCdkCliUsage(
      'BIN="${TEST_DIR}/node_modules/.bin"\nif [ ! -x "${BIN}/cdk" ]; then npm install; fi\nexport PATH="${BIN}:${PATH}"\n',
    );
    expect(c.hasCdkBinGuard).toBe(true);
    expect(c.hasPathPrepend).toBe(true);
    expect(c.hasFixtureInstall).toBe(true);
  });

  it('treats an unconditional install as unconditional', () => {
    const c = classifyCdkCliUsage('npm install\nexport PATH="${PWD}/node_modules/.bin:${PATH}"\n');
    expect(c.hasFixtureInstall).toBe(true);
    expect(c.installIsConditional).toBe(false);
  });

  it('does not accept a repo-root install as the fixture install', () => {
    const c = classifyCdkCliUsage('(cd "${REPO_ROOT}" && pnpm install)\n(cd "${REPO_ROOT}" && vp run build)\n');
    expect(c.hasFixtureInstall).toBe(false);
  });
});

describe('checkFixture verdicts (issue 1485)', () => {
  const pinnedPkg = JSON.stringify({ devDependencies: { 'aws-cdk': '^2.1135.1' } });
  const guardedInstall = '[ -x "${PWD}/node_modules/.bin/cdk" ] || npm install\n';
  const prepend = 'export PATH="${PWD}/node_modules/.bin:${PATH}"\n';

  it('flags a guarded install + pin but no PATH prepend (the incident shape)', () => {
    const v = checkFixture(`${guardedInstall}cdk deploy "\${STACK}"\n`, pinnedPkg);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain('PATH');
  });

  it('flags an invocation with no pin at all', () => {
    const v = checkFixture(
      `${guardedInstall}${prepend}npx cdk synth\n`,
      JSON.stringify({ dependencies: { 'aws-cdk-lib': '^2.169.0' } }),
    );
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain('pin');
  });

  it.each([['*'], ['latest'], ['x']])('rejects the non-range pin %s', (spec) => {
    const v = checkFixture(
      `${guardedInstall}${prepend}npx cdk synth\n`,
      JSON.stringify({ devDependencies: { 'aws-cdk': spec } }),
    );
    expect(v.violations.some((x) => x.includes('pin'))).toBe(true);
  });

  it('flags a fixture whose only install is the repo-root one', () => {
    const v = checkFixture(`(cd "\${REPO_ROOT}" && pnpm install)\n${prepend}npx cdk deploy X\n`, pinnedPkg);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain('FIXTURE');
  });

  it('flags a conditional install whose guard does not test the cdk bin', () => {
    const v = checkFixture(
      `[ -d node_modules ] || npm install\n${prepend}npx cdk deploy X\n`,
      pinnedPkg,
    );
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain('conditional');
  });

  it('accepts an UNCONDITIONAL install with no guard (strictly more hermetic)', () => {
    const v = checkFixture(`npm install\n${prepend}npx cdk deploy X\n`, pinnedPkg);
    expect(v.violations).toEqual([]);
  });

  it('accepts the canonical guarded shape', () => {
    const v = checkFixture(`${guardedInstall}${prepend}npx cdk deploy X\n`, pinnedPkg);
    expect(v.violations).toEqual([]);
  });

  it('accepts an explicit local CDK_BIN without a PATH prepend', () => {
    const v = checkFixture(
      'if [[ ! -x "node_modules/.bin/cdk" ]]; then pnpm install --ignore-workspace; fi\nCDK_BIN="${TEST_DIR}/node_modules/.bin/cdk"\n"${CDK_BIN}" migrate --from-path x.json\n',
      JSON.stringify({ dependencies: { 'aws-cdk': '2.1135.1' } }),
    );
    expect(v.violations).toEqual([]);
  });

  it('flags a non-local CDK_BIN even when bare/npx invocations are present', () => {
    const v = checkFixture(
      `${guardedInstall}${prepend}CDK_BIN="/usr/local/bin/cdk"\nnpx cdk deploy X\n"\${CDK_BIN}" synth\n`,
      pinnedPkg,
    );
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain('CDK_BIN');
  });

  it('ignores fixtures that never invoke upstream cdk', () => {
    const v = checkFixture('node "${LOCAL_DIST}" deploy --region us-east-1\n', undefined);
    expect(v.invokesUpstreamCdk).toBe(false);
    expect(v.violations).toEqual([]);
  });
});

describe('integ fixture verify.sh cdk CLI pins (issue 1485)', () => {
  const fixtures = readFixtures();

  it('finds the fixture tree', () => {
    expect(fixtures.length).toBeGreaterThan(100);
  });

  // Coverage floors, RE-MEASURED against this tree with this file's own
  // `checkFixture` on 2026-09-04 ("A checker must prove it sees its input",
  // .claude/rules/testing.md) — 7 invoking fixtures:
  //   bare  7 invocations / 3 fixtures: import-nested-stack(1),
  //         local-invoke-from-cfn-stack(3),
  //         local-invoke-from-cfn-stack-multi-stack(3)
  //   npx   7 invocations / 4 fixtures: asset-migration(2), export(1),
  //         import-auto-mode(3), intrinsics-torture-2(1)
  // The previous revision of this note said "export / import-auto-mode /
  // intrinsics-torture-2 (npx, 5)" and was wrong in both membership and count:
  // `asset-migration` was never listed, so the `invokers >= 7` floor was
  // passing on a fixture the comment did not know about. It was carried
  // forward across an edit instead of re-measured, which is the whole reason
  // the numbers below are now stated per fixture.
  // Both totals AND per-shape FIXTURE counts are pinned: a total-only floor
  // lets a within-fixture regression (import-auto-mode's 3 npx dropping to 1)
  // hide, and a per-shape fixture floor stops a dead shape being masked by new
  // fixtures of another shape. If a legitimate refactor removes one, lower the
  // floor in the same PR with a note — a silent drop to zero is the failure
  // mode this exists for.
  //
  // The explicit-CDK_BIN shape HAS no floor, and that is the documented case
  // above rather than an omission. Its only fixture was
  // `migrate-from-bare-cfn-codegen-only`, retired with `cdkd migrate` (issue
  // #2572), so the tree now holds ZERO of that shape and any floor above zero
  // would fail while a floor of zero asserts nothing. The shape's PARSER stays
  // covered by the synthetic cases earlier in this file
  // ('sees a CDK_BIN-style invocation...', 'accepts an explicit local
  // CDK_BIN...', 'flags a non-local CDK_BIN...'), which is what keeps the
  // detection from rotting while no fixture exercises it. Restore the pair of
  // floors below — `explicitBin >= n` and the per-shape fixture count — in the
  // same PR as the first fixture that reintroduces the shape.
  it('parses the known invocation shapes across the tree', () => {
    const invokers = fixtures.filter((f) => f.invokesUpstreamCdk);
    const bare = fixtures.reduce((n, f) => n + f.bareInvocations, 0);
    const npx = fixtures.reduce((n, f) => n + f.npxInvocations, 0);
    expect(invokers.length).toBeGreaterThanOrEqual(7);
    expect(bare).toBeGreaterThanOrEqual(7);
    expect(npx).toBeGreaterThanOrEqual(7);
    expect(fixtures.filter((f) => f.bareInvocations > 0).length).toBeGreaterThanOrEqual(3);
    expect(fixtures.filter((f) => f.npxInvocations > 0).length).toBeGreaterThanOrEqual(4);
  });

  // The zero above is an ASSERTED zero, not an unmeasured one: if a fixture
  // reintroduces the shape without restoring the floors, this reds and names
  // the fixture, so the removal cannot silently become permanent.
  it('has no explicit-CDK_BIN fixture left to floor (issue #2572)', () => {
    expect(fixtures.filter((f) => f.explicitBinInvocations > 0).map((f) => f.name)).toEqual([]);
  });

  it('every fixture that invokes the upstream cdk CLI is hermetic about which cdk it gets', () => {
    const offenders = fixtures
      .filter((f) => f.violations.length > 0)
      .map((f) => ({ name: f.name, violations: f.violations }));
    expect(offenders).toEqual([]);
  });
});

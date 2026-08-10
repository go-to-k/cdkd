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

describe('classifyCdkCliUsage (issue 1485)', () => {
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
    const c = classifyCdkCliUsage('  CDK_DEBUG=true npx cdk synth --app "node bin/app.ts" 2>/dev/null | grep Fn:: || true\n');
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

  it.each([
    ['comment line', '# this fixture used to run cdk deploy against the global CLI'],
    ['echo prose', 'echo "[verify] step 4: cdk deploy parent + nested child"'],
    ['cdkd is not cdk', 'node "${LOCAL_DIST}" deploy --region us-east-1'],
    ['string mention inside echo', "echo \"FAIL: this region has been 'cdk bootstrap'ed\" >&2"],
    ['grep for the word', 'grep -q "cdk deploy" some.log'],
  ])('does not count prose: %s', (_label, line) => {
    const c = classifyCdkCliUsage(`${line}\n`);
    expect(c.bareInvocations + c.npxInvocations + c.explicitBinInvocations).toBe(0);
  });

  it('detects the canonical PATH prepend and install guard', () => {
    const c = classifyCdkCliUsage(
      '[ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || (cd "${TEST_DIR}" && npm install)\nexport PATH="${TEST_DIR}/node_modules/.bin:${PATH}"\n',
    );
    expect(c.hasPathPrepend).toBe(true);
    expect(c.hasInstallStep).toBe(true);
  });
});

describe('checkFixture verdicts (issue 1485)', () => {
  const pinnedPkg = JSON.stringify({ devDependencies: { 'aws-cdk': '^2.1133.0' } });

  it('flags a bare invocation with a pin but no PATH prepend (the incident shape)', () => {
    const v = checkFixture('npm install\ncdk deploy "${STACK}"\n', pinnedPkg);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain('PATH');
  });

  it('flags an npx invocation with no pin at all', () => {
    const v = checkFixture(
      'pnpm install --ignore-workspace\nexport PATH="${PWD}/node_modules/.bin:${PATH}"\nnpx cdk synth\n',
      JSON.stringify({ dependencies: { 'aws-cdk-lib': '^2.169.0' } }),
    );
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain('pin');
  });

  it('flags a pinned + prepended fixture with no install step', () => {
    const v = checkFixture('export PATH="${PWD}/node_modules/.bin:${PATH}"\nnpx cdk deploy X\n', pinnedPkg);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain('install');
  });

  it('accepts the canonical hermetic shape', () => {
    const v = checkFixture(
      '[ -x "${PWD}/node_modules/.bin/cdk" ] || npm install\nexport PATH="${PWD}/node_modules/.bin:${PATH}"\nnpx cdk deploy X\n',
      pinnedPkg,
    );
    expect(v.violations).toEqual([]);
  });

  it('accepts an explicit local CDK_BIN without a PATH prepend', () => {
    const v = checkFixture(
      'if [[ ! -x "node_modules/.bin/cdk" ]]; then pnpm install --ignore-workspace; fi\nCDK_BIN="${TEST_DIR}/node_modules/.bin/cdk"\n"${CDK_BIN}" migrate --from-path x.json\n',
      JSON.stringify({ dependencies: { 'aws-cdk': '2.1128.0' } }),
    );
    expect(v.violations).toEqual([]);
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

  // Coverage floors, measured against the 2026-08-10 tree ("A checker must
  // prove it sees its input", .claude/rules/testing.md). The upstream-cdk
  // callers: import-nested-stack + the two local-invoke-from-cfn-stack
  // fixtures (bare), export / import-auto-mode / intrinsics-torture-2 (npx),
  // migrate-from-bare-cfn-codegen-only (CDK_BIN). If a legitimate refactor
  // removes one, lower the floor in the same PR with a note — a silent drop
  // to zero is the failure mode this exists for.
  it('parses the known invocation shapes across the tree', () => {
    const invokers = fixtures.filter((f) => f.invokesUpstreamCdk);
    const bare = fixtures.reduce((n, f) => n + f.bareInvocations, 0);
    const npx = fixtures.reduce((n, f) => n + f.npxInvocations, 0);
    const explicitBin = fixtures.reduce((n, f) => n + f.explicitBinInvocations, 0);
    expect(invokers.length).toBeGreaterThanOrEqual(7);
    expect(bare).toBeGreaterThanOrEqual(3);
    expect(npx).toBeGreaterThanOrEqual(3);
    expect(explicitBin).toBeGreaterThanOrEqual(1);
  });

  it('every fixture that invokes the upstream cdk CLI is hermetic about which cdk it gets', () => {
    const offenders = fixtures
      .filter((f) => f.violations.length > 0)
      .map((f) => ({ name: f.name, violations: f.violations }));
    expect(offenders).toEqual([]);
  });
});

import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyVerifyScript,
  joinContinuedLines,
} from '../../../scripts/check-integ-version-literals.js';

/**
 * Regression guard for issue #1324: hardcoded Lambda published-version
 * literals in integ fixtures. See `scripts/check-integ-version-literals.ts`
 * for why the monotonic version counter makes any `":1"` probe a
 * first-run-only assert.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

function readFixtures() {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => ({
      name: e.name,
      ...classifyVerifyScript(readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8')),
    }));
}

describe('classifyVerifyScript (version literals)', () => {
  it('flags a digits-literal --function-name qualifier', () => {
    const c = classifyVerifyScript(
      'aws lambda get-function-configuration --function-name "${FN}:1" --region us-east-1\n',
    );
    expect(c.findings.map((f) => f.kind)).toEqual(['literal-qualifier']);
  });

  it('flags a digits-literal qualifier on a full function ARN', () => {
    const c = classifyVerifyScript(
      'aws lambda invoke --function-name arn:aws:lambda:us-east-1:123456789012:function:my-fn:3 out.json\n',
    );
    expect(c.findings.map((f) => f.kind)).toEqual(['literal-qualifier']);
  });

  it('flags a digits-literal --qualifier', () => {
    const c = classifyVerifyScript(
      'aws lambda get-provisioned-concurrency-config --function-name "${FN}" --qualifier 5\n',
    );
    expect(c.findings.map((f) => f.kind)).toEqual(['literal-qualifier']);
  });

  it('flags a digits-literal --version-number on an aws lambda command', () => {
    const c = classifyVerifyScript(
      'aws lambda delete-layer-version --layer-name "${LAYER}" --version-number 1\n',
    );
    expect(c.findings.map((f) => f.kind)).toEqual(['literal-version-number']);
  });

  it('flags a literal integer compare of a version capture', () => {
    const c = classifyVerifyScript(
      `V="$(aws lambda get-alias --function-name "\${FN}" --name live --query 'FunctionVersion' --output text)"
if [ "\${V}" != "2" ]; then exit 1; fi
`,
    );
    expect(c.versionCaptureVars).toEqual(['V']);
    expect(c.findings.map((f) => f.kind)).toEqual(['literal-compare']);
  });

  it('flags the -eq form of a literal compare', () => {
    const c = classifyVerifyScript(
      `V="$(aws lambda publish-version --function-name "\${FN}" --query 'Version' --output text)"
if [ "\${V}" -eq 1 ]; then exit 1; fi
`,
    );
    expect(c.findings.map((f) => f.kind)).toEqual(['literal-compare']);
  });

  it('sees a qualifier that lands on a backslash-continuation line', () => {
    const script = `OPT="$(aws lambda get-function-configuration \\
  --function-name "\${FN}:1" --region "\${REGION}" \\
  --query 'SnapStart.OptimizationStatus' --output text)"
`;
    expect(joinContinuedLines(script).some((l) => l.includes('--function-name "${FN}:1"'))).toBe(
      true,
    );
    expect(classifyVerifyScript(script).findings.map((f) => f.kind)).toEqual([
      'literal-qualifier',
    ]);
  });

  it.each([
    ['variable qualifier', 'aws lambda invoke --function-name "${FN}:${V}" out.json'],
    ['alias qualifier', 'aws lambda invoke --function-name "${FN}:live" out.json'],
    ['$LATEST qualifier', 'aws lambda invoke --function-name "${FN}:$LATEST" out.json'],
    ['no qualifier', 'aws lambda get-function --function-name "${FN}"'],
    ['variable --qualifier', 'aws lambda get-policy --function-name "${FN}" --qualifier "${ALIAS}"'],
    ['variable --version-number', 'aws lambda delete-layer-version --layer-name "${L}" --version-number "${v}"'],
    ['default-expansion colon is not a qualifier', 'aws lambda get-function --function-name "${FN:-fallback}"'],
  ])('does not flag the legal shape: %s', (_label, line) => {
    expect(classifyVerifyScript(`${line}\n`).findings).toEqual([]);
  });

  it('does not flag non-lambda --version-number literals', () => {
    // appconfig hosted-configuration versions are ids the fixture itself
    // enumerated — a different API with different semantics.
    const c = classifyVerifyScript(
      'aws appconfig delete-hosted-configuration-version --application-id "${id}" --version-number 3\n',
    );
    expect(c.findings).toEqual([]);
    expect(c.versionNumberArgs).toBe(0);
  });

  it('does not flag relative compares or numeric-format case guards', () => {
    const c = classifyVerifyScript(
      `V="$(aws lambda get-alias --function-name "\${FN}" --name live --query 'FunctionVersion' --output text)"
case "\${V}" in ''|*[!0-9]*) exit 1 ;; esac
EXPECTED=$((V + 1))
if [ "\${V2}" != "\${EXPECTED}" ]; then exit 1; fi
if [ "\${V}" != "\${EXPECTED}" ]; then exit 1; fi
`,
    );
    expect(c.findings).toEqual([]);
    expect(c.versionCaptureCompares).toBe(1);
  });

  it('does not treat a count query as a version capture', () => {
    const c = classifyVerifyScript(
      `N="$(aws lambda list-versions-by-function --function-name "\${FN}" --query 'length(Versions)' --output text)"
if [ "\${N}" -ne 2 ]; then exit 1; fi
`,
    );
    expect(c.versionCaptureVars).toEqual([]);
    expect(c.findings).toEqual([]);
  });

  it('honors the allow-version-literal escape hatch (still counted, not flagged)', () => {
    const c = classifyVerifyScript(
      'aws lambda invoke --function-name "arn:aws:lambda:us-east-1:017000801446:function:shared:7" out.json # allow-version-literal: pinned by the layer owner, not this account\n',
    );
    expect(c.findings).toEqual([]);
    expect(c.lambdaQualifierArgs).toBe(1);
  });
});

describe('integ fixture verify.sh version literals (#1324)', () => {
  const fixtures = readFixtures();

  it('finds the fixture tree', () => {
    expect(fixtures.length).toBeGreaterThan(100);
  });

  // Coverage floors, measured against the 2026-07-31 tree (see
  // `.claude/rules/testing.md`, "A checker must prove it sees its input"):
  // qualifier args come from `lambda-snapstart` (3 variable + 1 alias) and
  // `codedeploy-lambda-deployment-group` (1 alias); version captures from the
  // same two fixtures (2 each); the relative compares and the variable
  // `--version-number` from those plus `lambda-layer-version-update`. If a
  // legitimate refactor removes one of these, lower the floor in the same PR
  // with a note — a silent drop to zero is the failure mode this exists for.
  it('parses the known qualifier shapes across the tree', () => {
    const total = fixtures.reduce((n, f) => n + f.lambdaQualifierArgs, 0);
    const variable = fixtures.reduce((n, f) => n + f.variableQualifierArgs, 0);
    const alias = fixtures.reduce((n, f) => n + f.aliasLiteralQualifierArgs, 0);
    expect(total).toBeGreaterThanOrEqual(5);
    expect(variable).toBeGreaterThanOrEqual(3);
    expect(alias).toBeGreaterThanOrEqual(2);
  });

  it('parses the known version-capture and compare shapes across the tree', () => {
    const captures = fixtures.reduce((n, f) => n + f.versionCaptureVars.length, 0);
    const compares = fixtures.reduce((n, f) => n + f.versionCaptureCompares, 0);
    const versionNumberArgs = fixtures.reduce((n, f) => n + f.versionNumberArgs, 0);
    expect(captures).toBeGreaterThanOrEqual(4);
    expect(compares).toBeGreaterThanOrEqual(2);
    expect(versionNumberArgs).toBeGreaterThanOrEqual(1);
  });

  it('never hardcodes a Lambda published-version literal', () => {
    const offenders = fixtures
      .filter((f) => f.findings.length > 0)
      .map((f) => ({ name: f.name, findings: f.findings }));
    expect(offenders).toEqual([]);
  });
});

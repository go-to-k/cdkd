import { describe, it, expect } from 'vite-plus/test';
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  classifyVerifyScript,
  joinContinuationLines,
  CANONICAL_HELPER_BLOCK,
  CANONICAL_NOT_FOUND_REGEX,
} from '../../../scripts/check-integ-probe-not-found.js';

/**
 * Regression guard for issue #1097 pattern 2 (blind gone-probes in integ
 * fixtures). See `scripts/check-integ-probe-not-found.ts` for why the correct
 * form is what it is.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

/**
 * Fixtures whose verify.sh is owned by an in-flight PR, so the sweep skips
 * them to avoid a cross-lane collision. Mirrors the pattern-1 test's
 * mechanism; entries are asserted stale-free below so the exception
 * self-expires once the owning PR lands.
 *
 * Empty today. `fsx-windows` / `fsx-ontap` (PR #1094) do not exist in this
 * tree yet; `emr-cluster` (PR #1101) already uses a strict output-capturing
 * idiom that this classifier accepts without an exception.
 */
const PENDING_OTHER_PR: Record<string, string> = {};

function readFixtures() {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => {
      const content = readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8');
      return { name: e.name, content, ...classifyVerifyScript(content) };
    });
}

describe('classifyVerifyScript (pattern 2)', () => {
  const FORM_B = `if aws lambda get-function --function-name "x" >/dev/null 2>&1; then
  echo "FAIL: function still exists after destroy" >&2
  exit 1
fi
`;

  it('flags Form B: blind probe backing a leak assertion', () => {
    expect(classifyVerifyScript(FORM_B).blindLeakAsserts).toHaveLength(1);
  });

  it.each([
    ['stderr-only silencing piped to grep', 'if aws sns list-topics --query "q" 2>/dev/null | grep -q x; then'],
    ['&> silencing', 'if aws iam get-role --role-name x &>/dev/null; then'],
    ['reversed redirect order', 'if aws ssm get-parameter --name x 2>&1 >/dev/null; then'],
    ['elif arm', 'elif aws s3api head-object --bucket b --key k >/dev/null 2>&1; then'],
    ['aws s3 ls', 'if aws s3 ls "s3://b/k" >/dev/null 2>&1; then'],
  ])('flags Form B variant: %s', (_label, cond) => {
    const script = `${cond}\n  echo "FAIL: still exists after destroy" >&2\n  exit 1\nfi\n`;
    expect(classifyVerifyScript(script).blindLeakAsserts).toHaveLength(1);
  });

  it('flags a multi-line continuation condition', () => {
    // The pattern-1 sweep learned that multi-line statements hide from
    // line-oriented scans; the same applies to probe conditions.
    const script = `if aws deploy get-deployment-group --application-name "a" \\
  --deployment-group-name "d" --region "r" >/dev/null 2>&1; then
  echo "FAIL: deployment group still exists after destroy" >&2
  exit 1
fi
`;
    expect(classifyVerifyScript(script).blindLeakAsserts).toHaveLength(1);
    expect(joinContinuationLines(script)[0]!.text).toContain('--deployment-group-name');
  });

  it('flags Form A: negated blind probe concluding gone', () => {
    const script = `if ! aws dynamodb describe-table --table-name x >/dev/null 2>&1; then
  TABLE_GONE=1
  break
fi
`;
    expect(classifyVerifyScript(script).blindGoneConcludes).toHaveLength(1);
  });

  it('does not flag Form A that fails loudly (fail-closed existence check)', () => {
    const script = `if ! aws codecommit get-file --repository-name r --file-path p >/dev/null 2>&1; then
  echo "FAIL: seed file not found" >&2
  exit 1
fi
`;
    const c = classifyVerifyScript(script);
    expect(c.blindGoneConcludes).toEqual([]);
    expect(c.blindLeakAsserts).toEqual([]);
  });

  it('does not flag a mutation probe (read-verb restriction)', () => {
    // `if ! aws fsx delete-backup ...` legitimately treats non-zero as "the
    // delete failed" -- the naive-grep over-count the issue warns about.
    const script = `if ! aws fsx delete-backup --backup-id b >/dev/null 2>&1; then
  echo "delete failed, retrying"
fi
`;
    expect(classifyVerifyScript(script).blindGoneConcludes).toEqual([]);
  });

  it('does not flag a cleanup guard whose body merely cleans up', () => {
    const script = `if aws s3api head-object --bucket b --key k >/dev/null 2>&1; then
  echo "[verify] cleanup: cdkd destroy stack"
  cli destroy stack --force || true
fi
`;
    expect(classifyVerifyScript(script).blindLeakAsserts).toEqual([]);
  });

  it('does not flag a pre-flight "already exists" guard', () => {
    const script = `if aws cloudformation describe-stacks --stack-name s >/dev/null 2>&1; then
  echo "FAIL: s already exists in CFn -- clean up first"
  exit 1
fi
`;
    expect(classifyVerifyScript(script).blindLeakAsserts).toEqual([]);
  });

  it('flags the &&-list Form B: `aws <probe> && { FAIL still exists }`', () => {
    const single = `aws scheduler get-schedule --name s >/dev/null 2>&1 && { echo "FAIL: schedule still exists after destroy" >&2; exit 1; }\n`;
    expect(classifyVerifyScript(single).blindLeakAsserts).toHaveLength(1);
    const multi = `aws s3 ls "s3://b/k" >/dev/null 2>&1 && {
  echo "FAIL: state remains" >&2
  exit 1
} || true
`;
    expect(classifyVerifyScript(multi).blindLeakAsserts).toHaveLength(1);
  });

  it('does not flag the &&-list pre-flight guard', () => {
    const script = `aws s3 ls "s3://b/k" >/dev/null 2>&1 && {
  echo "FAIL: state already exists -- clean up first."
  exit 1
} || true
`;
    expect(classifyVerifyScript(script).blindLeakAsserts).toEqual([]);
  });

  it('flags the ||-list Form A: `aws <probe> || { GONE=1; break; }`', () => {
    const script = `aws lambda get-function --function-name f >/dev/null 2>&1 || { GONE=1; break; }\n`;
    expect(classifyVerifyScript(script).blindGoneConcludes).toHaveLength(1);
  });

  it('does not flag a bare `|| true` tolerance suffix', () => {
    const script = `aws s3 ls "s3://b/k" >/dev/null 2>&1 || true\n`;
    const c = classifyVerifyScript(script);
    expect(c.blindGoneConcludes).toEqual([]);
    expect(c.blindLeakAsserts).toEqual([]);
  });

  it('flags a wait-until-gone while/until loop driven by a blind probe', () => {
    for (const kw of ['while', 'until']) {
      const script = `${kw} aws efs describe-file-systems --file-system-id f >/dev/null 2>&1; do
  sleep 5
done
`;
      expect(classifyVerifyScript(script).blindProbeLoops).toHaveLength(1);
    }
  });

  it('does not flag calls routed through the helpers', () => {
    const script = `${CANONICAL_HELPER_BLOCK}
assert_gone "function still exists after destroy" aws lambda get-function --function-name x
if ! gone_probe aws iam get-role --role-name r; then
  ROLE_LEFT=$((ROLE_LEFT + 1))
fi
`;
    const c = classifyVerifyScript(script);
    expect(c.blindLeakAsserts).toEqual([]);
    expect(c.blindGoneConcludes).toEqual([]);
    expect(c.usesHelpers).toBe(true);
    expect(c.hasCanonicalHelperBlock).toBe(true);
    expect(c.nonCanonicalNotFoundGreps).toEqual([]);
  });

  it('scans past a nested if inside the then-branch', () => {
    const script = `if aws sns list-subscriptions-by-topic --topic-arn t >/dev/null 2>&1; then
  if [ "x" != "0" ]; then
    echo "noise"
  fi
  echo "FAIL: topic still exists after destroy" >&2
  exit 1
fi
`;
    expect(classifyVerifyScript(script).blindLeakAsserts).toHaveLength(1);
  });

  it('flags a drifted copy of the not-found signature', () => {
    const script = `if ! printf '%s' "\${out}" | grep -qiE 'not ?found|404'; then
  exit 1
fi
`;
    expect(classifyVerifyScript(script).nonCanonicalNotFoundGreps).toHaveLength(1);
  });

  it('accepts the canonical signature outside the helper block (inline poll)', () => {
    const script = `if printf '%s' "\${out}" | grep -qiE ${CANONICAL_NOT_FOUND_REGEX}; then
  return 0
fi
`;
    expect(classifyVerifyScript(script).nonCanonicalNotFoundGreps).toEqual([]);
  });
});

describe('bash behavior of the canonical helpers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-probe-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);

  // PATH-shimmed `aws` whose behavior is chosen via AWS_STUB_MODE.
  writeFileSync(
    join(binDir, 'aws'),
    `#!/usr/bin/env bash
case "\${AWS_STUB_MODE}" in
  exists) exit 0 ;;
  notfound)
    echo "An error occurred (ResourceNotFoundException) when calling the GetFunction operation: Function not found" >&2
    exit 254 ;;
  throttle)
    echo "An error occurred (ThrottlingException) when calling the GetFunction operation: Rate exceeded" >&2
    exit 254 ;;
esac
`,
    { mode: 0o755 },
  );

  const script = join(dir, 'probe.sh');
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
${CANONICAL_HELPER_BLOCK}
assert_gone "widget still exists after destroy" aws lambda get-function --function-name w
echo "LEAK-CHECK-PASSED"
`,
    { mode: 0o755 },
  );

  const run = (mode: string) =>
    spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env['PATH']}`, AWS_STUB_MODE: mode },
    });

  it('probe success -> FAIL: still exists', () => {
    const r = run('exists');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: widget still exists after destroy');
    expect(r.stdout).not.toContain('LEAK-CHECK-PASSED');
  });

  it('not-found error -> the leak check passes', () => {
    const r = run('notfound');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LEAK-CHECK-PASSED');
  });

  it('throttle error -> FAIL: undetermined (never a silent pass)', () => {
    const r = run('throttle');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('gone-probe undetermined');
    expect(r.stderr).toContain('ThrottlingException');
    expect(r.stdout).not.toContain('LEAK-CHECK-PASSED');
  });

  it('cleans up the temp scripts', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});

describe('integ fixture verify.sh gone-probes (#1097 pattern 2)', () => {
  const fixtures = readFixtures();
  const inScope = fixtures.filter((f) => !(f.name in PENDING_OTHER_PR));

  it('finds the fixture tree', () => {
    expect(fixtures.length).toBeGreaterThan(100);
  });

  it('never backs a leak assertion with a blind probe (Form B)', () => {
    const offenders = inScope
      .filter((f) => f.blindLeakAsserts.length > 0)
      .map((f) => `${f.name}: ${f.blindLeakAsserts.map((p) => p.line).join(',')}`);
    expect(offenders).toEqual([]);
  });

  it('never concludes "gone" from a negated blind probe (Form A)', () => {
    const offenders = inScope
      .filter((f) => f.blindGoneConcludes.length > 0)
      .map((f) => `${f.name}: ${f.blindGoneConcludes.map((p) => p.line).join(',')}`);
    expect(offenders).toEqual([]);
  });

  it('never drives a wait loop directly off a blind probe', () => {
    const offenders = inScope
      .filter((f) => f.blindProbeLoops.length > 0)
      .map((f) => `${f.name}: ${f.blindProbeLoops.map((p) => p.line).join(',')}`);
    expect(offenders).toEqual([]);
  });

  it('every fixture that uses the helpers carries the canonical block verbatim', () => {
    const offenders = inScope
      .filter((f) => f.usesHelpers && !f.hasCanonicalHelperBlock)
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('uses the ONE canonical not-found signature everywhere', () => {
    const offenders = inScope
      .filter((f) => f.nonCanonicalNotFoundGreps.length > 0)
      .map((f) => `${f.name}: ${f.nonCanonicalNotFoundGreps.map((p) => p.line).join(',')}`);
    expect(offenders).toEqual([]);
  });

  it('the sweep actually landed: a majority of fixtures use the helpers', () => {
    // Guards against a future refactor silently dropping the helper blocks.
    expect(inScope.filter((f) => f.usesHelpers).length).toBeGreaterThan(100);
  });

  it('keeps the in-flight-PR exception list free of already-fixed fixtures', () => {
    const stale = Object.keys(PENDING_OTHER_PR).filter((name) => {
      const f = fixtures.find((x) => x.name === name);
      if (!f) return true; // fixture gone entirely -> entry is stale
      return (
        f.blindLeakAsserts.length === 0 &&
        f.blindGoneConcludes.length === 0 &&
        f.blindProbeLoops.length === 0
      );
    });
    expect(stale).toEqual([]);
  });
});

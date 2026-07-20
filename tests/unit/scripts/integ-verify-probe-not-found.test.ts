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
  extractCommandSubstitutions,
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
 * Empty today. `fsx-windows` / `fsx-ontap` (PR #1094) and `emr-cluster`
 * (PR #1101) have since landed in this tree and already use strict
 * output-capturing idioms this classifier accepts without an exception.
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
    ['spaced > /dev/null redirection', 'if aws lambda get-function --function-name x > /dev/null 2>&1; then'],
    ['spaced 2> /dev/null silencing', 'if aws sqs get-queue-url --queue-name x 2> /dev/null | grep -q x; then'],
    ['spaced reversed redirect order', 'if aws ssm get-parameter --name x 2>&1 > /dev/null; then'],
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

  it.each([
    ['if condition, variable verb', 'if aws glue ${chk} --region r >/dev/null 2>&1; then\n  echo "FAIL: still exists after destroy" >&2\n  exit 1\nfi\n'],
    ['negated if condition', 'if ! aws glue ${chk} --region r >/dev/null 2>&1; then\n  GONE=1\nfi\n'],
    ['quoted variable verb', 'if aws glue "$chk" --region r >/dev/null 2>&1; then\n  echo "FAIL: still exists" >&2\n  exit 1\nfi\n'],
    ['variable service', 'if aws ${svc} describe-thing --id x >/dev/null 2>&1; then\n  echo "noise"\nfi\n'],
    ['&&-list position', 'aws glue ${chk} --region r >/dev/null 2>&1 && { echo "FAIL: still exists" >&2; exit 1; }\n'],
    ['||-list position', 'aws glue ${chk} --region r >/dev/null 2>&1 || { GONE=1; break; }\n'],
  ])('flags a silenced variable-verb probe: %s', (_label, script) => {
    expect(classifyVerifyScript(script).variableVerbProbes).toHaveLength(1);
  });

  it.each([
    ['routed through gone_probe', 'if ! gone_probe aws glue ${chk} --region r; then\n  echo "FAIL: still exists" >&2\n  exit 1\nfi\n'],
    ['unsilenced strict capture', 'if ! out=$(aws glue ${chk} --region r 2>&1); then\n  echo "probe failed: ${out}" >&2\nfi\n'],
    ['literal-verb probe (handled by the read-probe categories)', 'if aws glue get-job --job-name x >/dev/null 2>&1; then\n  echo "noise"\nfi\n'],
  ])('does not flag a variable-verb non-violation: %s', (_label, script) => {
    expect(classifyVerifyScript(script).variableVerbProbes).toEqual([]);
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

describe('capture-form probes (issue #1120 item 1)', () => {
  it.each([
    [
      'silenced + || echo literal',
      'VER1="$(aws appconfig list-hosted-configuration-versions --application-id x --query q --output text 2>/dev/null || echo None)"\n',
    ],
    [
      'silenced + || true',
      "SSM_VALUE=$(aws ssm get-parameter --name p --query 'Parameter.Value' --output text 2>/dev/null || true)\n",
    ],
    [
      'silenced + || echo 0 count',
      `N="$(aws elbv2 describe-listeners --load-balancer-arn a --query 'length(Listeners)' --output text 2>/dev/null || echo 0)"\n`,
    ],
    [
      'unsilenced fallback (stderr to terminal, value still poisoned)',
      'URL=$(aws sqs get-queue-url --queue-name q --output text || echo "")\n',
    ],
    [
      'swallow tail attached AFTER the substitution',
      'STATUS=$(aws dynamodb describe-table --table-name t 2>/dev/null) || true\n',
    ],
    [
      'multi-line continuation capture',
      'POLICY=$(aws dynamodb get-resource-policy \\\n  --resource-arn a --region r \\\n  --query Policy --output text 2>/dev/null || echo "")\n',
    ],
    [
      'spaced 2> /dev/null silencing',
      'V=$(aws efs describe-backup-policy --file-system-id f 2> /dev/null || echo "")\n',
    ],
    [
      '|| printf swallow inside the substitution',
      "V=$(aws ssm get-parameter --name p --query 'Parameter.Value' --output text 2>/dev/null || printf '')\n",
    ],
    [
      '|| : swallow inside the substitution',
      'V=$(aws ssm get-parameter --name p --output text 2>/dev/null || :)\n',
    ],
    [
      'assignment-fallback tail after the substitution (|| V="")',
      'STATUS=$(aws dynamodb describe-table --table-name t 2>/dev/null) || STATUS=""\n',
    ],
    [
      'assignment-fallback inside the substitution (|| V=0)',
      "N=$(aws elbv2 describe-listeners --load-balancer-arn a --query 'length(Listeners)' --output text 2>/dev/null || N=0)\n",
    ],
    [
      'unsilenced assignment-fallback tail (value still poisoned)',
      "URL=$(aws sqs get-queue-url --queue-name q --output text) || URL=''\n",
    ],
  ])('flags a swallowed capture: %s', (_label, script) => {
    expect(classifyVerifyScript(script).blindCaptureProbes).toHaveLength(1);
  });

  it('flags the outer capture once when a nested substitution is present', () => {
    const script =
      `C="$(aws appconfig list-deployments --application-id x --environment-id "$(aws appconfig list-environments --application-id x --query 'Items[0].Id' --output text)" --query 'length(Items)' --output text 2>/dev/null || echo 0)"\n`;
    expect(classifyVerifyScript(script).blindCaptureProbes).toHaveLength(1);
  });

  it.each([
    ['mutation-verb capture', 'V=$(aws sqs delete-queue --queue-url u 2>/dev/null || true)\n'],
    [
      'plain silenced assignment without fallback (set -e fails it loudly)',
      'V=$(aws dynamodb describe-table --table-name t --query s --output text 2>/dev/null)\n',
    ],
    [
      'strict stderr-capture idiom (error text lands IN the value)',
      'EU_ERR="$(aws dynamodb describe-table --table-name t --region r 2>&1 >/dev/null || true)"\n',
    ],
    ['strict s3 ls listing capture', 'KEYS="$(aws s3 ls "s3://b/p" 2>&1 || true)"\n'],
    [
      'aws s3 cp content fetch (not a read-verb probe)',
      'STATE=$(aws s3 cp "s3://b/k" - 2>/dev/null || true)\n',
    ],
    [
      'plain unsilenced strict capture',
      "ARN=$(aws ssm get-parameter --name p --query 'Parameter.ARN' --output text)\n",
    ],
    [
      'silenced for-loop cleanup sweep without fallback (best-effort, out of scope)',
      'for r in $(aws iam list-roles --query q --output text 2>/dev/null); do\n  echo "${r}"\ndone\n',
    ],
    [
      'non-aws command substitution with a fallback',
      'LEFT="$(find_orphans || true)"\n',
    ],
    [
      'TOCTOU-guarded requery (stderr captured INTO the value for inspection)',
      `elif ! status="$(aws dynamodb describe-table --table-name t --query 'Table.TableStatus' --output text 2>&1)"; then\n`,
    ],
    [
      'assignment-fallback tail on a strict stderr-capturing probe',
      'V=$(aws ssm get-parameter --name p --output text 2>&1) || V=$(strict_fallback_probe)\n',
    ],
  ])('does not flag: %s', (_label, script) => {
    expect(classifyVerifyScript(script).blindCaptureProbes).toEqual([]);
  });

  it('exempts captures inside a best-effort set +eu cleanup span', () => {
    const script = `cleanup() {
  set +eu
  acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  set -eu
}
ACCT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
`;
    const c = classifyVerifyScript(script);
    expect(c.blindCaptureProbes).toHaveLength(1);
    expect(c.blindCaptureProbes[0]!.line).toBe(6); // only the live-phase one
  });

  it('bounds an unrestored set +e span at the enclosing function close', () => {
    // local-run-task-from-state's cleanup opens `set +e` and never restores
    // (it ends with exit); the span must not leak over the live phase below.
    const script = `cleanup() {
  set +e
  IMGS="$(aws ecr list-images --repository-name r --query imageIds --output json 2>/dev/null || echo '[]')"
  exit 0
}
LIVE="$(aws ecr list-images --repository-name r --query imageIds --output json 2>/dev/null || echo '[]')"
`;
    const c = classifyVerifyScript(script);
    expect(c.blindCaptureProbes).toHaveLength(1);
    expect(c.blindCaptureProbes[0]!.line).toBe(6);
  });

  it('extractCommandSubstitutions masks nested substitutions', () => {
    const [outer, inner] = extractCommandSubstitutions(
      'A="$(aws x list-y --id "$(aws x list-z --q 2>/dev/null)" --out text)"',
    );
    expect(outer!.body).toContain('__NESTED__');
    expect(outer!.body).not.toContain('list-z');
    expect(inner!.body).toContain('list-z');
  });

  it('extractCommandSubstitutions skips an unbalanced (never-closed) substitution', () => {
    expect(extractCommandSubstitutions('V=$(aws ec2 describe-vpcs --query "length(Vpcs"')).toEqual(
      [],
    );
    // ...while still returning a later balanced one on the same line.
    const subs = extractCommandSubstitutions('A=$(broken B=$(aws s3 ls "s3://b" 2>&1)');
    expect(subs.some((s) => s.body.includes('s3 ls'))).toBe(true);
  });
});

describe('silenced probes in function bodies (issue #1120 item 2)', () => {
  it.each([
    [
      'exit-status wrapper (the old ssm_exists shape)',
      'ssm_exists() {\n  aws ssm get-parameter --name "$1" --region r >/dev/null 2>&1\n}\n',
    ],
    [
      '&>/dev/null exit-status wrapper',
      'role_exists() {\n  aws iam get-role --role-name "$1" &>/dev/null\n}\n',
    ],
    [
      'value wrapper with || true swallow tail',
      "find_fixture_vpcs() {\n  aws ec2 describe-vpcs --filters f --query 'Vpcs[].VpcId' --output text 2>/dev/null || true\n}\n",
    ],
    [
      'value wrapper with || echo "" swallow tail (multi-line)',
      `queue_url() {\n  aws sqs get-queue-url --queue-name "\${name}" --region r \\\n    --query 'QueueUrl' --output text 2>/dev/null || echo ""\n}\n`,
    ],
    [
      'single-line exit-status wrapper (compact body on the header line)',
      'ssm_exists() { aws ssm get-parameter --name "$1" --region r >/dev/null 2>&1; }\n',
    ],
    [
      '`function` keyword form',
      'function role_exists() {\n  aws iam get-role --role-name "$1" >/dev/null 2>&1\n}\n',
    ],
    [
      'reversed 2>&1 >/dev/null exit-status wrapper',
      'fs_exists() {\n  aws efs describe-file-systems --file-system-id "$1" 2>&1 >/dev/null\n}\n',
    ],
    [
      'split 2>/dev/null + >/dev/null exit-status wrapper',
      'tbl_exists() {\n  aws dynamodb describe-table --table-name "$1" >/dev/null 2>/dev/null\n}\n',
    ],
    [
      'single-line value wrapper with a swallow tail',
      "api_id() { aws apigateway get-rest-apis --query q --output text 2>/dev/null || true; }\n",
    ],
  ])('flags a silenced wrapper: %s', (_label, script) => {
    expect(classifyVerifyScript(script).silencedFunctionProbes).toHaveLength(1);
  });

  it.each([
    [
      'tail-less value wrapper ($(fn) fails loudly under set -e)',
      "api_id() {\n  aws apigateway get-rest-apis --query q --output text 2>/dev/null\n}\n",
    ],
    [
      'unsilenced strict value wrapper',
      "find_ids() {\n  aws ec2 describe-vpcs --filters f --query 'Vpcs[].VpcId' --output text\n}\n",
    ],
    [
      'gone_probe-backed expected-missing wrapper',
      `queue_url() {\n  if gone_probe aws sqs get-queue-url --queue-name "$1"; then\n    echo ""\n    return 0\n  fi\n  aws sqs get-queue-url --queue-name "$1" --query 'QueueUrl' --output text\n}\n`,
    ],
    [
      'mutation probe inside a function',
      'drop() {\n  aws sqs delete-queue --queue-url "$1" >/dev/null 2>&1 || true\n}\n',
    ],
    [
      'best-effort cleanup function marked with set +eu',
      "sweep() {\n  set +eu\n  aws iam list-roles --query q --output text 2>/dev/null || true\n  set -eu\n}\n",
    ],
    [
      'condition-position probe (owned by the condition categories)',
      'guard() {\n  if aws s3api head-object --bucket b --key k >/dev/null 2>&1; then\n    cli destroy || true\n  fi\n}\n',
    ],
    [
      'top-level bare silenced probe (not in a function)',
      'aws ssm get-parameter --name p >/dev/null 2>&1 || true\n',
    ],
    [
      'single-line mutation wrapper',
      'drop() { aws sqs delete-queue --queue-url "$1" >/dev/null 2>&1 || true; }\n',
    ],
    [
      'single-line strict value wrapper (unsilenced)',
      "api_id() { aws apigateway get-rest-apis --query q --output text; }\n",
    ],
    [
      'subshell set +eu cleanup helper (span bounded at the function close)',
      'sweep() {\n  (\n    set +eu\n    aws iam list-roles --query q --output text 2>/dev/null || true\n  )\n}\n',
    ],
  ])('does not flag: %s', (_label, script) => {
    expect(classifyVerifyScript(script).silencedFunctionProbes).toEqual([]);
  });

  it('never flags the canonical helper block itself', () => {
    const c = classifyVerifyScript(`${CANONICAL_HELPER_BLOCK}\n`);
    expect(c.silencedFunctionProbes).toEqual([]);
    expect(c.blindCaptureProbes).toEqual([]);
    expect(c.unpropagatedWrapperCaptures).toEqual([]);
  });
});

describe('unpropagated intermediate wrapper captures (issue #1120 review blocker)', () => {
  // errexit is CLEARED inside $( ) command substitutions, so an intermediate
  // capture failure inside a value wrapper does not abort the body -- the
  // wrapper returns its LAST command's status and the probe error silently
  // reads as "nothing found". Empirically verified (see the PR discussion):
  // `V="$(fn)"` under set -e succeeds with V='' when fn's intermediate
  // capture fails without `|| return 1`.
  const WRAPPER = (capture: string) => `find_ids() {
  local out
  ${capture}
  printf '%s\\n' "\${out}" | tr '\\t' '\\n' | grep -v '^$' || true
}
`;

  it.each([
    [
      'intermediate capture without || return',
      WRAPPER(`out="$(aws ec2 describe-vpcs --filters f --query 'Vpcs[].VpcId' --output text)"`),
    ],
    [
      'silenced intermediate capture without || return',
      WRAPPER(`out="$(aws ec2 describe-vpcs --query 'Vpcs[].VpcId' --output text 2>/dev/null)"`),
    ],
    [
      'local declaration-assignment (masks the status even WITH || return 1)',
      `find_ids() {\n  local out="$(aws ec2 describe-vpcs --query q --output text)" || return 1\n  printf '%s\\n' "\${out}" || true\n}\n`,
    ],
  ])('flags: %s', (_label, script) => {
    expect(classifyVerifyScript(script).unpropagatedWrapperCaptures).toHaveLength(1);
  });

  it.each([
    [
      'intermediate capture WITH || return 1',
      WRAPPER(`out="$(aws ec2 describe-vpcs --filters f --query 'Vpcs[].VpcId' --output text)" || return 1`),
    ],
    [
      'capture as the LAST statement (its status IS the function status)',
      `api_id() {\n  RES="$(aws apigateway get-rest-apis --query q --output text)"\n}\n`,
    ],
    [
      'status-consuming tail (&& rc=0 || rc=$? state machine)',
      `fs_state() {\n  local out rc\n  out="$(aws fsx describe-file-systems --file-system-ids "$1" --output text 2>&1)" && rc=0 || rc=$?\n  case "\${out}" in *NotFound*) return 0 ;; *) return 2 ;; esac\n}\n`,
    ],
    [
      'condition-context capture (status inspected explicitly)',
      `queue_url() {\n  local out\n  if ! out="$(aws sqs get-queue-url --queue-name q --output text 2>&1)"; then\n    echo ""\n    return 0\n  fi\n  printf '%s\\n' "\${out}"\n}\n`,
    ],
    ['non-aws intermediate capture', WRAPPER(`out="$(some_helper)"`)],
    [
      'mutation-verb intermediate capture',
      WRAPPER(`out="$(aws sqs delete-queue --queue-url u 2>&1)"`),
    ],
    [
      'intermediate capture inside a set +eu cleanup span',
      `sweep() {\n  (\n    set +eu\n    out="$(aws iam list-roles --query q --output text 2>/dev/null)"\n    echo "\${out}"\n  )\n}\n`,
    ],
    [
      'top-level intermediate capture (not in a function; set -e applies)',
      `out="$(aws ec2 describe-vpcs --query q --output text)"\nprintf '%s\\n' "\${out}" || true\n`,
    ],
  ])('does not flag: %s', (_label, script) => {
    expect(classifyVerifyScript(script).unpropagatedWrapperCaptures).toEqual([]);
  });
});

describe('bash behavior of the strict capture form (issue #1120)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-capture-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, 'aws'),
    `#!/usr/bin/env bash
case "\${AWS_STUB_MODE}" in
  value) echo "plan-1"; exit 0 ;;
  throttle)
    echo "An error occurred (ThrottlingException) when calling the GetUsagePlans operation: Rate exceeded" >&2
    exit 254 ;;
esac
`,
    { mode: 0o755 },
  );
  const run = (script: string, mode: string) => {
    const p = join(dir, 'probe.sh');
    writeFileSync(p, script, { mode: 0o755 });
    return spawnSync('bash', [p], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env['PATH']}`, AWS_STUB_MODE: mode },
    });
  };
  const STRICT = `#!/usr/bin/env bash
set -euo pipefail
PLAN=$(aws apigateway get-usage-plans --query q --output text)
echo "VALUE:\${PLAN}"
`;

  it('strict capture propagates the value on success', () => {
    const r = run(STRICT, 'value');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('VALUE:plan-1');
  });

  it('strict capture hard-fails loudly on a throttle (never "0 remaining")', () => {
    const r = run(STRICT, 'throttle');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ThrottlingException');
    expect(r.stdout).not.toContain('VALUE:');
  });

  it('the banned fallback form silently reads a throttle as the fallback literal', () => {
    // Documents WHY the capture-form category exists: same throttle, but the
    // fallback masks it as a legitimate-looking value and the script passes.
    const r = run(
      `#!/usr/bin/env bash
set -euo pipefail
PLAN=$(aws apigateway get-usage-plans --query q --output text 2>/dev/null || echo None)
echo "VALUE:\${PLAN}"
`,
      'throttle',
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('VALUE:None');
  });

  it('an intermediate wrapper capture WITHOUT || return 1 silently reads a throttle as empty', () => {
    // Documents WHY unpropagatedWrapperCaptures exists: errexit is CLEARED
    // inside $( ), so the wrapper keeps running past the failed capture and
    // returns the formatting tail's status 0 -- the caller sees "".
    const r = run(
      `#!/usr/bin/env bash
set -euo pipefail
find_ids() {
  local out
  out="$(aws apigateway get-usage-plans --query q --output text)"
  printf '%s\\n' "\${out}" | grep -v '^None$' || true
}
IDS="$(find_ids)"
echo "IDS:[\${IDS}]"
`,
      'throttle',
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IDS:[]');
  });

  it('an intermediate wrapper capture WITH || return 1 hard-fails the caller on a throttle', () => {
    const r = run(
      `#!/usr/bin/env bash
set -euo pipefail
find_ids() {
  local out
  out="$(aws apigateway get-usage-plans --query q --output text)" || return 1
  printf '%s\\n' "\${out}" | grep -v '^None$' || true
}
IDS="$(find_ids)"
echo "IDS:[\${IDS}]"
`,
      'throttle',
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ThrottlingException');
    expect(r.stdout).not.toContain('IDS:[');
  });

  it('cleans up the temp scripts', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
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
  http404)
    echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2
    exit 254 ;;
  arn404)
    echo "An error occurred (AccessDenied) when calling the GetFunction operation: User arn:aws:iam::123404567890:role/x is not authorized" >&2
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

  it('"An error occurred (404)" -> the leak check passes (anchored 404)', () => {
    const r = run('http404');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LEAK-CHECK-PASSED');
  });

  it('a bare 404 embedded in an ARN does NOT match -> FAIL: undetermined', () => {
    // Before the \\(404 anchor, "123404567890" in an AccessDenied ARN would
    // satisfy the alternation and silently pass the leak check.
    const r = run('arn404');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('gone-probe undetermined');
    expect(r.stdout).not.toContain('LEAK-CHECK-PASSED');
  });

  it('a forgotten assert_gone description hard-FAILs instead of silently passing', () => {
    // `assert_gone aws ...` (desc omitted) makes gone_probe exec
    // `lambda get-function ...` -> "command not found" would match
    // `not ?found` without the first-arg guard.
    const noDescScript = join(dir, 'no-desc.sh');
    writeFileSync(
      noDescScript,
      `#!/usr/bin/env bash
set -euo pipefail
${CANONICAL_HELPER_BLOCK}
assert_gone aws lambda get-function --function-name w
echo "LEAK-CHECK-PASSED"
`,
      { mode: 0o755 },
    );
    const r = spawnSync('bash', [noDescScript], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env['PATH']}`, AWS_STUB_MODE: 'notfound' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('gone_probe: probe must start with aws (got: lambda)');
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

  it('never swallows a probe error inside a read-verb capture (capture form, #1120)', () => {
    const offenders = inScope
      .filter((f) => f.blindCaptureProbes.length > 0)
      .map((f) => `${f.name}: ${f.blindCaptureProbes.map((p) => p.line).join(',')}`);
    expect(offenders).toEqual([]);
  });

  it('never hides a silenced read probe inside a function wrapper (#1120)', () => {
    const offenders = inScope
      .filter((f) => f.silencedFunctionProbes.length > 0)
      .map((f) => `${f.name}: ${f.silencedFunctionProbes.map((p) => p.line).join(',')}`);
    expect(offenders).toEqual([]);
  });

  it('never leaves an intermediate wrapper capture unpropagated (#1120 review)', () => {
    const offenders = inScope
      .filter((f) => f.unpropagatedWrapperCaptures.length > 0)
      .map((f) => `${f.name}: ${f.unpropagatedWrapperCaptures.map((p) => p.line).join(',')}`);
    expect(offenders).toEqual([]);
  });

  it('never probes with a silenced variable verb in condition position', () => {
    const offenders = inScope
      .filter((f) => f.variableVerbProbes.length > 0)
      .map((f) => `${f.name}: ${f.variableVerbProbes.map((p) => p.line).join(',')}`);
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
        f.blindProbeLoops.length === 0 &&
        f.variableVerbProbes.length === 0 &&
        f.blindCaptureProbes.length === 0 &&
        f.silencedFunctionProbes.length === 0 &&
        f.unpropagatedWrapperCaptures.length === 0
      );
    });
    expect(stale).toEqual([]);
  });
});

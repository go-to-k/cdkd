#!/usr/bin/env bash
# verify.sh — a producer does not delete an old copy before the removal it
# uses while a consumer of the same `cdkd deploy` run, which may fail and roll
# back, still names it (go-to-k/cdkd#7204).
#
# Stacks (lib/stacks.ts):
#   CdkdXsEarlyDelProd  function <prefix>-v1 with its currentVersion and alias
#                       `live` (phase 2: renamed -v2, replacing the function and
#                       the alias and removing the old version); CDK exports
#                       the alias ARN.
#   CdkdXsEarlyDelCons  function whose ALIAS_ARN environment variable imports
#                       the alias ARN; with CDKD_TEST_FAIL=true also a queue AWS
#                       refuses, created after the function.
#
# Steps:
#   1. deploy both (phase 1): ALIAS_ARN is v1's alias.
#   2. deploy both, phase 2 + failure: exit non-zero. The producer did NOT
#      delete the old alias before the removed old version (#6977's early
#      delete), because the consumer's records name it, and says so; the
#      removed old version is kept without its delete being sent; the old
#      alias and version are alive, and the rolled-back consumer's ALIAS_ARN
#      names that live alias.
#   3. deploy both, phase 2 without failure: exit 2 (the consumer's records
#      still name the old alias until it deploys, so the removed old version
#      is kept, unsent, once more); ALIAS_ARN is v2's alias, and the old alias
#      is gone.
#   4. deploy both again: exit 0; nothing of v1 is left, in AWS or state.
#   5. destroy both; every resource and state record is gone.
#
# Run via: /run-integ cross-stack-early-delete-consumer

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
# The first-arg guard catches a forgotten assert_gone description: without it,
# `assert_gone aws ...` would exec `lambda get-function ...` and the shell's
# "command not found" error would match the signature -- a silent pass.
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  [ "${1:-}" = "aws" ] || { echo "FAIL: gone_probe: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
    echo "FAIL: gone-probe undetermined ($*): ${out}" >&2
    exit 1
  fi
  return 0
}
assert_gone() { # usage: assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  if ! gone_probe "$@"; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
[ -f ../../../dist/cli.js ] || { echo "FAIL: dist/cli.js is missing; run vp run build" >&2; exit 1; }
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"

PROD="CdkdXsEarlyDelProd"
CONS="CdkdXsEarlyDelCons"
FN1="cdkd-integ-xs-early-del-v1"
FN2="cdkd-integ-xs-early-del-v2"
FNC="cdkd-integ-xs-early-del-cons"
QBOOM="cdkd-integ-xs-early-del-boom"

sweep() { # best-effort; called from cleanup and before the run
  set +eu
  for s in "${CONS}" "${PROD}"; do
    ${CDKD} destroy "${s}" --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
  done
  for f in "${FNC}" "${FN1}" "${FN2}"; do
    aws lambda delete-function --function-name "${f}" --region "${AWS_REGION}" >/dev/null 2>&1
    aws logs delete-log-group --log-group-name "/aws/lambda/${f}" --region "${AWS_REGION}" >/dev/null 2>&1
  done
  url=$(aws sqs get-queue-url --queue-name "${QBOOM}" --region "${AWS_REGION}" --query QueueUrl --output text 2>/dev/null)
  [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${AWS_REGION}" >/dev/null 2>&1
  for s in "${CONS}" "${PROD}"; do
    for k in state.json lock.json; do
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${AWS_REGION}/${k}" >/dev/null 2>&1
    done
  done
  return 0
}

cleanup() {
  local rc=$?
  set +eu
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  sweep
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

alias_arn() { # usage: alias_arn <function> — prints its `live` alias ARN
  aws lambda get-alias --function-name "$1" --name live --region "${AWS_REGION}" \
    --query AliasArn --output text
}
alias_version() { # usage: alias_version <function> — prints the version `live` points at
  aws lambda get-alias --function-name "$1" --name live --region "${AWS_REGION}" \
    --query FunctionVersion --output text
}
cons_alias_arn() { # prints the consumer's ALIAS_ARN environment variable
  aws lambda get-function-configuration --function-name "${FNC}" --region "${AWS_REGION}" \
    --query 'Environment.Variables.ALIAS_ARN' --output text
}
prod_state() { # prints the producer's state.json
  aws s3 cp "s3://${STATE_BUCKET}/cdkd/${PROD}/${AWS_REGION}/state.json" - --region "${AWS_REGION}"
}
superseded_ids() { # prints the producer state's superseded physical ids, one per line
  prod_state |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{for(const e of JSON.parse(s).supersededResources??[])console.log(e.state.physicalId)})'
}
v1_records() { # prints the producer state's records whose physical id names v1, one per line
  prod_state |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{for(const [id,r] of Object.entries(JSON.parse(s).resources??{}))if(String(r.physicalId).includes(process.argv[1]))console.log(id)})' "${FN1}"
}
expect_eq() { # usage: expect_eq <what> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: got '$2', expected '$3'" >&2
    exit 1
  fi
}

echo "==> Pre-run sweep"
sweep
set -eu

echo "==> Step 1: deploy both (phase 1)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_FAIL ${CDKD} deploy --all --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}"
A1=$(alias_arn "${FN1}")
V1=$(alias_version "${FN1}")
expect_eq "ALIAS_ARN after phase 1" "$(cons_alias_arn)" "${A1}"

echo "==> Step 2: deploy both, phase 2 with the consumer failing"
RC=0
OUT=$(CDKD_TEST_UPDATE=true CDKD_TEST_FAIL=true ${CDKD} deploy --all --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" 2>&1) || RC=$?
echo "${OUT}"
if [ "${RC}" = "0" ]; then
  echo "FAIL: the deploy with the failing consumer resource exited 0" >&2
  exit 1
fi
# The producer did replace the function and its alias.
alias_arn "${FN2}" >/dev/null
assert_gone "the refused queue ${QBOOM} exists" aws sqs get-queue-url --queue-name "${QBOOM}" --region "${AWS_REGION}"
# go-to-k/cdkd#7204: the old alias was not deleted early, and said so.
if gone_probe aws lambda get-alias --function-name "${FN1}" --name live --region "${AWS_REGION}"; then
  echo "FAIL: the old alias was deleted before the removed old version although the consumer that names it failed and rolled back (go-to-k/cdkd#7204)" >&2
  exit 1
fi
if ! grep -q "${CONS} (importing this stack's outputs) still uses an old copy of a replaced resource" <<<"${OUT}"; then
  echo "FAIL: no line says the consumer still uses the old alias" >&2
  exit 1
fi
if grep -q "replaced resource(s) first: they use a resource removed from the template" <<<"${OUT}"; then
  echo "FAIL: the producer still announced the early delete" >&2
  exit 1
fi
# ...and the removed old version it uses is kept without its delete being sent.
if ! grep -q "was removed from the template, but the old Live.* still uses it and waits for the stacks importing this stack's outputs" <<<"${OUT}"; then
  echo "FAIL: no line says the removed old version is kept while the old alias waits" >&2
  exit 1
fi
if gone_probe aws lambda get-function --function-name "${FN1}" --qualifier "${V1}" --region "${AWS_REGION}"; then
  echo "FAIL: the old version ${V1} the old alias points at is gone" >&2
  exit 1
fi
if ! grep -qxF "${A1}" <<<"$(superseded_ids)"; then
  echo "FAIL: the producer's state does not record the old alias as still to delete" >&2
  exit 1
fi
# The rolled-back consumer names a live alias.
expect_eq "ALIAS_ARN after the rollback" "$(cons_alias_arn)" "${A1}"
expect_eq "the rolled-back ALIAS_ARN resolves" "$(alias_arn "${FN1}")" "${A1}"

echo "==> Step 3: deploy both, phase 2 without the failure"
RC=0
OUT=$(env -u CDKD_TEST_FAIL CDKD_TEST_UPDATE=true ${CDKD} deploy --all --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" 2>&1) || RC=$?
echo "${OUT}"
# The consumer's records still name the old alias until it deploys, so the
# removed old version is kept, unsent, once more (exit 2).
expect_eq "step 3 exit code" "${RC}" "2"
if ! grep -q "still uses it and waits for the stacks importing this stack's outputs" <<<"${OUT}"; then
  echo "FAIL: step 3 does not say the removed old version waits for the old alias" >&2
  exit 1
fi
expect_eq "ALIAS_ARN after phase 2" "$(cons_alias_arn)" "$(alias_arn "${FN2}")"
assert_gone "the old alias survived the deploy that moved its consumer off it" \
  aws lambda get-alias --function-name "${FN1}" --name live --region "${AWS_REGION}"

echo "==> Step 4: deploy both again"
env -u CDKD_TEST_FAIL CDKD_TEST_UPDATE=true ${CDKD} deploy --all --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}"
assert_gone "function ${FN1} survived" aws lambda get-function --function-name "${FN1}" --region "${AWS_REGION}"
expect_eq "superseded entries left in the producer's state" "$(superseded_ids)" ""
expect_eq "producer records still naming ${FN1}" "$(v1_records)" ""

echo "==> Step 5: destroy both"
CDKD_TEST_UPDATE=true ${CDKD} destroy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
for s in "${PROD}" "${CONS}"; do
  assert_gone "state of ${s} survived destroy" aws s3api head-object --bucket "${STATE_BUCKET}" \
    --key "cdkd/${s}/${AWS_REGION}/state.json"
done
for f in "${FN2}" "${FNC}"; do
  assert_gone "function ${f} survived destroy" aws lambda get-function --function-name "${f}" --region "${AWS_REGION}"
done
for f in "${FNC}" "${FN1}" "${FN2}"; do
  aws logs delete-log-group --log-group-name "/aws/lambda/${f}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
done

trap - EXIT INT TERM
echo "[verify] PASS — a producer keeps an old copy a same-run consumer names until the consumer is done, and the next deploys delete it"

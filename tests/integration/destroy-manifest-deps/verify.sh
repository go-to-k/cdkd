#!/usr/bin/env bash
# verify.sh — cdkd destroy widens the selection to the stacks that depend on a
# selected stack, and destroys a dependent first (go-to-k/cdkd#6115).
#
# Before the fix, destroy read only the Fn::ImportValue / Fn::GetStackOutput
# edges of the templates, never the cloud assembly's stack dependencies. A
# crossRegionReferences strong reference and an explicit addDependency() leave
# only a manifest dependency, so `cdkd destroy <producer>` left the dependent
# deployed (its value naming a deleted resource), and naming both destroyed the
# producer first.
#
# Pair 1: CdkdDmdXrProducer (us-west-2) <- CdkdDmdXrConsumer (us-east-1),
#         crossRegionReferences. Pair 2: CdkdDmdDepProducer <- CdkdDmdDepConsumer
#         (us-east-1), addDependency only (no reference, so a consumer left
#         behind by -e still works).
#
# Phase 1: deploy --all; premise: the four parameters exist and the XR
#          consumer's value is the XR producer's parameter ARN.
# Phase 2: destroy CdkdDmdXrProducer alone: the consumer is added, destroyed
#          FIRST, and both are gone with their state and the writer's
#          /cdk/exports parameters.
# Phase 3: destroy CdkdDmdDepProducer -e: only the producer goes; the consumer
#          and its state stay.
# Phase 4: redeploy CdkdDmdDepProducer, then destroy both named producer-first
#          under -e: the consumer is destroyed first, both are gone.
# Pre-fix red lines: "phase 2: CdkdDmdXrConsumer is still deployed" (phase 2),
# and the unknown -e option (phase 3).
#
# Required env: STATE_BUCKET. The XR pair needs CDK bootstrap assets in
# us-west-2 and us-east-1 (the export writer / reader are Lambda-backed).

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

LOCAL_DIST="${PWD}/../../../dist/cli.js"
XR_PRODUCER="CdkdDmdXrProducer"
XR_CONSUMER="CdkdDmdXrConsumer"
DEP_PRODUCER="CdkdDmdDepProducer"
DEP_CONSUMER="CdkdDmdDepConsumer"
XR_PRODUCER_REGION="us-west-2"
EAST="us-east-1"
PARAM_PREFIX="/cdkd/destroy-manifest-deps"
# The writer puts the exported value under this path in the CONSUMER's region.
EXPORTS_PATH="/cdk/exports/${XR_CONSUMER}"
# Lambda log groups of the export writer / reader, swept by this prefix.
LOG_PREFIX="/aws/lambda/CdkdDmdXr"

region_of() {
  case "$1" in
    "${XR_PRODUCER}") echo "${XR_PRODUCER_REGION}" ;;
    *) echo "${EAST}" ;;
  esac
}
state_key() { echo "cdkd/$1/$(region_of "$1")/state.json"; }

cleanup() {
  echo "==> Cleanup"
  set +eu
  local s r
  for s in "${XR_CONSUMER}" "${XR_PRODUCER}" "${DEP_CONSUMER}" "${DEP_PRODUCER}"; do
    r="$(region_of "${s}")"
    [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" --region "${r}" --yes >/dev/null 2>&1
  done
  aws ssm delete-parameter --name "${PARAM_PREFIX}/xr-producer" --region "${XR_PRODUCER_REGION}" >/dev/null 2>&1 || true
  for n in xr-consumer dep-producer dep-consumer; do
    aws ssm delete-parameter --name "${PARAM_PREFIX}/${n}" --region "${EAST}" >/dev/null 2>&1 || true
  done
  aws ssm get-parameters-by-path --path "${EXPORTS_PATH}" --recursive --region "${EAST}" \
    --query 'Parameters[].Name' --output text 2>/dev/null | tr '\t' '\n' | while read -r p; do
      [ -n "${p}" ] && aws ssm delete-parameter --name "${p}" --region "${EAST}" >/dev/null 2>&1
    done
  case "${LOG_PREFIX}" in
    /aws/lambda/CdkdDmdXr?*)
      for r in "${XR_PRODUCER_REGION}" "${EAST}"; do
        aws logs describe-log-groups --log-group-name-prefix "${LOG_PREFIX}" --region "${r}" \
          --query 'logGroups[].logGroupName' --output text 2>/dev/null | tr '\t' '\n' | while read -r lg; do
            [ -n "${lg}" ] && aws logs delete-log-group --log-group-name "${lg}" --region "${r}" >/dev/null 2>&1
          done
      done
      ;;
    *)
      echo "WARN: teardown sweep refused: log-group prefix '${LOG_PREFIX}' is out of scope" >&2
      ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    for s in "${XR_CONSUMER}" "${XR_PRODUCER}" "${DEP_CONSUMER}" "${DEP_PRODUCER}"; do
      r="$(region_of "${s}")"
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${r}/state.json" >/dev/null 2>&1 || true
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${r}/lock.json" >/dev/null 2>&1 || true
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${r}/rollback-journal.json" >/dev/null 2>&1 || true
    done
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

param_value() { # usage: param_value <name> <region>
  aws ssm get-parameter --name "${PARAM_PREFIX}/$1" --region "$2" --query Parameter.Value --output text
}
param_arn() { # usage: param_arn <name> <region>
  aws ssm get-parameter --name "${PARAM_PREFIX}/$1" --region "$2" --query Parameter.ARN --output text
}
# Line number of "Preparing to destroy stack: <stack>" in a destroy log; empty
# when the stack was never prepared.
prepared_line() { # usage: prepared_line <stack> <log text>
  grep -nE "Preparing to destroy stack: $1\$" <<<"$2" | head -1 | cut -d: -f1 || true
}
# A destroy log's lines, in order, asserting the dependent was prepared before
# its producer.
assert_dependent_first() { # usage: assert_dependent_first <phase> <dependent> <producer> <log text>
  local d p
  d="$(prepared_line "$2" "$4")"
  p="$(prepared_line "$3" "$4")"
  if [ -z "${d}" ] || [ -z "${p}" ]; then
    if grep -qF "Found " <<<"$4"; then
      echo "FAIL: $1: the destroy did not prepare both $2 and $3 (lines '${d}' / '${p}')" >&2
    else
      echo "FAIL: $1: the destroy log has no 'Found ... stack(s) to destroy' line; the wording drifted" >&2
    fi
    exit 1
  fi
  if [ "${d}" -ge "${p}" ]; then
    echo "FAIL: $1: $3 was destroyed before its dependent $2 (lines ${p} < ${d})" >&2
    exit 1
  fi
  echo "    OK: $1: $2 destroyed before $3"
}
assert_stack_gone() { # usage: assert_stack_gone <phase> <stack> <param> <region>
  assert_gone "$1: $2's parameter ${PARAM_PREFIX}/$3 still exists" aws ssm get-parameter --name "${PARAM_PREFIX}/$3" --region "$4"
  assert_gone "$1: $2's state $(state_key "$2") remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(state_key "$2")"
  echo "    OK: $1: $2 and its state are gone"
}
run_destroy() { # usage: run_destroy <args...>; prints the log, fails on a non-zero exit
  local out rc
  if out="$(node "${LOCAL_DIST}" destroy "$@" --state-bucket "${STATE_BUCKET}" --force 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  printf '%s\n' "${out}" >&2
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: cdkd destroy $* exited ${rc}" >&2
    return 1
  fi
  printf '%s\n' "${out}"
}

echo "==> Phase 1: deploy --all"
node "${LOCAL_DIST}" deploy --all --state-bucket "${STATE_BUCKET}" --yes
XR_ARN="$(param_arn xr-producer "${XR_PRODUCER_REGION}")"
XR_READ="$(param_value xr-consumer "${EAST}")"
if [ -z "${XR_ARN}" ] || [ "${XR_READ}" != "${XR_ARN}" ]; then
  echo "FAIL: phase 1: ${XR_CONSUMER} holds '${XR_READ}', not the producer's ARN '${XR_ARN}'" >&2
  exit 1
fi
param_value dep-producer "${EAST}" >/dev/null
param_value dep-consumer "${EAST}" >/dev/null
EXPORTS="$(aws ssm get-parameters-by-path --path "${EXPORTS_PATH}" --recursive --region "${EAST}" --query 'Parameters[].Name' --output text)"
[ -n "${EXPORTS}" ] || { echo "FAIL: phase 1: no export-writer parameter under ${EXPORTS_PATH} in ${EAST}" >&2; exit 1; }
echo "    OK: phase 1: the four stacks are deployed and the cross-region value resolved"

echo "==> Phase 2: destroy ${XR_PRODUCER} alone"
P2="$(run_destroy "${XR_PRODUCER}")" || exit 1
if ! gone_probe aws ssm get-parameter --name "${PARAM_PREFIX}/xr-consumer" --region "${EAST}"; then
  echo "FAIL: phase 2: ${XR_CONSUMER} is still deployed after destroying ${XR_PRODUCER} (go-to-k/cdkd#6115: the dependent was not added)" >&2
  exit 1
fi
grep -qF "Found 2 stack(s) to destroy: ${XR_CONSUMER} (depends on ${XR_PRODUCER}), ${XR_PRODUCER}" <<<"${P2}" \
  || { echo "FAIL: phase 2: the selection line does not name ${XR_CONSUMER} as added for ${XR_PRODUCER}" >&2; exit 1; }
assert_dependent_first "phase 2" "${XR_CONSUMER}" "${XR_PRODUCER}" "${P2}"
assert_stack_gone "phase 2" "${XR_CONSUMER}" xr-consumer "${EAST}"
assert_stack_gone "phase 2" "${XR_PRODUCER}" xr-producer "${XR_PRODUCER_REGION}"
EXPORTS="$(aws ssm get-parameters-by-path --path "${EXPORTS_PATH}" --recursive --region "${EAST}" --query 'Parameters[].Name' --output text)"
[ -z "${EXPORTS}" ] || { echo "FAIL: phase 2: export parameters remain under ${EXPORTS_PATH}: ${EXPORTS}" >&2; exit 1; }
echo "    OK: phase 2: no export parameter remains"

echo "==> Phase 3: destroy ${DEP_PRODUCER} -e"
P3="$(run_destroy "${DEP_PRODUCER}" -e)" || exit 1
assert_stack_gone "phase 3" "${DEP_PRODUCER}" dep-producer "${EAST}"
param_value dep-consumer "${EAST}" >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(state_key "${DEP_CONSUMER}")" >/dev/null
if grep -qF "Also destroying" <<<"${P3}"; then
  echo "FAIL: phase 3: -e still added a dependent" >&2
  exit 1
fi
echo "    OK: phase 3: -e destroyed only ${DEP_PRODUCER}; ${DEP_CONSUMER} and its state stay"

echo "==> Phase 4: redeploy ${DEP_PRODUCER}, then destroy both, producer named first"
node "${LOCAL_DIST}" deploy "${DEP_PRODUCER}" --state-bucket "${STATE_BUCKET}" --yes
param_value dep-producer "${EAST}" >/dev/null
P4="$(run_destroy "${DEP_PRODUCER}" "${DEP_CONSUMER}" -e)" || exit 1
assert_dependent_first "phase 4" "${DEP_CONSUMER}" "${DEP_PRODUCER}" "${P4}"
assert_stack_gone "phase 4" "${DEP_CONSUMER}" dep-consumer "${EAST}"
assert_stack_gone "phase 4" "${DEP_PRODUCER}" dep-producer "${EAST}"

trap - EXIT INT TERM
cleanup
echo ""
echo "[verify] PASS — destroy-manifest-deps: destroy adds manifest dependents, -e keeps to the named stacks, dependents go first"

#!/usr/bin/env bash
# verify.sh — a wide stack: 48 independent resources (12 each of SQS queue,
# SNS topic, SSM parameter, log group), more than the default --concurrency
# (10). Issue #5209: how long a resource whose dependencies are done waits for
# a slot, read off the `CDKD_PHASE_TIMINGS` report.
#
# Phases:
#   1. Deploy at --concurrency 10, with the phase report on. Assert
#      every resource exists, and that the report carries the slot-wait line
#      for all 48 resources. Destroy, assert gone.
#   (Settings: WIDE_SDK_SETTINGS, default "10 30"; WIDE_CC_SETTINGS, default
#   "10 20 30". Every phase passes --concurrency explicitly.)
#   2. The same at --concurrency 30, under a fresh name token (SQS holds a
#      deleted queue's name for 60s). Destroy, assert gone.
#   3. Issue #5242: CDKD_WIDE_KIND=cc, 48 resources of types with no SDK
#      provider (24 SSM documents, 24 Athena workgroups), so every one goes
#      through Cloud Control, at --concurrency 10, 20 and 30, each with its own
#      token. Assert live, destroy, assert gone, and the state file removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
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

STACK="CdkdWideIndependentExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
PER_TYPE=12
# One name token per phase; lowercase letters and digits only (an SQS name).
# The --concurrency settings each mode runs at, in order. Overridable to
# measure others (a setting may repeat, to see run-to-run spread).
SDK_SETTINGS="${WIDE_SDK_SETTINGS:-10 30}"
CC_SETTINGS="${WIDE_CC_SETTINGS:-10 20 30}"
# One name token per phase, `<letter><pid>`: at most ten phases.
TOKEN_LETTERS="a b c d e f g h i j"
ALL_TOKENS=""
for letter in ${TOKEN_LETTERS}; do ALL_TOKENS="${ALL_TOKENS} ${letter}$$"; done
CC_PER_TYPE=24
DEPLOY_LOG="${TMPDIR:-/tmp}/cdkd-5209-deploy.$$.log"
CLEANED_UP=0

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not built (run vp run build)" >&2
  exit 1
fi

# Delete everything one run token named. Best-effort, in a subshell so a
# `set +eu` caller is never re-armed. The token is scoped by the guard: an
# empty or foreign token would widen every listing below to the account.
reap_run() { # usage: reap_run <token>
  (
    set +eu
    case "${1:-}" in
      [a-j][0-9]?*) ;;
      *)
        echo "WARN: teardown sweep refused — '${1:-}' is not one of this fixture's run tokens" >&2
        exit 0
        ;;
    esac
    local prefix="cdkd-wide-$1"
    # By name: `ListQueues` is eventually consistent, and a listing of a
    # prefix that does not exist yet goes on answering empty for a while.
    for i in $(seq 0 $((PER_TYPE - 1))); do
      url="$(aws sqs get-queue-url --queue-name "${prefix}-q-${i}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)" || continue
      aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
    done
    for arn in $(aws sns list-topics --region "${REGION}" --query "Topics[?contains(TopicArn, ':${prefix}-t-')].TopicArn" --output text 2>/dev/null); do
      aws sns delete-topic --topic-arn "${arn}" --region "${REGION}" >/dev/null 2>&1
    done
    for name in $(aws ssm get-parameters-by-path --path "/${prefix}" --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null); do
      aws ssm delete-parameter --name "${name}" --region "${REGION}" >/dev/null 2>&1
    done
    for lg in $(aws logs describe-log-groups --log-group-name-prefix "/${prefix}/" --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
      aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
    done
    # The Cloud Control mode's resources, by name.
    for i in $(seq 0 $((CC_PER_TYPE - 1))); do
      aws ssm delete-document --name "${prefix}-doc-${i}" --region "${REGION}" >/dev/null 2>&1
      aws athena delete-work-group --work-group "${prefix}-wg-${i}" --recursive-delete-option --region "${REGION}" >/dev/null 2>&1
    done
  )
}

cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG}"
  for token in ${ALL_TOKENS}; do reap_run "${token}"; done
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Rows, never `length()`: --query runs per page under --output text.
count_rows() { # usage: count_rows <command...>; prints the number of non-empty rows
  local out
  out="$("$@")" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -cvE '^(None)?$' || true
}

assert_live() { # usage: assert_live <token>
  local prefix="cdkd-wide-$1" n i
  # Each queue by name (strongly consistent): `ListQueues` is not, and a
  # listing of a prefix that did not exist yet goes on answering empty.
  for i in $(seq 0 $((PER_TYPE - 1))); do
    aws sqs get-queue-url --queue-name "${prefix}-q-${i}" --region "${REGION}" >/dev/null \
      || { echo "FAIL: SQS queue ${prefix}-q-${i} is not live" >&2; exit 1; }
  done
  n="$(count_rows aws sns list-topics --region "${REGION}" --query "Topics[?contains(TopicArn, ':${prefix}-t-')].TopicArn" --output text)"
  [ "${n}" = "${PER_TYPE}" ] || { echo "FAIL: ${n} SNS topics live for ${prefix}, expected ${PER_TYPE}" >&2; exit 1; }
  n="$(count_rows aws ssm get-parameters-by-path --path "/${prefix}" --region "${REGION}" --query 'Parameters[].Name' --output text)"
  [ "${n}" = "${PER_TYPE}" ] || { echo "FAIL: ${n} SSM parameters live for ${prefix}, expected ${PER_TYPE}" >&2; exit 1; }
  n="$(count_rows aws logs describe-log-groups --log-group-name-prefix "/${prefix}/" --region "${REGION}" --query 'logGroups[].logGroupName' --output text)"
  [ "${n}" = "${PER_TYPE}" ] || { echo "FAIL: ${n} log groups live for ${prefix}, expected ${PER_TYPE}" >&2; exit 1; }
}

assert_live_cc() { # usage: assert_live_cc <token>
  local prefix="cdkd-wide-$1" i
  for i in $(seq 0 $((CC_PER_TYPE - 1))); do
    aws ssm describe-document --name "${prefix}-doc-${i}" --region "${REGION}" >/dev/null \
      || { echo "FAIL: SSM document ${prefix}-doc-${i} is not live" >&2; exit 1; }
    aws athena get-work-group --work-group "${prefix}-wg-${i}" --region "${REGION}" >/dev/null \
      || { echo "FAIL: Athena workgroup ${prefix}-wg-${i} is not live" >&2; exit 1; }
  done
}

assert_run_gone_cc() { # usage: assert_run_gone_cc <token>
  local prefix="cdkd-wide-$1" i
  for i in $(seq 0 $((CC_PER_TYPE - 1))); do
    assert_gone "SSM document ${prefix}-doc-${i} still exists after destroy" aws ssm describe-document --name "${prefix}-doc-${i}" --region "${REGION}"
    assert_gone "Athena workgroup ${prefix}-wg-${i} still exists after destroy" aws athena get-work-group --work-group "${prefix}-wg-${i}" --region "${REGION}"
  done
}

assert_run_gone() { # usage: assert_run_gone <token>
  local prefix="cdkd-wide-$1" i
  for i in $(seq 0 $((PER_TYPE - 1))); do
    assert_gone "SQS queue ${prefix}-q-${i} still exists after destroy" aws sqs get-queue-url --queue-name "${prefix}-q-${i}" --region "${REGION}"
    assert_gone "SSM parameter /${prefix}/p-${i} still exists after destroy" aws ssm get-parameter --name "/${prefix}/p-${i}" --region "${REGION}"
  done
  local n
  n="$(count_rows aws sns list-topics --region "${REGION}" --query "Topics[?contains(TopicArn, ':${prefix}-t-')].TopicArn" --output text)"
  [ "${n}" = "0" ] || { echo "FAIL: ${n} SNS topics of ${prefix} still exist after destroy" >&2; exit 1; }
  n="$(count_rows aws logs describe-log-groups --log-group-name-prefix "/${prefix}/" --region "${REGION}" --query 'logGroups[].logGroupName' --output text)"
  [ "${n}" = "0" ] || { echo "FAIL: ${n} log groups of ${prefix} still exist after destroy" >&2; exit 1; }
}

run_phase() { # usage: run_phase <kind: sdk|cc> <token> <label> [deploy args...]
  local kind="$1" token="$2" label="$3"
  shift 3
  local kind_env=""
  [ "${kind}" = "cc" ] && kind_env="cc"
  echo "==> ${label}: deploy (run ${token})"
  CDKD_WIDE_KIND="${kind_env}" CDKD_WIDE_RUN="${token}" CDKD_PHASE_TIMINGS=1 node "${LOCAL_DIST}" deploy \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes "$@" >"${DEPLOY_LOG}" 2>&1 \
    || { cat "${DEPLOY_LOG}" >&2; echo "FAIL: ${label} deploy failed" >&2; exit 1; }
  if [ "${kind}" = "cc" ]; then assert_live_cc "${token}"; else assert_live "${token}"; fi
  local wait_line
  wait_line="$(grep 'ready, waiting for a --concurrency slot' "${DEPLOY_LOG}" | sed 's/.*INFO[^ ]* *//' || true)"
  # Sentinel: the report itself must be there, or a missing wait line would
  # read as "no wait" rather than "no report".
  grep -q 'Phase timings (CDKD_PHASE_TIMINGS=1):' "${DEPLOY_LOG}" \
    || { echo "FAIL: ${label}: no phase timings report in the deploy output" >&2; exit 1; }
  grep -q 'x48' <<<"${wait_line}" \
    || { echo "FAIL: ${label}: no slot-wait line for all 48 resources: '${wait_line}'" >&2; exit 1; }
  echo "[measure] ${label}: ${wait_line}"
  echo "[measure] ${label}: $(grep -E 'resource DAG  ' "${DEPLOY_LOG}" | sed 's/.*INFO[^ ]* *//')"
  echo "[measure] ${label}: $(grep -cE 'Rate exceeded|Throttl' "${DEPLOY_LOG}" || true) throttling line(s)"
  # Every retry cdkd made, by error class (none is a valid answer).
  grep 'retry after ' "${DEPLOY_LOG}" | sed 's/.*INFO[^ ]* *//; s/^/[measure] '"${label}"': /' || true
  echo "==> ${label}: destroy"
  CDKD_WIDE_KIND="${kind_env}" CDKD_WIDE_RUN="${token}" node "${LOCAL_DIST}" destroy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >"${DEPLOY_LOG}" 2>&1 \
    || { cat "${DEPLOY_LOG}" >&2; echo "FAIL: ${label} destroy failed" >&2; exit 1; }
  if [ "${kind}" = "cc" ]; then assert_run_gone_cc "${token}"; else assert_run_gone "${token}"; fi
}

cleanup
CLEANED_UP=0

set -- ${ALL_TOKENS}
phases=0
for n in ${SDK_SETTINGS}; do
  [ "$#" -gt 0 ] || { echo "FAIL: more than ten phases requested" >&2; exit 1; }
  run_phase sdk "$1" "--concurrency ${n}" --concurrency "${n}"
  shift
  phases=$((phases + 1))
done
for n in ${CC_SETTINGS}; do
  [ "$#" -gt 0 ] || { echo "FAIL: more than ten phases requested" >&2; exit 1; }
  run_phase cc "$1" "cloud control, --concurrency ${n}" --concurrency "${n}"
  shift
  phases=$((phases + 1))
done
[ "${phases}" -gt 0 ] || { echo "FAIL: no phase ran" >&2; exit 1; }

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}"
echo "[verify] PASS — wide-independent: 48 independent SDK-route resources at --concurrency 10 and 30, 48 Cloud Control resources at 10, 20 and 30"

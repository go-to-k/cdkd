#!/usr/bin/env bash
# verify.sh — Pipe InputTemplate REMOVAL (issue #6233)
#
# `UpdatePipe` keeps a member it is not sent, so removing an `InputTemplate`
# from an AWS::Pipes::Pipe used to leave the live input transformer rewriting
# every event: warned when the whole `TargetParameters` block went, SILENT when
# only the member went and other target parameters stayed. Measured
# (us-east-1): `TargetParameters: {}` keeps the template, `InputTemplate: ''`
# clears it, and CloudFormation clears it on the same removal.
#
# Phase 1 templates both InputTemplates (enrichment + target) beside the
# target's `SqsQueueParameters.MessageGroupId`. Phase 2 (`CDKD_TEST_REMOVAL`)
# removes the whole `EnrichmentParameters` block and ONLY the target's
# `InputTemplate`; both must be gone from AWS, `MessageGroupId`, `Description`
# and `Enrichment` must survive, and no removal warning may print (nothing is
# left in place). Phase 3 is the no-op redeploy plus `cdkd drift`. Phase 4
# restores the baseline; phase 5 removes `Enrichment` together with
# `EnrichmentParameters`, so the update sends both clears at once.
#
# Run via: /run-integ pipes-input-template-removal
#         or: bash tests/integration/pipes-input-template-removal/verify.sh

set -euo pipefail

export AWS_PAGER=""

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
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STACK="PipesInputTemplateRemovalStack"
STATE_KEY="cdkd/${STACK}/${AWS_REGION}/state.json"
TARGET_TEMPLATE='{"wrapped": <$.body>}'
ENRICHMENT_TEMPLATE='{"enriched": <$.body>}'

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  rm -f "${PHASE2_LOG:-}" "${PHASE3_LOG:-}"
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# A physical id out of cdkd state by logical id: the exact id (an L1 such as
# `Pipe`), else the L2 spelling `<id><8 hex>`, so `Pipe` never matches `PipeRole...`.
physical_id() { # usage: physical_id "<state json>" <LogicalId>
  echo "$1" | python3 -c '
import sys, json, re
want = sys.argv[1]
res = json.load(sys.stdin)["resources"]
hit = [k for k in res if k == want] or [k for k in res if re.fullmatch(re.escape(want) + "[0-9A-F]{8}", k)]
print(res[hit[0]]["physicalId"] if len(hit) == 1 else "")
' "$2"
}

# One DescribePipe field; prints `None` when AWS does not report it.
pipe_field() { # usage: pipe_field <pipe name> <JMESPath>
  aws pipes describe-pipe --name "$1" --region "${AWS_REGION}" --query "$2" --output text
}

expect_field() { # usage: expect_field <pipe name> <JMESPath> <expected> <context>
  local got
  got=$(pipe_field "$1" "$2")
  if [[ "${got}" != "$3" ]]; then
    echo "FAIL: $4: $2 is '${got}', expected '$3'"
    exit 1
  fi
  echo "    $2=${got} (✓)"
}

echo "==> Installing fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "==> Pre-flight orphan scan"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "FAIL: state ${STATE_KEY} already exists — clean up first."
  exit 1
fi

echo ""
echo "==> Phase 1: deploy ${STACK} (baseline, both InputTemplates set)"
${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

STATE_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
PIPE=$(physical_id "${STATE_BODY}" Pipe)
SOURCE_URL=$(physical_id "${STATE_BODY}" Source)
TARGET_URL=$(physical_id "${STATE_BODY}" Target)
FN=$(physical_id "${STATE_BODY}" Enrichment)
if [[ -z "${PIPE}" || -z "${SOURCE_URL}" || -z "${TARGET_URL}" || -z "${FN}" ]]; then
  echo "FAIL: could not resolve every physical id from cdkd state"
  echo "    Pipe='${PIPE}' Source='${SOURCE_URL}' Target='${TARGET_URL}' Enrichment='${FN}'"
  exit 1
fi
echo "    pipe: ${PIPE}"

echo ""
echo "==> Assert phase-1 baseline reached AWS"
expect_field "${PIPE}" TargetParameters.InputTemplate "${TARGET_TEMPLATE}" "baseline"
expect_field "${PIPE}" EnrichmentParameters.InputTemplate "${ENRICHMENT_TEMPLATE}" "baseline"
expect_field "${PIPE}" TargetParameters.SqsQueueParameters.MessageGroupId cdkd-6233-group "baseline"
expect_field "${PIPE}" Description cdkd-6233-kept "baseline"

echo ""
echo "==> Phase 2: re-deploy with CDKD_TEST_REMOVAL=true (EnrichmentParameters + target InputTemplate removed)"
PHASE2_LOG="$(mktemp -t pipes-input-template-removal-phase2)"
CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1 \
  | tee "${PHASE2_LOG}"

echo ""
echo "==> Assert both InputTemplates were CLEARED, as CloudFormation clears them"
expect_field "${PIPE}" TargetParameters.InputTemplate None "after removal"
expect_field "${PIPE}" EnrichmentParameters.InputTemplate None "after removal"

echo ""
echo "==> Assert the retained siblings survived the same update"
expect_field "${PIPE}" TargetParameters.SqsQueueParameters.MessageGroupId cdkd-6233-group "after removal"
expect_field "${PIPE}" Description cdkd-6233-kept "after removal"
expect_field "${PIPE}" Enrichment "$(aws lambda get-function --function-name "${FN}" --region "${AWS_REGION}" \
  --query Configuration.FunctionArn --output text)" "after removal"

echo ""
echo "==> Assert no removal warning printed (nothing was left in place)"
PHASE2_PLAIN=$(sed -E $'s/\x1b\\[[0-9;]*m//g' "${PHASE2_LOG}")
# Sentinel: the pipe's per-resource update line must be there, so a log that
# lost its output cannot pass the absence check below.
if ! grep -qE 'Pipe \(AWS::Pipes::Pipe\)[[:space:]]+updated' <<<"${PHASE2_PLAIN}"; then
  echo "FAIL: the removal deploy's log has no 'Pipe (AWS::Pipes::Pipe) updated' line;"
  echo "    cdkd's status wording drifted or the update never ran."
  rm -f "${PHASE2_LOG}"
  exit 1
fi
if grep -q 'removed from the template' <<<"${PHASE2_PLAIN}"; then
  echo "FAIL: the removal deploy warned that a removed property was left in place:"
  grep 'removed from the template' <<<"${PHASE2_PLAIN}" | head -5
  rm -f "${PHASE2_LOG}"
  exit 1
fi
echo "    no left-in-place warning (✓)"

echo ""
echo "==> Phase 3: re-deploy unchanged — must be a clean no-op (phantom-drift guard)"
PHASE3_LOG="$(mktemp -t pipes-input-template-removal-phase3)"
CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1 \
  | tee "${PHASE3_LOG}"
# Match only PER-RESOURCE status lines (`<glyph> <id> (AWS::Type) <verb>`), never
# the run summary, which says "created" / "updated" / "deleted" on a no-op too.
# The phase-2 sentinel above proves the same pattern still matches cdkd's output.
PHASE3_CHANGES=$(sed -E $'s/\x1b\\[[0-9;]*m//g' "${PHASE3_LOG}" \
  | grep -E '\(AWS::[^)]+\)[[:space:]]+(created|updated|deleted)' || true)
rm -f "${PHASE2_LOG}" "${PHASE3_LOG}"
if [[ -n "${PHASE3_CHANGES}" ]]; then
  echo "FAIL: the unchanged re-deploy reported resource changes. Offending lines:"
  printf '%s\n' "${PHASE3_CHANGES}" | head -10
  exit 1
fi
echo "    no-op redeploy changed nothing (✓)"

echo ""
echo "==> Assert cdkd drift reports nothing after the removal"
DRIFT_RC=0
${CDKD} drift ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" || DRIFT_RC=$?
if [[ "${DRIFT_RC}" -ne 0 ]]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} after the removal deploy, expected 0"
  echo "    (a cleared EnrichmentParameters read back as drift)"
  exit 1
fi
echo "    drift exit 0 (✓)"

echo ""
echo "==> Phase 4: re-deploy the baseline (both InputTemplates added back)"
${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
expect_field "${PIPE}" TargetParameters.InputTemplate "${TARGET_TEMPLATE}" "after re-adding"
expect_field "${PIPE}" EnrichmentParameters.InputTemplate "${ENRICHMENT_TEMPLATE}" "after re-adding"

echo ""
echo "==> Phase 5: remove Enrichment TOGETHER with EnrichmentParameters (CDKD_TEST_REMOVE_ENRICHMENT=true)"
# The update carries `Enrichment: ''` beside `EnrichmentParameters:
# { InputTemplate: '' }`; AWS must accept the pair and hold neither.
CDKD_TEST_REMOVE_ENRICHMENT=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
expect_field "${PIPE}" Enrichment None "after removing the enrichment"
expect_field "${PIPE}" EnrichmentParameters.InputTemplate None "after removing the enrichment"
expect_field "${PIPE}" TargetParameters.InputTemplate "${TARGET_TEMPLATE}" "after removing the enrichment"

echo ""
echo "==> Destroy"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Verify clean"
assert_gone "pipe ${PIPE} still exists after destroy" \
  aws pipes describe-pipe --name "${PIPE}" --region "${AWS_REGION}"
assert_gone "enrichment function ${FN} still exists after destroy" \
  aws lambda get-function --function-name "${FN}" --region "${AWS_REGION}"
assert_gone "source queue ${SOURCE_URL} still exists after destroy" \
  aws sqs get-queue-attributes --queue-url "${SOURCE_URL}" --region "${AWS_REGION}"
assert_gone "target queue ${TARGET_URL} still exists after destroy" \
  aws sqs get-queue-attributes --queue-url "${TARGET_URL}" --region "${AWS_REGION}"
assert_gone "state ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    pipe, function, both queues gone, state removed (✓)"

trap - EXIT INT TERM
echo ""
echo "PASS: pipes-input-template-removal (#6233 removed InputTemplates cleared; siblings kept; no-op + drift clean; enrichment + parameters removed together)"

#!/usr/bin/env bash
# verify.sh — SNS topic attribute REMOVAL (issue #6226)
#
# Removing `TracingConfig`, `ContentBasedDeduplication` or `ArchivePolicy` from
# an AWS::SNS::Topic used to fail the deploy with InvalidParameterException:
# cdkd reset each removed attribute to `''`, which SetTopicAttributes refuses
# for all three. CloudFormation resets them on the same removal (live A/B,
# us-east-1): TracingConfig -> PassThrough, ContentBasedDeduplication -> false,
# ArchivePolicy -> none.
#
# Phase 1 templates every removed attribute at its NON-default value, so phase
# 2 can tell "reset" from "never set". The standard topic's DisplayName is the
# retained sibling. Phase 3 is the no-op redeploy (phantom-drift guard), plus a
# `cdkd drift` that must report nothing. Phase 4 turns tracing on out of band on
# a topic that never declared it (drift baseline `''`): `cdkd drift --revert`
# must send `PassThrough` (SNS refuses `''`), and the next `cdkd drift` must
# read `''` and `PassThrough` as the same value.
#
# Run via: /run-integ sns-topic-attr-removal
#         or: bash tests/integration/sns-topic-attr-removal/verify.sh

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
STACK="SnsTopicAttrRemovalStack"
STATE_KEY="cdkd/${STACK}/${AWS_REGION}/state.json"

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Resolve a topic ARN out of cdkd state by its logical id prefix.
topic_arn_by_logical_id() { # usage: topic_arn_by_logical_id "<state json>" <LogicalIdPrefix>
  echo "$1" | python3 -c '
import sys, json
prefix = sys.argv[1]
s = json.load(sys.stdin)
for k, v in s["resources"].items():
    if v["resourceType"] == "AWS::SNS::Topic" and k.startswith(prefix):
        print(v["physicalId"]); break
' "$2"
}

# One topic attribute; prints `None` when SNS does not report it.
topic_attr() { # usage: topic_attr <topic arn> <AttributeName>
  aws sns get-topic-attributes --topic-arn "$1" --region "${AWS_REGION}" \
    --query "Attributes.$2" --output text
}

expect_attr() { # usage: expect_attr <topic arn> <AttributeName> <expected> <context>
  local got
  got=$(topic_attr "$1" "$2")
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
echo "==> Phase 1: deploy ${STACK} (baseline, every removed attribute at its NON-default)"
${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

STATE_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
STANDARD_ARN=$(topic_arn_by_logical_id "${STATE_BODY}" "StandardTopic")
FIFO_ARN=$(topic_arn_by_logical_id "${STATE_BODY}" "FifoTopic")
UNSET_ARN=$(topic_arn_by_logical_id "${STATE_BODY}" "UnsetTopic")
if [[ -z "${STANDARD_ARN}" || -z "${FIFO_ARN}" || -z "${UNSET_ARN}" ]]; then
  echo "FAIL: could not resolve all three topic ARNs from cdkd state"
  echo "    StandardTopic='${STANDARD_ARN}' FifoTopic='${FIFO_ARN}' UnsetTopic='${UNSET_ARN}'"
  exit 1
fi
echo "    standard topic: ${STANDARD_ARN}"
echo "    FIFO topic:     ${FIFO_ARN}"
echo "    unset topic:    ${UNSET_ARN}"

echo ""
echo "==> Assert phase-1 baseline reached AWS"
expect_attr "${STANDARD_ARN}" TracingConfig Active "baseline"
expect_attr "${STANDARD_ARN}" DisplayName cdkd-6226-kept "baseline"
expect_attr "${FIFO_ARN}" ContentBasedDeduplication true "baseline"
ARCHIVE_P1=$(topic_attr "${FIFO_ARN}" ArchivePolicy)
if ! grep -q 'MessageRetentionPeriod' <<<"${ARCHIVE_P1}"; then
  echo "FAIL: baseline ArchivePolicy is '${ARCHIVE_P1}', expected a MessageRetentionPeriod"
  exit 1
fi
echo "    ArchivePolicy=${ARCHIVE_P1} (✓)"

echo ""
echo "==> Phase 2: re-deploy with CDKD_TEST_REMOVAL=true (the three attributes removed)"
PHASE2_LOG="$(mktemp -t sns-topic-attr-removal-phase2)"
CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1 \
  | tee "${PHASE2_LOG}"

echo ""
echo "==> Assert each removed attribute was RESET the way CloudFormation resets it"
expect_attr "${STANDARD_ARN}" TracingConfig PassThrough "after removal"
expect_attr "${FIFO_ARN}" ContentBasedDeduplication false "after removal"
expect_attr "${FIFO_ARN}" ArchivePolicy None "after removal"

echo ""
echo "==> Assert the retained sibling survived the same update"
expect_attr "${STANDARD_ARN}" DisplayName cdkd-6226-kept "after removal"

echo ""
echo "==> Phase 3: re-deploy unchanged — must be a clean no-op (phantom-drift guard)"
PHASE3_LOG="$(mktemp -t sns-topic-attr-removal-phase3)"
CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1 \
  | tee "${PHASE3_LOG}"
# Match only PER-RESOURCE status lines (`<glyph> <id> (AWS::Type) <verb>`), never
# the run summary, which says "created" / "updated" / "deleted" on a no-op too.
PHASE3_CHANGES=$(sed -E $'s/\x1b\\[[0-9;]*m//g' "${PHASE3_LOG}" \
  | grep -E '\(AWS::[^)]+\)[[:space:]]+(created|updated|deleted)' || true)
# Sentinel: the same per-resource pattern MUST match phase 2's two updates, so a
# reworded status line fails here instead of letting phase 3 pass on no match.
PHASE2_UPDATES=$(sed -E $'s/\x1b\\[[0-9;]*m//g' "${PHASE2_LOG}" \
  | grep -cE '\(AWS::SNS::Topic\)[[:space:]]+updated' || true)
rm -f "${PHASE2_LOG}"
if [[ "${PHASE2_UPDATES}" -ne 2 ]]; then
  echo "FAIL: the per-resource status pattern matched ${PHASE2_UPDATES} line(s) in the removal"
  echo "    deploy's output, expected 2 — cdkd's status wording drifted, so the no-op"
  echo "    check below can no longer see a change. Update both patterns."
  rm -f "${PHASE3_LOG}"
  exit 1
fi
rm -f "${PHASE3_LOG}"
if [[ -n "${PHASE3_CHANGES}" ]]; then
  echo "FAIL: the unchanged re-deploy reported resource changes. Offending lines:"
  printf '%s\n' "${PHASE3_CHANGES}" | head -10
  exit 1
fi
echo "    no-op redeploy changed nothing (✓)"

echo ""
echo "==> Assert cdkd drift reports nothing on the reset topics"
DRIFT_RC=0
${CDKD} drift ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" || DRIFT_RC=$?
if [[ "${DRIFT_RC}" -ne 0 ]]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} after the removal deploy, expected 0"
  echo "    (a reset-to-default value read back as drift)"
  exit 1
fi
echo "    drift exit 0 (✓)"

echo ""
echo "==> Phase 4: out-of-band TracingConfig=Active on the unset topic, then drift --revert"
expect_attr "${UNSET_ARN}" TracingConfig None "before the out-of-band change"
aws sns set-topic-attributes --topic-arn "${UNSET_ARN}" --region "${AWS_REGION}" \
  --attribute-name TracingConfig --attribute-value Active
DRIFT_RC=0
${CDKD} drift ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" || DRIFT_RC=$?
if [[ "${DRIFT_RC}" -ne 1 ]]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} after the out-of-band change, expected 1"
  exit 1
fi
echo "    out-of-band change detected (exit 1) (✓)"
${CDKD} drift ${STACK} --revert --yes --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
expect_attr "${UNSET_ARN}" TracingConfig PassThrough "after drift --revert"
DRIFT_RC=0
${CDKD} drift ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" || DRIFT_RC=$?
if [[ "${DRIFT_RC}" -ne 0 ]]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} after the revert, expected 0"
  echo "    (the unset baseline '' and the reverted PassThrough must compare equal)"
  exit 1
fi
echo "    drift exit 0 after the revert (✓)"

echo ""
echo "==> Destroy"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Verify clean"
assert_gone "standard topic ${STANDARD_ARN} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${STANDARD_ARN}" --region "${AWS_REGION}"
assert_gone "FIFO topic ${FIFO_ARN} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${FIFO_ARN}" --region "${AWS_REGION}"
assert_gone "unset topic ${UNSET_ARN} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${UNSET_ARN}" --region "${AWS_REGION}"
assert_gone "state ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    all three topics gone, state removed (✓)"

trap - EXIT INT TERM
echo ""
echo "PASS: sns-topic-attr-removal (#6226 removal resets: PassThrough / false / no archive policy; drift --revert)"

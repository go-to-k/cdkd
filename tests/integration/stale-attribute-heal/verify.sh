#!/usr/bin/env bash
# Integration test for issue #1852: a state record written BEFORE its provider
# recorded an attribute is healed when a deploy that changes none of the
# resource's properties adds a Fn::GetAtt on it.
#
# `AWS::SSM::Parameter.Arn` has been recorded since issue #1824. A parameter
# deployed by an older binary has `attributes: {Type, Value}` — no `Arn` — and
# adding `new CfnOutput(..., { value: param.attrArn })` changes no resource
# property, so the deploy engine's no-change skip never re-runs the provider and
# the record never gained the key: the deploy hit the resolver's `*Arn` shape
# refusal forever, with a message ("not enriched ... file an issue") that was
# false for a type that IS enriched.
#
# Phases:
#   1.  deploy v1 (the parameter, no reference to its Arn); the record holds
#       the Arn THIS binary records
#   2.  strip `attributes.Arn` from the state record out of band — a record a
#       pre-#1824 binary wrote — and prove the strip landed
#   3.  `cdkd diff` of v2: a READ-ONLY command must not write state (the state
#       object's VersionId + ETag are unchanged, the record still lacks Arn)
#   4.  deploy v2 (adds ONLY the output): exit 0; the output equals the ARN AWS
#       reports; the record carries `attributes.Arn` again, beside the
#       attributes it already had; the parameter itself was NOT updated
#       (Version + LastModifiedDate equal the values captured before)
#   5.  no-change re-deploy of v2: the heal persisted, so nothing is re-read
#       and state is not written again
#   6.  destroy; parameter gone; state gone
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="CdkdStaleAttributeHealExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM_NAME="/cdkd-test/stale-attribute-heal/param"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  [ -n "${SYNTH_DIR:-}" ] && rm -rf "${SYNTH_DIR}"
  # By PHYSICAL NAME first, then state: a state destroy that cannot read a
  # damaged record must not be the only thing standing between a failed run
  # and a leaked parameter.
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# Read the CURRENT state object. Strict: a failed read aborts under `set -e`
# rather than feeding an empty document to jq.
read_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --quiet
}

# The state OBJECT's identity: "<VersionId> <ETag>". Any write — even one that
# re-writes byte-identical content — mints a new VersionId on the versioned
# state bucket, which is what makes this a write detector rather than a content
# compare.
state_object_identity() {
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" \
    --query '[VersionId, ETag]' --output text
}

# "<Version> <LastModifiedDate>" of the live parameter. Compared for EQUALITY
# against the value captured earlier in THIS run, never against a literal: a
# parameter's version counter belongs to AWS.
param_revision() {
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
    --query 'Parameter.[Version, LastModifiedDate]' --output text
}

# --- Premise: v1 declares no output, v2 declares exactly one, and the two
# templates' Resources are byte-identical — otherwise phase 4 would not be the
# no-change deploy this fixture is about.
echo "==> Premise: v1 vs v2 differ ONLY by the ParamArn output"
SYNTH_DIR=$(mktemp -d)
if ! env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" synth --region "${REGION}" --output "${SYNTH_DIR}/v1" >/dev/null 2>&1; then
  echo "FAIL: cdkd synth (v1) failed" >&2
  exit 1
fi
if ! CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" synth --region "${REGION}" --output "${SYNTH_DIR}/v2" >/dev/null 2>&1; then
  echo "FAIL: cdkd synth (v2) failed" >&2
  exit 1
fi
T1="${SYNTH_DIR}/v1/${STACK}.template.json"
T2="${SYNTH_DIR}/v2/${STACK}.template.json"
PARAM_ID=$(jq -r '[.Resources | to_entries[] | select(.value.Type == "AWS::SSM::Parameter") | .key] | if length == 1 then .[0] else error("expected exactly one AWS::SSM::Parameter") end' "${T2}")
if [ "$(jq -S -c '.Resources | with_entries(select(.value.Type == "AWS::SSM::Parameter"))' "${T1}")" != \
     "$(jq -S -c '.Resources | with_entries(select(.value.Type == "AWS::SSM::Parameter"))' "${T2}")" ]; then
  echo "FAIL: the parameter differs between v1 and v2 — phase 4 would be an UPDATE, not the no-change deploy under test" >&2
  exit 1
fi
if [ "$(jq -r '(.Outputs // {}) | has("ParamArn")' "${T1}")" != "false" ]; then
  echo "FAIL: v1 already declares the ParamArn output" >&2
  exit 1
fi
if [ "$(jq -c '.Outputs.ParamArn.Value' "${T2}")" != "{\"Fn::GetAtt\":[\"${PARAM_ID}\",\"Arn\"]}" ]; then
  echo "FAIL: v2's ParamArn output is not a bare Fn::GetAtt on the parameter's Arn: $(jq -c '.Outputs.ParamArn' "${T2}")" >&2
  exit 1
fi
rm -rf "${SYNTH_DIR}"
SYNTH_DIR=""
echo "    OK: parameter logical id ${PARAM_ID}"

# --- Phase 1: deploy v1 ------------------------------------------------------
echo "==> Phase 1: deploy v1 (no reference to the Arn)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

REAL_ARN=$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" --query 'Parameter.ARN' --output text)
case "${REAL_ARN}" in
  arn:*:ssm:"${REGION}":*:parameter/cdkd-test/stale-attribute-heal/param) ;;
  *)
    echo "FAIL: AWS reported an unexpected ARN for ${PARAM_NAME}: ${REAL_ARN}" >&2
    exit 1
    ;;
esac
STATE_1=$(read_state)
RECORDED_ARN_1=$(jq -r --arg id "${PARAM_ID}" '.resources[$id].attributes.Arn // "<absent>"' <<<"${STATE_1}")
if [ "${RECORDED_ARN_1}" != "${REAL_ARN}" ]; then
  echo "FAIL: this binary did not record the parameter's Arn at create (got ${RECORDED_ARN_1}, AWS says ${REAL_ARN}) — the strip below would reproduce nothing" >&2
  exit 1
fi
ATTRS_KEPT_1=$(jq -S -c --arg id "${PARAM_ID}" '.resources[$id].attributes | del(.Arn)' <<<"${STATE_1}")
PROPS_1=$(jq -S -c --arg id "${PARAM_ID}" '.resources[$id].properties' <<<"${STATE_1}")
PHYSICAL_1=$(jq -r --arg id "${PARAM_ID}" '.resources[$id].physicalId' <<<"${STATE_1}")
REVISION_1=$(param_revision)
echo "    OK: record holds ${REAL_ARN}; parameter revision: ${REVISION_1}"

# --- Phase 2: reproduce a pre-#1824 record ----------------------------------
echo "==> Phase 2: strip attributes.Arn out of band (a record a pre-#1824 binary wrote)"
STRIPPED=$(jq -c --arg id "${PARAM_ID}" 'del(.resources[$id].attributes.Arn)' <<<"${STATE_1}")
if [ "$(jq -r --arg id "${PARAM_ID}" '.resources[$id].attributes | has("Arn")' <<<"${STRIPPED}")" != "false" ]; then
  echo "FAIL: could not strip attributes.Arn from the state document" >&2
  exit 1
fi
printf '%s' "${STRIPPED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
# Prove the strip LANDED before reading anything back through cdkd.
if [ "$(read_state | jq -r --arg id "${PARAM_ID}" '.resources[$id].attributes | has("Arn")')" != "false" ]; then
  echo "FAIL: the stripped state document did not land in S3" >&2
  exit 1
fi
echo "    OK: the record no longer holds Arn"

# --- Phase 3: cdkd diff is read-only ----------------------------------------
echo "==> Phase 3: cdkd diff of v2 writes no state"
IDENTITY_BEFORE_DIFF=$(state_object_identity)
set +e
DIFF_OUT=$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
DIFF_RC=$?
set -e
if [ "${DIFF_RC}" -ne 0 ]; then
  echo "FAIL: cdkd diff exited ${DIFF_RC}" >&2
  echo "${DIFF_OUT}" >&2
  exit 1
fi
IDENTITY_AFTER_DIFF=$(state_object_identity)
if [ "${IDENTITY_AFTER_DIFF}" != "${IDENTITY_BEFORE_DIFF}" ]; then
  echo "FAIL: cdkd diff WROTE state (object identity ${IDENTITY_BEFORE_DIFF} -> ${IDENTITY_AFTER_DIFF})" >&2
  exit 1
fi
if [ "$(read_state | jq -r --arg id "${PARAM_ID}" '.resources[$id].attributes | has("Arn")')" != "false" ]; then
  echo "FAIL: the record gained Arn during cdkd diff" >&2
  exit 1
fi
echo "    OK: state object identity unchanged (${IDENTITY_AFTER_DIFF})"

# --- Phase 4: the deploy the issue reports ----------------------------------
echo "==> Phase 4: deploy v2 (adds ONLY the output) over the stale record"
set +e
DEPLOY_2=$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DEPLOY_2_RC=$?
set -e
echo "${DEPLOY_2}"
if [ "${DEPLOY_2_RC}" -ne 0 ]; then
  echo "FAIL: the deploy over the stale record exited ${DEPLOY_2_RC} (pre-#1852: the *Arn shape refusal)" >&2
  exit 1
fi
# The pre-fix refusal, and the warn an Output failure is downgraded to, both
# carry this phrase; a green exit with it present means the output was SKIPPED.
if grep -qF "Cannot resolve Fn::GetAtt" <<<"${DEPLOY_2}"; then
  echo "FAIL: the deploy exited 0 but still refused the Fn::GetAtt (the output was skipped, not resolved)" >&2
  exit 1
fi
if ! grep -qF "No changes detected" <<<"${DEPLOY_2}"; then
  echo "FAIL: the v2 deploy did not take the no-change path — this run did not exercise the heal-on-no-change case" >&2
  exit 1
fi

STATE_2=$(read_state)
OUTPUT_2=$(jq -r '.outputs.ParamArn // "<absent>"' <<<"${STATE_2}")
if [ "${OUTPUT_2}" != "${REAL_ARN}" ]; then
  echo "FAIL: the ParamArn output is ${OUTPUT_2}, expected the ARN AWS reports (${REAL_ARN})" >&2
  exit 1
fi
RECORDED_ARN_2=$(jq -r --arg id "${PARAM_ID}" '.resources[$id].attributes.Arn // "<absent>"' <<<"${STATE_2}")
if [ "${RECORDED_ARN_2}" != "${REAL_ARN}" ]; then
  echo "FAIL: the state record was not healed (attributes.Arn is ${RECORDED_ARN_2}, expected ${REAL_ARN})" >&2
  exit 1
fi
# MERGED, never replaced: everything the record held before survives.
ATTRS_KEPT_2=$(jq -S -c --arg id "${PARAM_ID}" '.resources[$id].attributes | del(.Arn)' <<<"${STATE_2}")
if [ "${ATTRS_KEPT_2}" != "${ATTRS_KEPT_1}" ]; then
  echo "FAIL: the heal changed the record's other attributes (${ATTRS_KEPT_1} -> ${ATTRS_KEPT_2})" >&2
  exit 1
fi
PROPS_2=$(jq -S -c --arg id "${PARAM_ID}" '.resources[$id].properties' <<<"${STATE_2}")
PHYSICAL_2=$(jq -r --arg id "${PARAM_ID}" '.resources[$id].physicalId' <<<"${STATE_2}")
if [ "${PROPS_2}" != "${PROPS_1}" ] || [ "${PHYSICAL_2}" != "${PHYSICAL_1}" ]; then
  echo "FAIL: the heal touched properties / physicalId (${PROPS_1} / ${PHYSICAL_1} -> ${PROPS_2} / ${PHYSICAL_2})" >&2
  exit 1
fi
# The parameter itself was neither updated nor replaced.
REVISION_2=$(param_revision)
if [ "${REVISION_2}" != "${REVISION_1}" ]; then
  echo "FAIL: the parameter was written during the heal deploy (revision ${REVISION_1} -> ${REVISION_2})" >&2
  exit 1
fi
echo "    OK: output + record healed to ${REAL_ARN}; parameter untouched"

# --- Phase 5: the heal persisted --------------------------------------------
echo "==> Phase 5: no-change re-deploy of v2 writes nothing more"
IDENTITY_BEFORE_REDEPLOY=$(state_object_identity)
set +e
DEPLOY_3=$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DEPLOY_3_RC=$?
set -e
if [ "${DEPLOY_3_RC}" -ne 0 ] || ! grep -qF "No changes detected" <<<"${DEPLOY_3}"; then
  echo "FAIL: the re-deploy did not take the no-change path (rc=${DEPLOY_3_RC})" >&2
  echo "${DEPLOY_3}" >&2
  exit 1
fi
IDENTITY_AFTER_REDEPLOY=$(state_object_identity)
if [ "${IDENTITY_AFTER_REDEPLOY}" != "${IDENTITY_BEFORE_REDEPLOY}" ]; then
  echo "FAIL: the re-deploy wrote state again although the record was already healed (${IDENTITY_BEFORE_REDEPLOY} -> ${IDENTITY_AFTER_REDEPLOY})" >&2
  exit 1
fi
echo "    OK: nothing re-written"

# --- Phase 6: destroy --------------------------------------------------------
echo "==> Phase 6: destroy"
set +e
DESTROY_OUT=$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DESTROY_RC=$?
set -e
echo "${DESTROY_OUT}"
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  exit 1
fi

assert_gone "SSM parameter ${PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
echo "PASS: stale-attribute-heal"

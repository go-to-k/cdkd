#!/usr/bin/env bash
# verify.sh -- cdkd AWS::Lambda::MicrovmImage SDK provider integ.
#
# AWS::Lambda::MicrovmImage builds asynchronously: CreateMicrovmImage returns
# immediately in CREATING, then Lambda downloads the code-artifact zip from S3,
# runs the Dockerfile, boots the app, and snapshots -> CREATED (or
# CREATE_FAILED). This verifies the LambdaMicrovmImageProvider end to end,
# including the async CREATING -> CREATED poll and the clean async delete.
#
# Phases:
#   0. Build the code artifact (Dockerfile + app.js) and upload it to S3. The
#      build role's s3:GetObject targets this bucket.
#   1. Deploy. cdkd's provider polls until the image reaches CREATED. Assert the
#      state records the image ARN as physicalId, the CfnOutput resolves the
#      ARN, and GetMicrovmImage reports state == CREATED on AWS.
#   1b. Tags-only UPDATE: assert the tags are reconciled (Tag/UntagResource)
#      with the active image version UNCHANGED (no rebuild).
#   1c. Drift: cdkd drift is clean after deploy; an out-of-band tag mutation is
#      detected as drift; reverting realigns (readCurrentState).
#   2. Destroy + assert the image is gone (GetMicrovmImage 404s) and the cdkd
#      state file is removed.
#   3. --no-wait deploy: assert cdkd returns while the image is still CREATING
#      (it does NOT wait for CREATED, unlike the always-polling CC fallback),
#      then wait for CREATED.
#   4. Destroy the --no-wait image + assert gone.
#
# NOTE: the MicroVM image build runs the user's Dockerfile + boots the app + a
# Firecracker snapshot, so Phase 1's deploy can take several minutes. If the
# build fails (CREATE_FAILED), the logs are in CloudWatch under
# /aws/lambda/microvms/cdkd-integ-microvm-image.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

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

STACK="CdkdMicrovmImageExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
IMAGE_NAME="cdkd-integ-microvm-image"
ARTIFACT_KEY="cdkd-integ-microvm-artifacts/${STACK}/artifact.zip"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # GetMicrovmImage / DeleteMicrovmImage require the image ARN (a bare Name is
  # rejected with "Invalid ARN format"); resolve the ARN by name first.
  local leftover_arn
  leftover_arn="$(aws lambda-microvms list-microvm-images --name-filter "${IMAGE_NAME}" \
    --region "${REGION}" --query 'items[0].imageArn' --output text 2>/dev/null)"
  if [ -n "${leftover_arn}" ] && [ "${leftover_arn}" != "None" ]; then
    aws lambda-microvms delete-microvm-image --image-identifier "${leftover_arn}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${ARTIFACT_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
cleanup

# --- Phase 0: build + upload the code artifact --------------------------
echo "==> Phase 0: package the code artifact (Dockerfile + app.js) and upload to S3"
ARTIFACT_ZIP="$(mktemp -d)/artifact.zip"
( cd app && zip -q -X "${ARTIFACT_ZIP}" Dockerfile app.js )
aws s3 cp "${ARTIFACT_ZIP}" "s3://${STATE_BUCKET}/${ARTIFACT_KEY}" --region "${REGION}"
ARTIFACT_URI="s3://${STATE_BUCKET}/${ARTIFACT_KEY}"
echo "    artifact uploaded to ${ARTIFACT_URI}"

# --- Phase 1: deploy (async build -> CREATED) ---------------------------
echo "==> Phase 1: deploy (the MicroVM image build can take several minutes)"
MICROVM_ARTIFACT_URI="${ARTIFACT_URI}" MICROVM_ARTIFACT_BUCKET="${STATE_BUCKET}" \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
IMAGE_ARN="$(echo "${STATE_JSON}" | python3 -c '
import json, sys
s = json.load(sys.stdin)
for v in s["resources"].values():
    if v["resourceType"] == "AWS::Lambda::MicrovmImage":
        print(v["physicalId"])
        break
')"
if [ -z "${IMAGE_ARN}" ]; then
  echo "FAIL: state has no AWS::Lambda::MicrovmImage entry" >&2; exit 1
fi
case "${IMAGE_ARN}" in
  arn:aws:lambda:*:microvm-image:*) echo "    state records MicroVM image ARN ${IMAGE_ARN}" ;;
  *) echo "FAIL: physicalId is not a MicroVM image ARN: ${IMAGE_ARN}" >&2; exit 1 ;;
esac

# The CfnOutput must resolve to the image ARN (getAttribute('ImageArn')).
OUT_ARN="$(echo "${STATE_JSON}" | python3 -c '
import json, sys
print(json.load(sys.stdin).get("outputs", {}).get("MicrovmImageArn", ""))
')"
echo "    output MicrovmImageArn: ${OUT_ARN}"
[ "${OUT_ARN}" = "${IMAGE_ARN}" ] || { echo "FAIL: output ARN '${OUT_ARN}' != state physicalId '${IMAGE_ARN}'" >&2; exit 1; }

# GetMicrovmImage must report CREATED (cdkd's provider only returns from create
# once the build reached CREATED, so this must be true on AWS).
STATE_ON_AWS="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN}" \
  --region "${REGION}" --query 'state' --output text)"
echo "    GetMicrovmImage state: ${STATE_ON_AWS}"
[ "${STATE_ON_AWS}" = "CREATED" ] || { echo "FAIL: expected image state CREATED, got '${STATE_ON_AWS}'" >&2; exit 1; }
echo "    MicroVM image reached CREATED on AWS"

# Record the active version so the tags-only UPDATE below can prove it did NOT
# rebuild (a rebuild would bump the version).
VERSION_BEFORE="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN}" \
  --region "${REGION}" --query 'latestActiveImageVersion' --output text)"
echo "    active version after create: ${VERSION_BEFORE}"

# --- Phase 1b: tags-only UPDATE (reconcile via Tag/UntagResource, no rebuild) --
echo "==> Phase 1b: re-deploy with a tags-only change (env dev->prod, +team)"
MICROVM_ARTIFACT_URI="${ARTIFACT_URI}" MICROVM_ARTIFACT_BUCKET="${STATE_BUCKET}" CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# NOTE: ListTags returns the map under `Tags` (capital) even though
# GetMicrovmImage / CreateMicrovmImage use lowercase `tags` -- the service
# model is inconsistent, so query the exact `Tags` key here.
ENV_TAG="$(aws lambda-microvms list-tags --resource "${IMAGE_ARN}" --region "${REGION}" \
  --query 'Tags.env' --output text)"
TEAM_TAG="$(aws lambda-microvms list-tags --resource "${IMAGE_ARN}" --region "${REGION}" \
  --query 'Tags.team' --output text)"
echo "    tags after update: env=${ENV_TAG} team=${TEAM_TAG}"
[ "${ENV_TAG}" = "prod" ] || { echo "FAIL: expected env=prod after tags update, got '${ENV_TAG}'" >&2; exit 1; }
[ "${TEAM_TAG}" = "infra" ] || { echo "FAIL: expected team=infra added on update, got '${TEAM_TAG}'" >&2; exit 1; }

VERSION_AFTER="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN}" \
  --region "${REGION}" --query 'latestActiveImageVersion' --output text)"
echo "    active version after tags-only update: ${VERSION_AFTER}"
[ "${VERSION_AFTER}" = "${VERSION_BEFORE}" ] || { echo "FAIL: tags-only update rebuilt the image (version ${VERSION_BEFORE} -> ${VERSION_AFTER}); expected no rebuild" >&2; exit 1; }
echo "    tags reconciled via Tag/UntagResource with NO image rebuild"

# --- Phase 1c: drift detection (readCurrentState) ------------------------
# The provider's readCurrentState maps GetMicrovmImage + ListTags back to the
# Name + Tags cdkd stores (the build config is writeOnly and excluded via
# getDriftUnknownPaths). A freshly-deployed image reports ZERO drift; an
# out-of-band tag mutation must be detected as drift; reverting realigns.
echo "==> Phase 1c: drift is clean right after deploy (exit 0 expected)"
drift_rc=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" || drift_rc=$?
[ "${drift_rc}" -eq 0 ] || { echo "FAIL: expected zero drift after clean deploy, drift exited ${drift_rc}" >&2; exit 1; }
echo "    no drift on a freshly-deployed image"

echo "==> Phase 1c: mutate a tag out-of-band, expect drift (exit 1 expected)"
aws lambda-microvms tag-resource --resource "${IMAGE_ARN}" --tags env=drifted --region "${REGION}"
drift_rc=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" || drift_rc=$?
[ "${drift_rc}" -eq 1 ] || { echo "FAIL: expected drift (exit 1) after out-of-band tag change, drift exited ${drift_rc}" >&2; exit 1; }
echo "    out-of-band tag change detected as drift"

echo "==> Phase 1c: revert the tag so state and AWS realign"
aws lambda-microvms tag-resource --resource "${IMAGE_ARN}" --tags env=prod --region "${REGION}"
drift_rc=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" || drift_rc=$?
[ "${drift_rc}" -eq 0 ] || { echo "FAIL: expected zero drift after reverting the tag, drift exited ${drift_rc}" >&2; exit 1; }
echo "    drift clean again after revert"

# --- Phase 2: destroy (the waited-create image) --------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "MicroVM image ${IMAGE_ARN} still exists after destroy" \
  aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN}" --region "${REGION}"
echo "    MicroVM image deleted"
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

# --- Phase 3: --no-wait deploy returns BEFORE the build finishes ---------
# The whole point of the Tier-1 SDK provider (vs the Cloud Control fallback,
# which always polls to a terminal state) is that --no-wait short-circuits the
# CREATING -> CREATED poll. Verify cdkd returns while the image is still
# CREATING, with the ARN already resolved in state.
echo "==> Phase 3: --no-wait deploy (must return at CREATING, not wait for CREATED)"
DEPLOY_START="$(date +%s)"
MICROVM_ARTIFACT_URI="${ARTIFACT_URI}" MICROVM_ARTIFACT_BUCKET="${STATE_BUCKET}" \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --no-wait --yes
DEPLOY_SECS="$(( $(date +%s) - DEPLOY_START ))"
echo "    --no-wait deploy returned in ${DEPLOY_SECS}s"

STATE_JSON2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
IMAGE_ARN2="$(echo "${STATE_JSON2}" | python3 -c '
import json, sys
for v in json.load(sys.stdin)["resources"].values():
    if v["resourceType"] == "AWS::Lambda::MicrovmImage":
        print(v["physicalId"])
        break
')"
if [ -z "${IMAGE_ARN2}" ]; then
  echo "FAIL: --no-wait deploy did not record the image ARN in state" >&2; exit 1
fi
echo "    state records image ARN under --no-wait: ${IMAGE_ARN2}"

# The image must still be CREATING right after --no-wait returned (a normal
# deploy would have blocked for minutes and returned CREATED). The build takes
# minutes, so it cannot have finished in the seconds --no-wait took to return.
NW_STATE="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN2}" \
  --region "${REGION}" --query 'state' --output text)"
echo "    image state immediately after --no-wait deploy: ${NW_STATE}"
if [ "${NW_STATE}" != "CREATING" ]; then
  echo "FAIL: expected CREATING immediately after --no-wait (cdkd must not wait for CREATED); got '${NW_STATE}'" >&2
  exit 1
fi
echo "    --no-wait returned without waiting for CREATED (state CREATING)"

# Wait for the build to reach CREATED before destroying (a CREATING image
# cannot be cleanly deleted).
echo "    waiting for the --no-wait build to reach CREATED before destroy..."
NW_FINAL=""
for _ in $(seq 1 180); do
  NW_FINAL="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN2}" \
    --region "${REGION}" --query 'state' --output text)"
  [ "${NW_FINAL}" = "CREATED" ] && break
  if [ "${NW_FINAL}" = "CREATE_FAILED" ]; then
    echo "FAIL: --no-wait build entered CREATE_FAILED" >&2; exit 1
  fi
  sleep 10
done
if [ "${NW_FINAL}" != "CREATED" ]; then
  echo "FAIL: --no-wait build did not reach CREATED within the poll budget (last state ${NW_FINAL})" >&2; exit 1
fi
echo "    --no-wait build reached CREATED"

# --- Phase 4: destroy the --no-wait image --------------------------------
echo "==> Phase 4: destroy (--no-wait image)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "MicroVM image ${IMAGE_ARN2} still exists after destroy" \
  aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN2}" --region "${REGION}"
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    --no-wait image + state removed"

# Remove the code artifact we uploaded in Phase 0 (not a cdkd-managed resource).
aws s3 rm "s3://${STATE_BUCKET}/${ARTIFACT_KEY}" --region "${REGION}" >/dev/null

echo "[verify] PASS -- MicroVM image async create (CREATING -> CREATED), ARN physicalId + Ref-attr parity, tags-only update no-rebuild, tag drift detect/revert, --no-wait returns at CREATING, clean async destroy"

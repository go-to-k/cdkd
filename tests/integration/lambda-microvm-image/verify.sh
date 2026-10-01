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
#   5. Issue #4275: deploy with the image Name taken from a Secrets Manager
#      secret, then a tags-only update: assert it is applied in place (exit 0,
#      same ARN, new tag) instead of refused as a Name change. Destroy.
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
# Phase 5 resolves a Secrets Manager reference, so the stack's state versions
# are swept and asserted on the success path (issue #2096).
# shellcheck source=../s3-versions.sh
. ../s3-versions.sh

STACK="CdkdMicrovmImageExample"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
IMAGE_NAME="cdkd-integ-microvm-image"
ARTIFACT_KEY="cdkd-integ-microvm-artifacts/${STACK}/artifact.zip"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# Phase 5 (issue #4275): the image Name comes from this secret. A prefix that
# does not contain IMAGE_NAME, so each name filter below finds only its own.
SECRET_IMAGE_NAME="cdkd-integ-sdn-microvm-image"
NAME_SECRET="cdkd-integ-microvm-name-$(date +%s)-$$"
SEEDED_SECRET=0

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # GetMicrovmImage / DeleteMicrovmImage require the image ARN (a bare Name is
  # rejected with "Invalid ARN format"); resolve the ARN by name first.
  local leftover_arn name
  for name in "${IMAGE_NAME}" "${SECRET_IMAGE_NAME}"; do
    leftover_arn="$(aws lambda-microvms list-microvm-images --name-filter "${name}" \
      --region "${REGION}" --query 'items[0].imageArn' --output text 2>/dev/null)"
    if [ -n "${leftover_arn}" ] && [ "${leftover_arn}" != "None" ]; then
      aws lambda-microvms delete-microvm-image --image-identifier "${leftover_arn}" --region "${REGION}" >/dev/null 2>&1 || true
    fi
  done
  # Printed, not swallowed, so a surviving secret is visible.
  if [ "${SEEDED_SECRET}" = "1" ]; then
    local secret_out
    if ! secret_out="$(aws secretsmanager delete-secret --secret-id "${NAME_SECRET}" \
      --force-delete-without-recovery --region "${REGION}" 2>&1)"; then
      echo "WARNING: could not delete the phase 5 secret ${NAME_SECRET}: ${secret_out}" >&2
    else
      # INT/TERM run cleanup and then EXIT runs it again: no second attempt.
      SEEDED_SECRET=0
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${ARTIFACT_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # Safe on any path: only NON-current versions go.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" noncurrent || true
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

# --- Phase 5: a secret-derived Name is updated in place (#4275) -----------
# cdkd records a secret-derived value as its `{{resolve:secretsmanager:...}}`
# expression, while `update()` receives the RESOLVED value. The provider used
# to compare the two directly and refuse every update of such an image with
# "Name is create-only and cannot be changed in place". The engine's own diff
# sees no Name change (template and record spell the same expression), so the
# tags-only change below reaches `update()`.
#
# Pre-fix this arm fails at the update deploy's exit code (the refusal), and
# the tag assertion would fail with it. Post-fix the deploy exits 0, the ARN
# and active version are unchanged, and the new tag is on the image.
echo "==> Phase 5: secret-derived Name, then a tags-only update (issue #4275)"
# From a file, not argv, so the value never shows in the host's process list.
SECRET_FILE="$(mktemp -t lambda-microvm-image-secret.XXXXXX)"
printf '{"name":"%s"}' "${SECRET_IMAGE_NAME}" > "${SECRET_FILE}"
# Flagged BEFORE the call: a create that succeeds on AWS but reports failure
# (a client timeout) must still be deleted by the trap.
SEEDED_SECRET=1
aws secretsmanager create-secret --region "${REGION}" --name "${NAME_SECRET}" \
  --secret-string "file://${SECRET_FILE}" >/dev/null || { rm -f "${SECRET_FILE}"; exit 1; }
rm -f "${SECRET_FILE}"
echo "    seeded secret ${NAME_SECRET}"

MICROVM_NAME_SECRET="${NAME_SECRET}" MICROVM_ARTIFACT_URI="${ARTIFACT_URI}" MICROVM_ARTIFACT_BUCKET="${STATE_BUCKET}" \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_JSON5="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
microvm_state_field() { # usage: microvm_state_field physicalId|<property> <<< "<state json>"
  python3 -c '
import json, sys
for v in json.load(sys.stdin)["resources"].values():
    if v["resourceType"] == "AWS::Lambda::MicrovmImage":
        f = sys.argv[1]
        print(v.get("physicalId", "") if f == "physicalId" else v.get("properties", {}).get(f, ""))
        break
' "$1"
}
IMAGE_ARN5="$(microvm_state_field physicalId <<< "${STATE_JSON5}")"
case "${IMAGE_ARN5}" in
  arn:aws:lambda:*:microvm-image:*) echo "    secret-named image created: ${IMAGE_ARN5}" ;;
  *) echo "FAIL: physicalId is not a MicroVM image ARN: '${IMAGE_ARN5}'" >&2; exit 1 ;;
esac

# Non-vacuity: the record must hold the EXPRESSION, or the update below never
# compares a resolved value against a reference and proves nothing.
RECORDED_NAME="$(microvm_state_field Name <<< "${STATE_JSON5}")"
EXPECTED_REF="{{resolve:secretsmanager:${NAME_SECRET}:SecretString:name::}}"
[ "${RECORDED_NAME}" = "${EXPECTED_REF}" ] || {
  echo "FAIL: state records Name '${RECORDED_NAME}', expected '${EXPECTED_REF}'; the name is not secret-derived, so the update below would not exercise #4275" >&2
  exit 1
}
LIVE_NAME="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN5}" \
  --region "${REGION}" --query 'name' --output text)"
[ "${LIVE_NAME}" = "${SECRET_IMAGE_NAME}" ] || {
  echo "FAIL: the image is named '${LIVE_NAME}', expected the secret's '${SECRET_IMAGE_NAME}'" >&2
  exit 1
}
echo "    state records the Name as its secret reference; the image carries the resolved name"
VERSION5_BEFORE="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN5}" \
  --region "${REGION}" --query 'latestActiveImageVersion' --output text)"

# The update: the same tags-only change as Phase 1b. Exit code kept, stderr
# kept (it carries the refusal on the pre-fix code).
p5_rc=0
MICROVM_NAME_SECRET="${NAME_SECRET}" MICROVM_ARTIFACT_URI="${ARTIFACT_URI}" MICROVM_ARTIFACT_BUCKET="${STATE_BUCKET}" CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes || p5_rc=$?
[ "${p5_rc}" -eq 0 ] || {
  echo "FAIL: the tags-only update of a secret-named image exited ${p5_rc}; a refusal here is #4275's resolved-name-vs-reference comparison" >&2
  exit 1
}

IMAGE_ARN5_AFTER="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" | microvm_state_field physicalId)"
[ "${IMAGE_ARN5_AFTER}" = "${IMAGE_ARN5}" ] || {
  echo "FAIL: the image ARN changed across a tags-only update (${IMAGE_ARN5} -> ${IMAGE_ARN5_AFTER})" >&2
  exit 1
}
TEAM_TAG5="$(aws lambda-microvms list-tags --resource "${IMAGE_ARN5}" --region "${REGION}" \
  --query 'Tags.team' --output text)"
[ "${TEAM_TAG5}" = "infra" ] || {
  echo "FAIL: expected team=infra on ${IMAGE_ARN5} after the update, got '${TEAM_TAG5}' -- the update never reached it" >&2
  exit 1
}
VERSION5_AFTER="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN5}" \
  --region "${REGION}" --query 'latestActiveImageVersion' --output text)"
[ "${VERSION5_AFTER}" = "${VERSION5_BEFORE}" ] || {
  echo "FAIL: the tags-only update rebuilt the secret-named image (version ${VERSION5_BEFORE} -> ${VERSION5_AFTER})" >&2
  exit 1
}
echo "    tags-only update applied in place: same ARN, same version, team=infra"

node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "MicroVM image ${IMAGE_ARN5} still exists after destroy" \
  aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN5}" --region "${REGION}"
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    secret-named image + state removed"

# Remove the code artifact we uploaded in Phase 0 (not a cdkd-managed resource).
aws s3 rm "s3://${STATE_BUCKET}/${ARTIFACT_KEY}" --region "${REGION}" >/dev/null

# Success path: every image and the state are asserted gone above. Delete the
# secret while the trap is still armed (a failed delete then gets the trap's
# retry and WARNING), then disarm the trap -- its `state destroy` / `aws s3 rm`
# would write fresh delete markers under the prefix certified below -- and
# sweep every object version under the stack's prefix, asserting none
# survives.
aws secretsmanager delete-secret --secret-id "${NAME_SECRET}" \
  --force-delete-without-recovery --region "${REGION}" >/dev/null
SEEDED_SECRET=0
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX}" "stack state teardown"

echo "[verify] PASS -- MicroVM image async create (CREATING -> CREATED), ARN physicalId + Ref-attr parity, tags-only update no-rebuild, tag drift detect/revert, --no-wait returns at CREATING, clean async destroy, secret-derived Name updated in place (#4275)"

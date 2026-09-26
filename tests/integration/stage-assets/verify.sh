#!/usr/bin/env bash
# verify.sh - cdkd stage-assets integ.
#
# Covers a class NO other fixture in this repo reaches: assets declared inside
# a `cdk.Stage`.
#
# `cdk synth` stages every asset into the APP's output directory, while a
# Stage's own asset manifest is written to `cdk.out/assembly-<Stage>/`. So for
# a Stage stack upstream emits paths that point one level UP:
#
#   cdk.out/assembly-CdkdStageAssets/<Stack>.assets.json
#     files[].source.path          = "../asset.<hash>"
#     dockerImages[].source.directory = "../asset.<hash>"
#
# cdkd's assembly-path containment check (issue go-to-k/cdkd#3489) must measure
# those against the APP's outdir, not the manifest's own directory. Measuring
# against the manifest directory refused every Stage asset with a
# "hand-modified assembly" message — i.e. `cdkd deploy` of any Stage stack
# carrying a Lambda/S3/Docker asset failed outright, the common Stage and
# CDK-Pipelines layout. Deploying at all is therefore the load-bearing
# assertion here; the markers prove the right bytes were published and wired.
#
# Both publishers are exercised because each reads a different manifest field:
#   - a ZIP Lambda -> FileAssetPublisher   (`source.path`)
#   - a container Lambda -> DockerAssetPublisher (`source.directory`)
#
#   1. deploy CdkdStageAssets/Stack -> cdkd publishes 1 S3 zip + 1 ECR image
#      whose manifest paths both begin `../`.
#   2. assert the synth output really does carry the `../asset.` shape, so a
#      future CDK change that flattens it turns this into a loud failure
#      rather than a silently vacuous run.
#   3. invoke both Lambdas and assert their DISTINCT markers.
#   3b. hide the Stage's manifest.json and assert destroy names the Stage and
#      leaves the stack in state (go-to-k/cdkd#3507).
#   4. destroy -> assert clean (0 errors): both Lambdas gone, OUR pushed image
#      gone from ECR by tag, state file gone.
#
# BSD/macOS-portable. Captures real rc + prints an explicit `[verify] PASS`.
#
# REQUIRES Docker running. If `docker info` fails, the test SKIPs gracefully.
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

# The physical stack name cdkd deploys. A Stage prefixes its stacks, so this
# is the Stage id + the stack id, NOT the directory name.
STACK="CdkdStageAssets-Stack"
# The hierarchical selector, which is how a user names a Stage stack.
STACK_PATH="CdkdStageAssets/Stack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ECR_REPO=""
IMAGE_TAG=""

cleanup() {
  rc=$?
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  fi
  # Delete only the image WE pushed (by tag) from the shared CDK asset repo.
  if [ -n "${ECR_REPO}" ] && [ -n "${IMAGE_TAG}" ]; then
    aws ecr batch-delete-image --repository-name "${ECR_REPO}" \
      --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  set -eu
  exit "${rc}"
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

echo "==> Checking Docker is available"
if ! docker info >/dev/null 2>&1; then
  echo "[verify] SKIP: Docker daemon not available (docker info failed); the stage-assets integ requires a running Docker daemon to build + push the image."
  trap - EXIT INT TERM
  exit 0
fi
echo "    OK: Docker daemon is reachable"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
  --region "${REGION}" --yes >/dev/null 2>&1 || true

# --- Phase 0: prove the fixture really produces the `../asset.` shape -------
# Without this the run is silently vacuous if CDK ever flattens Stage asset
# staging: the deploy would pass while covering nothing.
echo "==> Phase 0: synth and assert the Stage manifest points one level UP"
node "${LOCAL_DIST}" synth "${STACK_PATH}" --region "${REGION}" >/dev/null

# Resolve the manifest from the Stage's OWN manifest.json rather than guessing
# its filename: an asset manifest is named after the stack's ARTIFACT ID
# (`CdkdStageAssetsStackCD815D27`), not its stackName (`CdkdStageAssets-Stack`),
# and the hash suffix moves whenever the construct tree does. Scoped to this one
# Stage's directory and asserted to resolve to exactly one stack, so a second
# (or nested) Stage cannot silently redirect the assertions below at the wrong
# manifest -- which a `find | head -1` would.
STAGE_DIR="cdk.out/assembly-CdkdStageAssets"
if [ ! -f "${STAGE_DIR}/manifest.json" ]; then
  echo "FAIL: no Stage assembly at ${STAGE_DIR} - the fixture is not producing a Stage" >&2
  find cdk.out -name 'manifest.json' >&2
  exit 1
fi
STAGE_ARTIFACTS=$(jq -r '[.artifacts | to_entries[] | select(.value.type == "aws:cloudformation:stack") | .key] | join(" ")' "${STAGE_DIR}/manifest.json")
if [ "$(printf '%s\n' "${STAGE_ARTIFACTS}" | wc -w | tr -d ' ')" != "1" ]; then
  echo "FAIL: expected exactly one stack artifact in ${STAGE_DIR}, got: '${STAGE_ARTIFACTS}'" >&2
  exit 1
fi
STAGE_MANIFEST="${STAGE_DIR}/${STAGE_ARTIFACTS}.assets.json"
if [ ! -f "${STAGE_MANIFEST}" ]; then
  echo "FAIL: no Stage asset manifest at ${STAGE_MANIFEST} - the Stage stack declares no assets" >&2
  find cdk.out -name '*.assets.json' >&2
  exit 1
fi
echo "    Stage asset manifest: ${STAGE_MANIFEST}"

UP_FILE=$(jq -r '[.files[]?.source.path | select(startswith("../"))] | length' "${STAGE_MANIFEST}")
UP_DOCKER=$(jq -r '[.dockerImages[]?.source.directory | select(startswith("../"))] | length' "${STAGE_MANIFEST}")
if [ "${UP_FILE}" -lt 1 ]; then
  echo "FAIL: Stage manifest has no file asset with a '../' source.path - this integ would be vacuous" >&2
  jq '.files' "${STAGE_MANIFEST}" >&2
  exit 1
fi
if [ "${UP_DOCKER}" -lt 1 ]; then
  echo "FAIL: Stage manifest has no docker asset with a '../' source.directory - this integ would be vacuous" >&2
  jq '.dockerImages' "${STAGE_MANIFEST}" >&2
  exit 1
fi
echo "    OK: ${UP_FILE} file asset(s) and ${UP_DOCKER} docker asset(s) point one level up"

# --- Phase 1: deploy --------------------------------------------------------
# A containment regression fails HERE, refusing with a "hand-modified
# assembly" message before anything is published.
echo "==> Phase 1: deploy the Stage stack (publishes 1 S3 zip + 1 ECR image)"
node "${LOCAL_DIST}" deploy "${STACK_PATH}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Resolve both Lambdas from state ---------------------------------------
ZIP_FN=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select((.value.properties.PackageType // "Zip") == "Zip") | .value.physicalId] | first')
IMAGE_FN=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.value.properties.PackageType == "Image") | .value.physicalId] | first')
for pair in "ZIP_FN:${ZIP_FN}" "IMAGE_FN:${IMAGE_FN}"; do
  name="${pair%%:*}"
  val="${pair#*:}"
  if [ -z "${val}" ] || [ "${val}" = "null" ]; then
    echo "FAIL: could not resolve ${name} from state" >&2
    echo "${STATE}" | jq '.resources' >&2
    exit 1
  fi
done
echo "    zip Lambda:   ${ZIP_FN}"
echo "    image Lambda: ${IMAGE_FN}"

# Capture the pushed image's repo + tag so cleanup can sweep it even if
# destroy is what breaks.
IMAGE_URI=$(aws lambda get-function --function-name "${IMAGE_FN}" --region "${REGION}" \
  --query 'Code.ImageUri' --output text)
ECR_REPO=$(printf '%s' "${IMAGE_URI}" | sed -E 's#^[^/]+/##; s#:.*$##')
IMAGE_TAG=$(printf '%s' "${IMAGE_URI}" | sed -E 's#^.*:##')
echo "    pushed image: repo=${ECR_REPO} tag=${IMAGE_TAG}"

# --- Phase 2: invoke both, assert DISTINCT markers --------------------------
# Proves each asset's real bytes were published and wired to its own function,
# not merely that a deploy succeeded.
echo "==> Phase 2: invoke both Lambdas"
# WAIT FIRST. A function is `Pending` for a while after CREATE -- an
# image-backed one for far longer, since Lambda optimizes the ECR image before
# it becomes `Active` -- and an invoke in that window fails with
# `ResourceConflictException`, which reads as an empty marker and accuses the
# asset wiring this fixture exists to prove. Measured: the image function was
# still `Pending` when the deploy returned.
await_active() { # usage: await_active <fn-name>
  local state
  for _ in $(seq 1 60); do
    state=$(aws lambda get-function --function-name "$1" --region "${REGION}" \
      --query 'Configuration.State' --output text) || return 1
    case "${state}" in
      Active) return 0 ;;
      Failed) echo "FAIL: Lambda $1 settled in state Failed, so the invoke below would not test the asset wiring" >&2; return 1 ;;
      *) sleep 5 ;;
    esac
  done
  echo "FAIL: Lambda $1 was still '${state}' after 300s -- not an asset-wiring failure" >&2
  return 1
}
await_active "${ZIP_FN}"
await_active "${IMAGE_FN}"
echo "    OK: both Lambdas reached Active"

invoke_marker() { # usage: invoke_marker <fn-name>
  local out
  out=$(mktemp)
  aws lambda invoke --function-name "$1" --region "${REGION}" \
    --cli-binary-format raw-in-base64-out --payload '{}' "${out}" >/dev/null
  jq -r '.marker // empty' "${out}"
  rm -f "${out}"
}

ZIP_MARKER=$(invoke_marker "${ZIP_FN}")
if [ "${ZIP_MARKER}" != "stage-file-asset" ]; then
  echo "FAIL: zip Lambda returned marker '${ZIP_MARKER}', expected 'stage-file-asset'" >&2
  exit 1
fi
IMAGE_MARKER=$(invoke_marker "${IMAGE_FN}")
if [ "${IMAGE_MARKER}" != "stage-docker-asset" ]; then
  echo "FAIL: image Lambda returned marker '${IMAGE_MARKER}', expected 'stage-docker-asset'" >&2
  exit 1
fi
echo "    OK: both markers correct"

# --- Phase 2b: destroy while the Stage fails to load names the Stage --------
# Hiding the Stage's own manifest.json is the one Stage failure the assembly
# reader tolerates: the stack drops out of the synthesized app, so the
# selection comes back empty. destroy must name the Stage rather than answer a
# bare "No matching stacks found in state" (go-to-k/cdkd#3507), and must not
# touch the stack, which is still in state. `--app cdk.out` reads the Phase 0
# assembly instead of re-synthesizing over the hidden file.
echo "==> Phase 2b: destroy with the Stage manifest hidden names the Stage"
mv "${STAGE_DIR}/manifest.json" "${STAGE_DIR}/manifest.json.hidden"
set +e
HIDDEN_OUT=$(node "${LOCAL_DIST}" destroy "${STACK_PATH}" --app cdk.out \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1)
HIDDEN_RC=$?
set -e
mv "${STAGE_DIR}/manifest.json.hidden" "${STAGE_DIR}/manifest.json"
printf '%s\n' "${HIDDEN_OUT}"
if [ "${HIDDEN_RC}" -ne 0 ]; then
  echo "FAIL: destroy with the Stage hidden exited ${HIDDEN_RC}, expected 0 (nothing selected)" >&2
  exit 1
fi
if ! printf '%s' "${HIDDEN_OUT}" | grep -qF "No matching stacks found in state. Stage CdkdStageAssets failed to load"; then
  echo "FAIL: destroy did not name the Stage that failed to load" >&2
  exit 1
fi
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null; then
  echo "FAIL: state file gone after a destroy that selected nothing" >&2
  exit 1
fi
echo "    OK: Stage named, stack left in place"

# --- Phase 3: destroy + leak assertions -------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK_PATH}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "zip Lambda ${ZIP_FN} still exists after destroy" \
  aws lambda get-function --function-name "${ZIP_FN}" --region "${REGION}"
assert_gone "image Lambda ${IMAGE_FN} still exists after destroy" \
  aws lambda get-function --function-name "${IMAGE_FN}" --region "${REGION}"

# The image lands in the SHARED container-assets repo, which cdkd does not own
# and must not delete: other stacks reference images there by content hash.
# `destroy` therefore leaves it BY DESIGN -- pruning published assets is
# `cdkd gc`'s job, and `gc.ts` is the only `BatchDeleteImage` caller in `src/`.
# So sweep OUR tag ourselves and then assert gone, exactly as `multi-asset` and
# `docker-image-asset` do; asserting that destroy removed it would accuse cdkd
# of a leak for doing the right thing.
if aws ecr describe-images --repository-name "${ECR_REPO}" \
    --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1; then
  echo "==> sweeping our pushed image (shared-repo asset images are not auto-pruned)"
  aws ecr batch-delete-image --repository-name "${ECR_REPO}" \
    --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1 || true
fi
assert_gone "pushed image ${ECR_REPO}:${IMAGE_TAG} still present after destroy + sweep" \
  aws ecr describe-images --repository-name "${ECR_REPO}" \
  --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}"

assert_gone "state file still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

# Success path: disarm the trap and do the final sweep explicitly, so the
# deployment-events sidecar (which deliberately survives destroy) is removed.
trap - EXIT INT TERM
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
aws ecr batch-delete-image --repository-name "${ECR_REPO}" \
  --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1 || true

echo "[verify] PASS"

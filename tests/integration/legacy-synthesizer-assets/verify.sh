#!/usr/bin/env bash
# verify.sh - cdkd LegacyStackSynthesizer assets integ (issue #6421).
#
# A stack synthesized with `LegacyStackSynthesizer` has NO `<Stack>.assets.json`:
# each asset is an `aws:cdk:asset` metadata entry, and the template declares
# `AssetParameters<hash>S3Bucket…` / `…S3VersionKey…` / `…ArtifactHash…`
# parameters with no default. Before the fix `cdkd deploy` stopped with
# "Parameter AssetParameters…S3Bucket… is required but no value was provided".
#
# Phases:
#   0. Premise: the synthesized assembly has no asset manifest for the stack and
#      its template carries the no-default AssetParameters.
#      The v1 and v2 asset objects are deleted from both candidate buckets
#      first, so every publish below is a real upload (the buckets persist
#      across runs, and an existing object would skip the publish).
#   1. Deploy (v1). The Lambda's recorded Code names the EXPECTED bucket --
#      the cdkd asset bucket from the region's bootstrap marker (key
#      `<hash>.zip` at its root), else the CDKToolkit stack's BucketName
#      (`assets/<hash>.zip`, CDK CLI layout) -- and that object exists; the
#      `||`-split key parameter resolved. Invoking the Lambda returns the v1
#      code marker and the v1 file asset's content, read through the DATA_URL
#      the file asset's parameters built, in the SAME bucket.
#   2. UPDATE (CDKD_TEST_UPDATE=true switches both assets to v2 sources): new
#      keys are published and the Lambda runs the v2 code and reads the v2 file.
#   3. Destroy: the function and state.json are gone.
#
# Asset objects persist by design (the asset bucket is shared storage; `cdkd gc`
# / `cdk gc` own their lifetime), so nothing asserts their absence.
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

STACK="CdkdLegacySynthesizerAssetsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
OUT_FILE="$(mktemp)"
V2_OUT="$(mktemp -d)"

FN_NAME=""

# Lambda auto-creates /aws/lambda/<fn> on invoke and nothing deletes it. The
# guard keeps an empty or foreign STACK from widening the listing; the exact
# group of the function this run invoked goes too, whatever its name.
sweep_log_groups() {
  ( set +eu
    if [ -n "${FN_NAME}" ]; then
      aws logs delete-log-group --log-group-name "/aws/lambda/${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
    fi
    case "${STACK}" in
      CdkdLegacySynthesizerAssets?*)
        for lg in $(aws logs describe-log-groups --region "${REGION}" \
          --log-group-name-prefix "/aws/lambda/${STACK}-" \
          --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
          aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
        done
        ;;
      *)
        echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CdkdLegacySynthesizerAssets?*" >&2
        ;;
    esac
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${OUT_FILE}"
  rm -rf "${V2_OUT}"
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  sweep_log_groups
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

# The Lambda's recorded Code, from state: "<bucket> <key>".
recorded_code() {
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  jq -r '.resources | to_entries[]
    | select(.value.resourceType == "AWS::Lambda::Function")
    | select(.key | startswith("Handler"))
    | "\(.value.properties.Code.S3Bucket) \(.value.properties.Code.S3Key) \(.value.physicalId)"' <<<"${state}"
}

# The bucket and key prefix the legacy assets must go to: the cdkd asset
# bucket (root keys) when the region has a bootstrap marker, else the
# CDKToolkit stack's bucket (`assets/` keys). Sets EXPECTED_BUCKET / KEY_PREFIX.
expected_destination() {
  local marker
  if marker=$(aws s3 cp "s3://${STATE_BUCKET}/cdkd-bootstrap/${REGION}.json" - 2>/dev/null); then
    EXPECTED_BUCKET=$(jq -r '.assetBucket' <<<"${marker}")
    KEY_PREFIX=""
  else
    EXPECTED_BUCKET=$(aws cloudformation describe-stacks --stack-name CDKToolkit --region "${REGION}" \
      --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text) || return 1
    KEY_PREFIX="assets/"
  fi
  [ -n "${EXPECTED_BUCKET}" ] && [ "${EXPECTED_BUCKET}" != "None" ]
}

# The object names (`<hash><ext>`) of the stack's legacy assets in a synthesized
# assembly directory, one per line.
asset_object_names() { # usage: asset_object_names <outdir>
  jq -r '.[][] | select(.type == "aws:cdk:asset") | .data
    | "\(.sourceHash)\(if .packaging == "zip" then ".zip" else ((.path | capture("(?<e>\\.[^.]*)$").e) // "") end)"' \
    "$1/${STACK}.metadata.json"
}

# Deploy-phase assertions: the recorded code object is in the expected bucket
# and exists, the Lambda runs the expected code and reads the expected file
# asset from the same bucket.
check_phase() { # usage: check_phase <code-marker> <data-content>
  local want_marker="$1" want_data="$2" line bucket key fn body marker data data_url
  line=$(recorded_code) || { echo "FAIL: could not read ${STATE_KEY}" >&2; exit 1; }
  read -r bucket key fn <<<"${line}"
  expected_destination || { echo "FAIL: could not determine the expected asset bucket" >&2; exit 1; }
  if [ "${bucket}" != "${EXPECTED_BUCKET}" ]; then
    echo "FAIL: recorded Code.S3Bucket '${bucket}', expected '${EXPECTED_BUCKET}' (marker bucket in cdkd-assets mode, else CDKToolkit's)" >&2
    exit 1
  fi
  if ! [[ "${key}" =~ ^${KEY_PREFIX}[0-9a-f]{64}\.zip$ ]]; then
    echo "FAIL: recorded Code.S3Key '${key}' is not ${KEY_PREFIX}<hash>.zip - the S3VersionKey parameter was not bound" >&2
    exit 1
  fi
  aws s3api head-object --bucket "${bucket}" --key "${key}" --region "${REGION}" >/dev/null || {
    echo "FAIL: code object s3://${bucket}/${key} does not exist - the asset was not published where the parameter points" >&2
    exit 1
  }
  echo "    OK: Code is s3://${bucket}/${key} and the object exists"
  FN_NAME="${fn}"
  aws lambda invoke --function-name "${fn}" --region "${REGION}" \
    --cli-binary-format raw-in-base64-out --payload '{}' "${OUT_FILE}" >/dev/null
  body=$(cat "${OUT_FILE}")
  marker=$(jq -r '.marker // empty' <<<"${body}")
  data=$(jq -r '.data // empty' <<<"${body}")
  data_url=$(jq -r '.dataUrl // empty' <<<"${body}")
  if [ "${marker}" != "${want_marker}" ]; then
    echo "FAIL: Lambda marker '${marker}', expected '${want_marker}'. Response: ${body}" >&2
    exit 1
  fi
  if [ "${data}" != "${want_data}" ]; then
    echo "FAIL: file asset content '${data}', expected '${want_data}'. Response: ${body}" >&2
    exit 1
  fi
  if ! [[ "${data_url}" =~ ^s3://${bucket}/${KEY_PREFIX}[0-9a-f]{64}\.txt$ ]]; then
    echo "FAIL: DATA_URL '${data_url}' is not s3://${bucket}/${KEY_PREFIX}<hash>.txt" >&2
    exit 1
  fi
  echo "    OK: Lambda runs ${want_marker} and read ${want_data} from ${data_url}"
  LAST_KEY="${key}"
}

# --- Phase 0: premise -------------------------------------------------------
echo "==> Phase 0: the assembly is a LegacyStackSynthesizer one"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" synth "${STACK}" --region "${REGION}" >/dev/null
if [ -e "cdk.out/${STACK}.assets.json" ]; then
  echo "FAIL: premise: cdk.out/${STACK}.assets.json exists - the stack is not using LegacyStackSynthesizer" >&2
  exit 1
fi
NO_DEFAULT_PARAMS=$(jq '[.Parameters // {} | to_entries[]
  | select(.key | startswith("AssetParameters")) | select(.value.Default == null)] | length' \
  "cdk.out/${STACK}.template.json")
if [ "${NO_DEFAULT_PARAMS}" -ne 6 ]; then
  echo "FAIL: premise: expected 6 no-default AssetParameters (2 assets x 3), found ${NO_DEFAULT_PARAMS}" >&2
  exit 1
fi
echo "    OK: no asset manifest; ${NO_DEFAULT_PARAMS} no-default AssetParameters in the template"

# Fresh uploads: delete this fixture's v1 + v2 objects (content hashes unique
# to it) from whichever candidate bucket exists.
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" synth "${STACK}" --region "${REGION}" --output "${V2_OUT}" >/dev/null
OBJECT_NAMES="$(asset_object_names cdk.out)
$(asset_object_names "${V2_OUT}")"
if [ "$(grep -c . <<<"${OBJECT_NAMES}")" -ne 4 ]; then
  echo "FAIL: premise: expected 4 asset objects (2 assets x 2 versions), got: ${OBJECT_NAMES}" >&2
  exit 1
fi
# Before the first deploy no marker may exist yet (the deploy auto-creates an
# empty bucket then) and no CDKToolkit stack either: nothing to purge.
if expected_destination; then
  while read -r name; do
    [ -n "${name}" ] || continue
    aws s3api delete-object --bucket "${EXPECTED_BUCKET}" --key "${KEY_PREFIX}${name}" --region "${REGION}" >/dev/null
  done <<<"${OBJECT_NAMES}"
  echo "    OK: purged this fixture's asset objects from ${EXPECTED_BUCKET}"
fi

# --- Phase 1: deploy --------------------------------------------------------
echo "==> Phase 1: deploy (v1 assets)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
check_phase cdkd-legacy-synth-code-v1 cdkd-legacy-synth-data-v1
V1_KEY="${LAST_KEY}"

# --- Phase 2: UPDATE with changed asset content -----------------------------
echo "==> Phase 2: deploy with CDKD_TEST_UPDATE=true (v2 assets)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
check_phase cdkd-legacy-synth-code-v2 cdkd-legacy-synth-data-v2
if [ "${LAST_KEY}" = "${V1_KEY}" ]; then
  echo "FAIL: the code key did not change across the asset update (${LAST_KEY})" >&2
  exit 1
fi
echo "    OK: the update published a new code object (${V1_KEY} -> ${LAST_KEY})"

# --- Phase 3: destroy -------------------------------------------------------
echo "==> Phase 3: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: Lambda function is gone"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

trap - EXIT INT TERM
rm -f "${OUT_FILE}"
rm -rf "${V2_OUT}"
sweep_log_groups

echo ""
echo "==> legacy-synthesizer-assets test passed (legacy asset publish + parameter binding + asset update + clean destroy)"
echo "[verify] PASS"

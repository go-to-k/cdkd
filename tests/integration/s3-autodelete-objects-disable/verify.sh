#!/usr/bin/env bash
# verify.sh — cdkd autoDeleteObjects true -> false on an untagged bucket (issue #6422).
#
# Turning autoDeleteObjects off strips the bucket's only tag and deletes the
# Custom::S3AutoDeleteObjects resource in ONE deploy. CDK's handler reads the
# bucket's tags on Delete; S3 answers NoSuchTagSet for a bucket with none, and
# the handler reports FAILED. cdkd used to keep the record as unaddressed and
# exit 2; CloudFormation never meets it (its buckets keep aws:cloudformation:*
# tags). cdkd now confirms the empty tag set itself and counts the delete done.
#
# Phases:
#   1. Deploy autoDeleteObjects=true; put two objects; assert the auto-delete tag.
#   2. Re-deploy CDKD_TEST_UPDATE=true (autoDeleteObjects=false, RETAIN) WITHOUT
#      --allow-unaddressed: assert rc 0, NO tag set, both objects kept, and the
#      custom resource's state record gone (a pre-fix run exits 2 and keeps it).
#   3. Destroy: the RETAIN bucket survives with its objects; delete it by hand
#      and assert the state file is gone.
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

STACK="CdkdS3AutoDeleteDisableExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
CR_LOGICAL_ID="BucketAutoDeleteObjectsCustomResourceBAFD23C2"
# Lambda truncates the generated name (`...-CustomS3AutoDeleteOb-<hash>`).
HANDLER_LG_PREFIX="/aws/lambda/${STACK}-CustomS3AutoDelete"
SCRATCH="$(mktemp -d)"
BUCKET=""

empty_and_delete_bucket() {
  ( set +eu
    [ -n "${BUCKET}" ] || exit 0
    aws s3 rm "s3://${BUCKET}" --recursive --region "${REGION}" >/dev/null 2>&1
    aws s3api delete-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1
    true )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  empty_and_delete_bucket
  case "${HANDLER_LG_PREFIX}" in
    /aws/lambda/CdkdS3AutoDeleteDisableExample-?*)
      for lg in $(aws logs describe-log-groups --log-group-name-prefix "${HANDLER_LG_PREFIX}" \
        --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
        aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
      done
      ;;
    *) echo "WARN: teardown sweep refused: unexpected log-group prefix '${HANDLER_LG_PREFIX}'" >&2 ;;
  esac
  rm -rf "${SCRATCH}"
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="cdkd-autodel-disable-${ACCOUNT}-${REGION}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup
SCRATCH="$(mktemp -d)"

object_keys() {
  aws s3api list-objects-v2 --bucket "${BUCKET}" --region "${REGION}" \
    --query "join(' ', sort(Contents[].Key || \`[]\`))" --output text
}

# --- Phase 1: autoDeleteObjects=true ----------------------------------------
echo "==> Phase 1: deploy autoDeleteObjects=true"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

echo "keep" > "${SCRATCH}/o.txt"
aws s3 cp "${SCRATCH}/o.txt" "s3://${BUCKET}/keep1.txt" --region "${REGION}" --quiet
aws s3 cp "${SCRATCH}/o.txt" "s3://${BUCKET}/keep2.txt" --region "${REGION}" --quiet

TAGS="$(aws s3api get-bucket-tagging --bucket "${BUCKET}" --region "${REGION}" \
  --query "join(' ', sort(TagSet[].Key))" --output text)"
if [ "${TAGS}" != "aws-cdk:auto-delete-objects" ]; then
  echo "FAIL: Phase 1 expected the auto-delete tag as the ONLY tag, got '${TAGS}'" >&2; exit 1
fi
echo "    auto-delete tag is the bucket's only tag"

# --- Phase 2: autoDeleteObjects=false, RETAIN -------------------------------
echo "==> Phase 2: re-deploy autoDeleteObjects=false (must exit 0, objects kept)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${SCRATCH}/phase2.log"
RC=${PIPESTATUS[0]}
set -e
if [ "${RC}" -ne 0 ]; then
  echo "FAIL: Phase 2 deploy exited ${RC} (issue #6422: the CR Delete's NoSuchTagSet left it unaddressed)" >&2; exit 1
fi
# rc 0 alone would also pass through another arm (a backing Lambda already gone
# drops the record too), so assert the #6422 line. Sentinel: the line's head,
# independent of the parsed marker, catches a reword of the marker.
sed 's/\x1b\[[0-9;]*m//g' "${SCRATCH}/phase2.log" > "${SCRATCH}/phase2.plain"
if ! grep -qF 'carries no tags, so it is not tagged for auto-delete' "${SCRATCH}/phase2.plain"; then
  if grep -qF "${CR_LOGICAL_ID} (Custom::S3AutoDeleteObjects): the handler answered FAILED" "${SCRATCH}/phase2.plain"; then
    echo "FAIL: Phase 2 printed the #6422 line in a wording this fixture does not parse — update the marker" >&2; exit 1
  fi
  echo "FAIL: Phase 2 exited 0 without the #6422 untagged-bucket arm (no 'carries no tags' line)" >&2; exit 1
fi
echo "    deploy exited 0 through the untagged-bucket arm"

TAG_OUT="$(aws s3api get-bucket-tagging --bucket "${BUCKET}" --region "${REGION}" 2>&1 >/dev/null || true)"
if ! grep -q 'NoSuchTagSet' <<<"${TAG_OUT}"; then
  echo "FAIL: Phase 2 expected the bucket to have NO tag set (the precondition under test), got: ${TAG_OUT:-<tags present>}" >&2; exit 1
fi
echo "    bucket has no tag set"

KEYS="$(object_keys)"
if [ "${KEYS}" != "keep1.txt keep2.txt" ]; then
  echo "FAIL: Phase 2 expected both objects kept, got '${KEYS}'" >&2; exit 1
fi
echo "    both objects kept"

aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${SCRATCH}/state.json" --quiet
if node -e 'const s=require(process.argv[1]); process.exit(s.resources && s.resources[process.argv[2]] ? 0 : 1)' \
  "${SCRATCH}/state.json" "${CR_LOGICAL_ID}"; then
  echo "FAIL: Phase 2 state still records ${CR_LOGICAL_ID}" >&2; exit 1
fi
if ! node -e 'const s=require(process.argv[1]); process.exit(s.resources && s.resources.Bucket83908E77 ? 0 : 1)' \
  "${SCRATCH}/state.json"; then
  echo "FAIL: Phase 2 state lost the bucket record Bucket83908E77 (the state read is not seeing resources)" >&2; exit 1
fi
echo "    custom resource record dropped, bucket record kept"

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy (the RETAIN bucket survives)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

KEYS="$(object_keys)"
if [ "${KEYS}" != "keep1.txt keep2.txt" ]; then
  echo "FAIL: Phase 3 expected the retained bucket with both objects, got '${KEYS}'" >&2; exit 1
fi
echo "    retained bucket keeps both objects"

aws s3 rm "s3://${BUCKET}" --recursive --region "${REGION}" --quiet
aws s3api delete-bucket --bucket "${BUCKET}" --region "${REGION}"
assert_gone "bucket ${BUCKET} still exists after manual delete" aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    bucket deleted, cdkd state removed"

echo "[verify] PASS — autoDeleteObjects true->false on an untagged bucket, all 3 phases passed"

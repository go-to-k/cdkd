#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd drift` + `cdkd drift --revert`.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDriftRevertExample
#   3. inject drift via direct AWS SDK calls
#   4. cdkd drift  -> assert exit 1 (drift detected)
#   5. cdkd drift --revert -y  -> assert exit 0
#   6. cdkd drift  -> assert exit 0 (clean)
#  6b. rewrite the recorded bucket-policy principal to a BOGUS unique id
#      -> assert exit 1 (a real principal change is still drift)
#  6c. rewrite it to the role's REAL unique id
#      -> assert exit 0 (issue #1515 canonicalization)
#   7. cdkd destroy --force
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDriftRevertExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/drift-revert"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

cleanup() {
  rc=$?
  rm -f "${BOGUS_DRIFT_LOG:-}"
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 3: inject drift"
node inject-drift.ts

echo "[verify] step 4: cdkd drift (expect exit 1)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL: expected drift exit 1, got ${rc}"
  exit 1
fi
echo "[verify] step 4 ok: exit ${rc}"

echo "[verify] step 5: cdkd drift --revert -y (expect exit 0)"
${CLI} drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}"

echo "[verify] step 6: cdkd drift again (expect exit 0)"
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"

# Issue #1515: AWS renders an IAM role principal inside a resource policy as
# either its ARN or its `AROA…` unique id, so the deploy-time capture and a
# later read can hold two spellings of ONE principal — permanent phantom drift
# `--revert` cannot clear. Which form gets captured is a RACE (this fixture's
# autoDeleteObjects role is created concurrently with the policy referencing
# it), so the state baseline is rewritten HERE to make it deterministic.
# Both directions are asserted: a BOGUS unique id must still read as drift,
# which is what proves the clean verdict below is canonicalization and not the
# field silently dropping out of the comparison.
echo "[verify] step 6b: bogus principal unique id in the baseline (expect exit 1)"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node inject-principal-uniqueid.ts bogus
# Removed by `cleanup` rather than inline or by a second EXIT trap: both
# assertion paths below `exit 1` before any inline `rm`, and a second
# `trap ... EXIT` would REPLACE the cleanup trap and silently disable the
# destroy-on-failure this fixture depends on.
BOGUS_DRIFT_LOG="$(mktemp)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}" >"${BOGUS_DRIFT_LOG}" 2>&1
rc=$?
set -e
cat "${BOGUS_DRIFT_LOG}"
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL: a principal that is nobody's unique id must still be drift, got exit ${rc}"
  exit 1
fi
# Exit 1 alone is satisfied by ANY drifted resource, which would make this
# step's non-vacuity argument false — name the resource under test.
if ! grep -q "DriftBucketPolicy" "${BOGUS_DRIFT_LOG}"; then
  echo "[verify] FAIL: expected the BUCKET POLICY to be the drifted resource, got:" >&2
  cat "${BOGUS_DRIFT_LOG}" >&2
  exit 1
fi
echo "[verify] step 6b ok: exit ${rc}, bucket policy named"

echo "[verify] step 6c: the role's REAL unique id in the baseline (expect exit 0)"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node inject-principal-uniqueid.ts real
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
echo "[verify] step 6c ok: issue #1515 canonicalization holds"

# Issue #1626: on a resource with NO `observedProperties` the revert baseline is
# the raw TEMPLATE, where an AWS-authored value and an out-of-band change are
# indistinguishable — so `--revert` MERGES every untemplated path into the bag it
# sends instead of overlaying the drifted subtree wholesale. No fixture can reach
# that baseline by deploying (every deploy records observedProperties), so it is
# manufactured here, exactly as step 6b/6c manufacture the #1515 principal form.
#
# `Tags` on AWS::S3::Bucket is the sharpest probe available: PutBucketTagging is
# documented FULL-REPLACE, so the preserved tag can only survive if it reached the
# provider on the DESIRED side. A fix that merely trimmed `previousProperties`
# leaves this assertion FAILING — which is why it is asserted against AWS here and
# not only in unit tests.
#
# The tag edit is applied DIRECTLY rather than by re-running inject-drift.ts: that
# injector also re-arms the log group's deletion protection, and a failure here
# would then leave `cleanup`'s destroy unable to remove it (orphaned stack) for a
# resource this step does not even assert on.
echo "[verify] step 6d: issue #1626 — untemplated AWS values survive a template-only baseline"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node strip-observed.ts
BUCKET_NAME="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const s=JSON.parse(b);const r=(s.state??s).resources;const id=Object.keys(r).find(k=>r[k].resourceType==="AWS::S3::Bucket"&&k.startsWith("DriftBucket"));if(!id)throw new Error("no DriftBucket in state");process.stdout.write(r[id].physicalId);})')"
echo "[verify] step 6d: bucket=${BUCKET_NAME}"

# Read-modify-write so every other tag (incl. `aws-cdk:auto-delete-objects`,
# which destroy relies on) is preserved. Two edits, because the assertion needs
# BOTH directions: an UNTEMPLATED addition that must survive, and a TEMPLATED
# value that must be reverted. Without the second, a `--revert` that skipped the
# bucket entirely would satisfy the first.
NEW_TAGGING="$(aws s3api get-bucket-tagging --bucket "${BUCKET_NAME}" --region "${REGION}" --output json \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const t=JSON.parse(b).TagSet.filter(e=>e.Key!=="IntegInjected");const o=t.find(e=>e.Key==="Owner");if(!o)throw new Error("template tag Owner missing — the revert-direction assertion would be vacuous");o.Value="DRIFTED-BY-INTEG";t.push({Key:"IntegInjected",Value:"yes"});process.stdout.write(JSON.stringify({TagSet:t}));})')"
aws s3api put-bucket-tagging --bucket "${BUCKET_NAME}" --region "${REGION}" --tagging "${NEW_TAGGING}"

${CLI} drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}"

# Bucket subresources are eventually consistent, so retry briefly. stderr is
# CAPTURED rather than discarded: an empty tag set legitimately raises
# NoSuchTagSet (which `set -e` would otherwise abort on with an opaque error
# instead of the FAIL message below), but any OTHER failure -- AccessDenied, a
# wrong bucket name -- must fail loudly rather than masquerade as "no tags" and
# turn this assertion into a false negative (the #1120 pattern).
TAGS_AFTER=""
for _ in 1 2 3 4 5; do
  if TAGS_RAW="$(aws s3api get-bucket-tagging --bucket "${BUCKET_NAME}" \
      --region "${REGION}" --output json 2>&1)"; then
    TAGS_AFTER="${TAGS_RAW}"
  elif printf '%s' "${TAGS_RAW}" | grep -q 'NoSuchTagSet'; then
    TAGS_AFTER='{"TagSet":[]}'
  else
    echo "[verify] FAIL step 6d: get-bucket-tagging failed for ${BUCKET_NAME}:"
    printf '%s\n' "${TAGS_RAW}"
    exit 1
  fi
  printf '%s' "${TAGS_AFTER}" | grep -q 'IntegInjected' && break
  sleep 3
done
echo "[verify] step 6d: tags after revert = ${TAGS_AFTER}"
OWNER_AFTER="$(printf '%s' "${TAGS_AFTER}" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const e=(JSON.parse(b).TagSet||[]).find(x=>x.Key==="Owner");process.stdout.write(e?e.Value:"(absent)");})')"

if ! printf '%s' "${TAGS_AFTER}" | grep -q 'IntegInjected'; then
  echo "[verify] FAIL step 6d: the untemplated 'IntegInjected' tag was RESET by --revert"
  echo "[verify]   on a template-only baseline it must be preserved (issue #1626)."
  exit 1
fi
# Non-vacuity: the revert must have done real work on THIS bucket. The value was
# mutated above, so this only passes if --revert actually pushed the template
# value back — a skipped resource leaves 'DRIFTED-BY-INTEG'.
if [ "${OWNER_AFTER}" != "cdkd-integ" ]; then
  echo "[verify] FAIL step 6d: templated tag Owner='${OWNER_AFTER}', expected 'cdkd-integ'"
  echo "[verify]   the revert did not touch this bucket, so the preservation"
  echo "[verify]   assertion above would be vacuous."
  exit 1
fi
echo "[verify] step 6d ok: untemplated tag preserved, templated tag reverted"

echo "[verify] step 7: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

trap - EXIT INT TERM
echo "[verify] PASS"

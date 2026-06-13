#!/usr/bin/env bash
# verify.sh — cdkd UPDATE / replacement breadth integ test.
#
# Broadens the real-AWS coverage of cdkd's provider update() paths +
# replacement propagation (issue #807) + Cloud Control write-only-property
# UPDATE on NON-ECS types (issue #809). Only `basic`,
# `dynamodb-globaltable`, and `ecs-fargate` previously exercised
# CDKD_TEST_UPDATE; this fixture adds a single cheap stack that covers BOTH
# in-place update() and replacement across several common resource types.
#
# Flow:
#   Phase 1   deploy (CDKD_TEST_UPDATE unset)  -> capture each resource's
#             physical id + the to-be-changed property value from AWS.
#   Phase 1b  redeploy with CDKD_TEST_UPDATE=true -> assert:
#               in-place  : SAME physical id, NEW property value on AWS
#                 - S3 InPlaceBucket   versioning Suspended/absent -> Enabled
#                 - Lambda WorkerFn     STAGE dev->prod, MemorySize 128->256
#                 - IAM    WorkerRole    inline policy gains s3:PutObject
#                 - EC2    WorkerSg       ingress gains tcp/443 0.0.0.0/0
#               replaced  : ReplaceBucket physical id CHANGED (v1 -> v2),
#                           old bucket gone, new bucket present.
#   Phase 2   destroy -> assert clean (state gone).
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# Portability notes (committed-file BSD/macOS rules):
#   - boolean / possibly-false AWS fields are probed via jq `has()` not
#     `// "default"` (the // operator treats an explicit `false` as absent).
#   - real rc is captured to a var, never trusted through a pipe.

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdUpdateReplaceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET}" --region "${REGION}"
    rc=$?
  else
    rc=0
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${rc}" = "0" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # Sidecar deployment events live in a separate key family from state.
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/deployments/" --recursive >/dev/null 2>&1 || true
  fi
  # Belt-and-suspenders: the replacement bucket name is fully predictable
  # (cdkd-update-replace-{account}-{region}-v1 / -v2). If a deploy crashed
  # MID-REPLACEMENT — after the v2 bucket was created but before state caught
  # up — `state destroy` may not know about both names, so directly drop both
  # predictable buckets so a re-run is not blocked by a leftover "v1"/"v2"
  # bucket (S3 names are globally unique). `aws s3 rb --force` is a no-op /
  # ignored error when the bucket does not exist.
  cleanup_acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  if [ -n "${cleanup_acct}" ] && [ "${cleanup_acct}" != "None" ]; then
    for sfx in v1 v2; do
      aws s3 rb "s3://cdkd-update-replace-${cleanup_acct}-${REGION}-${sfx}" --force --region "${REGION}" >/dev/null 2>&1 || true
    done
  fi
  set -eu
}

trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy (CDKD_TEST_UPDATE unset) -------------------------
echo "==> Phase 1: deploy with the local binary (CDKD_TEST_UPDATE unset)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

IN_PLACE_BUCKET=$(echo "${STATE}" | jq -r '.outputs.InPlaceBucketName // empty')
REPLACE_BUCKET_BEFORE=$(echo "${STATE}" | jq -r '.outputs.ReplaceBucketName // empty')
ROLE_NAME=$(echo "${STATE}" | jq -r '.outputs.RoleName // empty')
FUNCTION_NAME=$(echo "${STATE}" | jq -r '.outputs.FunctionName // empty')
SG_ID=$(echo "${STATE}" | jq -r '.outputs.SecurityGroupId // empty')

for pair in "InPlaceBucketName=${IN_PLACE_BUCKET}" "ReplaceBucketName=${REPLACE_BUCKET_BEFORE}" \
            "RoleName=${ROLE_NAME}" "FunctionName=${FUNCTION_NAME}" "SecurityGroupId=${SG_ID}"; do
  if [ -z "${pair#*=}" ]; then
    echo "FAIL: state output ${pair%%=*} is missing after deploy" >&2
    echo "${STATE}" | jq '.outputs'
    exit 1
  fi
done
echo "    captured: inPlaceBucket=${IN_PLACE_BUCKET} replaceBucket=${REPLACE_BUCKET_BEFORE} role=${ROLE_NAME} fn=${FUNCTION_NAME} sg=${SG_ID}"

# Baseline: versioning should NOT be Enabled (CDK omits VersioningConfiguration
# when versioned:false, so get-bucket-versioning returns an empty Status).
VERS_BEFORE=$(aws s3api get-bucket-versioning --bucket "${IN_PLACE_BUCKET}" --region "${REGION}" \
  --output json 2>/dev/null | jq -r 'if has("Status") then .Status else "none" end')
if [ "${VERS_BEFORE}" = "Enabled" ]; then
  echo "FAIL: InPlaceBucket versioning is already 'Enabled' before the update — baseline wrong" >&2
  exit 1
fi
echo "    OK (baseline): InPlaceBucket versioning is '${VERS_BEFORE}' (not Enabled)"

# Baseline: Lambda STAGE=dev, MemorySize=128.
FN_CFG_BEFORE=$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --output json 2>/dev/null)
MEM_BEFORE=$(echo "${FN_CFG_BEFORE}" | jq -r '.MemorySize')
STAGE_BEFORE=$(echo "${FN_CFG_BEFORE}" | jq -r '.Environment.Variables.STAGE // "none"')
if [ "${MEM_BEFORE}" != "128" ] || [ "${STAGE_BEFORE}" != "dev" ]; then
  echo "FAIL: Lambda baseline wrong — MemorySize='${MEM_BEFORE}' (want 128), STAGE='${STAGE_BEFORE}' (want dev)" >&2
  exit 1
fi
echo "    OK (baseline): Lambda MemorySize=128 STAGE=dev"

# Baseline: IAM inline policy must NOT yet grant s3:PutObject.
PUT_BEFORE=$(aws iam list-role-policies --role-name "${ROLE_NAME}" --output json 2>/dev/null | jq -r '.PolicyNames[0] // "none"')
if [ "${PUT_BEFORE}" = "none" ]; then
  echo "FAIL: WorkerRole has no inline policy after deploy" >&2
  exit 1
fi
HAS_PUT_BEFORE=$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name "${PUT_BEFORE}" --region "${REGION}" \
  --output json 2>/dev/null \
  | jq -r '[.PolicyDocument.Statement[]?.Action] | flatten | index("s3:PutObject") != null')
if [ "${HAS_PUT_BEFORE}" = "true" ]; then
  echo "FAIL: inline policy already grants s3:PutObject before the update — baseline wrong" >&2
  exit 1
fi
echo "    OK (baseline): inline policy '${PUT_BEFORE}' does NOT grant s3:PutObject"

# Baseline: SG has no tcp/443 ingress rule.
HAS_443_BEFORE=$(aws ec2 describe-security-groups --group-ids "${SG_ID}" --region "${REGION}" --output json 2>/dev/null \
  | jq -r '[.SecurityGroups[0].IpPermissions[]? | select(.FromPort==443 and .ToPort==443 and .IpProtocol=="tcp")] | length > 0')
if [ "${HAS_443_BEFORE}" = "true" ]; then
  echo "FAIL: SecurityGroup already has a tcp/443 ingress rule before the update — baseline wrong" >&2
  exit 1
fi
echo "    OK (baseline): SecurityGroup has no tcp/443 ingress rule"

# Baseline: the replacement bucket exists with the v1 name.
if ! aws s3api head-bucket --bucket "${REPLACE_BUCKET_BEFORE}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ReplaceBucket '${REPLACE_BUCKET_BEFORE}' does not exist on AWS after deploy" >&2
  exit 1
fi
case "${REPLACE_BUCKET_BEFORE}" in
  *-v1) ;;
  *) echo "FAIL: ReplaceBucket name '${REPLACE_BUCKET_BEFORE}' does not end with the expected '-v1' suffix" >&2; exit 1 ;;
esac
echo "    OK (baseline): ReplaceBucket '${REPLACE_BUCKET_BEFORE}' exists (v1)"

# --- Phase 1b: redeploy with CDKD_TEST_UPDATE=true --------------------
echo "==> Phase 1b: redeploy with CDKD_TEST_UPDATE=true"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE_AFTER=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE_AFTER}" ]; then
  echo "FAIL: no state file after the update deploy" >&2
  exit 1
fi

IN_PLACE_BUCKET_AFTER=$(echo "${STATE_AFTER}" | jq -r '.outputs.InPlaceBucketName // empty')
REPLACE_BUCKET_AFTER=$(echo "${STATE_AFTER}" | jq -r '.outputs.ReplaceBucketName // empty')
FUNCTION_NAME_AFTER=$(echo "${STATE_AFTER}" | jq -r '.outputs.FunctionName // empty')
ROLE_NAME_AFTER=$(echo "${STATE_AFTER}" | jq -r '.outputs.RoleName // empty')
SG_ID_AFTER=$(echo "${STATE_AFTER}" | jq -r '.outputs.SecurityGroupId // empty')

# --- In-place assertion: S3 bucket physical id unchanged, versioning ON
if [ "${IN_PLACE_BUCKET_AFTER}" != "${IN_PLACE_BUCKET}" ]; then
  echo "FAIL: InPlaceBucket physical id changed ('${IN_PLACE_BUCKET}' -> '${IN_PLACE_BUCKET_AFTER}') — expected an in-place update" >&2
  exit 1
fi
VERS_AFTER=$(aws s3api get-bucket-versioning --bucket "${IN_PLACE_BUCKET}" --region "${REGION}" \
  --output json 2>/dev/null | jq -r 'if has("Status") then .Status else "none" end')
if [ "${VERS_AFTER}" != "Enabled" ]; then
  echo "FAIL: InPlaceBucket versioning is '${VERS_AFTER}' after update, expected 'Enabled' (in-place update did NOT reach AWS)" >&2
  exit 1
fi
echo "    OK (in-place): InPlaceBucket id unchanged + versioning Enabled on AWS"

# --- In-place assertion: Lambda physical id unchanged, env + memory new
if [ "${FUNCTION_NAME_AFTER}" != "${FUNCTION_NAME}" ]; then
  echo "FAIL: FunctionName changed ('${FUNCTION_NAME}' -> '${FUNCTION_NAME_AFTER}')" >&2
  exit 1
fi
FN_CFG_AFTER=$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" --output json 2>/dev/null)
MEM_AFTER=$(echo "${FN_CFG_AFTER}" | jq -r '.MemorySize')
STAGE_AFTER=$(echo "${FN_CFG_AFTER}" | jq -r '.Environment.Variables.STAGE // "none"')
if [ "${MEM_AFTER}" != "256" ] || [ "${STAGE_AFTER}" != "prod" ]; then
  echo "FAIL: Lambda update did NOT reach AWS — MemorySize='${MEM_AFTER}' (want 256), STAGE='${STAGE_AFTER}' (want prod)" >&2
  exit 1
fi
echo "    OK (in-place): Lambda id unchanged + MemorySize=256 STAGE=prod on AWS"

# --- In-place assertion: IAM role id unchanged, inline policy gained PutObject
if [ "${ROLE_NAME_AFTER}" != "${ROLE_NAME}" ]; then
  echo "FAIL: RoleName changed ('${ROLE_NAME}' -> '${ROLE_NAME_AFTER}')" >&2
  exit 1
fi
POLICY_NAME_AFTER=$(aws iam list-role-policies --role-name "${ROLE_NAME}" --output json 2>/dev/null | jq -r '.PolicyNames[0] // "none"')
HAS_PUT_AFTER=$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name "${POLICY_NAME_AFTER}" --region "${REGION}" \
  --output json 2>/dev/null \
  | jq -r '[.PolicyDocument.Statement[]?.Action] | flatten | index("s3:PutObject") != null')
if [ "${HAS_PUT_AFTER}" != "true" ]; then
  echo "FAIL: inline policy does NOT grant s3:PutObject after update (in-place policy edit did NOT reach AWS)" >&2
  aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name "${POLICY_NAME_AFTER}" --region "${REGION}" | jq '.PolicyDocument'
  exit 1
fi
echo "    OK (in-place): WorkerRole id unchanged + inline policy now grants s3:PutObject"

# --- In-place assertion: SG id unchanged, tcp/443 ingress added
if [ "${SG_ID_AFTER}" != "${SG_ID}" ]; then
  echo "FAIL: SecurityGroupId changed ('${SG_ID}' -> '${SG_ID_AFTER}')" >&2
  exit 1
fi
HAS_443_AFTER=$(aws ec2 describe-security-groups --group-ids "${SG_ID}" --region "${REGION}" --output json 2>/dev/null \
  | jq -r '[.SecurityGroups[0].IpPermissions[]? | select(.FromPort==443 and .ToPort==443 and .IpProtocol=="tcp")] | length > 0')
if [ "${HAS_443_AFTER}" != "true" ]; then
  echo "FAIL: SecurityGroup has no tcp/443 ingress rule after update (in-place ingress add did NOT reach AWS)" >&2
  aws ec2 describe-security-groups --group-ids "${SG_ID}" --region "${REGION}" | jq '.SecurityGroups[0].IpPermissions'
  exit 1
fi
echo "    OK (in-place): WorkerSg id unchanged + tcp/443 ingress rule present on AWS"

# --- Replacement assertion: ReplaceBucket physical id CHANGED ---------
if [ -z "${REPLACE_BUCKET_AFTER}" ]; then
  echo "FAIL: ReplaceBucketName missing from state after update" >&2
  exit 1
fi
if [ "${REPLACE_BUCKET_AFTER}" = "${REPLACE_BUCKET_BEFORE}" ]; then
  echo "FAIL: ReplaceBucket physical id is still '${REPLACE_BUCKET_BEFORE}' after a BucketName change — expected a REPLACEMENT (new physical id)" >&2
  exit 1
fi
case "${REPLACE_BUCKET_AFTER}" in
  *-v2) ;;
  *) echo "FAIL: new ReplaceBucket name '${REPLACE_BUCKET_AFTER}' does not end with the expected '-v2' suffix" >&2; exit 1 ;;
esac
# New bucket must exist...
if ! aws s3api head-bucket --bucket "${REPLACE_BUCKET_AFTER}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: new ReplaceBucket '${REPLACE_BUCKET_AFTER}' does not exist on AWS after replacement" >&2
  exit 1
fi
# ...and the old bucket must be GONE (replacement deletes the original).
if aws s3api head-bucket --bucket "${REPLACE_BUCKET_BEFORE}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: old ReplaceBucket '${REPLACE_BUCKET_BEFORE}' still exists after replacement — old physical resource was not cleaned up" >&2
  exit 1
fi
echo "    OK (replacement): ReplaceBucket id CHANGED ${REPLACE_BUCKET_BEFORE} -> ${REPLACE_BUCKET_AFTER}, old gone, new present"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# Both buckets must be gone after destroy.
for b in "${IN_PLACE_BUCKET}" "${REPLACE_BUCKET_AFTER}"; do
  if aws s3api head-bucket --bucket "${b}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: bucket '${b}' still exists after destroy (orphan)" >&2
    exit 1
  fi
done
echo "    OK: both S3 buckets are gone after destroy"

# The named NON-bucket resources must also be NOT-FOUND in AWS after destroy.
# Checking only state.json + the buckets would miss an orphaned Lambda / IAM
# role / SecurityGroup that carries no stack name (the "state-empty misses a
# no-stack-name orphan" class). We use the physical ids captured from state in
# Phase 1 (they are stable across the in-place update — id unchanged asserts
# above prove it). Each AWS call exits non-zero once the resource is deleted.
if aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Lambda '${FUNCTION_NAME}' still exists after destroy (orphan)" >&2
  exit 1
fi
echo "    OK: Lambda '${FUNCTION_NAME}' is gone"

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "FAIL: IAM role '${ROLE_NAME}' still exists after destroy (orphan)" >&2
  exit 1
fi
echo "    OK: IAM role '${ROLE_NAME}' is gone"

# describe-security-groups exits non-zero (InvalidGroup.NotFound) once the SG
# is deleted. The SG lives in the account's default VPC, so a lingering SG is
# a true orphan that no VPC-gone check would surface here.
if aws ec2 describe-security-groups --group-ids "${SG_ID}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SecurityGroup '${SG_ID}' still exists after destroy (orphan)" >&2
  exit 1
fi
echo "    OK: SecurityGroup '${SG_ID}' is gone"
echo "    OK: named Lambda / IAM role / SecurityGroup are all gone after destroy"

echo ""
echo "==> update-replace test passed (in-place S3/Lambda/IAM/SG update + S3 BucketName replacement + clean destroy)"
echo "[verify] PASS"

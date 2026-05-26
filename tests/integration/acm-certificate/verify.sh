#!/usr/bin/env bash
# Integration test for ACMCertificateProvider.
#
# Uses a synthetic `example.test` (RFC 2606 reserved testing TLD) domain that
# is NOT a real DNS zone, so the cert never reaches `ISSUED`. To skip the
# default poll-until-ISSUED loop we run with `CDKD_NO_WAIT=true`. cdkd's
# create returns immediately with the ARN at PENDING_VALIDATION + logs a
# warning. Destroy then deletes the still-PENDING_VALIDATION cert.
#
# What this exercises:
#   - RequestCertificate (real AWS) returns ARN.
#   - cdkd state records the cert with the ARN as physicalId.
#   - DeleteCertificate succeeds against a PENDING_VALIDATION cert.
#   - The --no-wait code path returns immediately + warns the user.
#
# What this does NOT exercise:
#   - The poll-until-ISSUED happy path (needs a real DNS zone the test
#     account controls). Ship a follow-up integ once that lands.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="${CDKD:-node ../../../dist/cli.js}"
REGION="${AWS_REGION:-us-east-1}"
BUCKET="${STATE_BUCKET:?STATE_BUCKET is required}"
STACK="CdkdAcmCertificateExample"

echo "=== ACM Certificate integ (CDKD_NO_WAIT=true, synthetic domain) ==="
echo "Stack: ${STACK}"
echo "Region: ${REGION}"
echo "State bucket: ${BUCKET}"

cleanup() {
  echo "=== Destroying stack ${STACK} ==="
  $CDKD destroy --region "${REGION}" --state-bucket "${BUCKET}" --force || true
}
trap cleanup EXIT

echo "=== Deploying stack ${STACK} (no-wait) ==="
CDKD_NO_WAIT=true $CDKD deploy --region "${REGION}" --state-bucket "${BUCKET}"

# Verify the state file recorded an ACM ARN.
state_file=$(aws s3 cp "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" - --region "${REGION}")
arn=$(echo "${state_file}" | python3 -c '
import json, sys
s = json.load(sys.stdin)
for k, v in s["resources"].items():
    if v["resourceType"] == "AWS::CertificateManager::Certificate":
        print(v["physicalId"])
        break
')
if [[ -z "${arn}" ]]; then
  echo "FAIL: state has no AWS::CertificateManager::Certificate entry"
  exit 1
fi
if [[ "${arn}" != arn:aws:acm:* ]]; then
  echo "FAIL: physicalId is not an ACM ARN: ${arn}"
  exit 1
fi
echo "PASS: state records ACM cert ARN ${arn}"

# Verify the cert exists in ACM with PENDING_VALIDATION status.
status=$(aws acm describe-certificate --certificate-arn "${arn}" --region "${REGION}" --query 'Certificate.Status' --output text)
if [[ "${status}" != "PENDING_VALIDATION" ]]; then
  echo "FAIL: expected PENDING_VALIDATION (synthetic domain never issues), got ${status}"
  exit 1
fi
echo "PASS: ACM cert is in PENDING_VALIDATION as expected"

# trap will run destroy

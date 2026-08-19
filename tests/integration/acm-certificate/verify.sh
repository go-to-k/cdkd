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
#   - The ACM-SPECIFIC in-use rejection (issue #1922): a certificate is only
#     attachable to a CloudFront distribution / ALB once ISSUED, which needs
#     that same DNS zone. Phase 2 below therefore drives the SAME code path
#     through a different delete failure -- see its own note.

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

# Set once phase 1 knows the real ARN. Phase 2 rewrites state's physicalId away
# from it ON PURPOSE, which is precisely what makes cdkd stop tracking it -- so
# `cdkd destroy` cannot reach it and the fixture has to retire it by hand. This
# is the orphan class the feature under test exists to REPORT; leaving one
# behind here would be the fixture committing the bug it verifies.
ORIGINAL_ARN=""

cleanup() {
  # Seed from the incoming status and restore it on the way out: the destroy
  # below ends in `|| true`, and without this an `exit 1` from a failed
  # assertion left the run reporting SUCCESS -- observed on this fixture's
  # first partial-outcome run.
  local rc=$?
  echo "=== Destroying stack ${STACK} ==="
  $CDKD destroy --region "${REGION}" --state-bucket "${BUCKET}" --force || true
  if [[ -n "${ORIGINAL_ARN}" ]]; then
    echo "=== Retiring the deliberately-stranded original certificate ==="
    aws acm delete-certificate --certificate-arn "${ORIGINAL_ARN}" --region "${REGION}" \
      >/dev/null 2>&1 || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

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
# Hand the cleanup trap the ARN phase 2 is about to strand.
ORIGINAL_ARN="${arn}"

# Verify the cert exists in ACM. The synthetic `example.test` domain cannot
# be DNS-validated, so AWS's terminal state for it is either PENDING_VALIDATION
# (initial state, awaiting DNS records that will never appear) or FAILED
# (AWS fast-fails invalid-TLD validations after a brief window — observed
# behavior may vary by region/time). Either is acceptable for this integ —
# what matters is that cdkd's create() returned without waiting (the
# --no-wait path) and DeleteCertificate succeeds against the non-ISSUED
# cert in either status.
status=$(aws acm describe-certificate --certificate-arn "${arn}" --region "${REGION}" --query 'Certificate.Status' --output text)
case "${status}" in
  PENDING_VALIDATION|FAILED)
    echo "PASS: ACM cert is in ${status} (expected for synthetic domain under --no-wait)"
    ;;
  *)
    echo "FAIL: expected PENDING_VALIDATION or FAILED, got ${status}"
    exit 1
    ;;
esac

# --- Phase 2: a replacement whose inner delete FAILS (issues #1819 / #1922) --
#
# The partial-update outcome fires when a replacement's inner delete does not
# retire the old resource. #1922's own scenario -- an old certificate still
# referenced by a CloudFront distribution -- is NOT reachable here: a cert must
# be ISSUED to be attached, and this account has no DNS zone to validate one
# (the same limitation the header records for the poll-until-ISSUED path).
#
# So the failure is induced at the same place by a different cause: state's
# physicalId is rewritten to a MALFORMED ARN. AWS answers DeleteCertificate
# with an InvalidArnException rather than ResourceNotFoundException -- which
# matters, because the provider swallows not-found as an idempotent success and
# would report a CLEAN update instead (measured: a `certificate/<not-a-uuid>`
# suffix is merely NOT FOUND; it takes extra path segments to be INVALID). Everything downstream of the throw is
# the code under test and is identical for both causes: the catch, the
# `'partial'` outcome, the engine's counter, status line, summary row and
# survivor event. Only the in-use CLASSIFIER's wording differs, and that is
# unit-tested on both polarities.
#
# A malformed ARN also means the "orphan" never existed, so this arm proves the
# reporting without leaking a real certificate.
echo "=== Phase 2: replacement whose inner delete fails -> partial outcome ==="
account=$(aws sts get-caller-identity --query Account --output text)
# The suffix must contain SLASHES. A plausible-but-absent id
# (`certificate/<not-a-uuid>`) answers ResourceNotFoundException, which the
# provider swallows as an idempotent success -- the first version of this arm
# used exactly that and reported a CLEAN update, passing nothing. Extra path
# segments make AWS answer InvalidArnException instead, which throws.
malformed="arn:aws:acm:${REGION}:${account}:certificate/cdkd-integ/not/a/valid"

echo "${state_file}" | python3 -c "
import json, sys
s = json.load(sys.stdin)
for v in s['resources'].values():
    if v['resourceType'] == 'AWS::CertificateManager::Certificate':
        v['physicalId'] = sys.argv[1]
print(json.dumps(s))
" "${malformed}" > /tmp/cdkd-acm-state.json
aws s3 cp /tmp/cdkd-acm-state.json "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" --region "${REGION}" >/dev/null
echo "  state physicalId rewritten to ${malformed}"

# ValidationMethod is immutable to the PROVIDER but not createOnly in the CFn
# registry, so the engine hands this change to `update()` and the provider does
# its own create-then-delete -- the path under test.
set +e
deploy_out=$(CDKD_NO_WAIT=true CDKD_TEST_UPDATE=validation $CDKD deploy \
  --region "${REGION}" --state-bucket "${BUCKET}" 2>&1)
deploy_rc=$?
set -e
echo "${deploy_out}"

# Assert against a COLOR-STRIPPED copy. cdkd colorizes the summary numbers, so
# `of which left an orphaned predecessor: 1` is really `...: <ESC>[33m1<ESC>[0m`
# on the wire and a literal grep for the row silently never matches -- which is
# exactly how this arm reported a missing row that was printed correctly.
deploy_txt=$(printf '%s' "${deploy_out}" | sed $'s/\033\[[0-9;]*m//g')

if [[ "${deploy_rc}" -ne 0 ]]; then
  echo "FAIL: the replacement deploy exited ${deploy_rc}; a partial update must not fail the run"
  exit 1
fi
echo "PASS: deploy still succeeded (the resource WAS updated)"

# The status line names the cause instead of printing a bare `updated`.
if ! echo "${deploy_txt}" | grep -q "partial ("; then
  echo "FAIL: no 'partial (<reason>)' status line -- the survivor was reported as a clean update"
  exit 1
fi
echo "PASS: status line reports the partial outcome"

# The summary counts it apart from a clean update.
if ! echo "${deploy_txt}" | grep -q "of which left an orphaned predecessor: 1"; then
  echo "FAIL: summary has no orphaned-predecessor row"
  echo "${deploy_txt}" | grep -iE "updated|skipped" || true
  exit 1
fi
echo "PASS: summary counts the orphaned predecessor"

# The reason names the OLD physical id -- state now points at the NEW cert, so
# this event is the only place the survivor's identity still exists.
if ! echo "${deploy_txt}" | grep -q "${malformed}"; then
  echo "FAIL: the reported reason does not name the surviving physical id"
  exit 1
fi
echo "PASS: the reason names the surviving physical id"

# The durable post-mortem: RESOURCE_SKIPPED for the survivor, alongside the
# RESOURCE_SUCCEEDED the updated row still gets.
# `cdkd events <stack>` lists RUNS; the per-resource events need `--run <id>`.
# Grepping the run LIST for RESOURCE_SKIPPED matches nothing however correct the
# emission is -- which is how this arm first reported a missing event that had
# in fact been recorded. Take the newest deploy run (this query happens before
# the destroy, so that is phase 2's).
runs_out=$($CDKD events "${STACK}" --region "${REGION}" --state-bucket "${BUCKET}" 2>&1 \
  | sed $'s/\033\[[0-9;]*m//g' || true)
run_id=$(echo "${runs_out}" | awk '$2 == "deploy" { print $1; exit }')
if [[ -z "${run_id}" ]]; then
  echo "FAIL: no deploy run recorded in the events store"
  echo "${runs_out}" | tail -20
  exit 1
fi
events_out=$($CDKD events "${STACK}" --run "${run_id}" --region "${REGION}" \
  --state-bucket "${BUCKET}" 2>&1 | sed $'s/\033\[[0-9;]*m//g' || true)

if ! echo "${events_out}" | grep -q "RESOURCE_SKIPPED"; then
  echo "FAIL: no RESOURCE_SKIPPED event recorded for the survivor"
  echo "${events_out}" | tail -20
  exit 1
fi
# The updated row must ALSO be recorded as done -- the pair is the whole point.
# A lone skip would mean the events store claims the resource was not addressed.
if ! echo "${events_out}" | grep -q "RESOURCE_SUCCEEDED"; then
  echo "FAIL: no RESOURCE_SUCCEEDED event -- the updated row must still count as done"
  echo "${events_out}" | tail -20
  exit 1
fi
# The durable record must name the survivor: state points at the NEW cert, so
# this is the only place its identity still exists.
if ! echo "${events_out}" | grep -q "${malformed}"; then
  echo "FAIL: the RESOURCE_SKIPPED event does not name the surviving physical id"
  exit 1
fi
# The run-level counter cdkd events renders as the warn badge.
if ! echo "${events_out}" | grep -q "RUN_FINISHED.*⚠1"; then
  echo "FAIL: RUN_FINISHED does not carry the run-level skipped count"
  echo "${events_out}" | grep RUN_FINISHED || true
  exit 1
fi
echo "PASS: events store carries the success, the survivor skip, and the run count"

# State must now point at the NEW certificate, so the destroy below is clean.
new_state=$(aws s3 cp "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" - --region "${REGION}")
new_arn=$(echo "${new_state}" | python3 -c '
import json, sys
s = json.load(sys.stdin)
for v in s["resources"].values():
    if v["resourceType"] == "AWS::CertificateManager::Certificate":
        print(v["physicalId"])
        break
')
if [[ "${new_arn}" == "${malformed}" || "${new_arn}" != arn:aws:acm:* ]]; then
  echo "FAIL: state still holds ${new_arn}; the replacement did not re-point it"
  exit 1
fi
echo "PASS: state re-pointed to the replacement cert ${new_arn}"

# trap will run destroy

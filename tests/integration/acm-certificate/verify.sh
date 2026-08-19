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
# Phase 3 repeats the trick, so the certificate phase 2's replacement created is
# stranded in turn. Tracked separately and retired the same way -- a fixture
# that verifies orphan REPORTING must not itself leave orphans behind.
STRANDED_ARN=""

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
  if [[ -n "${STRANDED_ARN}" ]]; then
    echo "=== Retiring the certificate phase 3 stranded ==="
    aws acm delete-certificate --certificate-arn "${STRANDED_ARN}" --region "${REGION}" \
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

# Issue #1960 REVERSED this assertion. It used to require rc 0 on the grounds
# that a partial update must not fail the run -- but the run left an AWS
# resource cdkd owned alive and untracked, and reporting success for that is
# precisely the mis-report #1960 was filed for. `cdkd destroy` has exited 2 for
# the identical outcome since #1752; deploy now matches. The resource still
# WAS updated (the RESOURCE_SUCCEEDED assertion below is unchanged) -- what
# changed is the run-level verdict, not the row's.
if [[ "${deploy_rc}" -ne 2 ]]; then
  echo "FAIL: the replacement deploy exited ${deploy_rc}; a run that left an orphaned"
  echo "      predecessor must exit 2 (issue #1960)"
  exit 1
fi
echo "PASS: deploy exited 2 for the orphaned predecessor (issue #1960)"

# The banner must not claim success either -- the exit code was only half the
# mis-report. A run still printing "Deployment completed successfully" while a
# resource survived would leave the human-readable half wrong.
if echo "${deploy_txt}" | grep -q "Deployment completed successfully"; then
  echo "FAIL: the run still claims it completed successfully (issue #1960)"
  exit 1
fi
if ! echo "${deploy_txt}" | grep -q "were left unaddressed"; then
  echo "FAIL: no unaddressed-resource verdict line in the summary (issue #1960)"
  exit 1
fi
echo "PASS: the verdict line names the survivor instead of claiming success"

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

# --- Phase 3: --allow-unaddressed forces exit 0 for the SAME outcome (#1960) --
#
# The opposite polarity of phase 2's assertion. Without an arm that actually
# reaches exit 0 through the flag, a bug that ignored the flag entirely -- or
# one that never raised the error in the first place -- would look identical to
# a pass here: phase 2 alone cannot tell "exit 2 because the flag was honored"
# from "exit 2 because the flag is unread".
#
# Induced the same way, with the ValidationMethod toggle running in REVERSE:
# phase 2 deployed with CDKD_TEST_UPDATE=validation (DNS -> EMAIL), so omitting
# it here flips EMAIL -> DNS, which is another change reaching `update()` and
# therefore another provider-side replacement.
echo "=== Phase 3: --allow-unaddressed forces exit 0 (issue #1960) ==="
STRANDED_ARN="${new_arn}"

echo "${new_state}" | python3 -c "
import json, sys
s = json.load(sys.stdin)
for v in s['resources'].values():
    if v['resourceType'] == 'AWS::CertificateManager::Certificate':
        v['physicalId'] = sys.argv[1]
print(json.dumps(s))
" "${malformed}" > /tmp/cdkd-acm-state-3.json
aws s3 cp /tmp/cdkd-acm-state-3.json "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" \
  --region "${REGION}" >/dev/null
echo "  state physicalId rewritten to ${malformed} again"

set +e
allow_out=$(CDKD_NO_WAIT=true $CDKD deploy \
  --region "${REGION}" --state-bucket "${BUCKET}" --allow-unaddressed 2>&1)
allow_rc=$?
set -e
echo "${allow_out}"
allow_txt=$(printf '%s' "${allow_out}" | sed $'s/\033\[[0-9;]*m//g')

# The arm is only meaningful if this deploy actually reproduced the partial
# outcome. Checked FIRST: a run that quietly made no change would exit 0 too,
# and would then "pass" the flag assertion below while proving nothing.
if ! echo "${allow_txt}" | grep -q "of which left an orphaned predecessor: 1"; then
  echo "FAIL: phase 3 did not reproduce the partial update, so the flag is untested"
  echo "${allow_txt}" | grep -iE "updated|skipped|unaddressed" || true
  exit 1
fi
echo "PASS: phase 3 reproduced the orphaned predecessor"

if [[ "${allow_rc}" -ne 0 ]]; then
  echo "FAIL: --allow-unaddressed must force exit 0; got ${allow_rc} (issue #1960)"
  exit 1
fi
echo "PASS: --allow-unaddressed exited 0 for an outcome that otherwise exits 2"

# The flag suppresses the EXIT CODE only. If it also silenced the warning the
# operator would have no signal at all, which is the failure mode the flag must
# not create.
if ! echo "${allow_txt}" | grep -q "were left unaddressed"; then
  echo "FAIL: --allow-unaddressed silenced the survivor warning as well as the exit code"
  exit 1
fi
if ! echo "${allow_txt}" | grep -q "allow-unaddressed was passed"; then
  echo "FAIL: the verdict line does not say the exit code was suppressed by the flag"
  exit 1
fi
echo "PASS: the survivor warning is still printed under --allow-unaddressed"

# trap will run destroy

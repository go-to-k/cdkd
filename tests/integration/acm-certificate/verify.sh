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
#   - Phase 0 (issue #2169): a create whose ISSUED wait fails DELETES the
#     certificate it requested. The same synthetic domain that never validates
#     is what makes this arm cheap -- the poll cap is squeezed to 3 x 5s via
#     CDKD_ACM_POLL_ATTEMPTS / CDKD_ACM_POLL_INTERVAL_MS, so the timeout the
#     reporter waited 10 minutes for happens in seconds. It asserts the account
#     holds ZERO certificates for this fixture afterwards, and still zero after
#     a second failing deploy -- the accumulation the issue reports.
#   - Phase 4 (issue #4275): a certificate whose DomainName comes from a
#     Secrets Manager secret keeps its ARN across a Tags-only update instead
#     of being replaced.
#   - Phase 5 (issue #6799): an Amazon N2 certificate (RootHierarchyType +
#     CertificateUsage) is created on the SDK route and ACM holds both values.
#
# What this does NOT exercise:
#   - The poll-until-ISSUED happy path (needs a real DNS zone the test
#     account controls). Ship a follow-up integ once that lands.
#   - Phase 0's poll-cap-exhaustion throw specifically. Measured 2026-08-23:
#     AWS moves an `example.test` certificate to FAILED within the first poll,
#     so the wait usually ends on the TERMINAL-status throw rather than on cap
#     exhaustion. Both throws run the same cleanup, and phase 0 asserts on the
#     account state rather than on which message appeared, so the arm is
#     correct either way -- but it does not discriminate the two throws.
#   - The ACM-SPECIFIC in-use rejection (issue #1922): a certificate is only
#     attachable to a CloudFront distribution / ALB once ISSUED, which needs
#     that same DNS zone.
#   - The provider's own create-then-delete replacement inside `update()`
#     (#1819 / #1960's partial outcome). Since go-to-k/cdkd#6513 no template
#     edit reaches it: a ValidationMethod change, the last one that did, is a
#     replacement the engine makes. Its unit tests stay; phase 2 below covers
#     the engine replacement instead.

set -euo pipefail

cd "$(dirname "$0")"
# Phase 4 resolves a Secrets Manager reference, so the stack's state versions
# are swept and asserted on the success path (issue #2096).
# shellcheck source=../s3-versions.sh
. ../s3-versions.sh

CDKD="${CDKD:-node ../../../dist/cli.js}"
REGION="${AWS_REGION:-us-east-1}"
BUCKET="${STATE_BUCKET:?STATE_BUCKET is required}"
STACK="CdkdAcmCertificateExample"
PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
# Set once the success path has destroyed the stack itself.
DESTROYED=0

echo "=== ACM Certificate integ (CDKD_NO_WAIT=true, synthetic domain) ==="
echo "Stack: ${STACK}"
echo "Region: ${REGION}"
echo "State bucket: ${BUCKET}"

# Set once phase 1 knows the real ARN. Phase 2's replacement deletes it; the
# trap retires it by hand only if the run stops before that delete.
ORIGINAL_ARN=""
# Phase 4's Secrets Manager secret (go-to-k/cdkd#4275). A unique name per run,
# deleted by the trap once the stack is gone.
SECRET_NAME="cdkd-integ-acm-domain-$(date +%s)-$$"
SEEDED_SECRET=0

acm_arns_for_fixture() {
  local stack_lc query
  stack_lc=$(printf '%s' "${STACK}" | tr '[:upper:]' '[:lower:]')
  query="CertificateSummaryList[?contains(DomainName, 'cdkd-integ-${stack_lc}')].CertificateArn"
  aws acm list-certificates --region "${REGION}" --query "${query}" --output text || return
  # ListCertificates omits Amazon N2 certificates unless asked for them by
  # root hierarchy (phase 5's, go-to-k/cdkd#6799), so they take a second call.
  aws acm list-certificates --region "${REGION}" \
    --root-hierarchy-types N2_AMAZON_MANAGED N2_SFG2_AMAZON_MANAGED \
    --query "${query}" --output text
}

cleanup() {
  # Seed from the incoming status and restore it on the way out: the destroy
  # below ends in `|| true`, and without this an `exit 1` from a failed
  # assertion left the run reporting SUCCESS -- observed on this fixture's
  # first partial-outcome run.
  local rc=$?
  # The success path destroys (and sweeps state versions) itself; a second
  # destroy here would write fresh objects under the prefix it just certified.
  if [[ "${DESTROYED}" != "1" ]]; then
    echo "=== Destroying stack ${STACK} ==="
    $CDKD destroy --region "${REGION}" --state-bucket "${BUCKET}" --force || true
    # Safe on a failed run: the CURRENT state.json a later `cdkd state destroy`
    # may need survives; older versions (resolved by phase 4's secret
    # reference) go.
    s3_purge_prefix_versions "${BUCKET}" "${PREFIX}" noncurrent || true
  fi
  if [[ -n "${ORIGINAL_ARN}" ]]; then
    echo "=== Retiring the original certificate, if phase 2 did not ==="
    aws acm delete-certificate --certificate-arn "${ORIGINAL_ARN}" --region "${REGION}" \
      >/dev/null 2>&1 || true
  fi
  # After the destroy: the stack no longer needs to resolve it. Its failure is
  # printed, not swallowed, so a surviving secret is visible.
  if [[ "${SEEDED_SECRET}" = "1" ]]; then
    echo "=== Deleting the phase 4 secret ${SECRET_NAME} ==="
    local secret_out
    if ! secret_out=$(aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
      --force-delete-without-recovery --region "${REGION}" 2>&1); then
      echo "WARNING: could not delete the phase 4 secret: ${secret_out}"
      echo "Delete it with: aws secretsmanager delete-secret --secret-id ${SECRET_NAME} --force-delete-without-recovery --region ${REGION}"
    else
      # INT/TERM run cleanup and then EXIT runs it again: no second attempt.
      SEEDED_SECRET=0
    fi
  fi
  # Both hand-retirements above are best-effort (`|| true`), which is right --
  # a cleanup failure must not mask the assertion result -- but silent. Sweep
  # for survivors so a failed retirement is VISIBLE rather than discovered
  # later on the bill. Reported, not fatal: the run's own verdict is already
  # decided by `rc`.
  #
  # TRI-STATE, not two: `|| true` here would let a throttle / AccessDenied
  # answer read as "no certificates found" and print the clean line over a real
  # leak -- the sweep would then be worse than none, because it asserts absence
  # it never established. Consume the probe status explicitly and report
  # "could not determine" as its own outcome.
  #
  # POLLED, not a single probe. `DeleteCertificate` returns before
  # `ListCertificates` stops listing the certificate, so a one-shot check
  # immediately after the retirements above reports a survivor that is already
  # being deleted -- measured on this fixture: a retired certificate was
  # still listed at cleanup time and gone moments later. A warning that fires
  # on every clean run is worse than no warning, because the next reader learns
  # to ignore it.
  # `tr`, not `${STACK,,}`: the lowercase expansion needs bash >= 4. Under the
  # macOS system bash (3.2, still the default `/bin/bash`) it fails at RUNTIME
  # with `bad substitution` -- `bash -n` accepts it, so the problem is invisible
  # to a syntax check. It sits inside the EXIT trap, after the two hand
  # retirements, so it would abort the trap's tail and leave the script exiting
  # on the substitution error instead of the run's real status: a passing integ
  # reported as failed, or a failing one losing its reason. This is the only
  # such expansion in the repo's integ scripts, so nothing else establishes a
  # bash-4 floor for them.
  local leftover sweep_rc attempt
  for attempt in 1 2 3 4 5; do
    # Same query the phase assertions use -- one definition, so a change to
    # what "this fixture's certificates" means cannot drift between the arm
    # that asserts and the sweep that reports leaks.
    leftover=$(acm_arns_for_fixture 2>&1) && sweep_rc=0 || sweep_rc=$?
    # Stop early on a probe ERROR too: retrying an AccessDenied five times just
    # delays the same verdict, and the tri-state branch below reports it.
    [[ "${sweep_rc}" -ne 0 || -z "${leftover}" ]] && break
    [[ "${attempt}" -lt 5 ]] && sleep 6
  done
  if [[ "${sweep_rc}" -ne 0 ]]; then
    echo "WARNING: the ACM leak sweep could not run (aws exited ${sweep_rc}); a surviving"
    echo "         certificate would be INVISIBLE. Check by hand:"
    echo "         aws acm list-certificates --region ${REGION}"
    echo "${leftover}"
  elif [[ -n "${leftover}" ]]; then
    echo "WARNING: ACM certificates for this fixture survived cleanup (still listed after ~30s):"
    echo "${leftover}"
    echo "Retire them with: aws acm delete-certificate --certificate-arn <arn> --region ${REGION}"
  else
    echo "=== ACM sweep clean: no fixture certificates remain ==="
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# --- Phase 0: a failed create leaves no certificate behind (#2169) -----------
#
# Before this, `RequestCertificate` returned an ARN, the poll-until-ISSUED wait
# ran out, and the throw carried the ARN only inside its message text -- so the
# certificate stayed in AWS with nothing naming it, and every re-run requested
# another one. The reporter hit exactly this while migrating a real environment
# and had to find the certificate by hand and `cdkd import` it.
#
# Reproduced honestly rather than simulated: this is a real `RequestCertificate`
# against real ACM, and the wait genuinely fails, because `example.test` can
# never be DNS-validated. Only the CAP is shrunk (3 polls x 5s instead of
# 60 x 10s), which is the same code path on a shorter clock.
#
# The load-bearing assertion is the certificate COUNT in the account, taken
# twice. Pre-fix it is 1 then 2 -- one orphan per attempt, which is the issue's
# actual complaint. Post-fix it is 0 then 0. Counting the ACCOUNT rather than
# reading state is deliberate: state is exactly what the pre-fix code failed to
# write, so a state-based assertion cannot see the orphan at all.
echo "=== Phase 0: a failed create leaves no certificate behind (issue #2169) ==="

# Prints the count on stdout and returns the PROBE's status. A failed
# `ListCertificates` prints nothing, and `[[ "" -ne 0 ]]` is false -- so without
# propagating the status, a throttle or an AccessDenied reads as "0
# certificates" and this arm prints PASS over an orphan it never looked for.
# That matters more here than anywhere else in the file: this count IS the
# real-AWS evidence for a newly-added destructive call. `cleanup`'s sweep
# already does this correctly; phase 0 now matches it.
fixture_cert_count() {
  local all rc
  all=$(acm_arns_for_fixture 2>&1) && rc=0 || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    echo "ACM probe FAILED (aws exited ${rc}): ${all}" >&2
    return "${rc}"
  fi
  # `|| true` would swallow rc>=2 (a real grep failure) as well as rc 1 (zero
  # matches, which is the answer we want), and an empty stdout then reads as
  # "0 certificates" -- a PASS over a probe that never ran.
  printf '%s' "${all}" | tr '\t' '\n' | grep -c 'arn:aws:acm:' || [[ $? -eq 1 ]]
}

# Retire every fixture certificate still standing. Used by the FAIL branches so
# a failing assertion never also leaks -- `head -1` was wrong there, since the
# pre-fix behaviour this arm detects leaves TWO.
retire_all_fixture_certs() {
  local arn listing
  if ! listing=$(acm_arns_for_fixture 2>&1); then
    echo "  WARNING: could not list certificates to retire them (${listing});"
    echo "           check by hand: aws acm list-certificates --region ${REGION}"
    return
  fi
  for arn in $(printf '%s' "${listing}" | tr '\t' '\n'); do
    [[ "${arn}" == arn:aws:acm:* ]] || continue
    echo "  retiring leaked certificate ${arn}"
    aws acm delete-certificate --certificate-arn "${arn}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

# Nothing of ours may exist yet, or the counts below prove nothing.
if ! phase0_before=$(fixture_cert_count); then
  echo "FAIL: could not establish the pre-phase-0 certificate count; refusing to assert on it"
  exit 1
fi
if [[ "${phase0_before}" -ne 0 ]]; then
  echo "FAIL: ${phase0_before} certificate(s) for this fixture existed BEFORE phase 0:"
  acm_arns_for_fixture
  exit 1
fi

# The deploy MUST fail: an un-issued certificate is a real failure, and a run
# that exits 0 here would mean the wait was skipped rather than exercised.
set +e
CDKD_ACM_POLL_ATTEMPTS=3 CDKD_ACM_POLL_INTERVAL_MS=5000 \
  $CDKD deploy --region "${REGION}" --state-bucket "${BUCKET}"
phase0_rc=$?
set -e
if [[ "${phase0_rc}" -eq 0 ]]; then
  echo "FAIL: deploy exited 0 despite the certificate never reaching ISSUED"
  exit 1
fi
echo "PASS: deploy failed as expected (rc=${phase0_rc})"

# ListCertificates lags DeleteCertificate, so poll rather than probe once.
for attempt in 1 2 3 4 5; do
  if ! phase0_after=$(fixture_cert_count); then
    echo "FAIL: could not verify what the failed create left behind"
    exit 1
  fi
  [[ "${phase0_after}" -eq 0 ]] && break
  [[ "${attempt}" -lt 5 ]] && sleep 6
done
if [[ "${phase0_after}" -ne 0 ]]; then
  echo "FAIL: the failed create left ${phase0_after} certificate(s) behind -- this is the #2169 orphan:"
  acm_arns_for_fixture
  retire_all_fixture_certs
  exit 1
fi
echo "PASS: the failed create retired its own certificate -- 0 left behind"

# A failed create must also leave no state record: recording one would make the
# next deploy diff it as NO_CHANGE and silently exit 0 over a certificate that
# does not exist any more.
# Tri-state, not `|| true`: "no state file" and "the probe broke" are different
# answers, and only the first one is a PASS here.
phase0_state=$(aws s3 cp "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" - --region "${REGION}" 2>&1) && phase0_state_rc=0 || phase0_state_rc=$?
# Anchored: a bare `404` matches any account id containing those digits in a
# URI the error echoes back, and a bare `does not exist` also matches
# NoSuchBucket -- both would turn a broken probe into a PASS.
if [[ "${phase0_state_rc}" -ne 0 ]] && ! grep -qE 'NoSuchKey|\(404\)|Not Found' <<<"${phase0_state}"; then
  echo "FAIL: could not read state to check it, and the error is not a missing key:"
  printf '%s\n' "${phase0_state}"
  exit 1
fi
if [[ "${phase0_state_rc}" -eq 0 ]] && grep -q 'AWS::CertificateManager::Certificate' <<<"${phase0_state}"; then
  echo "FAIL: state records a certificate the failed create deleted:"
  printf '%s\n' "${phase0_state}"
  exit 1
fi
echo "PASS: no state record for the deleted certificate"

# Re-run the SAME failing deploy. This is the retry the reporter did, and the
# one that used to orphan a SECOND certificate.
set +e
CDKD_ACM_POLL_ATTEMPTS=3 CDKD_ACM_POLL_INTERVAL_MS=5000 \
  $CDKD deploy --region "${REGION}" --state-bucket "${BUCKET}"
phase0_rerun_rc=$?
set -e
# Still a failure, and that is the point: the certificate is still unusable, so
# the honest verdict is the same one. This is what recording the remnant would
# have destroyed -- the re-run would have diffed NO_CHANGE and exited 0.
if [[ "${phase0_rerun_rc}" -eq 0 ]]; then
  echo "FAIL: the re-run exited 0 while the certificate still cannot be validated"
  exit 1
fi
echo "PASS: the re-run failed too (rc=${phase0_rerun_rc}) -- no silent success"

for attempt in 1 2 3 4 5; do
  if ! phase0_after2=$(fixture_cert_count); then
    echo "FAIL: could not verify the certificate count after the re-run"
    exit 1
  fi
  [[ "${phase0_after2}" -eq 0 ]] && break
  [[ "${attempt}" -lt 5 ]] && sleep 6
done
if [[ "${phase0_after2}" -ne 0 ]]; then
  echo "FAIL: after two failed deploys the account holds ${phase0_after2} certificate(s) for this fixture:"
  acm_arns_for_fixture
  retire_all_fixture_certs
  exit 1
fi
echo "PASS: two failed deploys, still 0 certificates -- no accumulation"

# Drop what phase 0's failed deploys wrote -- the state file AND the
# rollback-journal sibling they leave behind -- so phase 1 below starts from a
# clean prefix exactly as it did before this arm existed. `deployments/` is
# append-only run history and is deliberately kept.
aws s3 rm "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" --region "${REGION}" >/dev/null 2>&1 || true
aws s3 rm "s3://${BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" --region "${REGION}" >/dev/null 2>&1 || true

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
# Hand the cleanup trap the ARN phase 2's replacement deletes, in case the run
# stops before that delete.
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

# --- Phase 2: a ValidationMethod change is an engine replacement (#6513) -----
#
# ACM cannot change a certificate's validation method, and CloudFormation (and
# the AWS CDK CLI's diff) treat the change as a replacement, but the registry
# schema leaves it out of `createOnlyProperties`. The diff must report it, so
# the ENGINE replaces the certificate: the new one first, then the old one
# deleted once its readers have moved. The provider used to do this inside its
# own `update()` while the diff showed a plain update.
echo "=== Phase 2: ValidationMethod DNS -> EMAIL is reported and made as a replacement (issue #6513) ==="
set +e
diff_out=$(CDKD_TEST_UPDATE=validation $CDKD diff --region "${REGION}" --state-bucket "${BUCKET}" \
  --fail-on=destructive </dev/null 2>&1)
diff_rc=$?
set -e
diff_txt=$(printf '%s' "${diff_out}" | sed $'s/\033\[[0-9;]*m//g')
# Sentinel: the property row itself, independent of its replacement note.
if ! grep -q -- "- ValidationMethod:" <<<"${diff_txt}"; then
  echo "FAIL: cdkd diff printed no ValidationMethod change"
  echo "${diff_txt}"
  exit 1
fi
if ! grep -q -- "- ValidationMethod: \[requires replacement\]" <<<"${diff_txt}"; then
  echo "FAIL: cdkd diff did not mark the ValidationMethod change as a replacement (issue #6513)"
  echo "${diff_txt}"
  exit 1
fi
if [[ "${diff_rc}" -ne 1 ]] || ! grep -q "TestCertificate6B4956B6 will be replaced" <<<"${diff_txt}"; then
  echo "FAIL: diff --fail-on=destructive exited ${diff_rc}; expected 1 naming the certificate's replacement"
  echo "${diff_txt}"
  exit 1
fi
echo "PASS: cdkd diff reports the replacement and --fail-on=destructive fails"

set +e
deploy_out=$(CDKD_NO_WAIT=true CDKD_TEST_UPDATE=validation $CDKD deploy \
  --region "${REGION}" --state-bucket "${BUCKET}" 2>&1)
deploy_rc=$?
set -e
echo "${deploy_out}"
if [[ "${deploy_rc}" -ne 0 ]]; then
  echo "FAIL: the ValidationMethod replacement deploy exited ${deploy_rc}"
  exit 1
fi
deploy_txt=$(printf '%s' "${deploy_out}" | sed $'s/\033\[[0-9;]*m//g')
if ! grep -q "immutable properties changed: ValidationMethod" <<<"${deploy_txt}"; then
  echo "FAIL: the deploy did not take the engine's replacement for ValidationMethod"
  exit 1
fi
new_arn=$(aws s3 cp "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" - --region "${REGION}" | python3 -c '
import json, sys
s = json.load(sys.stdin)
for v in s["resources"].values():
    if v["resourceType"] == "AWS::CertificateManager::Certificate":
        print(v["physicalId"])
        break
')
if [[ "${new_arn}" == "${ORIGINAL_ARN}" || "${new_arn}" != arn:aws:acm:* ]]; then
  echo "FAIL: state holds '${new_arn}'; expected a new certificate ARN, not ${ORIGINAL_ARN}"
  exit 1
fi
# The old certificate must be gone, not left beside the new one.
old_out=$(aws acm describe-certificate --certificate-arn "${ORIGINAL_ARN}" --region "${REGION}" \
  --query 'Certificate.Status' --output text 2>&1) && {
  echo "FAIL: the replaced certificate ${ORIGINAL_ARN} still exists (status ${old_out})"
  exit 1
}
if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${old_out}"; then
  echo "FAIL: could not confirm the old certificate is gone: ${old_out}"
  exit 1
fi
ORIGINAL_ARN=""
# The stack's one reader of the certificate ARN must follow the replacement.
out_arn=$(aws s3 cp "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" - --region "${REGION}" \
  | python3 -c 'import json, sys; print(json.load(sys.stdin).get("outputs", {}).get("CertificateArn", ""))')
if [[ "${out_arn}" != "${new_arn}" ]]; then
  echo "FAIL: Output CertificateArn is '${out_arn}', expected the replacement ${new_arn}"
  exit 1
fi
echo "PASS: replaced by ${new_arn}; the old certificate is deleted and the output follows it"

# --- Phase 4: a secret-derived DomainName is updated in place (#4275) ---------
#
# cdkd records a secret-derived value as its `{{resolve:secretsmanager:...}}`
# expression, while `update()` receives the RESOLVED value. The provider used
# to compare the two directly, read every update of such a certificate as a
# DomainName change, and REPLACE it: a new RequestCertificate, the old
# certificate deleted, state re-pointed. The engine's own diff sees no
# DomainName change (template and record spell the same expression), so the
# Tags-only change below reaches `update()`.
#
# Pre-fix this arm fails at the ARN assertion: the update deploy exits 0, but
# state names a NEW certificate and the old one is gone. Post-fix the ARN is
# unchanged and the new tag is on the ORIGINAL certificate.
echo "=== Phase 4: a secret-derived DomainName is updated in place, not replaced (issue #4275) ==="
stack_lc=$(printf '%s' "${STACK}" | tr '[:upper:]' '[:lower:]')
# Contains `cdkd-integ-<stack>`, so the trap's leak sweep covers it too.
secret_domain="cdkd-integ-${stack_lc}-sdn.example.test"
# From a file, not argv, so the value never shows in the host's process list.
secret_file=$(mktemp -t acm-certificate-secret.XXXXXX)
printf '{"domain":"%s"}' "${secret_domain}" > "${secret_file}"
# Flagged BEFORE the call: a create that succeeds on AWS but reports failure
# (a client timeout) must still be deleted by the trap.
SEEDED_SECRET=1
aws secretsmanager create-secret --region "${REGION}" --name "${SECRET_NAME}" \
  --secret-string "file://${secret_file}" >/dev/null || { rm -f "${secret_file}"; exit 1; }
rm -f "${secret_file}"
echo "  seeded secret ${SECRET_NAME}"

# Prints SecretCertificate's `physicalId` or one of its recorded properties.
secret_cert_field() { # usage: secret_cert_field physicalId | <property>
  aws s3 cp "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" - --region "${REGION}" \
    | python3 -c '
import json, sys
r = json.load(sys.stdin)["resources"].get("SecretCertificate", {})
f = sys.argv[1]
print(r.get("physicalId", "") if f == "physicalId" else r.get("properties", {}).get(f, ""))
' "$1"
}

# No CDKD_TEST_UPDATE here, so TestCertificate also goes back from EMAIL to
# DNS: a second engine replacement, beside the secret certificate's create.
CDKD_NO_WAIT=true CDKD_TEST_SECRET_NAME="${SECRET_NAME}" \
  $CDKD deploy --region "${REGION}" --state-bucket "${BUCKET}"

secret_arn=$(secret_cert_field physicalId)
if [[ "${secret_arn}" != arn:aws:acm:* ]]; then
  echo "FAIL: state records no ACM ARN for SecretCertificate (got '${secret_arn}')"
  exit 1
fi
echo "PASS: SecretCertificate created: ${secret_arn}"

# Non-vacuity: the record must hold the EXPRESSION, or the update below never
# compares a resolved value against a reference and proves nothing.
recorded_domain=$(secret_cert_field DomainName)
expected_ref="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:domain::}}"
if [[ "${recorded_domain}" != "${expected_ref}" ]]; then
  echo "FAIL: state records DomainName '${recorded_domain}', expected '${expected_ref}';"
  echo "      the name is not secret-derived, so the update below would not exercise #4275"
  exit 1
fi
echo "PASS: state records the DomainName as its secret reference"
live_domain=$(aws acm describe-certificate --certificate-arn "${secret_arn}" --region "${REGION}" \
  --query 'Certificate.DomainName' --output text)
if [[ "${live_domain}" != "${secret_domain}" ]]; then
  echo "FAIL: the certificate's DomainName is '${live_domain}', expected the secret's '${secret_domain}'"
  exit 1
fi
echo "PASS: the certificate carries the domain the secret resolves to"

# The update: a Tags-only change on SecretCertificate, nothing else in the
# template moves.
set +e
p4_out=$(CDKD_NO_WAIT=true CDKD_TEST_SECRET_NAME="${SECRET_NAME}" CDKD_TEST_SECRET_CERT_TAG=v2 \
  $CDKD deploy --region "${REGION}" --state-bucket "${BUCKET}" 2>&1)
p4_rc=$?
set -e
echo "${p4_out}"
if [[ "${p4_rc}" -ne 0 ]]; then
  echo "FAIL: the Tags-only update deploy exited ${p4_rc}"
  exit 1
fi

# LOAD-BEARING: the same certificate, not a replacement.
secret_arn_after=$(secret_cert_field physicalId)
if [[ "${secret_arn_after}" != "${secret_arn}" ]]; then
  echo "FAIL: SecretCertificate was REPLACED by a Tags-only update (${secret_arn} -> ${secret_arn_after});"
  echo "      the provider read the resolved DomainName as a change from its recorded reference (#4275)"
  exit 1
fi
echo "PASS: SecretCertificate keeps its ARN across the update"

# ...and the update really ran: the new tag is on the ORIGINAL certificate.
phase_tag=$(aws acm list-tags-for-certificate --certificate-arn "${secret_arn}" --region "${REGION}" \
  --query "Tags[?Key=='phase'].Value | [0]" --output text)
if [[ "${phase_tag}" != "v2" ]]; then
  echo "FAIL: tag phase on ${secret_arn} is '${phase_tag}', expected v2 -- the update never reached it"
  exit 1
fi
echo "PASS: the Tags-only update was applied in place (phase=v2)"

# --- Phase 5: an Amazon N2 certificate on the SDK route (#6799) ---------------
#
# RootHierarchyType and CertificateUsage are create-only and were SDK-unwired,
# so a certificate declaring them routed through Cloud Control. The SDK
# provider now sends both on RequestCertificate: assert the route the state
# records, and that ACM holds the values the template declares. The phase 4
# env is kept, so nothing else in the template moves.
echo "=== Phase 5: an Amazon N2 certificate is created on the SDK route (issue #6799) ==="
CDKD_NO_WAIT=true CDKD_TEST_SECRET_NAME="${SECRET_NAME}" CDKD_TEST_SECRET_CERT_TAG=v2 CDKD_TEST_N2=1 \
  $CDKD deploy --region "${REGION}" --state-bucket "${BUCKET}"

n2_record=$(aws s3 cp "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" - --region "${REGION}" \
  | python3 -c '
import json, sys
r = json.load(sys.stdin)["resources"].get("N2Certificate", {})
print(r.get("physicalId", ""), r.get("provisionedBy", "<absent>"))
')
read -r n2_arn n2_by <<<"${n2_record}"
if [[ "${n2_arn:-}" != arn:aws:acm:* ]]; then
  echo "FAIL: state records no ACM ARN for N2Certificate (got '${n2_record}')"
  exit 1
fi
if [[ "${n2_by:-}" != "sdk" ]]; then
  echo "FAIL: N2Certificate provisionedBy is '${n2_by:-}', expected sdk -- RootHierarchyType / CertificateUsage still route it through Cloud Control (#6799)"
  exit 1
fi
echo "PASS: N2Certificate ${n2_arn} is on the SDK route"
n2_live=$(aws acm describe-certificate --certificate-arn "${n2_arn}" --region "${REGION}" \
  --query 'Certificate.[RootHierarchyType, CertificateUsage]' --output text)
if [[ "${n2_live}" != $'N2_AMAZON_MANAGED\tCLIENT_AUTH_ONLY' ]]; then
  echo "FAIL: ACM holds RootHierarchyType/CertificateUsage '${n2_live}', expected N2_AMAZON_MANAGED/CLIENT_AUTH_ONLY"
  exit 1
fi
echo "PASS: ACM holds RootHierarchyType N2_AMAZON_MANAGED and CertificateUsage CLIENT_AUTH_ONLY"

# The drift readback (readCurrentState) against the live certificate: the
# baseline cdkd captured right after the create comes from it, so a field it
# misread is absent there (and drift, which compares against that baseline,
# would stay clean over it).
n2_observed=$(aws s3 cp "s3://${BUCKET}/cdkd/${STACK}/${REGION}/state.json" - --region "${REGION}" \
  | jq -r '.resources.N2Certificate.observedProperties // {} | "\(.RootHierarchyType // "<absent>") \(.CertificateUsage // "<absent>")"')
if [[ "${n2_observed}" != "N2_AMAZON_MANAGED CLIENT_AUTH_ONLY" ]]; then
  echo "FAIL: the captured readback of N2Certificate holds RootHierarchyType/CertificateUsage '${n2_observed}', expected 'N2_AMAZON_MANAGED CLIENT_AUTH_ONLY' (#6799)"
  exit 1
fi
# ...and drift reads the certificate as compared and clean. Other resources'
# verdicts are not this check's subject.
set +e
n2_drift=$($CDKD drift "${STACK}" --region "${REGION}" --state-bucket "${BUCKET}" --json)
n2_drift_rc=$?
set -e
if [[ "${n2_drift_rc}" -gt 2 ]] || ! jq -e --arg stack "${STACK}" '
  [.[] | select(.stack == $stack)] as $r |
  ($r | length) == 1 and ([$r[0].clean[] | select(.logicalId == "N2Certificate")] | length) == 1
' <<<"${n2_drift}" >/dev/null; then
  echo "FAIL: cdkd drift (exit ${n2_drift_rc}) does not report N2Certificate as compared and clean (#6799)"
  printf '%s\n' "${n2_drift}"
  exit 1
fi
echo "PASS: the readback holds both values and drift reads N2Certificate as clean"

# Destroy on the success path (unpiped, so `set -e` stops the run if it
# fails), then sweep every object version under the stack's prefix and assert
# none survives. The trap still retires a certificate phase 2 left, deletes
# the secret and runs the ACM leak sweep.
echo "=== Destroying stack ${STACK} ==="
$CDKD destroy --region "${REGION}" --state-bucket "${BUCKET}" --force
DESTROYED=1
s3_purge_prefix_versions "${BUCKET}" "${PREFIX}" all || true
s3_assert_versions_swept "${BUCKET}" "${PREFIX}" "stack state teardown"

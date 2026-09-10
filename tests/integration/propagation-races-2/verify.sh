#!/usr/bin/env bash
# verify.sh — cdkd propagation-races-2 integ test.
#
# A fresh-principal / propagation-race DETECTOR. Every resource in the stack is
# a NEW consumer of a resource created moments earlier in the SAME deploy:
#   1. IAM InstanceProfile -> EC2 Instance   (RunInstances validates the profile)
#   2. Lambda::Permission granting a fresh S3 bucket source (AddPermission)
#   3. S3 BucketPolicy referencing a fresh IAM role principal (PutBucketPolicy)
#   4. KMS Key policy referencing a fresh IAM role principal (CreateKey)
#
# PASS CONDITION = `cdkd deploy` SUCCEEDS. If cdkd does not retry the
# fresh-principal propagation error for one of these edges, the deploy fails and
# this script prints which resource failed + the AWS error + the
# `cdkd events --format json` RESOURCE_FAILED lines for triage. On success it
# asserts each resource works, then destroys and asserts every named resource is
# gone (by the fixture-owned `cdkd:integ-fixture` tag / state-resolved id, NOT
# the AWS-reserved `aws:cdk:path` tag).
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-safe (macOS): no `grep -P`, no `date -d`; boolean asserts use the
# `if has("X") then .X|tostring else "null" end` jq idiom (jq's `//` treats an
# explicit `false` as missing).

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

STACK="CdkdPropagationRaces2Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FIXTURE_TAG_KEY="cdkd:integ-fixture"
FIXTURE_TAG_VALUE="propagation-races-2"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved physical ids (populated post-deploy; used by assertions + cleanup).
INSTANCE_ID=""
INSTANCE_PROFILE_NAME=""
FUNCTION_NAME=""
NOTIFY_BUCKET=""
POLICED_BUCKET=""
KEY_ID=""
USER_POOL_ID=""
SMS_ROLE_NAME=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # cdkd-owned teardown first (deletes resources AND state in dependency order).
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  # Belt-and-suspenders direct deletes in case state is already gone. EC2 must
  # go BEFORE the VPC/SG (ENI ordering): terminate the instance and wait so the
  # security group + subnet are not blocked by a lingering ENI/DependencyViolation.
  if [ -n "${INSTANCE_ID}" ]; then
    aws ec2 terminate-instances --instance-ids "${INSTANCE_ID}" \
      --region "${REGION}" >/dev/null 2>&1
    aws ec2 wait instance-terminated --instance-ids "${INSTANCE_ID}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${INSTANCE_PROFILE_NAME}" ]; then
    # Detach roles before deleting the profile (AWS requires it).
    for r in $(aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" \
      --query 'InstanceProfile.Roles[].RoleName' --output text 2>/dev/null); do
      aws iam remove-role-from-instance-profile \
        --instance-profile-name "${INSTANCE_PROFILE_NAME}" \
        --role-name "${r}" >/dev/null 2>&1
    done
    aws iam delete-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" >/dev/null 2>&1
  fi
  if [ -n "${FUNCTION_NAME}" ]; then
    aws lambda delete-function --function-name "${FUNCTION_NAME}" --region "${REGION}" >/dev/null 2>&1
  fi
  for b in "${NOTIFY_BUCKET}" "${POLICED_BUCKET}"; do
    if [ -n "${b}" ]; then
      aws s3 rb "s3://${b}" --force --region "${REGION}" >/dev/null 2>&1
    fi
  done
  if [ -n "${KEY_ID}" ]; then
    aws kms schedule-key-deletion --key-id "${KEY_ID}" \
      --pending-window-in-days 7 --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${USER_POOL_ID}" ]; then
    aws cognito-idp delete-user-pool --user-pool-id "${USER_POOL_ID}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Triage helper: dump cdkd events RESOURCE_FAILED lines on a deploy failure so a
# CI run shows exactly which race edge failed + the AWS error.
# Fetch the newest run's FLAT event array, or print nothing.
#
# `cdkd events <stack> --format json` WITHOUT `--run` returns
# `{stackName, region, runs: [DeploymentRunSummary]}`, and a run summary carries
# `runId / command / cdkdVersion / startedAt / finishedAt / result / eventCount`
# and NO events at all -- so a jq filtering event fields over that payload
# matches nothing, whatever it asks for. Only `--run <id>` returns the array.
# Never fatal: this feeds diagnostics, so a failure here must not mask the
# failure being diagnosed.
fetch_run_events() { # stdout: a JSON array of DeploymentEvent, or empty
  ( set +eu
    runs_json=$(node "${LOCAL_DIST}" events "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --format json 2>/dev/null) || return 0
    [ -n "${runs_json}" ] || return 0
    # Newest by startedAt; `// empty` so an unparseable payload yields nothing
    # rather than the string "null" reaching --run.
    run_id=$(printf '%s' "${runs_json}" \
      | jq -r '(.runs // []) | sort_by(.startedAt) | last | .runId // empty' 2>/dev/null)
    [ -n "${run_id}" ] || return 0
    node "${LOCAL_DIST}" events "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --run "${run_id}" \
      --format json 2>/dev/null
  )
}

dump_failure_triage() {
  echo "==> DEPLOY FAILED -- triage via cdkd events --format json" >&2
  set +e
  EVENTS_JSON=$(fetch_run_events)
  if [ -n "${EVENTS_JSON}" ]; then
    # `eventType`, NOT `type`: `DeploymentEvent` has no `type` field, so the
    # previous filter matched nothing even when handed a real event stream.
    FAILED=$(printf '%s' "${EVENTS_JSON}" | jq -r '
      map(select(.eventType == "RESOURCE_FAILED" or .eventType == "ROLLBACK_RESOURCE_FAILED"))
      | .[]
      | "  \(.eventType): \(.logicalId // "?") (\(.resourceType // "?"))\n    \(.error.name // "?")\(if .error.awsErrorCode then " (\(.error.awsErrorCode))" else "" end): \(.error.message // "?")"
    ' 2>/dev/null)
    if [ -n "${FAILED}" ]; then
      printf '%s\n' "${FAILED}" >&2
    else
      echo "  (event stream parsed but carried no RESOURCE_FAILED / ROLLBACK_RESOURCE_FAILED; raw below)" >&2
      printf '%s\n' "${EVENTS_JSON}" >&2
    fi
  else
    echo "  (no events recorded -- deploy may have failed before any resource started)" >&2
  fi
  set -e
}

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

# --- Phase 1: deploy (the race detector) ------------------------------
echo "==> Phase 1: deploy with the local binary (pass condition = deploy succeeds)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes; then
  echo "FAIL: cdkd deploy returned non-zero — a fresh-principal propagation race was NOT retried" >&2
  dump_failure_triage
  exit 1
fi

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve physical ids from state.
resolve_id() {
  echo "${STATE}" | jq -r --arg t "$1" \
    '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.physicalId] | first // ""'
}
INSTANCE_ID=$(resolve_id "AWS::EC2::Instance")
INSTANCE_PROFILE_NAME=$(resolve_id "AWS::IAM::InstanceProfile")
FUNCTION_NAME=$(resolve_id "AWS::Lambda::Function")
KEY_ID=$(resolve_id "AWS::KMS::Key")
# Two buckets share a type; resolve by output name instead.
NOTIFY_BUCKET=$(echo "${STATE}" | jq -r '.outputs.NotifyBucketName // ""')
POLICED_BUCKET=$(echo "${STATE}" | jq -r '.outputs.PolicedBucketName // ""')
USER_POOL_ID=$(resolve_id "AWS::Cognito::UserPool")
# FOUR roles share AWS::IAM::Role, so resolve_id's `first` would pick an
# arbitrary one; the stack publishes this name as an output for that reason.
SMS_ROLE_NAME=$(echo "${STATE}" | jq -r '.outputs.SmsRoleName // ""')

echo "    instance=${INSTANCE_ID} profile=${INSTANCE_PROFILE_NAME} fn=${FUNCTION_NAME}"
echo "    notifyBucket=${NOTIFY_BUCKET} policedBucket=${POLICED_BUCKET} key=${KEY_ID}"
echo "    userPool=${USER_POOL_ID} smsRole=${SMS_ROLE_NAME}"

for v in "${INSTANCE_ID}" "${INSTANCE_PROFILE_NAME}" "${FUNCTION_NAME}" "${NOTIFY_BUCKET}" "${POLICED_BUCKET}" "${KEY_ID}" "${USER_POOL_ID}" "${SMS_ROLE_NAME}"; do
  if [ -z "${v}" ] || [ "${v}" = "null" ]; then
    echo "FAIL: could not resolve one or more physical ids from state" >&2
    echo "${STATE}" | jq '{resources: (.resources | keys), outputs}' >&2
    exit 1
  fi
done

# --- Edge 1 assertion: instance launched WITH the fresh instance profile
echo "==> Edge 1: EC2 Instance launched with the fresh InstanceProfile"
INSTANCE=$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" \
  --region "${REGION}" --query 'Reservations[0].Instances[0]' --output json 2>/dev/null)
INSTANCE_STATE=$(echo "${INSTANCE}" | jq -r '.State.Name // "null"')
if [ "${INSTANCE_STATE}" != "running" ] && [ "${INSTANCE_STATE}" != "pending" ]; then
  echo "FAIL: instance state is '${INSTANCE_STATE}', expected running/pending" >&2
  exit 1
fi
ATTACHED_PROFILE=$(echo "${INSTANCE}" | jq -r '.IamInstanceProfile.Arn // "null"')
if [ "${ATTACHED_PROFILE}" = "null" ]; then
  echo "FAIL: instance has no IAM instance profile attached — the fresh profile did not bind" >&2
  exit 1
fi
echo "    OK: instance ${INSTANCE_STATE}, profile attached (${ATTACHED_PROFILE})"

# --- Edge 2 assertion: Lambda is invokable + the bucket-source permission exists
echo "==> Edge 2: Lambda::Permission for the fresh S3 source"
INVOKE_OUT=$(aws lambda invoke --function-name "${FUNCTION_NAME}" \
  --region "${REGION}" --payload '{}' /tmp/prop2-invoke.out 2>/dev/null \
  --query 'StatusCode' --output text || echo "null")
if [ "${INVOKE_OUT}" != "200" ]; then
  echo "FAIL: Lambda invoke StatusCode was '${INVOKE_OUT}', expected 200" >&2
  exit 1
fi
POLICY_JSON=$(aws lambda get-policy --function-name "${FUNCTION_NAME}" \
  --region "${REGION}" --query 'Policy' --output text)
if ! echo "${POLICY_JSON}" | grep -qF "s3.amazonaws.com"; then
  echo "FAIL: Lambda resource policy does not grant s3.amazonaws.com — the permission PUT did not land" >&2
  echo "${POLICY_JSON}" >&2
  exit 1
fi
echo "    OK: Lambda invokable (200) + resource policy grants the S3 source"

# --- Edge 3 assertion: bucket policy present + references the fresh role
echo "==> Edge 3: S3 BucketPolicy referencing the fresh role"
BUCKET_POLICY=$(aws s3api get-bucket-policy --bucket "${POLICED_BUCKET}" \
  --region "${REGION}" --query 'Policy' --output text)
if [ -z "${BUCKET_POLICY}" ]; then
  echo "FAIL: no bucket policy on ${POLICED_BUCKET} — PutBucketPolicy did not land" >&2
  exit 1
fi
if ! echo "${BUCKET_POLICY}" | grep -qF "AllowFreshRoleRead"; then
  echo "FAIL: bucket policy missing the AllowFreshRoleRead statement" >&2
  echo "${BUCKET_POLICY}" >&2
  exit 1
fi
echo "    OK: bucket policy present + references the fresh role principal"

# --- Edge 4 assertion: KMS key usable + the key policy references the fresh role
echo "==> Edge 4: KMS Key policy referencing the fresh role"
KEY_STATE=$(aws kms describe-key --key-id "${KEY_ID}" --region "${REGION}" \
  --query 'KeyMetadata.KeyState' --output text)
if [ "${KEY_STATE}" != "Enabled" ]; then
  echo "FAIL: KMS key state is '${KEY_STATE}', expected Enabled" >&2
  exit 1
fi
# Key is usable: encrypt a tiny blob.
ENC=$(aws kms encrypt --key-id "${KEY_ID}" --plaintext "$(printf 'ok' | base64)" \
  --region "${REGION}" --query 'CiphertextBlob' --output text 2>/dev/null || echo "")
if [ -z "${ENC}" ]; then
  echo "FAIL: KMS encrypt failed — key not usable" >&2
  exit 1
fi
KEY_POLICY=$(aws kms get-key-policy --key-id "${KEY_ID}" --policy-name default \
  --region "${REGION}" --query 'Policy' --output text)
if ! echo "${KEY_POLICY}" | grep -qF "AllowFreshRoleUse"; then
  echo "FAIL: KMS key policy missing the AllowFreshRoleUse statement" >&2
  echo "${KEY_POLICY}" >&2
  exit 1
fi
echo "    OK: KMS key Enabled + usable + policy references the fresh role principal"

# --- Edge 5 assertion: UserPool bound the fresh SMS role, at BOTH call sites
echo "==> Edge 5: Cognito UserPool referencing the fresh SMS role"
POOL=$(aws cognito-idp describe-user-pool --user-pool-id "${USER_POOL_ID}" \
  --region "${REGION}" --query 'UserPool' --output json)
POOL_SNS_ARN=$(echo "${POOL}" | jq -r '.SmsConfiguration.SnsCallerArn // ""')
if [ -z "${POOL_SNS_ARN}" ]; then
  echo "FAIL: user pool has no SmsConfiguration.SnsCallerArn — CreateUserPool dropped it" >&2
  echo "${POOL}" | jq '{SmsConfiguration, MfaConfiguration}' >&2
  exit 1
fi
case "${POOL_SNS_ARN}" in
  *":role/${SMS_ROLE_NAME}") ;;
  *)
    echo "FAIL: pool SnsCallerArn '${POOL_SNS_ARN}' does not name the fresh role ${SMS_ROLE_NAME}" >&2
    exit 1
    ;;
esac

# The SECOND validating call. Asserting only the pool's own SmsConfiguration
# would pass with SetUserPoolMfaConfig never having succeeded -- and that call
# re-checks the SAME role, so it is half the race this edge exists to cover.
MFA=$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "${USER_POOL_ID}" \
  --region "${REGION}" --output json)
MFA_MODE=$(echo "${MFA}" | jq -r '.MfaConfiguration // ""')
MFA_SNS_ARN=$(echo "${MFA}" | jq -r '.SmsMfaConfiguration.SmsConfiguration.SnsCallerArn // ""')
if [ "${MFA_MODE}" != "ON" ]; then
  echo "FAIL: pool MfaConfiguration is '${MFA_MODE}', expected ON — SetUserPoolMfaConfig did not land" >&2
  echo "${MFA}" >&2
  exit 1
fi
if [ "${MFA_SNS_ARN}" != "${POOL_SNS_ARN}" ]; then
  echo "FAIL: SMS MFA SnsCallerArn '${MFA_SNS_ARN}' != the pool's '${POOL_SNS_ARN}'" >&2
  echo "${MFA}" >&2
  exit 1
fi
echo "    OK: pool + SMS MFA config both bound the fresh role (${POOL_SNS_ARN})"

# --- Window report: how much propagation time each edge actually got ---
# A green run of a RACE fixture does not prove the retry works -- it may simply
# never have raced. #2018 makes the same point about its own fixture, and asks
# for the window to be MEASURED rather than inferred. So record it: for each
# producer/consumer pair, print the gap between the producer's CREATE finishing
# and the consumer's starting. A small gap means this run exercised the window;
# a large one means the DAG had unrelated work in between and the edge was
# never under test, whatever the assertions above say.
#
# Informational ONLY -- a large gap is not a failure (it is not something the
# fixture controls), and an unparseable events stream is not either. What it
# buys is that "the retry is covered" stops being assumed from a green run.
echo "==> Window report: producer -> consumer gaps (informational, never fatal)"
set +e
WINDOW_EVENTS=$(fetch_run_events)
if [ -n "${WINDOW_EVENTS}" ]; then
  echo "${WINDOW_EVENTS}" | jq -r '
    # Millisecond precision is the whole point -- the reported window was
    # 336ms, and `fromdateiso8601` alone truncates to whole SECONDS, which
    # would print 0ms for every gap this measurement exists to see.
    def tms:
      capture("(?<base>.*)\\.(?<ms>[0-9]{3})Z$")
      | ((.base + "Z") | fromdateiso8601) * 1000 + (.ms | tonumber);
    # `fetch_run_events` always yields a FLAT array, so no run-wrapper
    # unwrapping is needed -- and the unwrapping this replaced was wrong
    # anyway: `(.[] .events // []) | add` applies `add` to each stream element,
    # merging event OBJECTS instead of concatenating the arrays.
    (if type == "array" then . else [] end)
    | map(select(.logicalId != null and (.timestamp | type) == "string"))
    | map({logicalId, eventType, t: (.timestamp | tms)})
    | group_by(.logicalId)
    | map({
        id: .[0].logicalId,
        start: ([.[] | select(.eventType == "RESOURCE_STARTED") | .t] | min),
        done:  ([.[] | select(.eventType == "RESOURCE_SUCCEEDED") | .t] | max)
      })
    | (reduce .[] as $r ({}; .[$r.id] = $r)) as $byId
    | [
        ["InstanceProfile", "Instance"],
        ["UserPoolsmsRole1998E37F", "RacedUserPool"]
      ]
    | map(
        ($byId[.[0]].done) as $p
        | ($byId[.[1]].start) as $c
        | if $p != null and $c != null
          then "    \(.[1]) started \(($c - $p) | floor)ms after \(.[0]) completed"
          else "    \(.[1]): gap unavailable (producer or consumer event missing)"
          end
      )
    | .[]
  ' 2>/dev/null || echo "    (could not parse the events stream for window timing)"
else
  echo "    (no events recorded — window timing unavailable)"
fi
set -e

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# --- Post-destroy: assert each NAMED resource is gone ------------------
echo "==> Post-destroy: assert named resources are gone (by fixture tag / resolved id)"

# Instance terminated / shutting-down / gone. AWS also spells "terminated" by
# sweeping the record entirely (InvalidInstanceID.NotFound) once the terminated
# instance ages out, so a not-found probe is a legitimate "gone".
if gone_probe aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}"; then
  ST="gone"
elif ! ST=$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>&1); then
  # TOCTOU: the record can be swept between gone_probe and this requery.
  printf '%s' "${ST}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && ST="gone" \
    || { echo "FAIL: describe-instances requery undetermined: ${ST}" >&2; exit 1; }
fi
case "${ST}" in
  terminated|shutting-down|gone) echo "    OK: instance gone (state: ${ST})" ;;
  *) echo "FAIL: instance ${INSTANCE_ID} still in state ${ST} after destroy" >&2; exit 1 ;;
esac

# Instance profile gone.
assert_gone "instance profile ${INSTANCE_PROFILE_NAME} still exists after destroy" aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}"
echo "    OK: instance profile gone"

# Lambda function gone.
assert_gone "Lambda ${FUNCTION_NAME} still exists after destroy" aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}"
echo "    OK: Lambda function gone"

# Both buckets gone.
for b in "${NOTIFY_BUCKET}" "${POLICED_BUCKET}"; do
  assert_gone "bucket ${b} still exists after destroy" aws s3api head-bucket --bucket "${b}" --region "${REGION}"
done
echo "    OK: both S3 buckets gone"

# User pool + its fresh SMS role gone. The pool is the resource issue #2902
# reports SURVIVING a rollback under a RETAIN policy, and this fixture's pool
# carries a deterministic name -- so a survivor here does not just leak, it
# wedges the NEXT run of this fixture on an EntityAlreadyExists.
assert_gone "user pool ${USER_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${USER_POOL_ID}" --region "${REGION}"
echo "    OK: Cognito user pool gone"
assert_gone "SMS role ${SMS_ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${SMS_ROLE_NAME}"
echo "    OK: fresh SMS role gone"

# KMS key scheduled for deletion (KMS keys cannot be hard-deleted immediately).
if gone_probe aws kms describe-key --key-id "${KEY_ID}" --region "${REGION}"; then
  KEY_STATE_AFTER="gone"
elif ! KEY_STATE_AFTER=$(aws kms describe-key --key-id "${KEY_ID}" --region "${REGION}" \
    --query 'KeyMetadata.KeyState' --output text 2>&1); then
  # TOCTOU: the key can vanish between gone_probe and this requery.
  printf '%s' "${KEY_STATE_AFTER}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && KEY_STATE_AFTER="gone" \
    || { echo "FAIL: describe-key requery undetermined: ${KEY_STATE_AFTER}" >&2; exit 1; }
fi
case "${KEY_STATE_AFTER}" in
  PendingDeletion|gone) echo "    OK: KMS key pending deletion / gone (state: ${KEY_STATE_AFTER})" ;;
  *) echo "FAIL: KMS key ${KEY_ID} still in state ${KEY_STATE_AFTER} after destroy (expected PendingDeletion)" >&2; exit 1 ;;
esac

# Tag-scoped sweep: no running/pending instance carries our fixture tag (catches
# an orphan that state-resolved-id checks would miss because it lost the stack
# name).
ORPHAN_INSTANCES=$(aws ec2 describe-instances --region "${REGION}" \
  --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "${ORPHAN_INSTANCES}" ] && [ "${ORPHAN_INSTANCES}" != "None" ]; then
  echo "FAIL: orphan instance(s) carrying the fixture tag remain: ${ORPHAN_INSTANCES}" >&2
  exit 1
fi
echo "    OK: no tagged orphan instances remain"

# Nothing left for the cleanup trap to delete. Every id resolved above must be
# cleared here: an id left set makes the EXIT trap issue a delete for a resource
# the assertions just proved gone, on every GREEN run.
INSTANCE_ID=""
INSTANCE_PROFILE_NAME=""
FUNCTION_NAME=""
NOTIFY_BUCKET=""
POLICED_BUCKET=""
KEY_ID=""
USER_POOL_ID=""
SMS_ROLE_NAME=""

echo ""
echo "=== PASS: propagation-races-2 integ (5 fresh-principal/consumer race edges deployed, asserted, destroyed clean) ==="

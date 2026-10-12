#!/usr/bin/env bash
# verify.sh — the AWS CDK-generated cross-account Fn::GetStackOutput (#4808).
#
# aws-cdk-lib answers a cross-account reference with a producer role that
# trusts only the consumer account's CloudFormation execution role, named as
# the consumer's `Fn::GetStackOutput` `RoleArn`. cdkd does not use that role:
# it reads the producer's cdkd state through the producer account's CDK lookup
# role, or refuses naming both remedies. One account cannot hold a real
# cross-account pair, so the arms are:
#
#   (c) IAM PROBE  — IAM's answer to a trust principal naming a role that does
#                    not exist (what an unbootstrapped consumer account makes
#                    of the generated role). Must be MalformedPolicyDocument.
#   (a) SUCCESS    — the generated SHAPE hand-written in this account: the
#                    consumer's value must be the producer's output, read
#                    through cdk-<qualifier>-lookup-role-<account>-<region>
#                    (debug log), never through the generated role; a second
#                    consumer reading an output that carries a dynamic
#                    reference must still be refused as a cross-account secret.
#   (b1) DENIED    — the REAL generated reference, producer in a fake account:
#                    the lookup role cannot be assumed, so the consumer deploy
#                    is refused with both remedies and creates no resource
#                    (the failed create keeps an empty state record, destroyed).
#   (b2) NO LOOKUP — the same with a producer synthesizer naming no lookup
#                    role: refused by the deploy pre-flight, before any lock.
#
# Requires the account to be CDK-bootstrapped with the default qualifier
# (hnb659fds) in AWS_REGION: arm (a) assumes its lookup role, and its
# generated-role trust names its cfn-exec-role.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (account-scoped, e.g. cdkd-state-{accountId})
#   AWS_REGION   — region to deploy into (default us-east-1)

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

REGION="${AWS_REGION:-us-east-1}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
QUALIFIER="hnb659fds"
FAKE_PRODUCER_ACCOUNT="111111111111"

PRODUCER="CdkdXaccLookupProducer"
CONSUMER="CdkdXaccLookupConsumer"
SECRET_CONSUMER="CdkdXaccLookupSecretConsumer"
DENIED_CONSUMER="CdkdXaccDeniedConsumer"
NO_LOOKUP_CONSUMER="CdkdXaccNoLookupConsumer"
ALL_STACKS="${PRODUCER} ${CONSUMER} ${SECRET_CONSUMER} ${DENIED_CONSUMER} ${NO_LOOKUP_CONSUMER}"

READER_ROLE="${PRODUCER}PublishGetStackOutputRole"
PARAM_PREFIX="/cdkd/cdk-cross-account-lookup-role"
ALL_PARAMS="producer seed consumer secret-consumer denied-producer denied-consumer no-lookup-producer no-lookup-consumer"
PROBE_ROLE="cdkd-xacc-iam-probe-$$-${RANDOM}"

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-xacc-lookup.XXXXXX")"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Best-effort, under `set +eu` in its own subshell: never re-arms strict mode.
sweep_iam_role() { # usage: sweep_iam_role <role-name>
  (
    set +eu
    case "${1:-}" in
      CdkdXacc?* | cdkd-xacc-iam-probe-?*)
        for p in $(aws iam list-role-policies --role-name "$1" --query 'PolicyNames[]' --output text 2>/dev/null); do
          aws iam delete-role-policy --role-name "$1" --policy-name "$p" >/dev/null 2>&1
        done
        aws iam delete-role --role-name "$1" >/dev/null 2>&1
        ;;
      *)
        echo "WARN: teardown sweep refused — '${1:-}' is not one of this fixture's roles" >&2
        ;;
    esac
  )
}

cleanup() {
  echo "==> Cleanup: dropping leftover state, parameters and roles"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    for s in ${ALL_STACKS}; do
      node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    done
  fi
  for p in ${ALL_PARAMS}; do
    aws ssm delete-parameter --name "${PARAM_PREFIX}/${p}" --region "${REGION}" >/dev/null 2>&1
  done
  sweep_iam_role "${READER_ROLE}"
  sweep_iam_role "${PROBE_ROLE}"
  if [ -n "${STATE_BUCKET:-}" ]; then
    for s in ${ALL_STACKS}; do
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/state.json" >/dev/null 2>&1
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/lock.json" >/dev/null 2>&1
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    done
  fi
  rm -rf cdk.out
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  fail "STATE_BUCKET env var is required"
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  fail "local cdkd binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first"
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
case "${ACCOUNT}" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) : ;;
  *) fail "could not read this account's id (got '${ACCOUNT}')" ;;
esac
[ "${ACCOUNT}" != "${FAKE_PRODUCER_ACCOUNT}" ] || fail "this account is the fixture's fake producer account"
LOOKUP_ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/cdk-${QUALIFIER}-lookup-role-${ACCOUNT}-${REGION}"
RUN_TOKEN="run-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
export CDKD_XACC_ACCOUNT="${ACCOUNT}"
export CDKD_XACC_RUN_TOKEN="${RUN_TOKEN}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

echo "==> Precondition: ${ACCOUNT} is CDK-bootstrapped (${QUALIFIER}) in ${REGION}"
aws iam get-role --role-name "cdk-${QUALIFIER}-lookup-role-${ACCOUNT}-${REGION}" --query 'Role.Arn' --output text >/dev/null \
  || fail "lookup role cdk-${QUALIFIER}-lookup-role-${ACCOUNT}-${REGION} is missing — run 'cdk bootstrap' first"
aws iam get-role --role-name "cdk-${QUALIFIER}-cfn-exec-role-${ACCOUNT}-${REGION}" --query 'Role.Arn' --output text >/dev/null \
  || fail "cfn-exec role cdk-${QUALIFIER}-cfn-exec-role-${ACCOUNT}-${REGION} is missing — run 'cdk bootstrap' first"

# Run cdkd, keep its whole output (stdout AND stderr) in a log, and record the
# exit code in RC without tripping errexit. Usage: run_cdkd <log> <mode> <args...>
run_cdkd() {
  local log="$1" mode="$2"
  shift 2
  set +e
  CDKD_XACC_MODE="${mode}" node "${LOCAL_DIST}" "$@" >"${log}" 2>&1
  RC=$?
  set -e
  rm -rf cdk.out
}
# Every needle must be present; on a miss, print the log tail.
assert_log_has() { # usage: assert_log_has <log> <what> <needle>
  if ! grep -qF -- "$3" "$1"; then
    echo "----- ${1} (tail) -----" >&2
    tail -n 40 "$1" >&2
    fail "$2 (missing: $3)"
  fi
}
assert_log_lacks() { # usage: assert_log_lacks <log> <what> <needle>
  if grep -qF -- "$3" "$1"; then
    grep -nF -- "$3" "$1" | head -5 >&2
    fail "$2 (present: $3)"
  fi
}
# Nothing of a refused consumer reached AWS or the state bucket.
assert_consumer_untouched() { # usage: assert_consumer_untouched <stack> <param-suffix>
  assert_gone "$1 created its parameter despite the refusal" aws ssm get-parameter --name "${PARAM_PREFIX}/$2" --region "${REGION}"
  assert_gone "$1 has a state record after the refusal" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/$1/${REGION}/state.json"
  assert_gone "$1 left a lock after the refusal" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/$1/${REGION}/lock.json"
}

# A refusal at RESOLUTION time fails the resource's create, so cdkd's ordinary
# failed-first-deploy path keeps an EMPTY state record (and its rollback
# journal). It must hold zero resources; destroy it, then nothing may remain.
settle_refused_create() { # usage: settle_refused_create <stack> <mode>
  local key="cdkd/$1/${REGION}/state.json" state count
  if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"; then
    state="$(aws s3 cp "s3://${STATE_BUCKET}/${key}" -)"
    count="$(printf '%s' "${state}" | jq -r '.resources | length')"
    [ "${count}" = "0" ] || fail "$1's state records ${count} resource(s) after the refused create"
    echo "    (the refused create kept an empty state record; destroying it)"
    CDKD_XACC_MODE="$2" node "${LOCAL_DIST}" destroy "$1" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
  fi
  assert_gone "$1 has a state record after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
  assert_gone "$1 left a lock" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/$1/${REGION}/lock.json"
  assert_gone "$1 left a rollback journal" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/$1/${REGION}/rollback-journal.json"
}

# --- (c) IAM probe ------------------------------------------------------------
echo "==> (c) IAM: create a role whose trust names a role that does not exist"
MISSING_PRINCIPAL="arn:aws:iam::${ACCOUNT}:role/cdkd-does-not-exist-$$-${RANDOM}"
TRUST="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"${MISSING_PRINCIPAL}\"},\"Action\":\"sts:AssumeRole\"}]}"
set +e
IAM_OUT="$(aws iam create-role --role-name "${PROBE_ROLE}" --assume-role-policy-document "${TRUST}" --query 'Role.Arn' --output text 2>&1)"
IAM_RC=$?
set -e
echo "    IAM answered (rc=${IAM_RC}): ${IAM_OUT}"
if [ "${IAM_RC}" -eq 0 ]; then
  sweep_iam_role "${PROBE_ROLE}"
  fail "IAM ACCEPTED a trust principal naming a role that does not exist (${MISSING_PRINCIPAL})"
fi
case "${IAM_OUT}" in
  *MalformedPolicyDocument*"Invalid principal"*) : ;;
  *) fail "IAM refused the probe role with an unexpected error: ${IAM_OUT}" ;;
esac
assert_gone "IAM probe role ${PROBE_ROLE} exists" aws iam get-role --role-name "${PROBE_ROLE}"
echo "    OK: MalformedPolicyDocument (Invalid principal), no role created"

# --- (a) success: the generated shape, read through the lookup role -----------
echo "==> (a1) seed the SecureString the producer's SecretValue output references, then deploy ${PRODUCER}"
aws ssm put-parameter --name "${PARAM_PREFIX}/seed" --type SecureString --value "not-a-secret-${RUN_TOKEN}" \
  --overwrite --region "${REGION}" >/dev/null
run_cdkd "${LOG_DIR}/a1.log" success deploy "${PRODUCER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "${RC}" -eq 0 ] || { tail -n 40 "${LOG_DIR}/a1.log" >&2; fail "producer deploy exited ${RC}"; }

PRODUCER_VALUE="$(aws ssm get-parameter --name "${PARAM_PREFIX}/producer" --region "${REGION}" --query 'Parameter.Value' --output text)"
[ "${PRODUCER_VALUE}" = "cdk-cross-account-lookup-role ${RUN_TOKEN}" ] \
  || fail "producer parameter holds '${PRODUCER_VALUE}', not this run's token"
TRUST_PRINCIPAL="$(aws iam get-role --role-name "${READER_ROLE}" --query 'Role.AssumeRolePolicyDocument.Statement[0].Principal.AWS' --output text)"
[ "${TRUST_PRINCIPAL}" = "arn:aws:iam::${ACCOUNT}:role/cdk-${QUALIFIER}-cfn-exec-role-${ACCOUNT}-${REGION}" ] \
  || fail "generated-shape role trusts '${TRUST_PRINCIPAL}', not the cfn-exec role"
echo "    OK: producer deployed; role ${READER_ROLE} trusts only the cfn-exec role"
PRODUCER_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/cdkd/${PRODUCER}/${REGION}/state.json" -)"
SECRET_RECORDED="$(printf '%s' "${PRODUCER_STATE}" | jq -r '.outputs.SecretValue // empty')"
case "${SECRET_RECORDED}" in
  *"{{resolve:ssm-secure:${PARAM_PREFIX}/seed}}"*) : ;;
  *) fail "producer state records SecretValue as '${SECRET_RECORDED}', not its redacted dynamic reference" ;;
esac
if printf '%s' "${PRODUCER_STATE}" | grep -qF "not-a-secret-${RUN_TOKEN}"; then
  fail "producer state holds the SecureString's plaintext"
fi

echo "==> (a2) deploy consumer ${CONSUMER} (--verbose)"
run_cdkd "${LOG_DIR}/a2.log" success deploy "${CONSUMER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose
[ "${RC}" -eq 0 ] || { tail -n 40 "${LOG_DIR}/a2.log" >&2; fail "consumer deploy exited ${RC}"; }
CONSUMER_VALUE="$(aws ssm get-parameter --name "${PARAM_PREFIX}/consumer" --region "${REGION}" --query 'Parameter.Value' --output text)"
[ "${CONSUMER_VALUE}" = "${PRODUCER_VALUE}" ] \
  || fail "consumer parameter holds '${CONSUMER_VALUE}', expected the producer output '${PRODUCER_VALUE}'"
echo "    OK: consumer parameter == producer output (${CONSUMER_VALUE})"
# The detection line and the STS hop it leads to, and never the generated role.
assert_log_has "${LOG_DIR}/a2.log" "the reference was not detected as the generated one" \
  "is the AWS CDK-generated cross-account reader role; reading through the producer account's lookup role ${LOOKUP_ROLE_ARN}"
assert_log_has "${LOG_DIR}/a2.log" "the state read did not assume the lookup role" \
  "Assuming role for cross-account state read: ${LOOKUP_ROLE_ARN}"
assert_log_lacks "${LOG_DIR}/a2.log" "cdkd assumed the generated role" \
  "Assuming role for cross-account state read: arn:aws:iam::${ACCOUNT}:role/${READER_ROLE}"
assert_log_has "${LOG_DIR}/a2.log" "the resolved-reference info line is missing" \
  "Resolved Fn::GetStackOutput: StackName=${PRODUCER}"
echo "    OK: read through ${LOOKUP_ROLE_ARN}, not ${READER_ROLE}"

echo "==> (a3) deploy ${SECRET_CONSUMER}: an output carrying a dynamic reference is refused"
run_cdkd "${LOG_DIR}/a3.log" success deploy "${SECRET_CONSUMER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose
[ "${RC}" -ne 0 ] || fail "the secret-carrying cross-account read was NOT refused (exit 0)"
assert_log_has "${LOG_DIR}/a3.log" "the read did not take the lookup-role path" \
  "reading through the producer account's lookup role ${LOOKUP_ROLE_ARN}"
assert_log_has "${LOG_DIR}/a3.log" "not refused as a cross-account secret" \
  "is a redacted dynamic reference, and this is a CROSS-ACCOUNT reference"
assert_log_has "${LOG_DIR}/a3.log" "the refusal does not name the output" "output SecretValue of stack ${PRODUCER}"
assert_gone "${SECRET_CONSUMER} created its parameter despite the refusal" \
  aws ssm get-parameter --name "${PARAM_PREFIX}/secret-consumer" --region "${REGION}"
settle_refused_create "${SECRET_CONSUMER}" success
grep -m1 -oE 'Fn::GetStackOutput: output SecretValue.*' "${LOG_DIR}/a3.log" | sed 's/^/    refusal: /'
echo "    OK: refused (exit ${RC}) with the cross-account secret refusal; nothing created"

# --- (b1) the real generated reference, lookup role not assumable -------------
echo "==> (b1) deploy ${DENIED_CONSUMER} (producer in fake account ${FAKE_PRODUCER_ACCOUNT})"
run_cdkd "${LOG_DIR}/b1.log" denied deploy "${DENIED_CONSUMER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose
[ "${RC}" -ne 0 ] || fail "${DENIED_CONSUMER} deployed (exit 0) — expected the lookup-role refusal"
assert_log_has "${LOG_DIR}/b1.log" "not the generated-reference refusal" \
  "Fn::GetStackOutput: cannot read output"
assert_log_has "${LOG_DIR}/b1.log" "the refusal does not say the lookup role was denied" \
  "assuming the lookup role arn:aws:iam::${FAKE_PRODUCER_ACCOUNT}:role/cdk-${QUALIFIER}-lookup-role-${FAKE_PRODUCER_ACCOUNT}-${REGION} or reading cdkd-state-${FAKE_PRODUCER_ACCOUNT} with it was denied"
assert_log_has "${LOG_DIR}/b1.log" "remedy (1) missing" \
  "run 'cdk bootstrap --trust-for-lookup ${ACCOUNT}' (or '--trust ${ACCOUNT}')"
assert_log_has "${LOG_DIR}/b1.log" "remedy (2) missing" "cdk.Fn.getStackOutput('CdkdXaccDeniedProducer', "
assert_log_has "${LOG_DIR}/b1.log" "remedy (2) does not name the producer bucket" \
  "s3:GetBucketLocation and s3:GetObject on cdkd-state-${FAKE_PRODUCER_ACCOUNT}"
assert_log_lacks "${LOG_DIR}/b1.log" "cdkd fell back to assuming the generated role" \
  "Assuming role for cross-account state read: arn:aws:iam::${FAKE_PRODUCER_ACCOUNT}:role/CdkdXaccDeniedProducerPublish"
assert_gone "${DENIED_CONSUMER} created its parameter despite the refusal" \
  aws ssm get-parameter --name "${PARAM_PREFIX}/denied-consumer" --region "${REGION}"
settle_refused_create "${DENIED_CONSUMER}" denied
grep -m1 -oE 'Fn::GetStackOutput: cannot read output.*' "${LOG_DIR}/b1.log" | sed 's/^/    refusal: /'
echo "    OK: refused (exit ${RC}) naming both remedies; no resource created"

# --- (b2) the real generated reference, producer names no lookup role ---------
echo "==> (b2) deploy ${NO_LOOKUP_CONSUMER} (producer synthesizer names no lookup role)"
run_cdkd "${LOG_DIR}/b2.log" no-lookup deploy "${NO_LOOKUP_CONSUMER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose
[ "${RC}" -ne 0 ] || fail "${NO_LOOKUP_CONSUMER} deployed (exit 0) — expected the pre-flight refusal"
assert_log_has "${LOG_DIR}/b2.log" "not the generated-reference refusal" \
  "Fn::GetStackOutput: cannot read output"
assert_log_has "${LOG_DIR}/b2.log" "the refusal does not say the producer names no lookup role" \
  "the producer stack's artifact names no CDK lookup role in account ${FAKE_PRODUCER_ACCOUNT}"
assert_log_has "${LOG_DIR}/b2.log" "remedy (1) missing" \
  "run 'cdk bootstrap --trust-for-lookup ${ACCOUNT}' (or '--trust ${ACCOUNT}')"
assert_log_has "${LOG_DIR}/b2.log" "remedy (2) missing" "cdk.Fn.getStackOutput('CdkdXaccNoLookupProducer', "
# The pre-flight runs before any lock, STS hop or asset publish.
assert_log_lacks "${LOG_DIR}/b2.log" "a lock was attempted before the refusal" "Attempting to acquire lock"
assert_log_lacks "${LOG_DIR}/b2.log" "an STS hop ran before the refusal" "Assuming role for cross-account state read"
assert_consumer_untouched "${NO_LOOKUP_CONSUMER}" no-lookup-consumer
grep -m1 -oE 'Fn::GetStackOutput: cannot read output.*' "${LOG_DIR}/b2.log" | sed 's/^/    refusal: /'
echo "    OK: refused (exit ${RC}) by the pre-flight, before any lock; nothing created"

# --- teardown -----------------------------------------------------------------
echo "==> Destroy ${CONSUMER}, then ${PRODUCER}"
CDKD_XACC_MODE=success node "${LOCAL_DIST}" destroy "${CONSUMER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
CDKD_XACC_MODE=success node "${LOCAL_DIST}" destroy "${PRODUCER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

aws ssm delete-parameter --name "${PARAM_PREFIX}/seed" --region "${REGION}"
for p in ${ALL_PARAMS}; do
  assert_gone "parameter ${PARAM_PREFIX}/${p} still exists after destroy" \
    aws ssm get-parameter --name "${PARAM_PREFIX}/${p}" --region "${REGION}"
done
assert_gone "role ${READER_ROLE} still exists after destroy" aws iam get-role --role-name "${READER_ROLE}"
for s in ${ALL_STACKS}; do
  assert_gone "state of ${s} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${s}/${REGION}/state.json"
  assert_gone "lock of ${s} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${s}/${REGION}/lock.json"
done
echo "    OK: every parameter, the role, and every state / lock key are gone"

trap - EXIT INT TERM
rm -rf cdk.out "${LOG_DIR}"
echo "[verify] PASS — cdk-cross-account-lookup-role: generated reference read through ${LOOKUP_ROLE_ARN}; secret, denied and no-lookup arms refused; IAM rejects a missing principal"

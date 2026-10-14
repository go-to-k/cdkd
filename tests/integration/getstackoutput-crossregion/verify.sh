#!/usr/bin/env bash
# verify.sh — cdkd cross-region Fn::GetStackOutput integ test.
#
# Failure-seeking test for cdkd's UNIQUE same-account / CROSS-REGION
# `Fn::GetStackOutput` intrinsic. A CONSUMER stack deployed in one region
# reads a PRODUCER stack's output from ANOTHER region. This works because
# cdkd's state bucket is account-scoped (not region-scoped), so the
# consumer's resolver reads `cdkd/CdkdGsoProducer/us-west-2/state.json`
# from the same bucket its own state lives in.
#
#   1. Deploy PRODUCER (CdkdGsoProducer) in region X (us-west-2). Writes
#      an SSM parameter + `cdkd/CdkdGsoProducer/us-west-2/state.json`
#      with output ProducerArn.
#   2. Deploy CONSUMER (CdkdGsoConsumer) in region Y (us-east-1). Its SSM
#      parameter Value is `Fn::GetStackOutput` of the producer's
#      ProducerArn WITH an explicit `Region: us-west-2` argument.
#   3. Assert the consumer's SSM parameter on AWS (us-east-1) carries the
#      producer's REAL ARN value (which itself names us-west-2) — proving
#      the cross-region read worked AND resolved the correct value.
#   4. Destroy consumer (us-east-1) then producer (us-west-2); assert
#      both AWS resources AND both region-prefixed state files are gone.
#
# go-to-k/cdkd#4847 arm (state schema v12: a recorded reference is re-resolved
# in its RECORDED region, at its RECORDED version). Secrets named
# `cdkd-gso-4847-*` hold a queue name, under the SAME name in both regions with
# DIFFERENT values; the producer publishes each as a `{{resolve:...}}` output
# and a us-east-1 queue is named from it through `Fn::GetStackOutput`
# (`Region: us-west-2`). Its record holds `arn:...:{{resolve:...}}`, and the
# stack reads another region, so pre-fix a reader of `Queue.Arn` added while
# the queue is NO_CHANGE was sent the literal reference.
#   0.  Seed the secrets; deploy the producer and CdkdGsoConsumerPre with the
#       LAST v11 binary; rotate the `-rot` secret BEFORE the upgrade.
#   5a. Add the reader of `Queue.Arn`: it holds the us-west-2 queue's ARN.
#   5b. `cdkd drift`: no region refusal.
#   5c. A forced failure under --no-rollback, then `cdkd rollback`: the reader
#       is restored, with the us-west-2 queue's ARN.
#   5d. `cdkd scrub --dry-run --fail`: no refusal, nothing to scrub.
#   5e. Rotate the main secret, edit the reader: it still holds the ARN of the
#       queue AWS has (the version the queue's record holds).
#   6.  CdkdGsoConsumerPre under v12: the migration deploy captures the
#       provenance (region + version; region only for the rotated queue),
#       then the readers: the unrotated queue's ARN is served; the rotated
#       one is served as recorded with the generation warning, never from
#       us-east-1.
# Pre-fix red line: "deploy failed / value carries {{resolve: / holds the
# us-east-1 value" (5a, 5e, 6), "drift refused" (5b), "rollback refused" (5c).
#
# go-to-k/cdkd#4879 arm (a DESTROY of a secret-derived IAM principal list).
# `cdkd-gso-4847-iam-*` holds a ROLE name, again different per region; the role
# the us-west-2 value names is created here, outside any stack.
# CdkdGsoConsumer4879 (us-east-1) puts an inline policy on it through
# `Fn::GetStackOutput` (`Region: us-west-2`), so its record holds a region-less
# `{{resolve:...}}` beside a foreign producer region.
#   7a. Deploy it; premise: the policy is on the role, the record holds the
#       reference with recorded region us-west-2.
#   7b. Destroy it: exit 0, the policy is gone from the role, the state is
#       gone, and the destroy log never prints the role name.
# Pre-fix red line: "7b: destroy exited 2" and "7b: the inline policy is still
# on the role" (the record was skipped as ambiguous).
#
# go-to-k/cdkd#4887 arm (the same principal list in a NESTED CHILD destroyed
# on its own). CdkdGsoNested4887 (us-east-1) passes the us-west-2 role-name
# output to its child `Child` as a PARAMETER; the child's inline policy names
# the role through it. The child's own state records no cross-region read, and
# its record's v12 provenance names us-west-2.
#   8a. Deploy it; premise: the policy is on the role, the child record holds
#       the region-less reference with recorded region us-west-2.
#   8b. `cdkd state destroy 'CdkdGsoNested4887~Child'`: exit 0, the policy is
#       gone from the role, the child state is gone, no role name printed.
#   8c. Destroy the parent: exit 0, its state is gone.
# Pre-fix red line: "8b: the lone destroy of the child exited 2" (the child,
# destroyed on its own, was given no resolution opt-in and skipped the record).
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (account-scoped, e.g. cdkd-state-{accountId})
#   AWS_REGION   — informational; this test pins explicit per-stack regions
#                  (producer us-west-2, consumer us-east-1) regardless.
#
# The cdkd `/run-integ` skill exports STATE_BUCKET before invoking.

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

# go-to-k/cdkd#4847: the arm resolves secret dynamic references, so every
# state version this run wrote is swept and the sweep asserted at the end.
# shellcheck source=../s3-versions.sh
. ../s3-versions.sh

PRODUCER_STACK="CdkdGsoProducer"
CONSUMER_STACK="CdkdGsoConsumer"
PRODUCER_REGION="us-west-2"
CONSUMER_REGION="us-east-1"
PRODUCER_OUTPUT_NAME="ProducerArn"
PRODUCER_STATE_KEY="cdkd/${PRODUCER_STACK}/${PRODUCER_REGION}/state.json"
CONSUMER_STATE_KEY="cdkd/${CONSUMER_STACK}/${CONSUMER_REGION}/state.json"
PRODUCER_LOCK_KEY="cdkd/${PRODUCER_STACK}/${PRODUCER_REGION}/lock.json"
CONSUMER_LOCK_KEY="cdkd/${CONSUMER_STACK}/${CONSUMER_REGION}/lock.json"
PRODUCER_PARAM_NAME="/cdkd/getstackoutput-crossregion/producer"
CONSUMER_PARAM_NAME="/cdkd/getstackoutput-crossregion/consumer"

# go-to-k/cdkd#4847 arm.
PRE_STACK="CdkdGsoConsumerPre"
PRE_STATE_KEY="cdkd/${PRE_STACK}/${CONSUMER_REGION}/state.json"
PRE_LOCK_KEY="cdkd/${PRE_STACK}/${CONSUMER_REGION}/lock.json"
PRODUCER_STATE_PREFIX="$(s3_stack_prefix "${PRODUCER_STACK}" "${PRODUCER_REGION}")"
CONSUMER_STATE_PREFIX="$(s3_stack_prefix "${CONSUMER_STACK}" "${CONSUMER_REGION}")"
PRE_STATE_PREFIX="$(s3_stack_prefix "${PRE_STACK}" "${CONSUMER_REGION}")"
CONSUMER_JOURNAL_KEY="cdkd/${CONSUMER_STACK}/${CONSUMER_REGION}/rollback-journal.json"
READER_PARAM_NAME="/cdkd/getstackoutput-crossregion/reader"
READER_PRE_PARAM_NAME="/cdkd/getstackoutput-crossregion/reader-pre"
FAIL_PARAM_NAME="/cdkd/getstackoutput-crossregion/fail-probe"
# The LAST v11-writing release (the schema-v11-to-v12-migration fixture's).
V11_CDKD_VERSION="0.298.7"
V11_TMPDIR=""
V11_BIN=""
# Unique per run: a deleted queue's name cannot be reused for 60 s, and a
# force-deleted secret's name for a few seconds.
SUFFIX="$(date +%s)"
SECRET_MAIN="cdkd-gso-4847-${SUFFIX}"
SECRET_PRE="cdkd-gso-4847-pre-${SUFFIX}"
SECRET_ROT="cdkd-gso-4847-rot-${SUFFIX}"
# go-to-k/cdkd#4879 arm.
SECRET_IAM="cdkd-gso-4847-iam-${SUFFIX}"
STACK_4879="CdkdGsoConsumer4879"
STATE_KEY_4879="cdkd/${STACK_4879}/${CONSUMER_REGION}/state.json"
LOCK_KEY_4879="cdkd/${STACK_4879}/${CONSUMER_REGION}/lock.json"
STATE_PREFIX_4879="$(s3_stack_prefix "${STACK_4879}" "${CONSUMER_REGION}")"
ROLE_4879="cdkd-gso-4879-role-${SUFFIX}"
POLICY_4879="cdkd-gso-4879-inline"
CREATED_ROLE_4879=0
# go-to-k/cdkd#4887 arm: the #4879 role and secret, under a second policy.
STACK_4887="CdkdGsoNested4887"
CHILD_4887="${STACK_4887}~Child"
STATE_KEY_4887="cdkd/${STACK_4887}/${CONSUMER_REGION}/state.json"
LOCK_KEY_4887="cdkd/${STACK_4887}/${CONSUMER_REGION}/lock.json"
CHILD_STATE_KEY_4887="cdkd/${CHILD_4887}/${CONSUMER_REGION}/state.json"
CHILD_LOCK_KEY_4887="cdkd/${CHILD_4887}/${CONSUMER_REGION}/lock.json"
STATE_PREFIX_4887="$(s3_stack_prefix "${STACK_4887}" "${CONSUMER_REGION}")"
CHILD_STATE_PREFIX_4887="$(s3_stack_prefix "${CHILD_4887}" "${CONSUMER_REGION}")"
POLICY_4887="cdkd-gso-4887-inline"
CTX=(-c "gso4847Suffix=${SUFFIX}")
LOGDIR="$(mktemp -d)"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probes (both regions)"
  set +e
  # Try the binary's destroy first (cleanest path). Consumer first,
  # producer last — Fn::GetStackOutput is a weak reference so order
  # doesn't strictly matter, but mirrors real-world recommended order.
  # Each stack is destroyed against its OWN region.
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${CONSUMER_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${CONSUMER_REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${PRODUCER_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${PRODUCER_REGION}" --yes >/dev/null 2>&1
  fi
  # Direct API fallback so a half-deployed AWS resource doesn't leak —
  # delete the SSM parameter from the region it was created in.
  aws ssm delete-parameter --name "${CONSUMER_PARAM_NAME}" --region "${CONSUMER_REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PRODUCER_PARAM_NAME}" --region "${PRODUCER_REGION}" >/dev/null 2>&1 || true
  # Drop both region-prefixed state + lock sidecars from the
  # account-scoped bucket.
  aws s3 rm "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${CONSUMER_LOCK_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${PRODUCER_LOCK_KEY}" >/dev/null 2>&1 || true
  # go-to-k/cdkd#4847 arm: only THIS run's names (they end in its suffix), so a
  # concurrent run on the same account keeps its own; an older run's leftovers
  # are `/cleanup`'s.
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${PRE_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${CONSUMER_REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK_4879}" --state-bucket "${STATE_BUCKET:-}" --region "${CONSUMER_REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK_4887}" --state-bucket "${STATE_BUCKET:-}" --region "${CONSUMER_REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${CHILD_4887}" --state-bucket "${STATE_BUCKET:-}" --region "${CONSUMER_REGION}" --yes >/dev/null 2>&1
  fi
  # go-to-k/cdkd#4879: the role is this run's (created below, its name carries
  # the suffix); a skipped destroy leaves the inline policy on it.
  if [ "${CREATED_ROLE_4879}" = 1 ]; then
    aws iam delete-role-policy --role-name "${ROLE_4879}" --policy-name "${POLICY_4879}" >/dev/null 2>&1 || true
    aws iam delete-role-policy --role-name "${ROLE_4879}" --policy-name "${POLICY_4887}" >/dev/null 2>&1 || true
    aws iam delete-role --role-name "${ROLE_4879}" >/dev/null 2>&1 || true
  fi
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY_4879}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY_4879}" >/dev/null 2>&1 || true
  for k in "${STATE_KEY_4887}" "${LOCK_KEY_4887}" "${CHILD_STATE_KEY_4887}" "${CHILD_LOCK_KEY_4887}"; do
    aws s3 rm "s3://${STATE_BUCKET}/${k}" >/dev/null 2>&1 || true
  done
  for p in "${READER_PARAM_NAME}" "${READER_PRE_PARAM_NAME}" "${FAIL_PARAM_NAME}"; do
    aws ssm delete-parameter --name "${p}" --region "${CONSUMER_REGION}" >/dev/null 2>&1 || true
  done
  for q in $(aws sqs list-queues --queue-name-prefix cdkd-gso-4847 --region "${CONSUMER_REGION}" --query 'QueueUrls[]' --output text 2>/dev/null); do
    case "${q}" in *"-${SUFFIX}") ;; *) continue ;; esac
    aws sqs delete-queue --queue-url "${q}" --region "${CONSUMER_REGION}" >/dev/null 2>&1 || true
  done
  for r in "${PRODUCER_REGION}" "${CONSUMER_REGION}"; do
    for sid in $(aws secretsmanager list-secrets --region "${r}" --filters Key=name,Values=cdkd-gso-4847 --query 'SecretList[].Name' --output text 2>/dev/null); do
      case "${sid}" in *"-${SUFFIX}") ;; *) continue ;; esac
      aws secretsmanager delete-secret --secret-id "${sid}" --force-delete-without-recovery --region "${r}" >/dev/null 2>&1 || true
    done
  done
  aws s3 rm "s3://${STATE_BUCKET}/${PRE_STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${PRE_LOCK_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${CONSUMER_JOURNAL_KEY}" >/dev/null 2>&1 || true
  if [ -n "${V11_TMPDIR}" ] && [ -d "${V11_TMPDIR}" ]; then rm -rf "${V11_TMPDIR}"; fi
  # Noncurrent only: the current objects are what a failed run is debugged
  # from; the final teardown below takes every version.
  for prefix in "${PRODUCER_STATE_PREFIX}" "${CONSUMER_STATE_PREFIX}" "${PRE_STATE_PREFIX}" "${STATE_PREFIX_4879}" \
    "${STATE_PREFIX_4887}" "${CHILD_STATE_PREFIX_4887}"; do
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${prefix}" noncurrent || true
  done
  if [ "${1:-}" = "final" ]; then rm -rf "${LOGDIR}"; fi
  set -e
}

trap 'cleanup final' EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local cdkd binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup (drop any stranded state / probes from a prior failed integ)"
cleanup

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[ -n "${ACCOUNT_ID}" ] || fail "could not read the account id"
queue_arn() { printf 'arn:aws:sqs:%s:%s:%s' "${CONSUMER_REGION}" "${ACCOUNT_ID}" "$1"; }

seed_secret() { # <region> <name> <queue name>
  aws secretsmanager create-secret --region "$1" --name "$2" \
    --secret-string "{\"queue\":\"$3\"}" >/dev/null
}

param_value() { # <name>
  aws ssm get-parameter --name "$1" --region "${CONSUMER_REGION}" --query 'Parameter.Value' --output text
}

# --- Phase 0 (go-to-k/cdkd#4847): secrets in BOTH regions, a v11 deploy ----
echo "==> Phase 0: seed the cdkd-gso-4847 secrets (same names, different values per region)"
seed_secret "${PRODUCER_REGION}" "${SECRET_MAIN}" "cdkd-gso-4847-west-a-${SUFFIX}"
seed_secret "${CONSUMER_REGION}" "${SECRET_MAIN}" "cdkd-gso-4847-east-${SUFFIX}"
seed_secret "${PRODUCER_REGION}" "${SECRET_PRE}" "cdkd-gso-4847-pre-a-${SUFFIX}"
seed_secret "${CONSUMER_REGION}" "${SECRET_PRE}" "cdkd-gso-4847-pre-east-${SUFFIX}"
seed_secret "${PRODUCER_REGION}" "${SECRET_ROT}" "cdkd-gso-4847-rot-a-${SUFFIX}"
seed_secret "${CONSUMER_REGION}" "${SECRET_ROT}" "cdkd-gso-4847-rot-east-${SUFFIX}"
# go-to-k/cdkd#4879: a role name; only the us-west-2 value names a real role.
aws secretsmanager create-secret --region "${PRODUCER_REGION}" --name "${SECRET_IAM}" \
  --secret-string "{\"role\":\"${ROLE_4879}\"}" >/dev/null
aws secretsmanager create-secret --region "${CONSUMER_REGION}" --name "${SECRET_IAM}" \
  --secret-string "{\"role\":\"cdkd-gso-4879-east-${SUFFIX}\"}" >/dev/null
CREATED_ROLE_4879=1
aws iam create-role --role-name "${ROLE_4879}" \
  --description "cdkd getstackoutput-crossregion #4879 (named through a secret)" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  >/dev/null

echo "==> Phase 0: deploy ${PRODUCER_STACK} and ${PRE_STACK} with the v11 binary (@go-to-k/cdkd@${V11_CDKD_VERSION})"
V11_TMPDIR="$(mktemp -d)"
(cd "${V11_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${V11_CDKD_VERSION}" >/dev/null)
V11_BIN="${V11_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
[ -f "${V11_BIN}" ] || fail "the v11 binary was not installed at ${V11_BIN}"
node "${V11_BIN}" deploy "${PRODUCER_STACK}" "${CTX[@]}" \
  --state-bucket "${STATE_BUCKET}" --region "${PRODUCER_REGION}" --yes
node "${V11_BIN}" deploy "${PRE_STACK}" "${CTX[@]}" \
  --state-bucket "${STATE_BUCKET}" --region "${CONSUMER_REGION}" --yes
PRE_V11_VERSION="$(aws s3 cp "s3://${STATE_BUCKET}/${PRE_STATE_KEY}" - | jq -r '.version')"
[ "${PRE_V11_VERSION}" = "11" ] || fail "${PRE_STACK} state is version ${PRE_V11_VERSION} after the v11 deploy, expected 11"
aws sqs get-queue-url --queue-name "cdkd-gso-4847-rot-a-${SUFFIX}" --region "${CONSUMER_REGION}" >/dev/null \
  || fail "the v11 deploy did not create the rotated arm's queue cdkd-gso-4847-rot-a-${SUFFIX}"
echo "    OK: v11 state written; queues named from the us-west-2 values"
# Rotated BEFORE the upgrade: the queue keeps its name (create-only), so the
# v12 capture cannot match the current value and records the region only.
aws secretsmanager put-secret-value --region "${PRODUCER_REGION}" --secret-id "${SECRET_ROT}" \
  --secret-string "{\"queue\":\"cdkd-gso-4847-rot-b-${SUFFIX}\"}" >/dev/null
echo "    OK: ${SECRET_ROT} rotated in ${PRODUCER_REGION} before the upgrade"

# --- Phase 1: deploy PRODUCER in region X (us-west-2) --------------------
echo "==> Phase 1: deploy PRODUCER ${PRODUCER_STACK} in ${PRODUCER_REGION}"
node "${LOCAL_DIST}" deploy "${PRODUCER_STACK}" "${CTX[@]}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${PRODUCER_REGION}" \
  --yes

# The producer state must land under the us-west-2 region prefix.
if ! aws s3 ls "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: producer state file not found at ${PRODUCER_STATE_KEY} after deploy" >&2
  exit 1
fi
echo "    OK: producer state written at ${PRODUCER_STATE_KEY}"

# Capture the producer output value recorded in cdkd state so we can
# assert the consumer's cross-region read resolves to EXACTLY this.
PRODUCER_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" - 2>/dev/null)
PRODUCER_OUTPUT_VALUE=$(echo "${PRODUCER_STATE}" | jq -r --arg k "${PRODUCER_OUTPUT_NAME}" '.outputs[$k] // empty')
if [ -z "${PRODUCER_OUTPUT_VALUE}" ]; then
  echo "FAIL: producer state has no output '${PRODUCER_OUTPUT_NAME}'" >&2
  echo "${PRODUCER_STATE}" | jq '.outputs'
  exit 1
fi
echo "    OK: producer output ${PRODUCER_OUTPUT_NAME} = ${PRODUCER_OUTPUT_VALUE}"

# Sanity: the producer ARN must name us-west-2 (the SSM parameter ARN
# carries the region segment). If it doesn't, the producer didn't land
# in region X and the cross-region claim is moot.
case "${PRODUCER_OUTPUT_VALUE}" in
  *":${PRODUCER_REGION}:"*) : ;;
  *)
    echo "FAIL: producer ARN '${PRODUCER_OUTPUT_VALUE}' does not contain region segment ':${PRODUCER_REGION}:' — producer did not deploy to ${PRODUCER_REGION}" >&2
    exit 1
    ;;
esac
echo "    OK: producer ARN carries the ${PRODUCER_REGION} region segment"

# Cross-check against the real AWS parameter in us-west-2.
PRODUCER_PARAM_ARN=$(aws ssm get-parameter --name "${PRODUCER_PARAM_NAME}" --region "${PRODUCER_REGION}" --query 'Parameter.ARN' --output text 2>/dev/null)
if [ -z "${PRODUCER_PARAM_ARN}" ] || [ "${PRODUCER_PARAM_ARN}" = "None" ]; then
  echo "FAIL: producer SSM parameter not found in ${PRODUCER_REGION}" >&2
  exit 1
fi
echo "    OK: producer SSM parameter exists in ${PRODUCER_REGION} (ARN ${PRODUCER_PARAM_ARN})"

# --- Phase 2: deploy CONSUMER in region Y (us-east-1) -------------------
# The consumer's Fn::GetStackOutput reads the producer's output FROM
# us-west-2 (cross-region). If cdkd cannot read the producer's
# region-X state from the account-scoped bucket, this deploy fails at
# resolve time ("stack not found in region 'us-west-2'") and the test
# fails here with that error surfaced.
echo "==> Phase 2: deploy CONSUMER ${CONSUMER_STACK} in ${CONSUMER_REGION} (reads producer output cross-region from ${PRODUCER_REGION})"
node "${LOCAL_DIST}" deploy "${CONSUMER_STACK}" "${CTX[@]}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" \
  --yes

if ! aws s3 ls "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: consumer state file not found at ${CONSUMER_STATE_KEY} after deploy" >&2
  exit 1
fi
echo "    OK: consumer state written at ${CONSUMER_STATE_KEY}"

# --- Phase 3: assert the cross-region read resolved correctly ----------
# The consumer's SSM parameter (in us-east-1) must hold the producer's
# REAL output value (the us-west-2 ARN). This is the load-bearing
# assertion: it proves the cross-region Fn::GetStackOutput read both
# WORKED and resolved the CORRECT value (not stale / wrong / empty).
echo "==> Phase 3: assert consumer (${CONSUMER_REGION}) carries the producer's cross-region output value"
CONSUMER_PARAM_VALUE=$(aws ssm get-parameter --name "${CONSUMER_PARAM_NAME}" --region "${CONSUMER_REGION}" --query 'Parameter.Value' --output text 2>/dev/null)
if [ -z "${CONSUMER_PARAM_VALUE}" ] || [ "${CONSUMER_PARAM_VALUE}" = "None" ]; then
  echo "FAIL: consumer SSM parameter not found in ${CONSUMER_REGION}" >&2
  exit 1
fi

if [ "${CONSUMER_PARAM_VALUE}" != "${PRODUCER_OUTPUT_VALUE}" ]; then
  echo "FAIL: cross-region Fn::GetStackOutput resolved WRONG value." >&2
  echo "      consumer (${CONSUMER_REGION}) param value: '${CONSUMER_PARAM_VALUE}'" >&2
  echo "      expected producer (${PRODUCER_REGION}) output: '${PRODUCER_OUTPUT_VALUE}'" >&2
  exit 1
fi
echo "    OK: consumer param value == producer cross-region output (${CONSUMER_PARAM_VALUE})"

# Belt-and-suspenders: the resolved value must name the PRODUCER's
# region, not the consumer's — guards against a resolver that silently
# fell back to the consumer's own region and happened to find nothing /
# something else.
case "${CONSUMER_PARAM_VALUE}" in
  *":${PRODUCER_REGION}:"*) : ;;
  *)
    echo "FAIL: resolved consumer value '${CONSUMER_PARAM_VALUE}' does not name producer region '${PRODUCER_REGION}' — cross-region read may have resolved against the wrong region" >&2
    exit 1
    ;;
esac
echo "    OK: resolved value names producer region ${PRODUCER_REGION} (true cross-region read)"

# --- Phase 5 (go-to-k/cdkd#4847): a reader of a cross-region-named queue ---
MAIN_QUEUE="cdkd-gso-4847-west-a-${SUFFIX}"
EXPECTED_ARN="$(queue_arn "${MAIN_QUEUE}")"
EAST_VALUE="cdkd-gso-4847-east-${SUFFIX}"
aws sqs get-queue-url --queue-name "${MAIN_QUEUE}" --region "${CONSUMER_REGION}" >/dev/null \
  || fail "the consumer's queue was not named from the us-west-2 value (${MAIN_QUEUE} not found)"
QUEUE_PROV="$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - | jq -c '.resources.Queue.referenceProvenance')"
case "${QUEUE_PROV}" in
  *'"region":"us-west-2"'*) echo "    OK: the queue's record carries region us-west-2 (${QUEUE_PROV})" ;;
  *) fail "the queue's record carries no us-west-2 provenance: ${QUEUE_PROV}" ;;
esac

assert_reader() { # <label> <param> <expected value> <expected description or ''>
  local value
  value="$(param_value "$2")" || fail "$1: parameter $2 not found"
  case "${value}" in
    *'{{resolve:'*) fail "$1: $2 holds the literal reference: ${value}" ;;
    *"${EAST_VALUE}"*) fail "$1: $2 holds the us-east-1 secret's value: ${value}" ;;
  esac
  [ "${value}" = "$3" ] || fail "$1: $2 = '${value}', expected '$3'"
  if [ -n "$4" ]; then
    local desc
    if ! desc="$(aws ssm describe-parameters --region "${CONSUMER_REGION}" \
      --parameter-filters "Key=Name,Values=$2" --query 'Parameters[0].Description' --output text)"; then
      fail "$1: could not describe $2"
    fi
    [ "${desc}" = "$4" ] || fail "$1: $2 description '${desc}', expected '$4'"
  fi
  echo "    OK: $1: $2 = ${value}"
}

echo "==> Phase 5a: add a reader of Queue.Arn while the queue is NO_CHANGE"
node "${LOCAL_DIST}" deploy "${CONSUMER_STACK}" "${CTX[@]}" -c gso4847Reader=1 \
  --state-bucket "${STATE_BUCKET}" --region "${CONSUMER_REGION}" --yes \
  || fail "5a: the reader deploy failed (pre-fix: the literal reference was sent)"
assert_reader "5a" "${READER_PARAM_NAME}" "${EXPECTED_ARN}" "reader rev 1"

echo "==> Phase 5b: cdkd drift resolves the recorded region (no region refusal)"
DRIFT_RC=0
node "${LOCAL_DIST}" drift "${CONSUMER_STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" --json >"${LOGDIR}/drift.json" 2>"${LOGDIR}/drift.err" || DRIFT_RC=$?
# Nothing changed since 5a, so exit 0 and both records CLEAN (fully compared).
# Pre-fix: the region-less reference was refused (exit 2, notCompared).
if [ "${DRIFT_RC}" -ne 0 ] || grep -qE 'carries no region of its own|refused to resolve' "${LOGDIR}/drift.err"; then
  sed 's/^/  /' "${LOGDIR}/drift.err" "${LOGDIR}/drift.json" >&2
  fail "5b: drift exited ${DRIFT_RC} (pre-fix: it refused the region-less reference, exit 2)"
fi
for id in Queue QueueArnReader; do
  CLEAN="$(jq -r --arg id "${id}" '[.[].clean[]? | select(.logicalId == $id)] | length' "${LOGDIR}/drift.json")" \
    || fail "5b: could not parse the drift JSON"
  [ "${CLEAN}" = "1" ] || fail "5b: ${id} is not reported clean by drift"
  UNRESOLVED="$(jq -r --arg id "${id}" '[.. | objects | select(.logicalId == $id) | .referencesUnresolved // false] | any' "${LOGDIR}/drift.json")" \
    || fail "5b: could not parse the drift JSON"
  [ "${UNRESOLVED}" = "false" ] || fail "5b: ${id} carries referencesUnresolved"
done
echo "    OK: drift exited 0, Queue and QueueArnReader clean and fully compared"

echo "==> Phase 5c: a forced failure under --no-rollback, then cdkd rollback"
FAIL_RC=0
node "${LOCAL_DIST}" deploy "${CONSUMER_STACK}" "${CTX[@]}" -c gso4847Reader=2 -c gso4847Fail=1 \
  --state-bucket "${STATE_BUCKET}" --region "${CONSUMER_REGION}" --yes --no-rollback \
  >"${LOGDIR}/fail-deploy.log" 2>&1 || FAIL_RC=$?
[ "${FAIL_RC}" -ne 0 ] || fail "5c: the deploy with FailProbe succeeded; the rollback below would replay nothing"
assert_reader "5c (the failed deploy updated the reader)" "${READER_PARAM_NAME}" "${EXPECTED_ARN}" "reader rev 2"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_JOURNAL_KEY}" >/dev/null \
  || fail "5c: no rollback journal after the failed --no-rollback deploy"
# PREMISE: the replay's desired side (the journaled previousState) carries
# the recorded region; without it the rollback below takes the v11 refusal.
JOURNAL_REGION="$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_JOURNAL_KEY}" - \
  | jq -r '[.. | objects | select(.logicalId == "QueueArnReader") | .previousState.referenceProvenance? // empty | .[] | .region | select(. != null)] | unique | join(",")')" \
  || fail "5c: could not read the rollback journal"
[ "${JOURNAL_REGION}" = "${PRODUCER_REGION}" ] \
  || fail "5c: premise: the journaled previousState of QueueArnReader records region '${JOURNAL_REGION}', expected ${PRODUCER_REGION}"
ROLLBACK_RC=0
node "${LOCAL_DIST}" rollback "${CONSUMER_STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" --force >"${LOGDIR}/rollback.log" 2>&1 || ROLLBACK_RC=$?
if [ "${ROLLBACK_RC}" -ne 0 ]; then
  sed 's/^/  /' "${LOGDIR}/rollback.log" >&2
  fail "5c: cdkd rollback exited ${ROLLBACK_RC} (pre-fix: the replay refused the region-less reference)"
fi
assert_reader "5c (restored)" "${READER_PARAM_NAME}" "${EXPECTED_ARN}" "reader rev 1"

echo "==> Phase 5d: cdkd scrub --dry-run --fail"
SCRUB_RC=0
# Today's template (with the reader), so scrub resolves what the deploy did.
node "${LOCAL_DIST}" scrub "${CONSUMER_STACK}" "${CTX[@]}" -c gso4847Reader=1 --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" --dry-run --fail >"${LOGDIR}/scrub.log" 2>&1 || SCRUB_RC=$?
if [ "${SCRUB_RC}" -ne 0 ]; then
  sed 's/^/  /' "${LOGDIR}/scrub.log" >&2
  fail "5d: scrub exited ${SCRUB_RC}"
fi
echo "    OK: scrub clean"

echo "==> Phase 5e: rotate ${SECRET_MAIN} in ${PRODUCER_REGION}, then edit the reader"
aws secretsmanager put-secret-value --region "${PRODUCER_REGION}" --secret-id "${SECRET_MAIN}" \
  --secret-string "{\"queue\":\"cdkd-gso-4847-west-b-${SUFFIX}\"}" >/dev/null
node "${LOCAL_DIST}" deploy "${CONSUMER_STACK}" "${CTX[@]}" -c gso4847Reader=3 \
  --state-bucket "${STATE_BUCKET}" --region "${CONSUMER_REGION}" --yes \
  || fail "5e: the reader edit after the rotation failed (pre-fix: the literal reference was sent)"
# The queue is NO_CHANGE (its name is create-only and the diff compares the
# reference), so AWS still has the pre-rotation queue: the reader must name it.
assert_reader "5e" "${READER_PARAM_NAME}" "${EXPECTED_ARN}" "reader rev 3"
if aws sqs get-queue-url --queue-name "cdkd-gso-4847-west-b-${SUFFIX}" --region "${CONSUMER_REGION}" >/dev/null 2>&1; then
  fail "5e: a queue named from the rotated value exists; the queue was replaced"
fi

# --- Phase 6 (go-to-k/cdkd#4847): a consumer deployed before the upgrade ----
echo "==> Phase 6a: the first v12 deploy of ${PRE_STACK} (the one-time capture)"
node "${LOCAL_DIST}" deploy "${PRE_STACK}" "${CTX[@]}" \
  --state-bucket "${STATE_BUCKET}" --region "${CONSUMER_REGION}" --yes \
  || fail "6a: the migration deploy of ${PRE_STACK} failed"
PRE_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${PRE_STATE_KEY}" -)"
[ "$(printf '%s' "${PRE_STATE}" | jq -r '.version')" = "12" ] || fail "6a: ${PRE_STACK} state is not version 12"
STILL_PROV="$(printf '%s' "${PRE_STATE}" | jq -c '[.resources.QueueStill.referenceProvenance[]?]')"
ROT_PROV="$(printf '%s' "${PRE_STATE}" | jq -c '[.resources.QueueRotated.referenceProvenance[]?]')"
case "${STILL_PROV}" in
  *'"region":"us-west-2"'*'"versions"'* | *'"versions"'*'"region":"us-west-2"'*) ;;
  *) fail "6a: QueueStill's capture is not region us-west-2 + versions: ${STILL_PROV}" ;;
esac
case "${ROT_PROV}" in
  *'"versions"'*) fail "6a: QueueRotated's capture recorded a version after a rotation: ${ROT_PROV}" ;;
  *'"region":"us-west-2"'*) ;;
  *) fail "6a: QueueRotated's capture recorded no us-west-2 region: ${ROT_PROV}" ;;
esac
echo "    OK: capture: QueueStill ${STILL_PROV}, QueueRotated ${ROT_PROV}"

echo "==> Phase 6b: add the readers of the pre-upgrade queues"
node "${LOCAL_DIST}" deploy "${PRE_STACK}" "${CTX[@]}" -c gso4847PreReaders=1 \
  --state-bucket "${STATE_BUCKET}" --region "${CONSUMER_REGION}" --yes \
  >"${LOGDIR}/pre-readers.log" 2>&1 || {
  sed 's/^/  /' "${LOGDIR}/pre-readers.log" >&2
  fail "6b: the readers deploy failed (pre-fix: the literal reference was sent)"
}
EAST_VALUE="cdkd-gso-4847-pre-east-${SUFFIX}"
assert_reader "6b (QueueStill: the region arm and the version arm)" "${READER_PRE_PARAM_NAME}" \
  "$(queue_arn "cdkd-gso-4847-pre-a-${SUFFIX}")" ""
# The rotated queue: no version was recordable, and the current value is not
# its name, so the physical-id proof fails in us-west-2 and the value is
# served as recorded, with the generation warning. Never a us-east-1 value.
ROTATED_OUT="$(aws s3 cp "s3://${STATE_BUCKET}/${PRE_STATE_KEY}" - | jq -r '.outputs.RotatedArn')"
case "${ROTATED_OUT}" in
  *"rot-east-${SUFFIX}"* | *"rot-b-${SUFFIX}"*) fail "6b: RotatedArn holds a value that is not the queue's: ${ROTATED_OUT}" ;;
  *'{{resolve:'*) ;;
  *) fail "6b: RotatedArn is not the recorded reference: ${ROTATED_OUT}" ;;
esac
grep -q 'cannot confirm the secret still holds the value' "${LOGDIR}/pre-readers.log" \
  || fail "6b: no generation warning for QueueRotated"
echo "    OK: QueueRotated served as recorded, with the generation warning"

# --- Phase 7 (go-to-k/cdkd#4879): destroy a cross-region secret principal ----
echo "==> Phase 7a: deploy ${STACK_4879} (an inline policy on a role named from the us-west-2 secret)"
node "${LOCAL_DIST}" deploy "${STACK_4879}" "${CTX[@]}" \
  --state-bucket "${STATE_BUCKET}" --region "${CONSUMER_REGION}" --yes \
  || fail "7a: the deploy of ${STACK_4879} failed"
aws iam get-role-policy --role-name "${ROLE_4879}" --policy-name "${POLICY_4879}" >/dev/null \
  || fail "7a: premise: the inline policy is not on the role the us-west-2 value names"
STATE_4879="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY_4879}" -)" || fail "7a: could not read the ${STACK_4879} state"
ROLES_4879="$(printf '%s' "${STATE_4879}" | jq -r '.resources.Policy4879.properties.Roles[0] // empty')"
case "${ROLES_4879}" in
  "{{resolve:secretsmanager:${SECRET_IAM}:"*) ;;
  *) fail "7a: premise: the record's Roles is not the region-less reference (got '${ROLES_4879}')" ;;
esac
REGION_4879="$(printf '%s' "${STATE_4879}" | jq -r --arg t "${ROLES_4879}" '.resources.Policy4879.referenceProvenance[$t].region // empty')"
[ "${REGION_4879}" = "${PRODUCER_REGION}" ] \
  || fail "7a: premise: the record's provenance gives the reference region '${REGION_4879}', expected ${PRODUCER_REGION}"
READS_4879="$(printf '%s' "${STATE_4879}" | jq -r '[.outputReads[]?.sourceRegion] | unique | join(",")')"
[ "${READS_4879}" = "${PRODUCER_REGION}" ] \
  || fail "7a: premise: the stack's recorded cross-region reads are '${READS_4879}', expected ${PRODUCER_REGION} (without them the reference is not ambiguous)"
echo "    OK: policy on the role; the record holds the reference, recorded in ${PRODUCER_REGION}"

echo "==> Phase 7b: destroy ${STACK_4879}"
DESTROY_4879_RC=0
node "${LOCAL_DIST}" destroy "${STACK_4879}" --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" --force >"${LOGDIR}/destroy-4879.log" 2>&1 || DESTROY_4879_RC=$?
if [ "${DESTROY_4879_RC}" -ne 0 ]; then
  sed 's/^/  /' "${LOGDIR}/destroy-4879.log" >&2
  fail "7b: destroy exited ${DESTROY_4879_RC} (pre-fix: 2, the record skipped as ambiguous)"
fi
assert_gone "7b: the inline policy is still on the role after the destroy" \
  aws iam get-role-policy --role-name "${ROLE_4879}" --policy-name "${POLICY_4879}"
assert_gone "7b: ${STACK_4879} state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_4879}"
grep -q 'resolved to the principals the secret names NOW' "${LOGDIR}/destroy-4879.log" \
  || fail "7b: no resolution warning in the destroy log (the policy was not removed by resolving the reference)"
if grep -qF "${ROLE_4879}" "${LOGDIR}/destroy-4879.log"; then
  fail "7b: the destroy log prints the secret-derived role name"
fi
echo "    OK: destroy exited 0, the policy is gone from the role, no role name printed"

# --- Phase 8 (go-to-k/cdkd#4887): the same, in a nested child destroyed alone ---
echo "==> Phase 8a: deploy ${STACK_4887} (its nested child puts an inline policy on the role, named through a parameter)"
node "${LOCAL_DIST}" deploy "${STACK_4887}" "${CTX[@]}" \
  --state-bucket "${STATE_BUCKET}" --region "${CONSUMER_REGION}" --yes \
  || fail "8a: the deploy of ${STACK_4887} failed"
aws iam get-role-policy --role-name "${ROLE_4879}" --policy-name "${POLICY_4887}" >/dev/null \
  || fail "8a: premise: the nested child's inline policy is not on the role the us-west-2 value names"
CHILD_STATE_4887="$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY_4887}" -)" \
  || fail "8a: could not read the ${CHILD_4887} state"
[ "$(printf '%s' "${CHILD_STATE_4887}" | jq -r '.parentStack // empty')" = "${STACK_4887}" ] \
  || fail "8a: premise: the child record does not name ${STACK_4887} as its parent"
ROLES_4887="$(printf '%s' "${CHILD_STATE_4887}" | jq -r '.resources.Policy4887.properties.Roles[0] // empty')"
case "${ROLES_4887}" in
  "{{resolve:secretsmanager:${SECRET_IAM}:"*) ;;
  *) fail "8a: premise: the child record's Roles is not the region-less reference (got '${ROLES_4887}')" ;;
esac
REGION_4887="$(printf '%s' "${CHILD_STATE_4887}" | jq -r --arg t "${ROLES_4887}" '.resources.Policy4887.referenceProvenance[$t].region // empty')"
[ "${REGION_4887}" = "${PRODUCER_REGION}" ] \
  || fail "8a: premise: the child record's provenance gives the reference region '${REGION_4887}', expected ${PRODUCER_REGION}"
[ "$(printf '%s' "${CHILD_STATE_4887}" | jq '(.outputReads // []) + (.imports // []) | length')" = 0 ] \
  || fail "8a: premise: the child record holds its own cross-stack reads (the arm needs a child that reads nothing itself)"
echo "    OK: policy on the role; the child record holds the reference, recorded in ${PRODUCER_REGION}"

echo "==> Phase 8b: cdkd state destroy '${CHILD_4887}' (the child on its own)"
DESTROY_4887_RC=0
node "${LOCAL_DIST}" state destroy "${CHILD_4887}" --state-bucket "${STATE_BUCKET:-}" \
  --region "${CONSUMER_REGION}" --yes >"${LOGDIR}/destroy-4887.log" 2>&1 || DESTROY_4887_RC=$?
if [ "${DESTROY_4887_RC}" -ne 0 ]; then
  sed 's/^/  /' "${LOGDIR}/destroy-4887.log" >&2
  fail "8b: the lone destroy of the child exited ${DESTROY_4887_RC} (pre-fix: 2, the record skipped without its parent)"
fi
assert_gone "8b: the nested child's inline policy is still on the role after its destroy" \
  aws iam get-role-policy --role-name "${ROLE_4879}" --policy-name "${POLICY_4887}"
assert_gone "8b: ${CHILD_4887} state file still exists after its destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY_4887}"
grep -q 'resolved to the principals the secret names NOW' "${LOGDIR}/destroy-4887.log" \
  || fail "8b: no resolution warning in the destroy log (the policy was not removed by resolving the reference)"
if grep -qF 'destroy it through its parent stack' "${LOGDIR}/destroy-4887.log"; then
  fail "8b: the destroy printed the parent-stack hint for a reference its record places in a region"
fi
if grep -qF "${ROLE_4879}" "${LOGDIR}/destroy-4887.log"; then
  fail "8b: the destroy log prints the secret-derived role name"
fi
echo "    OK: the child's destroy exited 0, the policy is gone from the role, no role name printed"

echo "==> Phase 8c: destroy ${STACK_4887} (its child is already gone)"
node "${LOCAL_DIST}" destroy "${STACK_4887}" --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" --force \
  || fail "8c: the destroy of ${STACK_4887} failed"
assert_gone "8c: ${STACK_4887} state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_4887}"
echo "    OK: ${STACK_4887} is gone"

# --- Phase 4: destroy both, assert clean in BOTH regions ---------------
echo "==> Phase 4a: destroy CONSUMER ${CONSUMER_STACK} (${CONSUMER_REGION})"
node "${LOCAL_DIST}" destroy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" \
  --force

assert_gone "consumer parameter still exists in ${CONSUMER_REGION} after destroy" aws ssm get-parameter --name "${CONSUMER_PARAM_NAME}" --region "${CONSUMER_REGION}"
assert_gone "consumer state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"
echo "    OK: consumer is gone (AWS resource in ${CONSUMER_REGION} + state)"

assert_gone "the reader parameter still exists after destroy" aws ssm get-parameter --name "${READER_PARAM_NAME}" --region "${CONSUMER_REGION}"

echo "==> Phase 4a2: destroy ${PRE_STACK} (${CONSUMER_REGION})"
node "${LOCAL_DIST}" destroy "${PRE_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" \
  --force
assert_gone "the pre-upgrade reader parameter still exists after destroy" aws ssm get-parameter --name "${READER_PRE_PARAM_NAME}" --region "${CONSUMER_REGION}"
assert_gone "${PRE_STACK} state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PRE_STATE_KEY}"
# SQS keeps listing a deleted queue for up to 60 s: poll before calling it a leak.
LEFT_QUEUES=""
for _ in $(seq 1 18); do
  LEFT_QUEUES="$(aws sqs list-queues --queue-name-prefix "cdkd-gso-4847" --region "${CONSUMER_REGION}" \
    --query 'QueueUrls[]' --output text)" || fail "could not list the cdkd-gso-4847 queues"
  LEFT_QUEUES="$(printf '%s\n' ${LEFT_QUEUES} | grep -e "-${SUFFIX}\$" || true)"
  [ -z "${LEFT_QUEUES}" ] && break
  sleep 5
done
[ -z "${LEFT_QUEUES}" ] || fail "this run's queues remain after destroy: ${LEFT_QUEUES}"
echo "    OK: ${PRE_STACK} is gone, no queue of this run remains"

echo "==> Phase 4b: destroy PRODUCER ${PRODUCER_STACK} (${PRODUCER_REGION})"
node "${LOCAL_DIST}" destroy "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${PRODUCER_REGION}" \
  --force

assert_gone "producer parameter still exists in ${PRODUCER_REGION} after destroy" aws ssm get-parameter --name "${PRODUCER_PARAM_NAME}" --region "${PRODUCER_REGION}"
assert_gone "producer state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PRODUCER_STATE_KEY}"
echo "    OK: producer is gone (AWS resource in ${PRODUCER_REGION} + state)"

# Every state version this run wrote (go-to-k/cdkd#4847: a secret-resolving
# arm), after the final cleanup, with the trap disarmed so nothing writes a
# new marker after the count.
cleanup final
trap - EXIT INT TERM
for prefix in "${PRODUCER_STATE_PREFIX}" "${CONSUMER_STATE_PREFIX}" "${PRE_STATE_PREFIX}" "${STATE_PREFIX_4879}" \
  "${STATE_PREFIX_4887}" "${CHILD_STATE_PREFIX_4887}"; do
  s3_purge_prefix_versions "${STATE_BUCKET}" "${prefix}" all || true
  s3_assert_versions_swept "${STATE_BUCKET}" "${prefix}" "getstackoutput-crossregion ${prefix} teardown"
done
# After the sweep, so a failure here still leaves the state history swept.
# go-to-k/cdkd#4879: the role is created outside any stack under a name no
# stack-prefix sweep matches, so a failed delete must fail the run here.
if [ "${CREATED_ROLE_4879}" = 1 ]; then
  assert_gone "the #4879 role ${ROLE_4879} leaked after cleanup" aws iam get-role --role-name "${ROLE_4879}"
fi

echo ""
echo "==> getstackoutput-crossregion test passed (cross-region Fn::GetStackOutput resolved correctly + both regions clean)"

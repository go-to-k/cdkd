#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the S3 bucket arm: a fix-forward deploy deletes the bucket
# an earlier failed CREATE left in AWS, once a live read
# (`S3BucketProvider.isSameResource`) proves it is not the bucket the new state
# record holds, and its journaled identity (name, region and this account's
# `ListBuckets` `CreationDate`, `S3BucketProvider.resourceIdentity`) proves the
# bucket under the name is still the one that CREATE made. A bucket whose name
# was deleted and re-used in between is kept.
#
# Phases:
#   1. Baseline deploy: `BaseBucket` alone.
#   2. The failed CREATE. A role is created that may create a bucket and
#      enable its versioning (and list and locate buckets) but may neither tag
#      nor delete it. A `--no-rollback` deploy run as that role with
#      WITH_ORPHANS=true creates `OrphanA`'s and `OrphanC`'s buckets, enables
#      their versioning, fails on the tagging call that follows, and the
#      provider's own cleanup cannot delete them. (The AccessDenied is retried
#      as IAM propagation; the retry meets the bucket and refuses it as an
#      explicit name already held, so the deploy's last line for each is that
#      refusal, while the first attempt's created-bucket mark is carried to
#      the journal.) Asserted: the
#      deploy failed, both buckets exist, no state record holds them, and the
#      rollback journal carries each as a proven orphan with its identity
#      `<name>|<region>|<CreationDate>`, equal to what ListBuckets reports.
#   2b. The re-used name: `OrphanC`'s bucket is deleted and its name created
#      again outside the stack, with a marker tag. Asserted: ListBuckets now
#      reports another CreationDate for it (the premise the identity rests on).
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps both
#      logical ids under other names (`-b`). Asserted: `OrphanA`'s earlier
#      bucket is deleted (`deleting partially-created OrphanA`), the re-created
#      `OrphanC` name is kept with its marker and warned about as another
#      bucket (exit 2, the warning's code), the journal is dropped, and the
#      state records hold the new buckets. Before #4606 the deploy kept
#      `OrphanA`'s bucket too.
#   2c. An object is written into `OrphanD`'s bucket (a third orphan, whose
#      template declares CDK's autoDeleteObjects opt-in).
#   (3, also) `OrphanD`'s bucket is NOT emptied: it keeps the object, the
#      deploy says cdkd never empties such a bucket, and the journal keeps that
#      entry alone.
#   4. Destroy, and every bucket and the state file are gone, and the state
#      prefix's object versions are swept.
#
# Region: us-west-2 by default, the stricter case. Measured for #4606 (us-east-1
# and us-west-2, 2026-10-08): outside us-east-1 a bucket's `CreationDate` moves
# to the second of a versioning, tagging, encryption or policy write, while in
# us-east-1 it does not. The failed CREATE above writes versioning before it
# fails, so the identity it journals must already carry that moved date: the
# read has to come after the CREATE's last write.
#
# Cost: a handful of empty buckets. On any failure, cleanup deletes every
# bucket this run names, destroys the stack and deletes the role.
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
# S3 propagates a DeleteBucket to HeadBucket asynchronously: retry the
# gone-probe on a bounded schedule. A bucket that never disappears still FAILs.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws s3api head-bucket ...
  local desc="$1"; shift
  for _ in $(seq 1 10); do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 3
  done
  echo "FAIL: ${desc} (still present after 10 probes over ~30s)" >&2
  exit 1
}

REGION="${AWS_REGION:-us-west-2}"
export AWS_REGION="${REGION}"
STACK="CdkdS3FixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/s3-fix-forward-orphan"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096): the state bucket is
# versioned, and the journal and state records this run writes stay readable
# as noncurrent versions. Sourced by absolute path, before the `cd` below, so
# the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The names the stack derives (lib/s3-fix-forward-orphan-stack.ts).
BASE_BUCKET="cdkd-s3ffo-base-${ACCOUNT_ID}"
BUCKET_A="cdkd-s3ffo-a-${ACCOUNT_ID}"
BUCKET_A_B="cdkd-s3ffo-a-b-${ACCOUNT_ID}"
BUCKET_C="cdkd-s3ffo-c-${ACCOUNT_ID}"
BUCKET_C_B="cdkd-s3ffo-c-b-${ACCOUNT_ID}"
BUCKET_D="cdkd-s3ffo-d-${ACCOUNT_ID}"
BUCKET_D_B="cdkd-s3ffo-d-b-${ACCOUNT_ID}"
ALL_BUCKETS=("${BASE_BUCKET}" "${BUCKET_A}" "${BUCKET_A_B}" "${BUCKET_C}" "${BUCKET_C_B}" "${BUCKET_D}" "${BUCKET_D_B}")

# The one object this run writes, into OrphanD's bucket.
D_OBJECT_KEY="cdkd-integ/held-data.txt"

DENY_ROLE="${STACK}-no-tagging"
DENY_POLICY_NAME="create-without-configure"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the buckets or the
# stack may belong to a concurrent or earlier run, which a failure-path delete
# must not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The bucket's CreationDate in this account's ListBuckets, normalized to the
# ISO form the provider journals (`Date#toISOString`), or empty when unlisted.
listed_creation_date() { # usage: listed_creation_date <bucket>
  local raw
  raw="$(aws s3api list-buckets --prefix "$1" --region "${REGION}" \
    --query "Buckets[?Name=='$1'].CreationDate | [0]" --output text)" || return 1
  if [ -z "${raw}" ] || [ "${raw}" = "None" ]; then
    return 0
  fi
  node -e 'process.stdout.write(new Date(process.argv[1]).toISOString())' "${raw}"
}

# Outside us-east-1 a CreateBucket names its region.
CREATE_CFG=()
if [ "${REGION}" != "us-east-1" ]; then
  CREATE_CFG=(--create-bucket-configuration "LocationConstraint=${REGION}")
fi
# Create a bucket, tolerating S3's post-delete namespace window
# (`OperationAborted` for a few seconds after a same-name delete).
plant_bucket() { # usage: plant_bucket <bucket>
  local out
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if out="$(aws s3api create-bucket --bucket "$1" --region "${REGION}" ${CREATE_CFG[@]+"${CREATE_CFG[@]}"} 2>&1)"; then
      return 0
    fi
    if ! printf '%s' "${out}" | grep -q 'OperationAborted'; then
      echo "[verify] FAIL: create-bucket $1: ${out}" >&2
      return 1
    fi
    echo "  (create-bucket $1: OperationAborted, attempt ${attempt}/10)"
    sleep 5
  done
  echo "[verify] FAIL: create-bucket $1 still OperationAborted after 10 attempts" >&2
  return 1
}

delete_bucket_by_name() { ( # usage: delete_bucket_by_name <bucket>  (best-effort)
  set +eu
  aws s3api delete-bucket --bucket "$1" --region "${REGION}" >/dev/null 2>&1
  true
); }
# OrphanD's bucket is versioned and holds the one object this run wrote:
# delete every version and delete marker of that key (best-effort).
empty_bucket_by_name() { ( # usage: empty_bucket_by_name <bucket>
  set +eu
  for v in $(aws s3api list-object-versions --bucket "$1" --region "${REGION}" --prefix "${D_OBJECT_KEY}" \
    --query '[Versions[].VersionId, DeleteMarkers[].VersionId][]' --output text 2>/dev/null); do
    [ "${v}" = "None" ] && continue
    aws s3api delete-object --bucket "$1" --region "${REGION}" --key "${D_OBJECT_KEY}" --version-id "${v}" >/dev/null 2>&1
  done
  true
); }
delete_deny_role() { ( # usage: delete_deny_role
  set +eu
  aws iam delete-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" >/dev/null 2>&1
  aws iam delete-role --role-name "${DENY_ROLE}" >/dev/null 2>&1
  true
); }

cleanup() {
  rc=$?
  set +eu
  rm -rf "${LOG_DIR}"
  if [ -n "${DENY_ROLE_CREATED}" ]; then
    delete_deny_role
    for _ in $(seq 1 12); do
      if ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then break; fi
      sleep 5
    done
    if ! ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then
      echo "[verify] WARN: role ${DENY_ROLE} could not be confirmed deleted; delete it by hand" >&2
    fi
  fi
  if [ "${rc}" -ne 0 ] && [ -n "${CLEANUP_ARMED}" ]; then
    echo "[verify] FAIL (exit ${rc}) -- attempting cleanup"
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    # Then by name, for the buckets no state record holds (the orphans and
    # the re-created name). OrphanD's holds the one object step 2c wrote,
    # emptied first.
    empty_bucket_by_name "${BUCKET_D}"
    for b in "${ALL_BUCKETS[@]}"; do
      delete_bucket_by_name "${b}"
    done
  elif [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) before the preconditions passed -- nothing of this run to clean up"
  fi
  # NONCURRENT only, per ../s3-versions.sh: on a failure a live state.json may
  # be the only record of what is still standing. The success path sweeps all.
  if [ -n "${CLEANUP_ARMED}" ]; then
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent
  fi
  exit "${rc}"
}
trap cleanup EXIT
# Drop the EXIT trap first: the signal handler's own `exit` would otherwise
# run the cleanup a second time.
trap 'trap - EXIT; (exit 130); cleanup; exit 130' INT
trap 'trap - EXIT; (exit 143); cleanup; exit 143' TERM

echo "[verify] step 0: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install
fi

# A record or bucket left by an earlier, interrupted run would be blamed on
# the steps below.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
for b in "${ALL_BUCKETS[@]}"; do
  assert_gone "precondition: bucket ${b} already exists (left by an earlier run); delete it first" \
    aws s3api head-bucket --bucket "${b}" --region "${REGION}"
done
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (BaseBucket)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
BASE_CREATED="$(listed_creation_date "${BASE_BUCKET}")"

echo "[verify] step 2: a role that may create a bucket and enable its versioning but neither tag nor delete it"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls, never `*`. The S3 verbs on the state
# bucket are the state path's (src/state/{s3-state-backend,lock-manager,
# s3-noncurrent-version-purge,s3-replication-purge-gap}.ts,
# src/utils/aws-region-resolver.ts). On this run's buckets the role may:
# CreateBucket; ListBucket (the engine's pre-create name lookup is a
# HeadBucket) and GetBucketLocation (the provider's us-east-1 pre-flight, and
# the identity read). ListAllMyBuckets is the identity read's ListBuckets.
# PutBucketVersioning (the first configuration call) is allowed, so S3 has a
# configuration write to move the date on; PutBucketTagging (the next one,
# the stack's fixture tag) is denied, so each CREATE fails after S3 made the
# bucket; DeleteBucket is denied, so the provider's own cleanup cannot remove
# it.
DENY_POLICY="$(node -e 'const [bucket,stack,acct]=process.argv.slice(1);process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["s3:CreateBucket","s3:PutBucketVersioning","s3:ListBucket","s3:GetBucketLocation"],Resource:`arn:aws:s3:::cdkd-s3ffo-*-${acct}`},{Effect:"Allow",Action:["s3:ListAllMyBuckets","cloudformation:Describe*","cloudformation:List*","ssm:GetParameter","ssm:GetParameters","kms:Decrypt","kms:GenerateDataKey","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["s3:PutBucketTagging","s3:DeleteBucket"],Resource:`arn:aws:s3:::cdkd-s3ffo-*-${acct}`}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=s3-fix-forward-orphan >/dev/null
DENY_ROLE_CREATED=1
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-s3-fix-forward \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)"; then
    break
  fi
  DENY_CREDS=""
  sleep 5
done
if [ -z "${DENY_CREDS}" ]; then
  echo "[verify] FAIL: precondition -- could not assume ${DENY_ROLE} within 2 minutes" >&2
  exit 1
fi
# Process substitution, not a here-string: bash 3.2 backs a here-string with a
# temp file, and these are live credentials.
read -r DENY_AK DENY_SK DENY_ST < <(printf '%s\n' "${DENY_CREDS}")
unset DENY_CREDS
# Run a command as the role. A profile in the environment would win over the
# key variables in the SDK's credential chain, so it is dropped. Exported
# inside a subshell, so the keys never sit in a process's argv.
as_deny_role() {
  (
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}"
    exec "$@"
  )
}
DENY_ARN=""
deny_id_err=""
for _ in $(seq 1 24); do
  if DENY_ARN="$(as_deny_role aws sts get-caller-identity --query Arn --output text 2>"${LOG_DIR}/id-err")"; then
    break
  fi
  DENY_ARN=""
  deny_id_err="$(cat "${LOG_DIR}/id-err" 2>/dev/null || true)"
  sleep 5
done
if [ -z "${DENY_ARN}" ]; then
  echo "[verify] FAIL: precondition -- STS never accepted ${DENY_ROLE}'s credentials within 2 minutes (last answer: ${deny_id_err})" >&2
  exit 1
fi
case "${DENY_ARN}" in
  *":assumed-role/${DENY_ROLE}/"*) ;;
  *)
    echo "[verify] FAIL: precondition -- the role's commands run as '${DENY_ARN}', not ${DENY_ROLE}" >&2
    exit 1
    ;;
esac
# The EXPLICIT deny must already bind: before the inline policy propagates,
# the role is refused everything implicitly, and the deploy below would then
# fail before any CREATE for the wrong reason. Probed on BaseBucket, which
# EXISTS: S3 answers NoSuchBucket for a bucket that does not, before any
# policy. The probe cannot delete it: no statement allows DeleteBucket, so it
# is refused implicitly before the policy binds and explicitly after.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws s3api delete-bucket --bucket "${BASE_BUCKET}" --region "${REGION}" 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} DELETED ${BASE_BUCKET} (its policy must refuse DeleteBucket)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DeleteBucket never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: both CREATEs fail after S3 made and versioned the bucket"
set +e
as_deny_role env -u ORPHAN_FIX_FORWARD WITH_ORPHANS=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --no-rollback > "${LOG_DIR}/inject.log" 2>&1
INJECT_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/inject.log" || true
# The role is not needed again. Still flagged until confirmed gone, so a
# failure here leaves cleanup to retry the delete.
delete_deny_role
for _ in $(seq 1 12); do
  if gone_probe aws iam get-role --role-name "${DENY_ROLE}"; then break; fi
  sleep 5
done
assert_gone "role ${DENY_ROLE} still exists a minute after its delete" aws iam get-role --role-name "${DENY_ROLE}"
DENY_ROLE_CREATED=""
if [ "${INJECT_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the --no-rollback deploy as ${DENY_ROLE} unexpectedly SUCCEEDED" >&2
  exit 1
fi
for b in "${BUCKET_A}" "${BUCKET_C}" "${BUCKET_D}"; do
  if ! aws s3api head-bucket --bucket "${b}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] FAIL: bucket ${b} does not exist after step 2 -- its CREATE failed before CreateBucket returned (output above)" >&2
    exit 1
  fi
  # The premise of the region note above: the CREATE wrote to the bucket
  # before it failed.
  B_VERSIONING="$(aws s3api get-bucket-versioning --bucket "${b}" --region "${REGION}" --query Status --output text)"
  if [ "${B_VERSIONING}" != "Enabled" ]; then
    echo "[verify] FAIL: bucket ${b}'s versioning reads '${B_VERSIONING}' after step 2 (expected Enabled: the CREATE must fail AFTER a configuration write)" >&2
    exit 1
  fi
done
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
for lid in OrphanA OrphanC OrphanD; do
  if [ "$(printf '%s' "${STATE_2}" | jq --arg l "${lid}" '.resources | has($l)')" != "false" ]; then
    echo "[verify] FAIL: state records ${lid} after step 2 (expected no record for a CREATE that threw)" >&2
    exit 1
  fi
done
JOURNAL_2="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
# go-to-k/cdkd#4655: the journal carries the identity the settle compares
# before deleting a name-keyed orphan. Read live by the failing deploy (the
# role may list and locate buckets); it must equal what ListBuckets reports.
assert_journaled() { # usage: assert_journaled <logicalId> <bucket>
  local op created want
  created="$(listed_creation_date "$2")" || return 1
  if [ -z "${created}" ]; then
    echo "[verify] FAIL: ListBuckets does not list $2 after step 2" >&2
    exit 1
  fi
  want="$2|${REGION}|${created}"
  op="$(printf '%s' "${JOURNAL_2}" | jq -c --arg l "$1" '[.segments[-1].failedOperations[]? | select(.logicalId == $l)] | first // empty')" || return 1
  if [ -z "${op}" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalId // "<absent>"')" != "$2" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.provisionedBy // "<absent>"')" != "sdk" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.createdResourceIdentity // "<absent>"')" != "${want}" ]; then
    echo "[verify] FAIL: the journal does not carry $1's proven id $2 (via sdk) with its identity ${want} after step 2 (op: ${op:-<none>})" >&2
    exit 1
  fi
}
assert_journaled OrphanA "${BUCKET_A}"
assert_journaled OrphanC "${BUCKET_C}"
assert_journaled OrphanD "${BUCKET_D}"
C_CREATED="$(listed_creation_date "${BUCKET_C}")"
echo "[verify] step 2 ok: ${BUCKET_A} and ${BUCKET_C} are in AWS, journaled with their identities, with no state record"

echo "[verify] step 2b: ${BUCKET_C} is deleted and its name re-used outside the stack"
aws s3api delete-bucket --bucket "${BUCKET_C}" --region "${REGION}"
assert_gone_eventually "step 2b: ${BUCKET_C} survived its delete" \
  aws s3api head-bucket --bucket "${BUCKET_C}" --region "${REGION}"
plant_bucket "${BUCKET_C}"
C_MARKER="phase2b-$(date -u +%s)"
aws s3api put-bucket-tagging --bucket "${BUCKET_C}" --region "${REGION}" \
  --tagging "TagSet=[{Key=cdkd-integ-marker,Value=${C_MARKER}}]"
# The premise the identity rests on: the re-created bucket reports ANOTHER
# CreationDate. Polled, since the list can lag a create.
C2_CREATED=""
for _ in $(seq 1 20); do
  C2_CREATED="$(listed_creation_date "${BUCKET_C}")"
  if [ -n "${C2_CREATED}" ] && [ "${C2_CREATED}" != "${C_CREATED}" ]; then break; fi
  sleep 3
done
if [ -z "${C2_CREATED}" ] || [ "${C2_CREATED}" = "${C_CREATED}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${BUCKET_C} reports CreationDate '${C2_CREATED}', the deleted one '${C_CREATED}': a CreationDate that does not change on re-create cannot tell the two apart (go-to-k/cdkd#4606's S3 identity is then unsound)" >&2
  exit 1
fi
echo "[verify] step 2b ok: ${BUCKET_C} re-created outside the stack (CreationDate ${C_CREATED} -> ${C2_CREATED})"

echo "[verify] step 2c: something writes data into ${BUCKET_D}"
D_CREATED="$(listed_creation_date "${BUCKET_D}")"
printf 'held by someone else\n' > "${LOG_DIR}/held-data.txt"
aws s3api put-object --bucket "${BUCKET_D}" --region "${REGION}" --key "${D_OBJECT_KEY}" \
  --body "${LOG_DIR}/held-data.txt" >/dev/null
# Premise: an object write does not move the bucket's CreationDate (not part
# of the #4606 measurement). If it did, OrphanD would read as another bucket
# and be kept for that reason, and step 3 would measure the wrong guard.
D_CREATED_AFTER="$(listed_creation_date "${BUCKET_D}")"
if [ -z "${D_CREATED}" ] || [ "${D_CREATED_AFTER}" != "${D_CREATED}" ]; then
  echo "[verify] FAIL: premise -- ${BUCKET_D}'s CreationDate moved from '${D_CREATED}' to '${D_CREATED_AFTER}' on an object write, so step 3 could not tell the never-empty guard from an identity mismatch" >&2
  exit 1
fi

echo "[verify] step 3: the fix-forward (same logical ids, other names)"
set +e
env WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/fix-forward.log" 2>&1
FF_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/fix-forward.log" || true
# 2: OrphanC's re-used name and OrphanD's non-empty bucket are left in place
# with warnings, which counts as unaddressed (journaled-orphans.ts,
# `settleJournaledOrphansOnSuccess`). Any other code is a failed deploy, or a
# settle that skipped the warnings.
if [ "${FF_RC}" -ne 2 ]; then
  echo "[verify] FAIL: the fix-forward deploy exited ${FF_RC} (expected 2: OrphanC's re-used name and OrphanD's non-empty bucket are warned about and kept -- output above)" >&2
  exit 1
fi
# OrphanD's delete did not complete, so the journal is kept with that entry
# alone (the next successful deploy retries it).
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "[verify] FAIL: the fix-forward dropped the rollback journal (expected it kept with OrphanD's entry, whose delete the never-empty guard skipped -- output above)" >&2
  exit 1
fi
JOURNAL_3="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
J3_IDS="$(printf '%s' "${JOURNAL_3}" | jq -r '[.segments[].failedOperations[]? | select(.physicalIdRecoveredFromError == true) | .logicalId] | sort | join(",")')"
if [ "${J3_IDS}" != "OrphanD" ]; then
  echo "[verify] FAIL: after the fix-forward the journal keeps proven orphans [${J3_IDS}] (expected exactly [OrphanD])" >&2
  exit 1
fi
assert_gone_eventually "the earlier attempt's bucket ${BUCKET_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws s3api head-bucket --bucket "${BUCKET_A}" --region "${REGION}"
# The re-used name is someone else's now: kept, untouched.
C_TAG="$(aws s3api get-bucket-tagging --bucket "${BUCKET_C}" --region "${REGION}" \
  --query "TagSet[?Key=='cdkd-integ-marker'].Value | [0]" --output text 2>&1)" || C_TAG="<get-bucket-tagging failed: ${C_TAG}>"
if [ "${C_TAG}" != "${C_MARKER}" ]; then
  echo "[verify] FAIL: the re-created ${BUCKET_C} was not left untouched by the fix-forward (marker tag '${C_TAG}', expected '${C_MARKER}')" >&2
  exit 1
fi
# The bucket holding data is never emptied, even with autoDeleteObjects declared.
D_OBJECT="$(aws s3api head-object --bucket "${BUCKET_D}" --region "${REGION}" --key "${D_OBJECT_KEY}" \
  --query ContentLength --output text 2>&1)" || D_OBJECT="<head-object failed: ${D_OBJECT}>"
case "${D_OBJECT}" in
  ''|*[!0-9]*)
    echo "[verify] FAIL: ${BUCKET_D}'s object ${D_OBJECT_KEY} is gone after the fix-forward (${D_OBJECT}): a failed CREATE's orphan must never be emptied (go-to-k/cdkd#4606)" >&2
    exit 1
    ;;
esac
for b in "${BUCKET_A_B}" "${BUCKET_C_B}" "${BUCKET_D_B}" "${BASE_BUCKET}"; do
  if ! aws s3api head-bucket --bucket "${b}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] FAIL: the record's bucket ${b} is missing after the fix-forward (the settle must not delete the records' buckets)" >&2
    exit 1
  fi
done
if [ "$(listed_creation_date "${BASE_BUCKET}")" != "${BASE_CREATED}" ]; then
  echo "[verify] FAIL: ${BASE_BUCKET}'s CreationDate moved during the run (expected the baseline's ${BASE_CREATED})" >&2
  exit 1
fi
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_record() { # usage: assert_record <logicalId> <bucket>
  local pid by
  pid="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || return 1
  by="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || return 1
  if [ "${pid}" != "$2" ] || [ "${by}" != "sdk" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected $2 via sdk, where isSameResource lives)" >&2
    exit 1
  fi
}
assert_record OrphanA "${BUCKET_A_B}"
assert_record OrphanC "${BUCKET_C_B}"
assert_record OrphanD "${BUCKET_D_B}"
assert_record BaseBucket "${BASE_BUCKET}"
# The assertions above decide the step on AWS's own answers. The log lines
# below only confirm the deploy's account of it, so a reworded line fails
# here, never silently above.
FF_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/fix-forward.log" | tr '\n' ' ' | tr -s ' ')"
if ! printf '%s' "${FF_FLAT}" | grep -qF 'deleting partially-created OrphanA'; then
  echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's OrphanA (output above)" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF 'Skipping failed CREATE of OrphanA'; then
  echo "[verify] FAIL: the fix-forward deploy still warned about the earlier OrphanA instead of deleting it (output above)" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF 'deleting partially-created OrphanC'; then
  echo "[verify] FAIL: the fix-forward deploy tried to delete OrphanC's re-used name (output above)" >&2
  exit 1
fi
if ! printf '%s' "${FF_FLAT}" | grep -qF 'cdkd never empties such a bucket'; then
  echo "[verify] FAIL: the fix-forward deploy did not say why it kept OrphanD's non-empty bucket (output above)" >&2
  exit 1
fi
if ! printf '%s' "${FF_FLAT}" | grep -qF 'is not deleted: the resource now under its physical id is another one'; then
  echo "[verify] FAIL: the fix-forward deploy did not warn that OrphanC's name now holds another bucket (output above)" >&2
  exit 1
fi
echo "[verify] step 3 ok: the fix-forward deleted ${BUCKET_A}, kept the re-created ${BUCKET_C} untouched and ${BUCKET_D} with its data, and the records hold the -b buckets (rc=${FF_RC})"

echo "[verify] step 4: destroy"
# The re-created name and OrphanD's kept bucket are no record's: this run
# made them, so it removes them. The journal still names OrphanD's bucket;
# the destroy then finds it gone and only drops the entry.
aws s3api delete-bucket --bucket "${BUCKET_C}" --region "${REGION}"
empty_bucket_by_name "${BUCKET_D}"
aws s3api delete-bucket --bucket "${BUCKET_D}" --region "${REGION}"
# The destroy's journal replay asks GetBucketLocation first: wait until IT
# reports the bucket gone, or a half-propagated delete reads as 'unproven'.
assert_gone_eventually "step 4: ${BUCKET_D} still located after its delete" \
  aws s3api get-bucket-location --bucket "${BUCKET_D}" --region "${REGION}"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for b in "${ALL_BUCKETS[@]}"; do
  assert_gone_eventually "bucket ${b} still exists after destroy" \
    aws s3api head-bucket --bucket "${b}" --region "${REGION}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "s3-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's bucket and kept one whose name was re-used (go-to-k/cdkd#4606)"

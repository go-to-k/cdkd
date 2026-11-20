#!/usr/bin/env bash
# verify.sh -- template-only drift baseline for resource policies and IAM
# principals (go-to-k/cdkd#6624 / #6627).
#
# Deploys object-form resource policies (S3, SQS, SNS, KMS, Secrets Manager,
# the Cloud Control-routed IAM inline policies) and IAM principals, records
# each resource's deploy-time readback (`cdkd state show --json`, summarized by
# summarize-readback.ts) into an artifact directory printed at the end, then:
#   1. drift on the observed baseline is clean;
#   2. with every observed baseline stripped (strip-all-observed.ts: the
#      template-only baseline a capture-off deploy leaves), drift is clean;
#   3. a Condition added out of band to every document is drift, named by
#      path; `drift --revert` removes it from AWS, replacing nothing (every
#      resource's physical id and AWS-side identity unchanged); drift is
#      clean again.
# go-to-k/cdkd#6627, on the observed baseline (before step 2) and on the
# template-only one (after step 3): a managed policy, an inline policy, a
# permissions boundary and a group membership granted out of band to IAM
# principals whose template declares none are drift, each by its key;
# `drift --revert` removes exactly those members, keeps every member a
# sibling record of the stack writes, and replaces nothing. Then `--accept`
# adopts a grant (and a removed accepted boundary is put back), and the grant
# phase runs once more with every principal routed through Cloud Control.

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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdDriftVerbatimReadbackExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
ARTIFACT_DIR="${DVR_ARTIFACT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/cdkd-dvr.XXXXXX")}"
mkdir -p "${ARTIFACT_DIR}"

BUCKET_PREFIX="cdkd-dvr-"
QUEUE="cdkd-dvr-queue"
TOPIC="cdkd-dvr-topic"
SECRET="cdkd-dvr-secret"
SIB_ROLE="cdkd-dvr-sibling-role"
SIB_USER="cdkd-dvr-sibling-user"
SIB_GROUP="cdkd-dvr-sibling-group"
BARE_ROLE="cdkd-dvr-bare-role"
BARE_USER="cdkd-dvr-bare-user"
BARE_GROUP="cdkd-dvr-bare-group"
MP_NAME="cdkd-dvr-managed-policy"
KEY_ALIAS="alias/cdkd-dvr-key"
KEY_ID=""

# Strip every inline and attached policy from a principal, then delete it.
# $1 = role | user | group, $2 = name.
delete_principal() {
  local kind="$1" name="$2" flag p
  case "${kind}" in
    role) flag="--role-name" ;;
    user) flag="--user-name" ;;
    group) flag="--group-name" ;;
    *) return 0 ;;
  esac
  for p in $(aws iam "list-${kind}-policies" "${flag}" "${name}" --query 'PolicyNames' --output text 2>/dev/null); do
    aws iam "delete-${kind}-policy" "${flag}" "${name}" --policy-name "${p}" >/dev/null 2>&1 || true
  done
  for p in $(aws iam "list-attached-${kind}-policies" "${flag}" "${name}" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam "detach-${kind}-policy" "${flag}" "${name}" --policy-arn "${p}" >/dev/null 2>&1 || true
  done
  if [ "${kind}" = "role" ]; then
    aws iam delete-role-permissions-boundary --role-name "${name}" >/dev/null 2>&1 || true
  fi
  # go-to-k/cdkd#6627's phases add memberships and a user boundary out of band.
  if [ "${kind}" = "user" ]; then
    aws iam delete-user-permissions-boundary --user-name "${name}" >/dev/null 2>&1 || true
    for p in $(aws iam list-groups-for-user --user-name "${name}" --query 'Groups[].GroupName' --output text 2>/dev/null); do
      aws iam remove-user-from-group --user-name "${name}" --group-name "${p}" >/dev/null 2>&1 || true
    done
  fi
  if [ "${kind}" = "group" ]; then
    for p in $(aws iam get-group --group-name "${name}" --query 'Users[].UserName' --output text 2>/dev/null); do
      aws iam remove-user-from-group --user-name "${p}" --group-name "${name}" >/dev/null 2>&1 || true
    done
  fi
  aws iam "delete-${kind}" "${flag}" "${name}" >/dev/null 2>&1 || true
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  if [ -n "${ACCOUNT:-}" ]; then
    aws s3 rb "s3://${BUCKET_PREFIX}${ACCOUNT}-${REGION}" --force >/dev/null 2>&1 || true
    aws sns delete-topic --topic-arn "arn:${PARTITION}:sns:${REGION}:${ACCOUNT}:${TOPIC}" --region "${REGION}" >/dev/null 2>&1 || true
    aws iam delete-policy --policy-arn "arn:${PARTITION}:iam::${ACCOUNT}:policy/${MP_NAME}" >/dev/null 2>&1 || true
  fi
  q_url=$(aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null) &&
    aws sqs delete-queue --queue-url "${q_url}" --region "${REGION}" >/dev/null 2>&1
  aws secretsmanager delete-secret --secret-id "${SECRET}" --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  # A run that died with no state record leaves the key: find it by alias as
  # well as by the id state recorded (the two can differ), and schedule both.
  alias_key=$(aws kms describe-key --key-id "${KEY_ALIAS}" --region "${REGION}" --query KeyMetadata.KeyId --output text 2>/dev/null)
  aws kms delete-alias --alias-name "${KEY_ALIAS}" --region "${REGION}" >/dev/null 2>&1 || true
  for k in "${KEY_ID}" "${alias_key}"; do
    [ -n "${k}" ] || continue
    aws kms schedule-key-deletion --key-id "${k}" --pending-window-in-days 7 --region "${REGION}" >/dev/null 2>&1 || true
  done
  # The managed policy is detached here before its own delete below can run.
  for r in "${SIB_ROLE}" "${BARE_ROLE}"; do delete_principal role "${r}"; done
  for u in "${SIB_USER}" "${BARE_USER}"; do delete_principal user "${u}"; done
  for g in "${SIB_GROUP}" "${BARE_GROUP}"; do delete_principal group "${g}"; done
  if [ -n "${ACCOUNT:-}" ]; then
    aws iam delete-policy --policy-arn "arn:${PARTITION}:iam::${ACCOUNT}:policy/${MP_NAME}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  echo "    readback artifacts: ${ARTIFACT_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PARTITION=$(aws sts get-caller-identity --query Arn --output text | cut -d: -f2)
echo "==> Pre-run cleanup"; cleanup

# Deploy WITH the observed capture (the default), so state records each
# resource's deploy-time `readCurrentState` output to read back below.
echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes \
  2>&1 | tee "${ARTIFACT_DIR}/deploy.log"
# go-to-k/cdkd#6634: the documents below omit `Version`, and the services fill
# in `2008-10-17` (asserted after the readback). The post-write settle takes
# that as the declared document, so no member settle (ProbeKey's KeyPolicy,
# the bucket policy, the roles' trust policies) warns that the read never
# showed what the write left.
unsettled=$(grep -F 'the read right after the write never showed' "${ARTIFACT_DIR}/deploy.log" || true)
[ -z "${unsettled}" ] || { echo "FAIL: #6634: the deploy warned of an unsettled post-write read:" >&2; echo "${unsettled}" >&2; exit 1; }
echo "    OK: #6634: no post-write settle warning on the deploy"

# `drift` exits 0 clean, 1 drifted, 2 refused; any of the three is a result
# to record here, anything else is a failure of the run.
run_drift() { # $1 = output file
  local rc=0
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --json >"$1" || rc=$?
  DRIFT_RC="${rc}"
  case "${rc}" in
    0 | 1 | 2) echo "    drift rc=${rc} -> $1" ;;
    *) echo "FAIL: cdkd drift exited ${rc}" >&2; exit 1 ;;
  esac
}
show_state() { # $1 = output file
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --json >"$1"
}

echo "==> Record the deploy-time readback"
show_state "${ARTIFACT_DIR}/state-show-deploy.json"
node summarize-readback.ts "${ARTIFACT_DIR}/state-show-deploy.json" >"${ARTIFACT_DIR}/summary-deploy.json"
KEY_ID=$(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).state.resources;
  const id = Object.keys(s).find((k) => s[k].resourceType === "AWS::KMS::Key");
  process.stdout.write(id ? String(s[id].physicalId) : "");
' "${ARTIFACT_DIR}/state-show-deploy.json")
[ -n "${KEY_ID}" ] || { echo "FAIL: no AWS::KMS::Key physical id in state" >&2; exit 1; }
# AWS::IAM::UserToGroupAddition has no readback by design (its provider's
# readCurrentState returns undefined: the membership is read on the user, as
# its `Groups`), so it alone records none; drift reports it unsupported (exit 0).
missing=$(node -e '
  const s = require(process.argv[1]);
  const noRead = new Set(["AWS::IAM::UserToGroupAddition"]);
  process.stdout.write(Object.keys(s).filter((k) => !s[k].hasObserved && !noRead.has(s[k].resourceType)).join(" "));
' "${ARTIFACT_DIR}/summary-deploy.json")
[ -z "${missing}" ] || { echo "FAIL: no deploy-time readback for: ${missing}" >&2; exit 1; }
unexpected=$(node -e '
  const s = require(process.argv[1]);
  process.stdout.write(Object.keys(s).filter((k) => s[k].resourceType === "AWS::IAM::UserToGroupAddition" && s[k].hasObserved).join(" "));
' "${ARTIFACT_DIR}/summary-deploy.json")
[ -z "${unexpected}" ] || { echo "FAIL: ${unexpected} recorded a readback; the UserToGroupAddition exemption above is stale" >&2; exit 1; }
echo "    OK: every resource recorded a deploy-time readback (UserToGroupAddition has none by design)"

# go-to-k/cdkd#6624: what the drift comparator relies on. These services write
# `Version: 2008-10-17` (what an omitted Version means) into a document the
# template submitted without one; the Cloud Control IAM inline types and
# AWS::IAM::Policy write none. A change on AWS's side fails here, by name.
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).state.resources;
  const filled = {
    BareRole: "AssumeRolePolicyDocument", SiblingRole: "AssumeRolePolicyDocument",
    ProbeBucketPolicy: "PolicyDocument", ProbeQueuePolicy: "PolicyDocument",
    ProbeTopicPolicy: "PolicyDocument", ProbeKey: "KeyPolicy", ProbeSecretPolicy: "ResourcePolicy",
  };
  const none = ["ProbeRolePolicy", "ProbeUserPolicy", "ProbeGroupPolicy", "ProbePolicy"];
  const bad = [];
  for (const [id, key] of Object.entries(filled)) {
    const v = s[id]?.observedProperties?.[key]?.Version;
    if (v !== "2008-10-17") bad.push(`${id}.${key}.Version is ${JSON.stringify(v)}, expected "2008-10-17"`);
  }
  for (const id of none) {
    const doc = s[id]?.observedProperties?.PolicyDocument;
    if (doc === undefined) bad.push(`${id} has no observed PolicyDocument`);
    else if (doc.Version !== undefined) bad.push(`${id}.PolicyDocument.Version is ${JSON.stringify(doc.Version)}, expected none`);
  }
  if (bad.length) { console.error("FAIL: Version fill differs from the measured one:\n  " + bad.join("\n  ")); process.exit(1); }
' "${ARTIFACT_DIR}/state-show-deploy.json"
echo "    OK: 7 documents read back with Version 2008-10-17, 4 with none"

# Drift JSON -> one "<logicalId> <path>" line per change, sorted.
drift_paths() { # $1 = drift --json file
  node -e '
    const [r] = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const out = r.drifted.flatMap((d) => d.changes.map((c) => `${d.logicalId} ${c.path}`));
    process.stdout.write(out.sort().join("\n"));
  ' "$1"
}

BUCKET="${BUCKET_PREFIX}${ACCOUNT}-${REGION}"
TOPIC_ARN="arn:${PARTITION}:sns:${REGION}:${ACCOUNT}:${TOPIC}"
QUEUE_URL=$(aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}" --query QueueUrl --output text)
QUEUE_ARN="arn:${PARTITION}:sqs:${REGION}:${ACCOUNT}:${QUEUE}"

# --- The revert must update in place: no resource replaced ------------------
# tests/integration/revert-identity.sh snapshots every state resource's
# physical id and an AWS-side identity (its per-type probe) before a revert and
# proves both unchanged right after it, before any assertion on the revert.
# The count is a literal, so an emptied or partial snapshot cannot pass.
. ../revert-identity.sh
REVERT_IDS=22
# The stack's logical ids, read from state; the count must be the stack's 22.
revert_ids_before() { # usage: revert_ids_before <tag>
  local st="${ARTIFACT_DIR}/state-identity.json" lids
  show_state "${st}"
  lids=($(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).state.resources;
    console.log(Object.keys(s).sort().join(" "));
  ' "${st}")) || { echo "FAIL: could not read the state's logical ids" >&2; exit 1; }
  [ "${#lids[@]}" = "${REVERT_IDS}" ] || { echo "FAIL: the state holds ${#lids[@]} resources, expected the stack's ${REVERT_IDS}" >&2; exit 1; }
  revert_identity_snapshot "${ARTIFACT_DIR}/revert-ids-$1-before" "${STACK}" "${lids[@]}" || exit 1
}
# The identities right after the revert (rc captured first, before any
# assertion on it). A Cloud Control patch's own `"op":"replace"` (the --verbose
# line listing it) is a JSON Patch verb, not a resource replacement.
revert_ids_after() { # usage: revert_ids_after <tag> <revert log>
  revert_identity_verify "${ARTIFACT_DIR}/revert-ids-$1-before" "${ARTIFACT_DIR}/revert-ids-$1-after" "${REVERT_IDS}" "$2" \
    'ignore="op":"replace"' || exit 1
}

# --- go-to-k/cdkd#6627: grants out of band on principals declaring none ------
# AWSDenyAll is the out-of-band managed policy and boundary: an AWS-managed
# policy, so nothing to create or delete, and granting it widens nothing.
OOB_POLICY_ARN="arn:${PARTITION}:iam::aws:policy/AWSDenyAll"
OOB_INLINE="cdkd-dvr-oob-inline"
MP_ARN="arn:${PARTITION}:iam::${ACCOUNT}:policy/${MP_NAME}"
# The template of every Bare* and Sibling* principal declares none of
# ManagedPolicyArns / Policies / PermissionsBoundary / Groups.
GRANT_DRIFT=$(printf '%s\n' \
  "BareGroup ManagedPolicyArns" "BareGroup Policies" \
  "BareRole ManagedPolicyArns" "BareRole PermissionsBoundary" "BareRole Policies" \
  "BareUser Groups" "BareUser ManagedPolicyArns" "BareUser PermissionsBoundary" "BareUser Policies" \
  "SiblingGroup ManagedPolicyArns" "SiblingGroup Policies" \
  "SiblingRole ManagedPolicyArns" "SiblingRole Policies" \
  "SiblingUser Groups" "SiblingUser ManagedPolicyArns" "SiblingUser Policies" | LC_ALL=C sort)

# One line per principal: its attached policies, inline policies, boundary
# and (a user) groups, each sorted.
live_principal() { # $1 = role | user | group, $2 = name
  local kind="$1" name="$2" flag m i b="" g=""
  case "${kind}" in
    role) flag="--role-name" ;;
    user) flag="--user-name" ;;
    group) flag="--group-name" ;;
  esac
  m=$(aws iam "list-attached-${kind}-policies" "${flag}" "${name}" --query 'AttachedPolicies[].PolicyArn' --output text | tr '\t' '\n' | LC_ALL=C sort | tr '\n' ' ') || return 1
  i=$(aws iam "list-${kind}-policies" "${flag}" "${name}" --query 'PolicyNames' --output text | tr '\t' '\n' | LC_ALL=C sort | tr '\n' ' ') || return 1
  if [ "${kind}" != group ]; then
    b=$(aws iam "get-${kind}" "${flag}" "${name}" --query "*.PermissionsBoundary.PermissionsBoundaryArn | [0]" --output text) || return 1
  fi
  if [ "${kind}" = user ]; then
    g=$(aws iam list-groups-for-user --user-name "${name}" --query 'Groups[].GroupName' --output text | tr '\t' '\n' | LC_ALL=C sort | tr '\n' ' ') || return 1
  fi
  printf '%s %s managed=[%s] inline=[%s] boundary=%s groups=[%s]\n' "${kind}" "${name}" "${m% }" "${i% }" "${b:-None}" "${g% }"
}
live_principals() {
  live_principal role "${BARE_ROLE}" && live_principal user "${BARE_USER}" && live_principal group "${BARE_GROUP}" &&
    live_principal role "${SIB_ROLE}" && live_principal user "${SIB_USER}" && live_principal group "${SIB_GROUP}"
}

grant_phase() { # $1 = baseline label (observed | template-only)
  local label="$1" before after got
  echo "==> #6627 (${label} baseline): the principals before any grant"
  before=$(live_principals) || { echo "FAIL: could not read the principals" >&2; exit 1; }
  echo "${before}" >"${ARTIFACT_DIR}/principals-${label}-before.txt"
  # Vacuity guard: the siblings' members are live, so the revert below has
  # something it must keep.
  for want in "role ${SIB_ROLE} managed=[${MP_ARN}] inline=[cdkd-dvr-policy cdkd-dvr-role-policy]" \
    "user ${SIB_USER} managed=[${MP_ARN}] inline=[cdkd-dvr-policy cdkd-dvr-user-policy] boundary=None groups=[${SIB_GROUP}]" \
    "group ${SIB_GROUP} managed=[${MP_ARN}] inline=[cdkd-dvr-group-policy cdkd-dvr-policy]" \
    "role ${BARE_ROLE} managed=[] inline=[] boundary=None"; do
    grep -qF "${want}" <<<"${before}" || { echo "FAIL: precondition: no principal line holds '${want}':" >&2; echo "${before}" >&2; exit 1; }
  done

  echo "==> #6627 (${label}): grant out of band"
  local deny='{"Version":"2012-10-17","Statement":{"Effect":"Deny","Action":"s3:PutObjectLegalHold","Resource":"*"}}'
  aws iam attach-role-policy --role-name "${BARE_ROLE}" --policy-arn "${OOB_POLICY_ARN}"
  aws iam attach-user-policy --user-name "${BARE_USER}" --policy-arn "${OOB_POLICY_ARN}"
  aws iam attach-group-policy --group-name "${BARE_GROUP}" --policy-arn "${OOB_POLICY_ARN}"
  aws iam attach-role-policy --role-name "${SIB_ROLE}" --policy-arn "${OOB_POLICY_ARN}"
  aws iam attach-user-policy --user-name "${SIB_USER}" --policy-arn "${OOB_POLICY_ARN}"
  aws iam attach-group-policy --group-name "${SIB_GROUP}" --policy-arn "${OOB_POLICY_ARN}"
  aws iam put-role-policy --role-name "${BARE_ROLE}" --policy-name "${OOB_INLINE}" --policy-document "${deny}"
  aws iam put-user-policy --user-name "${BARE_USER}" --policy-name "${OOB_INLINE}" --policy-document "${deny}"
  aws iam put-group-policy --group-name "${BARE_GROUP}" --policy-name "${OOB_INLINE}" --policy-document "${deny}"
  # Beside the siblings' inline policies on the same list.
  aws iam put-role-policy --role-name "${SIB_ROLE}" --policy-name "${OOB_INLINE}" --policy-document "${deny}"
  aws iam put-user-policy --user-name "${SIB_USER}" --policy-name "${OOB_INLINE}" --policy-document "${deny}"
  aws iam put-group-policy --group-name "${SIB_GROUP}" --policy-name "${OOB_INLINE}" --policy-document "${deny}"
  aws iam put-role-permissions-boundary --role-name "${BARE_ROLE}" --permissions-boundary "${OOB_POLICY_ARN}"
  aws iam put-user-permissions-boundary --user-name "${BARE_USER}" --permissions-boundary "${OOB_POLICY_ARN}"
  aws iam add-user-to-group --user-name "${BARE_USER}" --group-name "${SIB_GROUP}"
  aws iam add-user-to-group --user-name "${SIB_USER}" --group-name "${BARE_GROUP}"
  sleep 15

  echo "==> #6627 (${label}): drift names every grant by its key"
  run_drift "${ARTIFACT_DIR}/drift-grants-${label}.json"
  got=$(drift_paths "${ARTIFACT_DIR}/drift-grants-${label}.json" | LC_ALL=C sort)
  if [ "${got}" != "${GRANT_DRIFT}" ] || [ "${DRIFT_RC}" != 1 ]; then
    echo "FAIL: #6627 (${label}): drift after the out-of-band grants differs from the expected set (rc=${DRIFT_RC})" >&2
    diff <(echo "${GRANT_DRIFT}") <(echo "${got}") >&2 || true
    exit 1
  fi
  echo "    OK: all 16 grants reported"

  revert_ids_before "grants-${label}"
  echo "==> #6627 (${label}): drift --revert"
  # On the Cloud Control route, --verbose so the log proves each principal's
  # update went through Cloud Control (its `Update request submitted` line).
  local verbose=()
  [ "${label}" = cc-api ] && verbose=(--verbose)
  local rc=0
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --revert --yes \
    "${verbose[@]+"${verbose[@]}"}" 2>&1 | tee "${ARTIFACT_DIR}/revert-grants-${label}.log" || rc=$?
  revert_ids_after "grants-${label}" "${ARTIFACT_DIR}/revert-grants-${label}.log"
  [ "${rc}" -eq 0 ] || { echo "FAIL: #6627 (${label}): drift --revert exited ${rc}" >&2; exit 1; }
  if [ "${label}" = cc-api ]; then
    local id
    for id in BareRole BareUser BareGroup SiblingRole SiblingUser SiblingGroup; do
      grep -qF "Update request submitted for ${id}," "${ARTIFACT_DIR}/revert-grants-${label}.log" ||
        { echo "FAIL: #6627 (cc-api): ${id} was not reverted through Cloud Control (no 'Update request submitted' line)" >&2; exit 1; }
    done
    echo "    OK: every principal reverted through Cloud Control"
  fi
  sleep 15
  # The plan names each member it removes, and only those.
  local count line
  for line in "6|- detaches managed policy ${OOB_POLICY_ARN}" "6|- deletes inline policy ${OOB_INLINE}" \
    "2|- deletes permissions boundary ${OOB_POLICY_ARN}" "1|- removes the user from group ${SIB_GROUP}" \
    "1|- removes the user from group ${BARE_GROUP}"; do
    count=$(grep -cF -- "${line#*|}" "${ARTIFACT_DIR}/revert-grants-${label}.log" || true)
    [ "${count}" = "${line%%|*}" ] || { echo "FAIL: #6627 (${label}): the revert plan names '${line#*|}' ${count} time(s), expected ${line%%|*}" >&2; exit 1; }
  done
  # Captured, never `| grep -q`: under pipefail an early-exiting reader
  # SIGPIPEs the writer and the pipeline reads as "no match".
  local hits
  hits=$(grep -E '^ +- ' "${ARTIFACT_DIR}/revert-grants-${label}.log" | grep -E "${MP_NAME}|cdkd-dvr-(role|user|group)-policy|cdkd-dvr-policy" || true)
  if [ -n "${hits}" ]; then
    echo "FAIL: #6627 (${label}): the revert plan names a sibling's member for removal:" >&2
    echo "${hits}" >&2
    exit 1
  fi
  # A Cloud Control patch's own `"op":"replace"` (the verbose debug line
  # listing it) is a JSON Patch verb, not a resource replacement.
  hits=$(grep -iE 'replac|re-?creat' "${ARTIFACT_DIR}/revert-grants-${label}.log" | grep -vF 'patch operations for' || true)
  if [ -n "${hits}" ]; then
    echo "FAIL: #6627 (${label}): drift --revert output names a replacement:" >&2
    echo "${hits}" >&2
    exit 1
  fi

  echo "==> #6627 (${label}): AWS holds exactly the pre-grant members again"
  after=$(live_principals) || { echo "FAIL: could not read the principals after the revert" >&2; exit 1; }
  echo "${after}" >"${ARTIFACT_DIR}/principals-${label}-after.txt"
  if [ "${after}" != "${before}" ]; then
    echo "FAIL: #6627 (${label}): the principals' members after the revert differ from before the grants" >&2
    diff <(echo "${before}") <(echo "${after}") >&2 || true
    exit 1
  fi
  echo "    OK: every out-of-band member removed, every sibling's member kept"

  echo "==> #6627 (${label}): drift after the revert is clean"
  run_drift "${ARTIFACT_DIR}/drift-grants-${label}-after.json"
  got=$(drift_paths "${ARTIFACT_DIR}/drift-grants-${label}-after.json")
  [ -z "${got}" ] && [ "${DRIFT_RC}" = 0 ] || { echo "FAIL: #6627 (${label}): drift after --revert:" >&2; echo "${got}" >&2; exit 1; }
  echo "    OK: clean"
}

# go-to-k/cdkd#6627: `drift --accept` adopts an out-of-band grant, after which
# drift is clean and a revert removes nothing; a recorded boundary removed out
# of band is drift and `--revert` puts it back. On BareRole, from the
# template-only baseline. Leaves BareRole with no member and no boundary, and
# its accepted baseline recording neither.
accept_phase() {
  local got
  echo "==> #6627 accept: grant a managed policy and a boundary to ${BARE_ROLE}, then accept"
  aws iam attach-role-policy --role-name "${BARE_ROLE}" --policy-arn "${OOB_POLICY_ARN}"
  aws iam put-role-permissions-boundary --role-name "${BARE_ROLE}" --permissions-boundary "${OOB_POLICY_ARN}"
  sleep 15
  run_drift "${ARTIFACT_DIR}/drift-accept-before.json"
  got=$(drift_paths "${ARTIFACT_DIR}/drift-accept-before.json" | LC_ALL=C sort | tr '\n' ' ')
  [ "${got}" = "BareRole ManagedPolicyArns BareRole PermissionsBoundary " ] && [ "${DRIFT_RC}" = 1 ] ||
    { echo "FAIL: #6627 accept: drift before --accept is '${got}' (rc=${DRIFT_RC})" >&2; exit 1; }
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --accept --yes
  run_drift "${ARTIFACT_DIR}/drift-accept-after.json"
  got=$(drift_paths "${ARTIFACT_DIR}/drift-accept-after.json")
  [ -z "${got}" ] && [ "${DRIFT_RC}" = 0 ] || { echo "FAIL: #6627 accept: drift after --accept:" >&2; echo "${got}" >&2; exit 1; }
  revert_ids_before accepted
  local rc=0
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --revert --yes \
    2>&1 | tee "${ARTIFACT_DIR}/revert-accepted.log" || rc=$?
  revert_ids_after accepted "${ARTIFACT_DIR}/revert-accepted.log"
  [ "${rc}" -eq 0 ] || { echo "FAIL: #6627 accept: drift --revert exited ${rc}" >&2; exit 1; }
  sleep 15
  got=$(live_principal role "${BARE_ROLE}") || exit 1
  grep -qF "managed=[${OOB_POLICY_ARN}] inline=[] boundary=${OOB_POLICY_ARN}" <<<"${got}" ||
    { echo "FAIL: #6627 accept: a revert after --accept changed the accepted members: ${got}" >&2; exit 1; }
  echo "    OK: accepted members kept by drift and --revert"

  echo "==> #6627 accept: remove the accepted boundary out of band; drift reports it and --revert puts it back"
  aws iam delete-role-permissions-boundary --role-name "${BARE_ROLE}"
  sleep 15
  run_drift "${ARTIFACT_DIR}/drift-boundary-removed.json"
  got=$(drift_paths "${ARTIFACT_DIR}/drift-boundary-removed.json")
  [ "${got}" = "BareRole PermissionsBoundary" ] && [ "${DRIFT_RC}" = 1 ] ||
    { echo "FAIL: #6627 accept: drift after removing the accepted boundary is '${got}' (rc=${DRIFT_RC})" >&2; exit 1; }
  revert_ids_before boundary
  rc=0
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --revert --yes \
    2>&1 | tee "${ARTIFACT_DIR}/revert-boundary.log" || rc=$?
  revert_ids_after boundary "${ARTIFACT_DIR}/revert-boundary.log"
  [ "${rc}" -eq 0 ] || { echo "FAIL: #6627 accept: drift --revert exited ${rc}" >&2; exit 1; }
  sleep 15
  got=$(live_principal role "${BARE_ROLE}") || exit 1
  grep -qF "boundary=${OOB_POLICY_ARN}" <<<"${got}" ||
    { echo "FAIL: #6627 accept: --revert did not put the recorded boundary back: ${got}" >&2; exit 1; }
  echo "    OK: the recorded boundary is back"

  echo "==> #6627 accept: clear ${BARE_ROLE} again (an accepted member AWS lost is not drift)"
  aws iam detach-role-policy --role-name "${BARE_ROLE}" --policy-arn "${OOB_POLICY_ARN}"
  aws iam delete-role-permissions-boundary --role-name "${BARE_ROLE}"
  sleep 15
  run_drift "${ARTIFACT_DIR}/drift-accept-cleared.json"
  got=$(drift_paths "${ARTIFACT_DIR}/drift-accept-cleared.json")
  [ "${got}" = "BareRole PermissionsBoundary" ] && [ "${DRIFT_RC}" = 1 ] ||
    { echo "FAIL: #6627 accept: after clearing, drift is '${got}' (rc=${DRIFT_RC}); expected only the boundary" >&2; exit 1; }
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --accept --yes
  run_drift "${ARTIFACT_DIR}/drift-accept-final.json"
  got=$(drift_paths "${ARTIFACT_DIR}/drift-accept-final.json")
  [ -z "${got}" ] && [ "${DRIFT_RC}" = 0 ] || { echo "FAIL: #6627 accept: drift after the final --accept:" >&2; echo "${got}" >&2; exit 1; }
  echo "    OK: clean"
}

echo "==> Drift on the observed baseline: clean"
run_drift "${ARTIFACT_DIR}/drift-observed.json"
got=$(drift_paths "${ARTIFACT_DIR}/drift-observed.json")
[ -z "${got}" ] && [ "${DRIFT_RC}" = 0 ] || { echo "FAIL: observed-baseline drift on a clean stack:" >&2; echo "${got}" >&2; exit 1; }
echo "    OK: observed baseline clean"

grant_phase observed

# The template-only baseline: a deploy with capture off, or a failed capture.
echo "==> Strip every observed baseline"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET:-}" AWS_REGION="${REGION}" node strip-all-observed.ts

# go-to-k/cdkd#6624: before the fix, the object-form Statement each of S3,
# SQS, SNS, KMS, Secrets Manager and the role trust policy returns as a
# one-element list was drift here on a stack nobody touched.
echo "==> Drift on the template-only baseline: clean"
run_drift "${ARTIFACT_DIR}/drift-template-only.json"
got=$(drift_paths "${ARTIFACT_DIR}/drift-template-only.json")
[ -z "${got}" ] && [ "${DRIFT_RC}" = 0 ] || { echo "FAIL: template-only drift on a clean stack:" >&2; echo "${got}" >&2; exit 1; }
echo "    OK: template-only baseline clean"

# --- go-to-k/cdkd#6624: a Condition added out of band to each document ------
COND="{\"StringEquals\":{\"aws:PrincipalAccount\":\"${ACCOUNT}\"}}"
ROOT="{\"AWS\":\"arn:${PARTITION}:iam::${ACCOUNT}:root\"}"
stmt() { # $1 = Effect, $2 = Principal JSON or "", $3 = Action, $4 = Resource or ""
  local p="" r=""
  [ -n "$2" ] && p=",\"Principal\":$2"
  [ -n "$4" ] && r=",\"Resource\":\"$4\""
  printf '{"Statement":{"Effect":"%s"%s,"Action":"%s"%s,"Condition":%s}}' \
    "$1" "${p}" "$3" "${r}" "${COND}"
}

echo "==> Add a Condition to every probed document out of band"
aws s3api put-bucket-policy --bucket "${BUCKET}" --region "${REGION}" \
  --policy "$(stmt Deny "${ROOT}" s3:PutObjectLegalHold "arn:${PARTITION}:s3:::${BUCKET}/*")"
node -e 'process.stdout.write(JSON.stringify({ Policy: process.argv[1] }))' \
  "$(stmt Deny "${ROOT}" sqs:PurgeQueue "${QUEUE_ARN}")" >"${ARTIFACT_DIR}/sqs-attrs.json"
aws sqs set-queue-attributes --queue-url "${QUEUE_URL}" --region "${REGION}" \
  --attributes "file://${ARTIFACT_DIR}/sqs-attrs.json"
aws sns set-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" --attribute-name Policy \
  --attribute-value "$(stmt Deny "${ROOT}" sns:ListSubscriptionsByTopic "${TOPIC_ARN}")"
aws kms put-key-policy --key-id "${KEY_ID}" --region "${REGION}" --policy-name default \
  --policy "$(stmt Allow "${ROOT}" 'kms:*' '*')"
aws secretsmanager put-resource-policy --secret-id "${SECRET}" --region "${REGION}" \
  --resource-policy "$(stmt Deny "${ROOT}" secretsmanager:RestoreSecret '*')" >/dev/null
aws iam put-role-policy --role-name "${SIB_ROLE}" --policy-name cdkd-dvr-role-policy \
  --policy-document "$(stmt Deny "" s3:PutObjectLegalHold '*')"
aws iam put-user-policy --user-name "${SIB_USER}" --policy-name cdkd-dvr-user-policy \
  --policy-document "$(stmt Deny "" s3:PutObjectLegalHold '*')"
aws iam put-group-policy --group-name "${SIB_GROUP}" --policy-name cdkd-dvr-group-policy \
  --policy-document "$(stmt Deny "" s3:PutObjectLegalHold '*')"
aws iam update-assume-role-policy --role-name "${BARE_ROLE}" \
  --policy-document "$(stmt Allow '{"Service":"lambda.amazonaws.com"}' sts:AssumeRole "")"
# IAM is eventually consistent; let every read see the write.
sleep 15

# A one-element-list readback compares as a list, so the drift names the
# Statement; an object readback (the Cloud Control IAM inline types) names
# the added key.
EXPECTED_DRIFT=$(printf '%s\n' \
  "BareRole AssumeRolePolicyDocument.Statement" \
  "ProbeBucketPolicy PolicyDocument.Statement" \
  "ProbeGroupPolicy PolicyDocument.Statement.Condition" \
  "ProbeKey KeyPolicy.Statement" \
  "ProbeQueuePolicy PolicyDocument.Statement" \
  "ProbeRolePolicy PolicyDocument.Statement.Condition" \
  "ProbeSecretPolicy ResourcePolicy.Statement" \
  "ProbeTopicPolicy PolicyDocument.Statement" \
  "ProbeUserPolicy PolicyDocument.Statement.Condition" | LC_ALL=C sort)

echo "==> Drift on the template-only baseline names every added Condition"
run_drift "${ARTIFACT_DIR}/drift-condition.json"
got=$(drift_paths "${ARTIFACT_DIR}/drift-condition.json" | LC_ALL=C sort)
if [ "${got}" != "${EXPECTED_DRIFT}" ] || [ "${DRIFT_RC}" != 1 ]; then
  echo "FAIL: template-only drift after the out-of-band Conditions differs from the expected set" >&2
  diff <(echo "${EXPECTED_DRIFT}") <(echo "${got}") >&2 || true
  exit 1
fi
echo "    OK: all 9 documents report the added Condition"

revert_ids_before main

echo "==> drift --revert"
RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --revert --yes \
  2>&1 | tee "${ARTIFACT_DIR}/revert.log" || RC=$?
revert_ids_after main "${ARTIFACT_DIR}/revert.log"
[ "${RC}" -eq 0 ] || { echo "FAIL: drift --revert exited ${RC}" >&2; exit 1; }
sleep 15

# A revert updates in place; its output must not describe a replacement.
if grep -qiE 'replac|re-?creat' "${ARTIFACT_DIR}/revert.log"; then
  echo "FAIL: drift --revert output names a replacement:" >&2
  grep -iE 'replac|re-?creat' "${ARTIFACT_DIR}/revert.log" >&2
  exit 1
fi

echo "==> The live documents hold no Condition after the revert"
live_docs() {
  aws s3api get-bucket-policy --bucket "${BUCKET}" --region "${REGION}" --query Policy --output text || return 1
  aws sqs get-queue-attributes --queue-url "${QUEUE_URL}" --region "${REGION}" --attribute-names Policy --query Attributes.Policy --output text || return 1
  aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" --query Attributes.Policy --output text || return 1
  aws kms get-key-policy --key-id "${KEY_ID}" --region "${REGION}" --policy-name default --query Policy --output text || return 1
  aws secretsmanager get-resource-policy --secret-id "${SECRET}" --region "${REGION}" --query ResourcePolicy --output text || return 1
  aws iam get-role-policy --role-name "${SIB_ROLE}" --policy-name cdkd-dvr-role-policy --output json || return 1
  aws iam get-user-policy --user-name "${SIB_USER}" --policy-name cdkd-dvr-user-policy --output json || return 1
  aws iam get-group-policy --group-name "${SIB_GROUP}" --policy-name cdkd-dvr-group-policy --output json || return 1
  aws iam get-role --role-name "${BARE_ROLE}" --output json || return 1
}
LIVE=$(live_docs) || { echo "FAIL: could not read a live document back after the revert" >&2; exit 1; }
if grep -q 'PrincipalAccount' <<<"${LIVE}"; then
  echo "FAIL: a Condition survived drift --revert:" >&2
  echo "${LIVE}" >&2
  exit 1
fi
echo "    OK: every Condition removed from AWS"

echo "==> Drift on the template-only baseline after the revert: clean"
run_drift "${ARTIFACT_DIR}/drift-after-revert.json"
got=$(drift_paths "${ARTIFACT_DIR}/drift-after-revert.json")
[ -z "${got}" ] && [ "${DRIFT_RC}" = 0 ] || { echo "FAIL: drift after --revert:" >&2; echo "${got}" >&2; exit 1; }
echo "    OK: clean after the revert"

grant_phase template-only

accept_phase
# Back to the template-only baseline (the accept above recorded one for BareRole).
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET:-}" AWS_REGION="${REGION}" node strip-all-observed.ts

# go-to-k/cdkd#6627 on the Cloud Control route: its read is not filtered by
# sibling ownership, so the Sibling* principals' lists hold the siblings'
# members and the revert must keep them while removing the out-of-band ones.
echo "==> Route every principal through Cloud Control"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET:-}" AWS_REGION="${REGION}" node route-cc-api.ts \
  BareRole BareUser BareGroup SiblingRole SiblingUser SiblingGroup
grant_phase cc-api

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force

assert_gone "bucket ${BUCKET_PREFIX}${ACCOUNT}-${REGION} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_PREFIX}${ACCOUNT}-${REGION}" --region "${REGION}"
assert_gone "topic ${TOPIC} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "arn:${PARTITION}:sns:${REGION}:${ACCOUNT}:${TOPIC}" --region "${REGION}"
assert_gone "managed policy ${MP_NAME} still exists after destroy" \
  aws iam get-policy --policy-arn "arn:${PARTITION}:iam::${ACCOUNT}:policy/${MP_NAME}"
for r in "${SIB_ROLE}" "${BARE_ROLE}"; do
  assert_gone "role ${r} still exists after destroy" aws iam get-role --role-name "${r}"
done
for u in "${SIB_USER}" "${BARE_USER}"; do
  assert_gone "user ${u} still exists after destroy" aws iam get-user --user-name "${u}"
done
for g in "${SIB_GROUP}" "${BARE_GROUP}"; do
  assert_gone "group ${g} still exists after destroy" aws iam get-group --group-name "${g}"
done
# SQS and Secrets Manager settle a delete asynchronously.
for probe in queue secret; do
  GONE=""
  for _ in $(seq 1 24); do
    if [ "${probe}" = queue ]; then
      gone_probe aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}" && { GONE=1; break; }
    else
      gone_probe aws secretsmanager describe-secret --secret-id "${SECRET}" --region "${REGION}" && { GONE=1; break; }
    fi
    sleep 5
  done
  [ -n "${GONE}" ] || { echo "FAIL: ${probe} still exists after destroy" >&2; exit 1; }
done
assert_gone "alias ${KEY_ALIAS} still exists after destroy" \
  aws kms describe-key --key-id "${KEY_ALIAS}" --region "${REGION}"
# A deleted KMS key stays readable through its pending window; 7 days is the
# AWS minimum, so PendingDeletion is the terminal state of a deleted key.
key_state=$(aws kms describe-key --key-id "${KEY_ID}" --region "${REGION}" --query 'KeyMetadata.KeyState' --output text)
[ "${key_state}" = "PendingDeletion" ] || { echo "FAIL: key ${KEY_ID} is ${key_state} after destroy, expected PendingDeletion" >&2; exit 1; }
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: every resource gone"

trap - EXIT INT TERM
echo "    readback artifacts: ${ARTIFACT_DIR}"
echo "[verify] PASS -- drift-verbatim-readback recorded readbacks in ${ARTIFACT_DIR}"

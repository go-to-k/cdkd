#!/usr/bin/env bash
# verify.sh - iam-secret-derived-principals: IAM principal lists whose NAMES come
# from a Secrets Manager secret (go-to-k/cdkd#3906, go-to-k/cdkd#3888).
#
# cdkd persists a secret-derived value REDACTED: state records the
# `{{resolve:secretsmanager:...}}` expression, never the resolved name. So every
# later update of such a resource sees a RECORDED principal list it cannot diff
# from the record. cdkd reads that kind from IAM instead, ADD-only for an
# AWS::IAM::ManagedPolicy's `Roles` and an AWS::IAM::User's `Groups`: it attaches
# what the template names and detaches nothing on IAM's evidence.
#
# The role and the group are created OUTSIDE the stack, and the secret holds
# their names, so a name can reach cdkd state only through the secret.
#
# LOAD-BEARING assertions:
#   1. PREMISE: after the first deploy, state records the {{resolve:secretsmanager:
#      expression and neither name.
#   2. THE UPDATE (CDKD_TEST_UPDATE=true: an unrelated policy-document change
#      plus one ADDED principal on each list) SUCCEEDS. This is what
#      discriminates the fix: without the live read the update either refuses
#      the secret-derived record or sends a Detach / Remove for the literal
#      `{{resolve:` name, which IAM rejects.
#   3. The added principal is attached, the secret-named one still is, AND a
#      principal attached BY HAND that no template names still is too (ADD-only:
#      a full live diff would detach it), with the update log carrying both
#      ADD-only warnings as positive markers of the live-read path; the document
#      change landed; and neither name appears in the deploy or update log.
#   4. Destroy is clean, and no surviving object version under the stack's
#      state prefix carries either name.
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured. Explicit PASS.

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
# shellcheck source=../s3-versions.sh
. ../s3-versions.sh

STACK="CdkdIamSecretDerivedPrincipals"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t iam-secret-derived-principals.XXXXXX)"

# One run's names: unique, so a leftover from a failed run cannot be mistaken
# for this one's, and grep-able in the plaintext sweep.
SUFFIX="$(date +%s)-$$"
EXT_ROLE="cdkd-integ-sdp-role-${SUFFIX}"
EXT_GROUP="cdkd-integ-sdp-group-${SUFFIX}"
# Attached / joined BY HAND after the first deploy, and named by NO template:
# what IAM lists beyond the template. A full live diff would detach / remove
# them; ADD-only must leave them.
ELSE_ROLE="cdkd-integ-sdp-else-role-${SUFFIX}"
ELSE_GROUP="cdkd-integ-sdp-else-group-${SUFFIX}"
export SDP_SECRET_NAME="cdkd-integ-sdp-${SUFFIX}"
SEEDED_ROLE=0
SEEDED_GROUP=0
SEEDED_ELSE_ROLE=0
SEEDED_ELSE_GROUP=0
SEEDED_SECRET=0
# Set just before the first deploy: the stack name is fixed, so a run refused by
# the pre-flight must not destroy (or sweep the state history of) a stack an
# earlier or concurrent run left behind.
DEPLOYED=0

# IAM is eventually consistent right after create; let the CLI back off
# transparently for the assertion + cleanup calls.
export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

# Best-effort teardown of one seeded principal, detaching / emptying it first
# (a failed destroy can leave the policy or a membership behind). Subshelled
# with `set +eu`, so a call from `cleanup` never re-arms strict mode.
delete_seeded_role() { # usage: delete_seeded_role <role-name>
  (
    set +eu
    arns="$(aws iam list-attached-role-policies --role-name "$1" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null)"
    for arn in ${arns}; do
      [ "${arn}" = "None" ] && continue
      aws iam detach-role-policy --role-name "$1" --policy-arn "${arn}" >/dev/null 2>&1
    done
    aws iam delete-role --role-name "$1" >/dev/null 2>&1
  )
}
delete_seeded_group() { # usage: delete_seeded_group <group-name>
  (
    set +eu
    users="$(aws iam get-group --group-name "$1" --query 'Users[].UserName' --output text 2>/dev/null)"
    for user in ${users}; do
      [ "${user}" = "None" ] && continue
      aws iam remove-user-from-group --group-name "$1" --user-name "${user}" >/dev/null 2>&1
    done
    aws iam delete-group --group-name "$1" >/dev/null 2>&1
  )
}
# Redacts the secret-derived names from what this script prints: the run log's
# tail and expect_eq's FAIL line. NOT covered: the canonical gone_probe /
# assert_gone block (a fenced verbatim copy) and raw AWS CLI stderr, which can
# name a seeded principal on a failure; those names are synthetic per-run
# values, never a real secret.
redact() {
  sed -e "s|${EXT_ROLE}|<secret-role>|g" -e "s|${EXT_GROUP}|<secret-group>|g"
}
log_tail() {
  tail -60 "${DEPLOY_LOG}" | redact >&2
}

# Cleanup order: the STACK first (its deletes detach the policy from the
# external role and remove the user from the external group), then the
# external principals (detaching anything left by a failed destroy), then the
# secret, then the non-current state versions (safe on any path: a live
# state.json a later `cdkd state destroy` needs survives).
cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +eu
  if [ "${DEPLOYED}" = "1" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
  fi
  [ "${SEEDED_ROLE}" = "1" ] && delete_seeded_role "${EXT_ROLE}"
  [ "${SEEDED_ELSE_ROLE}" = "1" ] && delete_seeded_role "${ELSE_ROLE}"
  [ "${SEEDED_GROUP}" = "1" ] && delete_seeded_group "${EXT_GROUP}"
  [ "${SEEDED_ELSE_GROUP}" = "1" ] && delete_seeded_group "${ELSE_GROUP}"
  if [ "${SEEDED_SECRET}" = "1" ]; then
    aws secretsmanager delete-secret --region "${REGION}" --secret-id "${SDP_SECRET_NAME}" \
      --force-delete-without-recovery >/dev/null 2>&1
  fi
  if [ "${DEPLOYED}" = "1" ]; then
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${PREFIX}" noncurrent || true
  fi
  rm -f "${DEPLOY_LOG}" "${SECRET_FILE:-}" 2>/dev/null || true
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "==> Pre-flight orphan scan"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state already exists at ${STATE_KEY} - clean up first." >&2
  exit 1
fi

echo "==> Step 1: seed the external role and group, and the secret naming them"
aws iam create-role --role-name "${EXT_ROLE}" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  >/dev/null
SEEDED_ROLE=1
aws iam create-role --role-name "${ELSE_ROLE}" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  >/dev/null
SEEDED_ELSE_ROLE=1
aws iam create-group --group-name "${EXT_GROUP}" >/dev/null
SEEDED_GROUP=1
aws iam create-group --group-name "${ELSE_GROUP}" >/dev/null
SEEDED_ELSE_GROUP=1
# From a file, not argv, so the value never shows in the host's process list.
SECRET_FILE="$(mktemp -t iam-secret-derived-principals-secret.XXXXXX)"
printf '{"role":"%s","group":"%s"}' "${EXT_ROLE}" "${EXT_GROUP}" > "${SECRET_FILE}"
aws secretsmanager create-secret --region "${REGION}" --name "${SDP_SECRET_NAME}" \
  --secret-string "file://${SECRET_FILE}" >/dev/null
SEEDED_SECRET=1
rm -f "${SECRET_FILE}"
aws iam wait role-exists --role-name "${EXT_ROLE}"
aws iam wait role-exists --role-name "${ELSE_ROLE}"
# No group-exists waiter: poll, so the deploy's AddUserToGroup does not race it.
for group in "${EXT_GROUP}" "${ELSE_GROUP}"; do
  seen=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if aws iam get-group --group-name "${group}" >/dev/null 2>&1; then
      seen=1
      break
    fi
    sleep 3
  done
  if [ "${seen}" -ne 1 ]; then
    echo "FAIL: a seeded group was not readable after 30s" >&2
    exit 1
  fi
done
echo "    OK: seeded (names withheld from the log)"

# One IAM name per line, sorted: list readbacks are order-insensitive.
find_name() { # usage: find_name <list-verb> <collection> <name-field> <logical-id> [extra args...]
  local verb="$1" coll="$2" field="$3" id="$4"
  shift 4
  aws iam "${verb}" "$@" --query "${coll}[?contains(${field}, '${STACK}') && contains(${field}, '${id}')].${field}" \
    --output text | tr '\t' '\n' | awk 'NF{print; exit}'
}
user_groups() { # usage: user_groups <user-name>
  aws iam list-groups-for-user --user-name "$1" --query "Groups[].GroupName" --output text \
    | tr '\t' '\n' | awk 'NF' | sort | tr '\n' ' '
}
policy_on_role() { # usage: policy_on_role <role-name> -> 1 when attached, 0 when not
  aws iam list-attached-role-policies --role-name "$1" \
    --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}'] | length(@)" --output text
}
policy_roles() { # usage: policy_roles <unused> -> the roles IAM lists for the policy, sorted
  aws iam list-entities-for-policy --policy-arn "${POLICY_ARN}" --entity-filter Role \
    --query 'PolicyRoles[].RoleName' --output text | tr '\t' '\n' | awk 'NF' | sort | tr '\n' ' '
}
policy_document() { # usage: policy_document <unused> -> the default version's document, compact
  local version
  version="$(aws iam get-policy --policy-arn "${POLICY_ARN}" --query 'Policy.DefaultVersionId' --output text)" || return 1
  aws iam get-policy-version --policy-arn "${POLICY_ARN}" --version-id "${version}" \
    --query 'PolicyVersion.Document.Statement[0].Action' --output text | tr '\t' '\n' | sort | tr '\n' ' '
}
expect_eq() { # usage: expect_eq <what> <want> <readback-fn> <arg>
  # Polls: IAM reads are eventually consistent right after a write. A failed
  # readback FAILS the run rather than reading as an empty answer.
  local got="" i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    got=$("$3" "$4") || { echo "FAIL: $1: readback failed" >&2; exit 1; }
    [ "${got}" = "$2" ] && break
    sleep 5
  done
  if [ "${got}" != "$2" ]; then
    echo "FAIL: $1: want '$2', got '${got}'" | redact >&2
    exit 1
  fi
  echo "    OK: $1"
}
# The current state.json, fetched fresh; never echoed (it is what the premise
# asserts holds no plaintext).
# cdkd masks a resolved secret in its own output (issue #2177), so neither name
# may appear in a deploy or update log. Not checked on destroy: a provider's
# delete path has no masker by design (issue #2007), and the user's delete logs
# each group it leaves. Never echoes the needle.
log_holds_no_plaintext() { # usage: log_holds_no_plaintext <phase>
  local needle
  for needle in "${EXT_ROLE}" "${EXT_GROUP}"; do
    if grep -qF "${needle}" "${DEPLOY_LOG}"; then
      echo "FAIL: the $1 log carries a secret-derived name in plaintext" >&2
      exit 1
    fi
  done
  echo "    OK: the $1 log carries neither name"
}
state_holds() { # usage: state_holds <literal> -> 0 when the current state.json contains it
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>&1)" || {
    echo "FAIL: could not read ${STATE_KEY}" >&2
    exit 1
  }
  # A here-string, not `printf | grep -q`: grep exits at the first match, so a
  # body larger than the pipe buffer takes SIGPIPE in printf and pipefail turns
  # a MATCH into "no match" -- a vacuous pass for every absence check.
  grep -qF -- "$1" <<< "${body}"
}

# Every SURVIVING object version under the stack's key space, grepped for a
# plaintext name. On a VERSIONED bucket `aws s3 rm` writes a delete marker and
# every byte ever written stays readable, so the current object proves nothing.
# `Versions[]`, not delete markers: a marker has no body and `get-object` on it
# answers 405. A here-string keeps `scanned` alive past the loop, and
# `|| [ -n "${key}" ]` reads the last row `$(...)` left unterminated. The
# zero-scanned refusal stops a mistyped prefix from certifying nothing.
assert_no_plaintext_in_versions() { # usage: assert_no_plaintext_in_versions <plaintext> <description>
  local needle="$1" desc="$2" rows key vid body scanned=0
  if ! rows="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
      --prefix "${PREFIX}" --query 'Versions[].[Key,VersionId]' --output text 2>&1)"; then
    echo "FAIL: ${desc}: could not list object versions under s3://${STATE_BUCKET}/${PREFIX}" >&2
    exit 1
  fi
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ -n "${vid}" ] || continue
    [ "${vid}" != "None" ] || continue
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
        --version-id "${vid}" /dev/stdout < /dev/null 2>&1)"; then
      echo "FAIL: ${desc}: could not read s3://${STATE_BUCKET}/${key} version ${vid} - undetermined" >&2
      exit 1
    fi
    # -qF so a match is never echoed.
    # A here-string: see state_holds for why not a pipe.
    if grep -qF -- "${needle}" <<< "${body}"; then
      echo "FAIL: ${desc}: s3://${STATE_BUCKET}/${key} version ${vid} carries the plaintext" >&2
      exit 1
    fi
    scanned=$((scanned + 1))
  done <<< "${rows}"
  if [ "${scanned}" -eq 0 ]; then
    echo "FAIL: ${desc}: scanned ZERO object versions under s3://${STATE_BUCKET}/${PREFIX}" >&2
    exit 1
  fi
  echo "    OK: ${desc}: ${scanned} surviving object version(s) scanned, none carries it"
}

echo "==> Step 2: deploy (policy on the secret-named role, user in the secret-named group)"
DEPLOYED=1
set +e
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  log_tail
  exit 1
fi
echo "    OK: deploy exited 0"
log_holds_no_plaintext deploy

POLICY_ARN=$(aws iam list-policies --scope Local \
  --query "Policies[?contains(PolicyName, '${STACK}') && contains(PolicyName, 'SecretPolicy')].Arn" \
  --output text | tr '\t' '\n' | awk 'NF{print; exit}')
ADDED_ROLE=$(find_name list-roles Roles RoleName AddedRole)
ADDED_GROUP=$(find_name list-groups Groups GroupName AddedGroup)
MEMBER=$(find_name list-users Users UserName SecretMember)
for v in POLICY_ARN ADDED_ROLE ADDED_GROUP MEMBER; do
  if [ -z "${!v}" ]; then echo "FAIL: ${v} not found for ${STACK}" >&2; exit 1; fi
done

echo "==> Step 3 (PREMISE): state records the redacted expression, not the names"
for field in role group; do
  if ! state_holds "{{resolve:secretsmanager:${SDP_SECRET_NAME}:SecretString:${field}::}}"; then
    echo "FAIL: state does not record the {{resolve:secretsmanager: expression for the ${field}; that list is not secret-derived, so the update below would not exercise its live read" >&2
    exit 1
  fi
done
for needle in "${EXT_ROLE}" "${EXT_GROUP}"; do
  if state_holds "${needle}"; then
    echo "FAIL: the current state.json carries a secret-derived name in plaintext" >&2
    exit 1
  fi
done
echo "    OK: state holds the expression and neither name"
expect_eq "SecretPolicy on the secret-named role" "1" policy_on_role "${EXT_ROLE}"
expect_eq "the user's groups" "${EXT_GROUP} " user_groups "${MEMBER}"

echo "==> Step 3b: attach the policy and add the user BY HAND to principals no template names"
aws iam attach-role-policy --role-name "${ELSE_ROLE}" --policy-arn "${POLICY_ARN}"
aws iam add-user-to-group --group-name "${ELSE_GROUP}" --user-name "${MEMBER}"
expect_eq "SecretPolicy on the hand-attached role" "1" policy_on_role "${ELSE_ROLE}"
# Through the API the update reads (ListEntitiesForPolicy), so its eventual
# consistency is settled before the update runs.
WANT_ROLES=$(printf '%s\n%s\n' "${EXT_ROLE}" "${ELSE_ROLE}" | sort | tr '\n' ' ')
expect_eq "the roles IAM lists for SecretPolicy" "${WANT_ROLES}" policy_roles -
WANT_BASE=$(printf '%s\n%s\n' "${EXT_GROUP}" "${ELSE_GROUP}" | sort | tr '\n' ' ')
expect_eq "the user's groups (hand-added one included)" "${WANT_BASE}" user_groups "${MEMBER}"

echo "==> Step 4 (LOAD-BEARING): update - a document change plus one ADDED principal per list"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
UPDATE_RC=$?
set -e
if [ "${UPDATE_RC}" -ne 0 ]; then
  echo "FAIL: update deploy exited ${UPDATE_RC}; the secret-derived recorded list was not read from IAM" >&2
  log_tail
  exit 1
fi
echo "    OK: update deploy exited 0"
log_holds_no_plaintext update
# The ADD-only path announces what it leaves: IAM lists the hand-attached
# principals, which the template does not name. The positive marker proves the
# live-read path ran rather than a record diff.
for marker in "cdkd detaches none of them" "cdkd removes the user from none of them"; do
  if ! grep -qF "${marker}" "${DEPLOY_LOG}"; then
    echo "FAIL: the update log has no '${marker}' warning; the secret-derived record was not read from IAM ADD-only (or the wording drifted)" >&2
    log_tail
    exit 1
  fi
done
echo "    OK: the update read the secret-derived lists from IAM, ADD-only"
# The fail-closed half of the ADD-only claim. A readback of "still attached"
# can be served stale right after a detach, so it alone cannot prove nothing
# was detached; the update's own --verbose log can. Every list here only GROWS,
# so ANY detach or removal line in the update log is the regression, whichever
# principal it names (the secret-derived names are masked there).
# Positive siblings from the same debug stream first: the ADDED principals'
# attach / add lines prove debug lines reach this log, so the absence check
# below cannot pass on a silent log.
for sibling in 'Attached .* to role ' 'Added user .* to group '; do
  if ! grep -qE "${sibling}" "${DEPLOY_LOG}"; then
    echo "FAIL: the update log has no '${sibling}' line; its debug output is missing (or the wording drifted), so the no-detach check below would pass on nothing" >&2
    log_tail
    exit 1
  fi
done
# Keyed on the line SHAPE, not the ARN, so a masked policy name cannot blunt it.
for forbidden in 'Detached .* from (role|group|user) ' 'Removed user .* from group '; do
  if grep -qE "${forbidden}" "${DEPLOY_LOG}"; then
    echo "FAIL: the update log carries a '${forbidden}' line; an update that only adds principals detached or removed one" >&2
    log_tail
    exit 1
  fi
done
echo "    OK: the update log carries no detach or removal"

echo "==> Step 5 (LOAD-BEARING): the added principals joined, the secret-named ones stayed"
expect_eq "the policy's document change landed" "logs:DescribeLogGroups logs:GetLogEvents " policy_document -
expect_eq "SecretPolicy on the ADDED role" "1" policy_on_role "${ADDED_ROLE}"
expect_eq "SecretPolicy still on the secret-named role" "1" policy_on_role "${EXT_ROLE}"
expect_eq "SecretPolicy still on the hand-attached role (ADD-only: no template names it)" "1" policy_on_role "${ELSE_ROLE}"
WANT_GROUPS=$(printf '%s\n%s\n%s\n' "${EXT_GROUP}" "${ELSE_GROUP}" "${ADDED_GROUP}" | sort | tr '\n' ' ')
expect_eq "the user's groups (added one joined; secret-named and hand-added ones kept, ADD-only)" "${WANT_GROUPS}" user_groups "${MEMBER}"
for needle in "${EXT_ROLE}" "${EXT_GROUP}"; do
  if state_holds "${needle}"; then
    echo "FAIL: the current state.json carries a secret-derived name in plaintext after the update" >&2
    exit 1
  fi
done
echo "    OK: state still holds neither name"

echo "==> Step 6: destroy"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  log_tail
  exit 1
fi
echo "    OK: destroy exited 0"

echo "==> Step 7: assert 0 orphans from the stack"
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "managed policy ${POLICY_ARN} still exists after destroy" \
  aws iam get-policy --policy-arn "${POLICY_ARN}"
assert_gone "IAM role ${ADDED_ROLE} still exists after destroy" \
  aws iam get-role --role-name "${ADDED_ROLE}"
assert_gone "IAM group ${ADDED_GROUP} still exists after destroy" \
  aws iam get-group --group-name "${ADDED_GROUP}"
assert_gone "IAM user ${MEMBER} still exists after destroy" \
  aws iam get-user --user-name "${MEMBER}"
echo "    OK: 0 orphans (state, policy, added role and group, user all gone)"

echo "==> Step 8 (LOAD-BEARING): no surviving state version carries either name"
assert_no_plaintext_in_versions "${EXT_ROLE}" "the secret-named role"
assert_no_plaintext_in_versions "${EXT_GROUP}" "the secret-named group"

echo "==> Step 9: remove the seeded roles, groups and secret"
aws iam delete-role --role-name "${EXT_ROLE}"
SEEDED_ROLE=0
aws iam delete-role --role-name "${ELSE_ROLE}"
SEEDED_ELSE_ROLE=0
aws iam delete-group --group-name "${EXT_GROUP}"
SEEDED_GROUP=0
aws iam delete-group --group-name "${ELSE_GROUP}"
SEEDED_ELSE_GROUP=0
aws secretsmanager delete-secret --region "${REGION}" --secret-id "${SDP_SECRET_NAME}" \
  --force-delete-without-recovery >/dev/null
SEEDED_SECRET=0
assert_gone "the seeded secret-named role still exists" aws iam get-role --role-name "${EXT_ROLE}"
assert_gone "the seeded secret-named group still exists" aws iam get-group --group-name "${EXT_GROUP}"
assert_gone "the seeded hand-attached role still exists" aws iam get-role --role-name "${ELSE_ROLE}"
assert_gone "the seeded hand-added group still exists" aws iam get-group --group-name "${ELSE_GROUP}"
echo "    OK: seeded principals and secret removed"

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}" 2>/dev/null || true

echo "==> Step 10: sweep every object version under the stack's state prefix"
# On the SUCCESS path, after the disarm: a sweep living only in `cleanup` never
# runs here, and `noncurrent` would leave the delete marker behind.
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX}" "stack state teardown"
echo ""
echo "==> iam-secret-derived-principals test passed: the secret-derived lists were read from IAM ADD-only, the added principals joined, the secret-named ones stayed, destroy clean, no plaintext in any state version"

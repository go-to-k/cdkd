#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6324.
#
# A sibling AWS::IAM::ManagedPolicy attaching itself to a role / user / group
# through its own `Roles` / `Users` / `Groups` list is that resource's, not the
# principal's. Before the fix `cdkd drift` reported it on a fresh stack as
#   ~ Role... (AWS::IAM::Role)  ManagedPolicyArns: [Basic] -> [<Mp arn>, Basic]
# and `cdkd drift --revert -y` DETACHED the policy from the role, printing
# success.
#
# Phases:
#   1. Deploy a role (declaring AWSLambdaBasicExecutionRole), a user and a
#      group (each declaring IAMUserChangePassword), and a ManagedPolicy
#      attached to all three; assert the attachments.
#   2. `cdkd drift` exits 0: no drift on any principal.
#   3. Attach AWSDenyAll to the role, the user and the group OUT OF BAND.
#   4. `cdkd drift` exits 1 and reports each principal's out-of-band ARN,
#      never the sibling's.
#   5. `cdkd drift --revert -y` detaches AWSDenyAll ONLY: the sibling policy
#      stays attached to the role, the user and the group.
#   6. `cdkd drift` exits 0 again.
#   7. Destroy + gone-probes.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdIamSiblingManagedPolicyDriftExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE_NAME="cdkd-iam-sibling-mp-role"
USER_NAME="cdkd-iam-sibling-mp-user"
GROUP_NAME="cdkd-iam-sibling-mp-group"
POLICY_NAME="cdkd-iam-sibling-mp-policy"
DRIFT_LOG=""

# We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The partition and account the policy ARNs live in, read once before cleanup.
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
PARTITION="$(cut -d: -f2 <<<"${CALLER_ARN}")"
MP_ARN="arn:${PARTITION}:iam::${ACCOUNT}:policy/${POLICY_NAME}"
BASIC_ARN="arn:${PARTITION}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
DENY_ARN="arn:${PARTITION}:iam::aws:policy/AWSDenyAll"
OWN_ARN="arn:${PARTITION}:iam::aws:policy/IAMUserChangePassword"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  rm -f "${DRIFT_LOG:-}"
  for arn in $(aws iam list-attached-role-policies --role-name "${ROLE_NAME}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${ROLE_NAME}" --policy-arn "${arn}" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
  for arn in $(aws iam list-attached-user-policies --user-name "${USER_NAME}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-user-policy --user-name "${USER_NAME}" --policy-arn "${arn}" >/dev/null 2>&1
  done
  aws iam delete-user --user-name "${USER_NAME}" >/dev/null 2>&1
  for arn in $(aws iam list-attached-group-policies --group-name "${GROUP_NAME}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-group-policy --group-name "${GROUP_NAME}" --policy-arn "${arn}" >/dev/null 2>&1
  done
  aws iam delete-group --group-name "${GROUP_NAME}" >/dev/null 2>&1
  # A policy with non-default versions refuses DeletePolicy until they go.
  for v in $(aws iam list-policy-versions --policy-arn "${MP_ARN}" \
      --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text 2>/dev/null); do
    aws iam delete-policy-version --policy-arn "${MP_ARN}" --version-id "${v}" >/dev/null 2>&1
  done
  aws iam delete-policy --policy-arn "${MP_ARN}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

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

attached() { # usage: attached role|user|group <name> -> its attached policy ARNs, sorted, space-joined
  local out
  out="$(aws iam "list-attached-$1-policies" "--$1-name" "$2" \
    --query "join(' ', sort(AttachedPolicies[].PolicyArn || \`[]\`))" --output text)" || return 1
  printf '%s' "${out}"
}
sorted() { # usage: sorted <arn>... -> the ARNs sorted, space-joined (attached's shape)
  printf '%s\n' "$@" | sort | tr '\n' ' ' | sed 's/ $//'
}
# Reads all three principals into GOT_ROLE / GOT_USER / GOT_GROUP. Called at
# the TOP level, never inside `$( )`, so a failed read ends the RUN.
read_all() {
  if ! GOT_ROLE="$(attached role "${ROLE_NAME}")"; then
    echo "FAIL: list-attached-role-policies ${ROLE_NAME} failed" >&2
    exit 1
  fi
  if ! GOT_USER="$(attached user "${USER_NAME}")"; then
    echo "FAIL: list-attached-user-policies ${USER_NAME} failed" >&2
    exit 1
  fi
  if ! GOT_GROUP="$(attached group "${GROUP_NAME}")"; then
    echo "FAIL: list-attached-group-policies ${GROUP_NAME} failed" >&2
    exit 1
  fi
}
run_drift() { # usage: run_drift [extra drift flags...] -> sets DRIFT_RC; output in DRIFT_LOG
  DRIFT_LOG="$(mktemp)"
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" "$@" \
    >"${DRIFT_LOG}" 2>&1
  DRIFT_RC=$?
  set -e
  sed 's/^/    | /' "${DRIFT_LOG}"
}
# Every principal's block must name AWSDenyAll (header to the next 20 lines).
assert_block_names_deny() { # usage: assert_block_names_deny <type>
  local block
  if ! grep -qF "($1)" "${DRIFT_LOG}"; then
    echo "FAIL: cdkd drift reported no '($1)' resource header; its out-of-band AWSDenyAll went unreported, or the report wording drifted" >&2
    exit 1
  fi
  block="$(grep -A20 -F "($1)" "${DRIFT_LOG}")"
  if ! grep -qF 'AWSDenyAll' <<<"${block}"; then
    echo "FAIL: cdkd drift did not name AWSDenyAll in the $1 drift block" >&2
    exit 1
  fi
}

WANT_ROLE="$(sorted "${BASIC_ARN}" "${MP_ARN}")"
WANT_OTHER="$(sorted "${OWN_ARN}" "${MP_ARN}")"

# --- Phase 1: deploy -----------------------------------------------------
echo "==> Phase 1: deploy the role / user / group and the sibling ManagedPolicy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# Polled: IAM reads are eventually consistent right after a write.
premise_ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  read_all
  if [ "${GOT_ROLE}" = "${WANT_ROLE}" ] && [ "${GOT_USER}" = "${WANT_OTHER}" ] && [ "${GOT_GROUP}" = "${WANT_OTHER}" ]; then
    premise_ok=1
    break
  fi
  sleep 5
done
if [ "${premise_ok}" -ne 1 ]; then
  echo "FAIL: premise: after deploy role='${GOT_ROLE}' (want '${WANT_ROLE}'), user='${GOT_USER}', group='${GOT_GROUP}' (want '${WANT_OTHER}')" >&2
  exit 1
fi
echo "    the sibling policy is attached to the role, the user and the group"

# --- Phase 2: no drift on a fresh stack ----------------------------------
echo "==> Phase 2: cdkd drift on the fresh stack (expect exit 0)"
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} on a freshly deployed stack; the sibling ManagedPolicy's attachment read as the principal's drift (go-to-k/cdkd#6324)" >&2
  exit 1
fi
echo "    no drift"

# --- Phase 3: out-of-band attachments ------------------------------------
echo "==> Phase 3: attach AWSDenyAll to the role, the user and the group out of band"
aws iam attach-role-policy --role-name "${ROLE_NAME}" --policy-arn "${DENY_ARN}"
aws iam attach-user-policy --user-name "${USER_NAME}" --policy-arn "${DENY_ARN}"
aws iam attach-group-policy --group-name "${GROUP_NAME}" --policy-arn "${DENY_ARN}"
WANT_OOB_ROLE="$(sorted "${BASIC_ARN}" "${MP_ARN}" "${DENY_ARN}")"
WANT_OOB_OTHER="$(sorted "${OWN_ARN}" "${MP_ARN}" "${DENY_ARN}")"
oob_ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  read_all
  if [ "${GOT_ROLE}" = "${WANT_OOB_ROLE}" ] && [ "${GOT_USER}" = "${WANT_OOB_OTHER}" ] && [ "${GOT_GROUP}" = "${WANT_OOB_OTHER}" ]; then
    oob_ok=1
    break
  fi
  sleep 5
done
if [ "${oob_ok}" -ne 1 ]; then
  echo "FAIL: premise: the out-of-band attachments did not land (role='${GOT_ROLE}', user='${GOT_USER}', group='${GOT_GROUP}')" >&2
  exit 1
fi

# --- Phase 4: the out-of-band ARN is drift, the sibling's is not ---------
echo "==> Phase 4: cdkd drift reports the out-of-band ARN only (expect exit 1)"
run_drift
if [ "${DRIFT_RC}" -ne 1 ]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC}; out-of-band AWSDenyAll attachments must report drift (exit 1)" >&2
  exit 1
fi
assert_block_names_deny AWS::IAM::Role
assert_block_names_deny AWS::IAM::User
assert_block_names_deny AWS::IAM::Group
if grep -qF "${POLICY_NAME}" "${DRIFT_LOG}"; then
  echo "FAIL: cdkd drift reported the sibling ManagedPolicy's ARN as principal drift (go-to-k/cdkd#6324)" >&2
  exit 1
fi
echo "    AWSDenyAll is reported on each principal; the sibling policy is not"

# --- Phase 5: --revert detaches the out-of-band ARN only -----------------
echo "==> Phase 5: cdkd drift --revert -y (expect exit 0)"
run_drift --revert -y
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd drift --revert -y exited ${DRIFT_RC}" >&2
  exit 1
fi
# Polled on the detaches the revert made; the sibling's attachments are then
# asserted exactly (they must never have been touched).
revert_ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  read_all
  case " ${GOT_ROLE} ${GOT_USER} ${GOT_GROUP} " in
    *" ${DENY_ARN} "*) ;;
    *)
      revert_ok=1
      break
      ;;
  esac
  sleep 5
done
if [ "${revert_ok}" -ne 1 ]; then
  echo "FAIL: --revert did not detach every out-of-band AWSDenyAll (role='${GOT_ROLE}', user='${GOT_USER}', group='${GOT_GROUP}')" >&2
  exit 1
fi
if [ "${GOT_ROLE}" != "${WANT_ROLE}" ]; then
  echo "FAIL: after --revert the role holds '${GOT_ROLE}', want '${WANT_ROLE}'; the revert detached the sibling ManagedPolicy (go-to-k/cdkd#6324)" >&2
  exit 1
fi
if [ "${GOT_USER}" != "${WANT_OTHER}" ] || [ "${GOT_GROUP}" != "${WANT_OTHER}" ]; then
  echo "FAIL: after --revert user='${GOT_USER}', group='${GOT_GROUP}', want '${WANT_OTHER}' on both; the revert detached the sibling ManagedPolicy (go-to-k/cdkd#6324)" >&2
  exit 1
fi
echo "    AWSDenyAll detached everywhere; the sibling policy is still attached to the role, the user and the group"

# --- Phase 6: clean again --------------------------------------------------
echo "==> Phase 6: cdkd drift after the revert (expect exit 0)"
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} after the revert" >&2
  exit 1
fi
rm -f "${DRIFT_LOG}"
echo "    no drift"

# --- Phase 7: destroy ------------------------------------------------------
echo "==> Phase 7: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "user ${USER_NAME} still exists after destroy" aws iam get-user --user-name "${USER_NAME}"
assert_gone "group ${GROUP_NAME} still exists after destroy" aws iam get-group --group-name "${GROUP_NAME}"
assert_gone "policy ${MP_ARN} still exists after destroy" aws iam get-policy --policy-arn "${MP_ARN}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    every resource and the cdkd state are gone"

echo "[verify] PASS — a sibling AWS::IAM::ManagedPolicy's attachment is not principal drift, and drift --revert detaches only the out-of-band ARN"

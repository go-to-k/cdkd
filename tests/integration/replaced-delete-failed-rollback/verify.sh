#!/usr/bin/env bash
#
# go-to-k/cdkd#2631: a replacement whose delete of the OLD resource is refused,
# followed by a failure later in the same deploy. The rollback journal records
# that the old resource may still exist (`oldResourceMaySurvive`), and the
# automatic rollback reads AWS for it before re-creating it: it is alive, so
# it is re-adopted and the replacement's new resource deleted. Before #2631
# the rollback re-created it, which for this named policy collided with the
# live one (EntityAlreadyExists) and failed the rollback of `Target`, leaving
# state on the new policy and the old one untracked.
#
# Phases:
#   1. Baseline deploy: `Target` = managed policy `cdkd-rdfr-target-a`.
#   2. A role is created that may create, read and delete this run's policies
#      (`cdkd-rdfr-*`) and use the state bucket, but may NOT delete
#      `cdkd-rdfr-target-a` nor create `cdkd-rdfr-breaker`. As that role,
#      `TARGET_SUFFIX=b BREAK=true` deploys with the automatic rollback:
#      `Target` is replaced by `cdkd-rdfr-target-b`, the old policy's delete is
#      refused (deferred to the post-deploy retry, go-to-k/cdkd#4900), and
#      `Breaker`'s create is refused, failing the deploy before that retry.
#      Asserted: the deploy failed; it deferred the refused delete; the
#      rollback re-adopted the old policy (the #2631 line) and did not fail on
#      `Target`; `cdkd-rdfr-target-a` exists, `cdkd-rdfr-target-b` and
#      `cdkd-rdfr-breaker` do not; state's `Target` names `cdkd-rdfr-target-a`.
#   3. `cdkd destroy`: every policy, the state file and the role are gone.
#   4. go-to-k/cdkd#4911, the provider's own replacement: baseline deploy with
#      `Cert`, a DNS-validated ACM certificate (`CERT_MODE=dns`).
#   5. As a role that may not delete that certificate nor create Breaker,
#      `CERT_MODE=email BREAK=true` deploys with the automatic rollback. The
#      ACM provider replaces the certificate inside its `update()` (a
#      `ValidationMethod` change), its delete of the old one is refused, and
#      it reports a partial update saying AWS refused that delete outright;
#      Breaker then fails the deploy. Asserted: the rollback read AWS, found
#      the old certificate alive and re-adopted it, deleting the replacement;
#      only the old certificate exists and state names it. Before #4911 the
#      rollback requested a new copy of the old certificate (a duplicate).
#   6. `cdkd destroy`: every policy and certificate, the state file, the
#      journal and the role are gone, and the state prefix's object versions
#      are swept.
#
# Cost: up to three IAM managed policies, two ACM certificates (three on a
# pre-#4911 binary) left in
# PENDING_VALIDATION on a synthetic `.example.test` domain under
# `CDKD_NO_WAIT=true` (free, no DNS) and one role at a time. On any failure,
# cleanup deletes the policies and this run's certificates by ARN, destroys
# the stack and deletes the role.
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
# IAM is eventually consistent: retry the gone-probe on a bounded schedule.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws iam get-policy ...
  local desc="$1"; shift
  for _ in $(seq 1 30); do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 5
  done
  echo "FAIL: ${desc} (still present after 30 probes over ~150s)" >&2
  exit 1
}
present_eventually() { # usage: present_eventually aws iam get-policy ...  (0 = present)
  for _ in $(seq 1 12); do
    if ! gone_probe "$@"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdReplacedDeleteFailedRollback"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/replaced-delete-failed-rollback"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096). Sourced before the `cd`
# below, so the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The names the stack derives (lib/replaced-delete-failed-rollback-stack.ts).
POLICY_ARN_PREFIX="arn:aws:iam::${ACCOUNT_ID}:policy/"
TARGET_A="${POLICY_ARN_PREFIX}cdkd-rdfr-target-a"
TARGET_B="${POLICY_ARN_PREFIX}cdkd-rdfr-target-b"
BREAKER="${POLICY_ARN_PREFIX}cdkd-rdfr-breaker"
ALL_POLICIES=("${TARGET_A}" "${TARGET_B}" "${BREAKER}")
# The certificate's domain the stack derives from the stack name.
CERT_DOMAIN="cdkd-rdfr-$(printf '%s' "${STACK}" | tr '[:upper:]' '[:lower:]').example.test"
# Every status, so a certificate in any state is counted.
CERT_STATUSES=(PENDING_VALIDATION ISSUED INACTIVE EXPIRED VALIDATION_TIMED_OUT REVOKED FAILED)

DENY_ROLE="${STACK}-no-delete"
DENY_POLICY_NAME="refuse-old-delete"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the policies or the
# stack may belong to a concurrent or earlier run.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

delete_policy_by_arn() { ( # usage: delete_policy_by_arn <arn>  (best-effort; versions first)
  set +eu
  for v in $(aws iam list-policy-versions --policy-arn "$1" --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
    aws iam delete-policy-version --policy-arn "$1" --version-id "${v}" >/dev/null 2>&1
  done
  aws iam delete-policy --policy-arn "$1" >/dev/null 2>&1
  true
); }
# This run's certificates (the domain is the stack's), one ARN per line.
cert_arns() { # usage: cert_arns  (fails on a failed listing)
  local out
  out="$(aws acm list-certificates --certificate-statuses "${CERT_STATUSES[@]}" \
    --query "CertificateSummaryList[?DomainName=='${CERT_DOMAIN}'].CertificateArn" \
    --output text)" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' || true
}
delete_certs() { ( # usage: delete_certs  (best-effort)
  set +eu
  for a in $(cert_arns 2>/dev/null); do
    aws acm delete-certificate --certificate-arn "${a}" >/dev/null 2>&1
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
    # What no state record may hold (the untracked old policy before #2631,
    # a new one a failed rollback left) first, by ARN; the destroy below then
    # deletes what the records hold and the journal.
    for a in "${ALL_POLICIES[@]}"; do
      delete_policy_by_arn "${a}"
    done
    delete_certs
    (cd "${TEST_DIR}" && env -u TARGET_SUFFIX -u BREAK -u CERT_MODE ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    delete_certs
    [ -z "$(cert_arns 2>/dev/null)" ] \
      || echo "[verify] WARN: ACM certificates for ${CERT_DOMAIN} may remain; delete them by hand" >&2
    for a in "${ALL_POLICIES[@]}"; do
      for _ in $(seq 1 12); do
        if ( gone_probe aws iam get-policy --policy-arn "${a}" ); then break; fi
        sleep 5
      done
      ( gone_probe aws iam get-policy --policy-arn "${a}" ) \
        || echo "[verify] WARN: managed policy ${a} could not be confirmed deleted; delete it by hand" >&2
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

# A record, journal or policy left by an earlier, interrupted run would be
# blamed on the steps below.
for key in "${STATE_KEY}" "${JOURNAL_KEY}"; do
  if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}" 2>&1)"; then
    echo "[verify] FAIL: ${key} already exists (left by an earlier run); destroy the stack, or delete what the journal records and then the journal, first" >&2
    exit 1
  elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "[verify] FAIL: pre-probe of ${key} undetermined: ${HEAD_PRE}" >&2
    exit 1
  fi
done
for a in "${ALL_POLICIES[@]}"; do
  assert_gone "precondition: managed policy ${a} already exists (left by an earlier run); delete it first" \
    aws iam get-policy --policy-arn "${a}"
done
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
PRE_CERTS="$(cert_arns)"
if [ -n "${PRE_CERTS}" ]; then
  echo "[verify] FAIL: precondition -- ACM certificates for ${CERT_DOMAIN} already exist (left by an earlier run); delete them first: ${PRE_CERTS}" >&2
  exit 1
fi
CLEANUP_ARMED=1

# Run a command as the role. A profile in the environment would win over the
# key variables in the SDK's credential chain, so it is dropped. Exported
# inside a subshell, so the keys never sit in a process's argv.
as_deny_role() {
  (
    # CDKD_ROLE_ARN would make the deploy AssumeRole, which this role denies.
    unset AWS_PROFILE AWS_DEFAULT_PROFILE CDKD_ROLE_ARN
    export AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}"
    exec "$@"
  )
}
# Create the role with the inline policy "$1", assume it, and confirm STS
# answers as it. Sets DENY_AK / DENY_SK / DENY_ST.
make_deny_role() { # usage: make_deny_role <policy-json>
  aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
    --tags Key=cdkd-integ,Value=replaced-delete-failed-rollback >/dev/null
  DENY_ROLE_CREATED=1
  aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
    --policy-document "$1"
  # A new role is assumable only once IAM has propagated it.
  DENY_CREDS=""
  assume_err=""
  for _ in $(seq 1 24); do
    # stderr (the error text only) goes to the log; stdout (the credentials)
    # stays in the variable.
    if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
      --role-session-name cdkd-replaced-delete-failed-rollback \
      --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>"${LOG_DIR}/assume-err")"; then
      break
    fi
    DENY_CREDS=""
    assume_err="$(tail -3 "${LOG_DIR}/assume-err" 2>/dev/null || true)"
    sleep 5
  done
  if [ -z "${DENY_CREDS}" ]; then
    echo "[verify] FAIL: precondition -- could not assume ${DENY_ROLE} within 2 minutes (last answer: ${assume_err:-<none>})" >&2
    exit 1
  fi
  # Process substitution, not a here-string: bash 3.2 backs a here-string with a
  # temp file, and these are live credentials.
  read -r DENY_AK DENY_SK DENY_ST < <(printf '%s\n' "${DENY_CREDS}")
  unset DENY_CREDS
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
}

echo "[verify] step 1: baseline deploy (Target = cdkd-rdfr-target-a)"
env -u TARGET_SUFFIX -u BREAK -u CERT_MODE ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
if ! present_eventually aws iam get-policy --policy-arn "${TARGET_A}"; then
  echo "[verify] FAIL: ${TARGET_A} does not read back after step 1" >&2
  exit 1
fi
STATE_1_ID="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.Target.physicalId // "<absent>"')"
if [ "${STATE_1_ID}" != "${TARGET_A}" ]; then
  echo "[verify] FAIL: state's Target is '${STATE_1_ID}' after step 1 (expected ${TARGET_A})" >&2
  exit 1
fi

echo "[verify] step 2: a role that may not delete ${TARGET_A} nor create ${BREAKER}"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy and its rollback call: only read-only
# CloudFormation verbs, iam:ListPolicies and sts:GetCallerIdentity (which take
# no resource) are `*`; SSM is the CDK bootstrap parameters, KMS only through
# S3 (the state bucket's encryption). The S3 verbs on the state bucket are the
# state path's. On this run's policies (`cdkd-rdfr-*`) the role may create,
# tag, read and delete (the rollback deletes `cdkd-rdfr-target-b`), but the
# explicit denies refuse the delete of `cdkd-rdfr-target-a` (the replacement's
# old policy) and the create of `cdkd-rdfr-breaker` (the failure after it). No
# statement allows a credential, a PassRole or a role or user write.
DENY_POLICY="$(node -e 'const [bucket,stack,acct]=process.argv.slice(1);const p=`arn:aws:iam::${acct}:policy/`;process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["iam:CreatePolicy","iam:TagPolicy","iam:GetPolicy","iam:GetPolicyVersion","iam:ListPolicyVersions","iam:ListPolicyTags","iam:ListEntitiesForPolicy","iam:DeletePolicy","iam:DeletePolicyVersion"],Resource:`${p}cdkd-rdfr-*`},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","iam:ListPolicies","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["iam:DeletePolicy","iam:DeletePolicyVersion"],Resource:`${p}cdkd-rdfr-target-a`},{Effect:"Deny",Action:"iam:CreatePolicy",Resource:`${p}cdkd-rdfr-breaker`},{Effect:"Deny",Action:["iam:PassRole","sts:AssumeRole"],Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}")"
make_deny_role "${DENY_POLICY}"
# The EXPLICIT deny must already bind, or the old policy's delete would go
# through and the rollback would have nothing to re-adopt. Probed on the old
# policy itself: refused implicitly before the policy binds, explicitly after,
# and never deleted.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws iam delete-policy --policy-arn "${TARGET_A}" 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} DELETED ${TARGET_A} (its policy must refuse that DeletePolicy)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DeletePolicy never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi
# The Allow statements must bind too, or the deploy below fails for the wrong
# reason.
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if ALLOW_PROBE="$(as_deny_role aws iam get-policy --policy-arn "${TARGET_A}" \
    --query 'Policy.Arn' --output text 2>&1)" && [ "${ALLOW_PROBE}" = "${TARGET_A}" ]; then
    break
  fi
  ALLOW_PROBE=""
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not GetPolicy ${TARGET_A} within 2 minutes" >&2
  exit 1
fi

echo "[verify] step 2: replacing deploy as ${DENY_ROLE}: the old policy's delete is refused, then Breaker fails the deploy"
set +e
as_deny_role env -u CERT_MODE TARGET_SUFFIX=b BREAK=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/deploy.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/deploy.log" || true
# The role is not needed again, nor are its live credentials. Still flagged
# until confirmed gone, so a failure here leaves cleanup to retry the delete.
unset DENY_AK DENY_SK DENY_ST
delete_deny_role
for _ in $(seq 1 12); do
  if gone_probe aws iam get-role --role-name "${DENY_ROLE}"; then break; fi
  sleep 5
done
assert_gone "role ${DENY_ROLE} still exists a minute after its delete" aws iam get-role --role-name "${DENY_ROLE}"
DENY_ROLE_CREATED=""
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the deploy as ${DENY_ROLE} unexpectedly SUCCEEDED (Breaker's create must be refused)" >&2
  exit 1
fi
DEPLOY_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/deploy.log" | tr '\n' ' ' | tr -s ' ')"
# The premise: the replacement ran, and its delete of the old policy was
# refused and left for the post-deploy retry the failure then pre-empted.
if ! printf '%s' "${DEPLOY_FLAT}" | grep -qF "Could not delete old Target (${TARGET_A}) yet"; then
  echo "[verify] FAIL: precondition -- the deploy did not report the refused delete of the old Target (${TARGET_A}); the replacement or the deny did not happen as designed (output above)" >&2
  exit 1
fi
if ! printf '%s' "${DEPLOY_FLAT}" | grep -qF "Failed to create IAM managed policy Breaker" \
  || ! printf '%s' "${DEPLOY_FLAT}" | grep -qiF "explicit deny"; then
  echo "[verify] FAIL: precondition -- the deploy did not fail on the role's explicit deny of Breaker's create (output above)" >&2
  exit 1
fi
# go-to-k/cdkd#2631: the rollback read AWS, found the old policy alive and
# re-adopted it. Before the fix it re-created it, which collided on its name.
if ! printf '%s' "${DEPLOY_FLAT}" | grep -qF "the old resource of Target (${TARGET_A}) still exists"; then
  echo "[verify] FAIL: the rollback did not report re-adopting the surviving old Target (${TARGET_A}) -- go-to-k/cdkd#2631: a rollback re-creates an old resource whose delete failed (output above)" >&2
  exit 1
fi
if printf '%s' "${DEPLOY_FLAT}" | grep -qF "Rollback failed for Target"; then
  echo "[verify] FAIL: the rollback of Target failed (output above)" >&2
  exit 1
fi
if ! present_eventually aws iam get-policy --policy-arn "${TARGET_A}"; then
  echo "[verify] FAIL: ${TARGET_A} is gone after step 2 (it must survive the refused delete and be re-adopted)" >&2
  exit 1
fi
assert_gone_eventually "the replacement's new policy ${TARGET_B} survived the rollback (its reversal must delete it)" \
  aws iam get-policy --policy-arn "${TARGET_B}"
assert_gone "${BREAKER} exists after step 2 (its create must be refused)" \
  aws iam get-policy --policy-arn "${BREAKER}"
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
STATE_2_ID="$(printf '%s' "${STATE_2}" | jq -r '.resources.Target.physicalId // "<absent>"')"
STATE_2_NAME="$(printf '%s' "${STATE_2}" | jq -r '.resources.Target.properties.ManagedPolicyName // "<absent>"')"
if [ "${STATE_2_ID}" != "${TARGET_A}" ] || [ "${STATE_2_NAME}" != "cdkd-rdfr-target-a" ]; then
  echo "[verify] FAIL: state's Target is '${STATE_2_ID}' named '${STATE_2_NAME}' after the rollback (expected ${TARGET_A}, cdkd-rdfr-target-a)" >&2
  exit 1
fi
if [ "$(printf '%s' "${STATE_2}" | jq '.resources | has("Breaker")')" != "false" ]; then
  echo "[verify] FAIL: state records Breaker after the rollback" >&2
  exit 1
fi
echo "[verify] step 2 ok: the rollback re-adopted ${TARGET_A} instead of re-creating it, and deleted ${TARGET_B} (deploy rc=${DEPLOY_RC})"

echo "[verify] step 3: destroy"
env -u TARGET_SUFFIX -u BREAK -u CERT_MODE ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for a in "${ALL_POLICIES[@]}"; do
  assert_gone_eventually "managed policy ${a} still exists after destroy" \
    aws iam get-policy --policy-arn "${a}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

echo "[verify] step 4: baseline deploy with Cert (a DNS-validated ACM certificate)"
env -u TARGET_SUFFIX -u BREAK CERT_MODE=dns CDKD_NO_WAIT=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
CERT_OLD="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.Cert.physicalId // "<absent>"')"
case "${CERT_OLD}" in
  arn:aws:acm:*) ;;
  *)
    echo "[verify] FAIL: state's Cert is '${CERT_OLD}' after step 4 (expected an ACM certificate ARN)" >&2
    exit 1
    ;;
esac
# ACM's list is eventually consistent after the request.
STEP4_CERTS=""
for _ in $(seq 1 12); do
  STEP4_CERTS="$(cert_arns)"
  [ "${STEP4_CERTS}" = "${CERT_OLD}" ] && break
  sleep 5
done
if [ "${STEP4_CERTS}" != "${CERT_OLD}" ]; then
  echo "[verify] FAIL: the certificates for ${CERT_DOMAIN} after step 4 are '${STEP4_CERTS}' (expected only ${CERT_OLD})" >&2
  exit 1
fi

echo "[verify] step 5: a role that may not delete ${CERT_OLD} nor create ${BREAKER}"
# As step 2's role, with ACM in place of the managed policies' replacement:
# ACM's request and read verbs take no resource, so they are `*`; tagging and
# deleting are limited to certificates tagged `cdkd-integ=rdfr` (the stack's
# tag). The explicit denies refuse the delete of the old certificate and
# Breaker's create.
DENY_POLICY="$(node -e 'const [bucket,stack,acct,cert]=process.argv.slice(1);const p=`arn:aws:iam::${acct}:policy/`;process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["iam:CreatePolicy","iam:TagPolicy","iam:GetPolicy","iam:GetPolicyVersion","iam:ListPolicyVersions","iam:ListPolicyTags","iam:ListEntitiesForPolicy","iam:DeletePolicy","iam:DeletePolicyVersion"],Resource:`${p}cdkd-rdfr-*`},{Effect:"Allow",Action:["acm:RequestCertificate","acm:DescribeCertificate","acm:GetCertificate","acm:ListCertificates","acm:ListTagsForCertificate"],Resource:"*"},{Effect:"Allow",Action:"acm:AddTagsToCertificate",Resource:"*",Condition:{StringEquals:{"aws:RequestTag/cdkd-integ":"rdfr"}}},{Effect:"Allow",Action:"acm:DeleteCertificate",Resource:"*",Condition:{StringEquals:{"aws:ResourceTag/cdkd-integ":"rdfr"}}},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","iam:ListPolicies","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:"acm:DeleteCertificate",Resource:cert},{Effect:"Deny",Action:"iam:CreatePolicy",Resource:`${p}cdkd-rdfr-breaker`},{Effect:"Deny",Action:["iam:PassRole","sts:AssumeRole"],Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}" "${CERT_OLD}")"
make_deny_role "${DENY_POLICY}"
# The explicit deny must bind first, or the old certificate's delete goes
# through and nothing survives for the rollback to read.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws acm delete-certificate --certificate-arn "${CERT_OLD}" 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} DELETED ${CERT_OLD} (its policy must refuse that DeleteCertificate)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DeleteCertificate never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if ALLOW_PROBE="$(as_deny_role aws acm describe-certificate --certificate-arn "${CERT_OLD}" \
    --query 'Certificate.CertificateArn' --output text 2>&1)" && [ "${ALLOW_PROBE}" = "${CERT_OLD}" ]; then
    break
  fi
  ALLOW_PROBE=""
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not DescribeCertificate ${CERT_OLD} within 2 minutes" >&2
  exit 1
fi

echo "[verify] step 5: ValidationMethod change as ${DENY_ROLE}: the provider's replacement cannot delete the old certificate, then Breaker fails the deploy"
set +e
as_deny_role env -u TARGET_SUFFIX CERT_MODE=email BREAK=true CDKD_NO_WAIT=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/deploy-cert.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/deploy-cert.log" || true
unset DENY_AK DENY_SK DENY_ST
delete_deny_role
for _ in $(seq 1 12); do
  if gone_probe aws iam get-role --role-name "${DENY_ROLE}"; then break; fi
  sleep 5
done
assert_gone "role ${DENY_ROLE} still exists a minute after its delete" aws iam get-role --role-name "${DENY_ROLE}"
DENY_ROLE_CREATED=""
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the deploy as ${DENY_ROLE} unexpectedly SUCCEEDED (Breaker's create must be refused)" >&2
  exit 1
fi
DEPLOY_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/deploy-cert.log" | tr '\n' ' ' | tr -s ' ')"
# The premise: the PROVIDER replaced the certificate inside its update() and
# its delete of the old one was refused (the engine's own replacement would
# print step 2's "Could not delete old ... yet" instead).
if ! printf '%s' "${DEPLOY_FLAT}" | grep -qF "Failed to delete old ACM certificate" \
  || printf '%s' "${DEPLOY_FLAT}" | grep -qF "Could not delete old Cert"; then
  echo "[verify] FAIL: precondition -- the deploy did not report the ACM provider's refused delete of the old certificate inside its own replacement (output above)" >&2
  exit 1
fi
if ! printf '%s' "${DEPLOY_FLAT}" | grep -qF "Failed to create IAM managed policy Breaker"; then
  echo "[verify] FAIL: precondition -- the deploy did not fail on Breaker's create (output above)" >&2
  exit 1
fi
# go-to-k/cdkd#4911: the journaled op carried the survivor mark, `kept` on the
# provider's word that AWS refused the delete by name (an explicit deny), so
# the rollback read AWS, found the old certificate alive, re-adopted it and
# deleted the replacement. Before the fix it requested a new copy of the old
# certificate (a duplicate), leaving the old one untracked.
if ! printf '%s' "${DEPLOY_FLAT}" | grep -qF "the old resource of Cert (${CERT_OLD}) still exists"; then
  echo "[verify] FAIL: the rollback did not report re-adopting the surviving old certificate (${CERT_OLD}) -- go-to-k/cdkd#4911: a provider's in-update replacement journals no survivor mark (output above)" >&2
  exit 1
fi
if printf '%s' "${DEPLOY_FLAT}" | grep -qF "Rollback failed for Cert"; then
  echo "[verify] FAIL: the rollback of Cert failed (output above)" >&2
  exit 1
fi
# ACM's list is eventually consistent after the replacement's delete.
STEP5_CERTS=""
for _ in $(seq 1 12); do
  STEP5_CERTS="$(cert_arns)"
  [ "${STEP5_CERTS}" = "${CERT_OLD}" ] && break
  sleep 5
done
if [ "${STEP5_CERTS}" != "${CERT_OLD}" ]; then
  echo "[verify] FAIL: the certificates for ${CERT_DOMAIN} after step 5 are '${STEP5_CERTS}' (expected only the re-adopted ${CERT_OLD}: no copy of it, and the replacement deleted)" >&2
  exit 1
fi
STATE_5_ID="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.Cert.physicalId // "<absent>"')"
if [ "${STATE_5_ID}" != "${CERT_OLD}" ]; then
  echo "[verify] FAIL: state's Cert is '${STATE_5_ID}' after the rollback (expected the re-adopted ${CERT_OLD})" >&2
  exit 1
fi
echo "[verify] step 5 ok: the rollback re-adopted ${CERT_OLD} instead of requesting a copy, and deleted the replacement (deploy rc=${DEPLOY_RC})"

echo "[verify] step 6: destroy"
env -u TARGET_SUFFIX -u BREAK CERT_MODE=email ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for a in "${ALL_POLICIES[@]}"; do
  assert_gone_eventually "managed policy ${a} still exists after destroy" \
    aws iam get-policy --policy-arn "${a}"
done
assert_gone_eventually "certificate ${CERT_OLD} still exists after destroy" \
  aws acm describe-certificate --certificate-arn "${CERT_OLD}"
LEFT_CERTS="$(cert_arns)"
if [ -n "${LEFT_CERTS}" ]; then
  echo "[verify] FAIL: certificates for ${CERT_DOMAIN} remain after destroy: ${LEFT_CERTS}" >&2
  exit 1
fi
assert_gone "state file ${STATE_KEY} still exists after step 6's destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after step 6's destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "replaced-delete-failed-rollback state teardown"

echo "[verify] PASS -- the rollback re-adopted a replaced resource whose delete was refused instead of re-creating it (go-to-k/cdkd#2631), and read a provider-replaced survivor before re-creating it (go-to-k/cdkd#4911)"

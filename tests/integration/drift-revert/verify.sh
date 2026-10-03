#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd drift` + `cdkd drift --revert`.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDriftRevertExample (refused on a peer's lock -> fail
#      WITHOUT the cleanup destroy: the stack is the peer's)
#   3. inject drift via direct AWS SDK calls
#   4. cdkd drift  -> assert exit 1 (drift detected)
#   5. cdkd drift --revert -y  -> assert exit 0
#   6. cdkd drift  -> assert exit 0 (clean)
#  6b. rewrite the recorded bucket-policy principal to a BOGUS unique id
#      -> assert exit 1 (a real principal change is still drift)
#  6c. rewrite it to the role's REAL unique id
#      -> assert exit 0 (issue #1515 canonicalization)
#  6d. issue #1626: untemplated values survive a template-only baseline
#  6e. issue #4023: --revert on a legacy-prefixed NAMED role / managed policy
#      with a template-only baseline updates them in place, never under the
#      bare template name
#  6f. issue #4081: plain `cdkd drift --json` reports no name drift on those
#      two records (still template-only, bare names)
#  6g. issue #4283: delete the Glue database out of band -> drift exits 1 and
#      lists it under `deleted`; --revert / --accept refuse it (exit 2)
#   7. cdkd destroy --force
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDriftRevertExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/drift-revert"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

# Lambda creates `/aws/lambda/<stack>-CustomS3AutoDeleteObjects...` when the S3
# auto-delete custom resource first runs (during DEPLOY), and nothing in the
# stack owns it, so destroy leaves it behind (#3885).
. ../cr-log-groups.sh

# Set to 1 only when step 2's deploy failed acquiring the lock (a peer's, or an
# S3 error on it): this run then created no stack resources, the stack under
# ${STACK} may be a PEER's, and a destroy from `cleanup` would delete it once
# the peer releases its lock.
PEER_HOLDS_STACK=0

# Issue #4023: the template names of step 6e's role and managed policy. A
# revert that re-derives the name (the pre-fix behaviour) creates copies under
# these BARE names that no state record owns, so `destroy` cannot reach them.
BARE_ROLE="cdkd-drift-revert-named-role"
BARE_POLICY="cdkd-drift-revert-named-policy"
# Set by step 6e once it knows the partition-qualified ARN; empty before that,
# when no revert has run and nothing under the bare names can exist.
BARE_POLICY_ARN=""

# Best-effort removal of those copies. Neither is attached to anything (the
# template attaches no policy to the role and the policy to no principal), so
# one call each deletes them.
sweep_bare_iam_names() { (
  set +eu
  [ -n "${BARE_POLICY_ARN}" ] || exit 0
  # Only a copy carrying the fixture's own description: a same-named role
  # someone else made is left alone.
  if [ "$(aws iam get-role --role-name "${BARE_ROLE}" --query Role.Description --output text 2>/dev/null)" = "drift-revert named role" ]; then
    aws iam delete-role --role-name "${BARE_ROLE}" >/dev/null 2>&1
  fi
  aws iam delete-policy --policy-arn "${BARE_POLICY_ARN}" >/dev/null 2>&1
  exit 0
) }

cleanup() {
  rc=$?
  rm -f "${BOGUS_DRIFT_LOG:-}" "${DEPLOY_LOG:-}" "${STEP6E_ERR:-}" "${STEP6F_JSON:-}" "${STEP6G_OUT:-}"
  if [ "${PEER_HOLDS_STACK}" = 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — destroy and log-group sweep SKIPPED: this run deployed nothing to ${STACK}"
    exit "${rc}"
  fi
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    sweep_bare_iam_names
  fi
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
# The lock is the FIRST thing deploy takes (deploy-engine.ts), so a refusal on
# it means this run created no stack resources (assets and event logs are not
# destroy's to remove); any other deploy failure may have created resources,
# and `cleanup` still destroys them. The head is the parsed marker; the
# recovery clause, built separately and printed on the same line, is the
# sentinel: seen without the head, the wording drifted, and the destroy is
# skipped too rather than risk a peer's stack.
DEPLOY_LOG="$(mktemp)"
set +e
# `tee -i`: a Ctrl-C must not kill tee first, or deploy's interrupt notice hits
# a closed pipe and it exits without saving state.
# `CDKD_PREFIX_USER_SUPPLIED_NAMES=true` (issue #4023) is the legacy naming step
# 6e needs, `<stack>-<name>` on AWS beside `<name>` in the template. It changes
# no other resource here — only a NAMED IAM / ELBv2 resource takes the prefix.
CDKD_PREFIX_USER_SUPPLIED_NAMES=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee -i "${DEPLOY_LOG}"
deploy_rc=${PIPESTATUS[0]}
set -e
if [ "${deploy_rc}" -ne 0 ]; then
  if grep -qF "Failed to acquire lock for stack ${STACK} " "${DEPLOY_LOG}"; then
    PEER_HOLDS_STACK=1
    echo "[verify] FAIL step 2: deploy failed acquiring the lock on ${STACK} (a peer's lock, or an S3 error on it); nothing was deployed, so the destroy is skipped" >&2
  elif grep -qF "If you are certain no other process is active" "${DEPLOY_LOG}"; then
    PEER_HOLDS_STACK=1
    echo "[verify] FAIL step 2: the lock-recovery clause printed without the 'Failed to acquire lock for stack' head this fixture keys on; update verify.sh for the new wording" >&2
  fi
  exit "${deploy_rc}"
fi

echo "[verify] step 3: inject drift"
node inject-drift.ts

echo "[verify] step 4: cdkd drift (expect exit 1)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL: expected drift exit 1, got ${rc}"
  exit 1
fi
echo "[verify] step 4 ok: exit ${rc}"

echo "[verify] step 5: cdkd drift --revert -y (expect exit 0)"
${CLI} drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}"

echo "[verify] step 6: cdkd drift again (expect exit 0)"
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"

# Issue #1515: AWS renders an IAM role principal inside a resource policy as
# either its ARN or its `AROA…` unique id, so the deploy-time capture and a
# later read can hold two spellings of ONE principal — permanent phantom drift
# `--revert` cannot clear. Which form gets captured is a RACE (this fixture's
# autoDeleteObjects role is created concurrently with the policy referencing
# it), so the state baseline is rewritten HERE to make it deterministic.
# Both directions are asserted: a BOGUS unique id must still read as drift,
# which is what proves the clean verdict below is canonicalization and not the
# field silently dropping out of the comparison.
echo "[verify] step 6b: bogus principal unique id in the baseline (expect exit 1)"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node inject-principal-uniqueid.ts bogus
# Removed by `cleanup` rather than inline or by a second EXIT trap: both
# assertion paths below `exit 1` before any inline `rm`, and a second
# `trap ... EXIT` would REPLACE the cleanup trap and silently disable the
# destroy-on-failure this fixture depends on.
BOGUS_DRIFT_LOG="$(mktemp)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}" >"${BOGUS_DRIFT_LOG}" 2>&1
rc=$?
set -e
cat "${BOGUS_DRIFT_LOG}"
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL: a principal that is nobody's unique id must still be drift, got exit ${rc}"
  exit 1
fi
# Exit 1 alone is satisfied by ANY drifted resource, which would make this
# step's non-vacuity argument false — name the resource under test.
if ! grep -q "DriftBucketPolicy" "${BOGUS_DRIFT_LOG}"; then
  echo "[verify] FAIL: expected the BUCKET POLICY to be the drifted resource, got:" >&2
  cat "${BOGUS_DRIFT_LOG}" >&2
  exit 1
fi
echo "[verify] step 6b ok: exit ${rc}, bucket policy named"

echo "[verify] step 6c: the role's REAL unique id in the baseline (expect exit 0)"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node inject-principal-uniqueid.ts real
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
echo "[verify] step 6c ok: issue #1515 canonicalization holds"

# Issue #1626: on a resource with NO `observedProperties` the revert baseline is
# the raw TEMPLATE, where an AWS-authored value and an out-of-band change are
# indistinguishable — so `--revert` MERGES every untemplated path into the bag it
# sends instead of overlaying the drifted subtree wholesale. No fixture can reach
# that baseline by deploying (every deploy records observedProperties), so it is
# manufactured here, exactly as step 6b/6c manufacture the #1515 principal form.
#
# `Tags` on AWS::S3::Bucket is the sharpest probe available: PutBucketTagging is
# documented FULL-REPLACE, so the preserved tag can only survive if it reached the
# provider on the DESIRED side. A fix that merely trimmed `previousProperties`
# leaves this assertion FAILING — which is why it is asserted against AWS here and
# not only in unit tests.
#
# The tag edit is applied DIRECTLY rather than by re-running inject-drift.ts: that
# injector also re-arms the log group's deletion protection, and a failure here
# would then leave `cleanup`'s destroy unable to remove it (orphaned stack) for a
# resource this step does not even assert on.
echo "[verify] step 6d: issue #1626 — untemplated AWS values survive a template-only baseline"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node strip-observed.ts
BUCKET_NAME="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const s=JSON.parse(b);const r=(s.state??s).resources;const id=Object.keys(r).find(k=>r[k].resourceType==="AWS::S3::Bucket"&&k.startsWith("DriftBucket"));if(!id)throw new Error("no DriftBucket in state");process.stdout.write(r[id].physicalId);})')"
echo "[verify] step 6d: bucket=${BUCKET_NAME}"

# Read-modify-write so every other tag (incl. `aws-cdk:auto-delete-objects`,
# which destroy relies on) is preserved. Two edits, because the assertion needs
# BOTH directions: an UNTEMPLATED addition that must survive, and a TEMPLATED
# value that must be reverted. Without the second, a `--revert` that skipped the
# bucket entirely would satisfy the first.
NEW_TAGGING="$(aws s3api get-bucket-tagging --bucket "${BUCKET_NAME}" --region "${REGION}" --output json \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const t=JSON.parse(b).TagSet.filter(e=>e.Key!=="IntegInjected");const o=t.find(e=>e.Key==="Owner");if(!o)throw new Error("template tag Owner missing — the revert-direction assertion would be vacuous");o.Value="DRIFTED-BY-INTEG";t.push({Key:"IntegInjected",Value:"yes"});process.stdout.write(JSON.stringify({TagSet:t}));})')"
aws s3api put-bucket-tagging --bucket "${BUCKET_NAME}" --region "${REGION}" --tagging "${NEW_TAGGING}"

${CLI} drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}"

# Bucket subresources are eventually consistent, so retry briefly. stderr is
# CAPTURED rather than discarded: an empty tag set legitimately raises
# NoSuchTagSet (which `set -e` would otherwise abort on with an opaque error
# instead of the FAIL message below), but any OTHER failure -- AccessDenied, a
# wrong bucket name -- must fail loudly rather than masquerade as "no tags" and
# turn this assertion into a false negative (the #1120 pattern).
TAGS_AFTER=""
for _ in 1 2 3 4 5; do
  if TAGS_RAW="$(aws s3api get-bucket-tagging --bucket "${BUCKET_NAME}" \
      --region "${REGION}" --output json 2>&1)"; then
    TAGS_AFTER="${TAGS_RAW}"
  elif printf '%s' "${TAGS_RAW}" | grep -q 'NoSuchTagSet'; then
    TAGS_AFTER='{"TagSet":[]}'
  else
    echo "[verify] FAIL step 6d: get-bucket-tagging failed for ${BUCKET_NAME}:"
    printf '%s\n' "${TAGS_RAW}"
    exit 1
  fi
  printf '%s' "${TAGS_AFTER}" | grep -q 'IntegInjected' && break
  sleep 3
done
echo "[verify] step 6d: tags after revert = ${TAGS_AFTER}"
OWNER_AFTER="$(printf '%s' "${TAGS_AFTER}" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const e=(JSON.parse(b).TagSet||[]).find(x=>x.Key==="Owner");process.stdout.write(e?e.Value:"(absent)");})')"

if ! printf '%s' "${TAGS_AFTER}" | grep -q 'IntegInjected'; then
  echo "[verify] FAIL step 6d: the untemplated 'IntegInjected' tag was RESET by --revert"
  echo "[verify]   on a template-only baseline it must be preserved (issue #1626)."
  exit 1
fi
# Non-vacuity: the revert must have done real work on THIS bucket. The value was
# mutated above, so this only passes if --revert actually pushed the template
# value back — a skipped resource leaves 'DRIFTED-BY-INTEG'.
if [ "${OWNER_AFTER}" != "cdkd-integ" ]; then
  echo "[verify] FAIL step 6d: templated tag Owner='${OWNER_AFTER}', expected 'cdkd-integ'"
  echo "[verify]   the revert did not touch this bucket, so the preservation"
  echo "[verify]   assertion above would be vacuous."
  exit 1
fi
echo "[verify] step 6d ok: untemplated tag preserved, templated tag reverted"

# Issue #4023: `--revert` handed the provider a desired bag holding the
# TEMPLATE name while AWS holds the legacy-prefixed one, and the IAM Role /
# ManagedPolicy providers re-derive the name outside the deploy's stack-name /
# prefix scope and REPLACE on a mismatch — a new role / policy under the bare
# name, the live one deleted. The baseline must be template-only for the bag to
# carry the bare name (an observed baseline carries the live one), so it is
# manufactured as in step 6d. Asserted on AWS: the SAME role (RoleId) and the
# SAME policy ARN carry the reverted values, and nothing exists under the bare
# names.
echo "[verify] step 6e: issue #4023 — --revert keeps a legacy-prefixed IAM name"
NAMED_IDS="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const r=(JSON.parse(b).state??JSON.parse(b)).resources;const one=(p,t)=>{const ids=Object.keys(r).filter(k=>k.startsWith(p)&&r[k].resourceType===t);if(ids.length!==1)throw new Error(`expected one ${t} ${p}, found ${ids.length}`);return r[ids[0]].physicalId;};process.stdout.write(one("DriftNamedRole","AWS::IAM::Role")+" "+one("DriftNamedPolicy","AWS::IAM::ManagedPolicy"));})')"
NAMED_ROLE="${NAMED_IDS%% *}"
NAMED_POLICY_ARN="${NAMED_IDS#* }"
# Non-vacuity: the deploy must have PREFIXED both names, or the template name
# equals the live one and there is nothing for a revert to re-derive.
if [ "${NAMED_ROLE}" != "${STACK}-${BARE_ROLE}" ]; then
  echo "[verify] FAIL step 6e: role is '${NAMED_ROLE}', expected '${STACK}-${BARE_ROLE}' (was CDKD_PREFIX_USER_SUPPLIED_NAMES honoured?)" >&2
  exit 1
fi
case "${NAMED_POLICY_ARN}" in
  arn:*:iam::"${ACCOUNT_ID}":policy/"${STACK}-${BARE_POLICY}") ;;
  *)
    echo "[verify] FAIL step 6e: policy is '${NAMED_POLICY_ARN}', expected the '${STACK}-${BARE_POLICY}' ARN" >&2
    exit 1
    ;;
esac
BARE_POLICY_ARN="${NAMED_POLICY_ARN%/*}/${BARE_POLICY}"
ROLE_ID_BEFORE="$(aws iam get-role --role-name "${NAMED_ROLE}" --query Role.RoleId --output text)"
[ -n "${ROLE_ID_BEFORE}" ] || { echo "[verify] FAIL step 6e: empty RoleId for ${NAMED_ROLE}" >&2; exit 1; }

STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node strip-observed.ts DriftNamedRole AWS::IAM::Role RoleName
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node strip-observed.ts DriftNamedPolicy AWS::IAM::ManagedPolicy ManagedPolicyName

# The out-of-band changes the revert must undo: without them a revert that
# skipped both resources would pass every assertion below.
aws iam update-role --role-name "${NAMED_ROLE}" --description "DRIFTED-BY-INTEG"
DRIFTED_POLICY_DOC='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::cdkd-drift-revert-placeholder/*"}]}'
DRIFTED_VERSION="$(aws iam create-policy-version --query PolicyVersion.VersionId --output text --cli-input-json "$(node -e \
  'process.stdout.write(JSON.stringify({PolicyArn:process.argv[1],PolicyDocument:process.argv[2],SetAsDefault:true}))' \
  "${NAMED_POLICY_ARN}" "${DRIFTED_POLICY_DOC}")")"
[ -n "${DRIFTED_VERSION}" ] || { echo "[verify] FAIL step 6e: create-policy-version returned no VersionId" >&2; exit 1; }

# IAM reads lag writes briefly: wait until both changes are visible, or the
# drift read can miss them and the revert has nothing to undo.
wait_iam() { # usage: wait_iam "<what>" "<expected>" aws ... (reads one text value)
  local what="$1" want="$2" got="" _
  shift 2
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    got="$("$@")" || { echo "[verify] FAIL step 6e: ${what} probe failed ($*)" >&2; exit 1; }
    [ "${got}" = "${want}" ] && return 0
    sleep 2
  done
  echo "[verify] FAIL step 6e: ${what} is '${got}' after 20s, expected '${want}'" >&2
  exit 1
}
wait_iam "injected role description" "DRIFTED-BY-INTEG" \
  aws iam get-role --role-name "${NAMED_ROLE}" --query Role.Description --output text
wait_iam "injected policy default version" "${DRIFTED_VERSION}" \
  aws iam get-policy --policy-arn "${NAMED_POLICY_ARN}" --query Policy.DefaultVersionId --output text

${CLI} drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}"

STEP6E_ERR="$(mktemp)"
ROLE_ID_AFTER="$(aws iam get-role --role-name "${NAMED_ROLE}" --query Role.RoleId --output text 2>"${STEP6E_ERR}")" || {
  echo "[verify] FAIL step 6e: the prefixed role ${NAMED_ROLE} is gone after --revert: $(cat "${STEP6E_ERR}")" >&2
  exit 1
}
if [ "${ROLE_ID_AFTER}" != "${ROLE_ID_BEFORE}" ]; then
  echo "[verify] FAIL step 6e: ${NAMED_ROLE} was REPLACED by --revert (RoleId ${ROLE_ID_BEFORE} -> ${ROLE_ID_AFTER})" >&2
  exit 1
fi
wait_iam "reverted role description" "drift-revert named role" \
  aws iam get-role --role-name "${NAMED_ROLE}" --query Role.Description --output text
POLICY_VERSION="$(aws iam get-policy --policy-arn "${NAMED_POLICY_ARN}" --query Policy.DefaultVersionId --output text 2>"${STEP6E_ERR}")" || {
  echo "[verify] FAIL step 6e: the prefixed policy ${NAMED_POLICY_ARN} is gone after --revert: $(cat "${STEP6E_ERR}")" >&2
  exit 1
}
[ -n "${POLICY_VERSION}" ] || { echo "[verify] FAIL step 6e: empty DefaultVersionId for ${NAMED_POLICY_ARN}" >&2; exit 1; }
# The revert sets a NEW default version; a lagging read still names the drifted one.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "${POLICY_VERSION}" != "${DRIFTED_VERSION}" ] && break
  sleep 2
  POLICY_VERSION="$(aws iam get-policy --policy-arn "${NAMED_POLICY_ARN}" --query Policy.DefaultVersionId --output text)"
done
POLICY_ACTION="$(aws iam get-policy-version --policy-arn "${NAMED_POLICY_ARN}" --version-id "${POLICY_VERSION}" \
  --query 'PolicyVersion.Document.Statement[0].Action' --output text)"
if [ "${POLICY_ACTION}" != "s3:GetObject" ]; then
  echo "[verify] FAIL step 6e: policy default version grants '${POLICY_ACTION}', expected the template's s3:GetObject" >&2
  exit 1
fi
assert_gone "--revert created a role under the bare template name ${BARE_ROLE}" \
  aws iam get-role --role-name "${BARE_ROLE}"
assert_gone "--revert created a policy under the bare template name ${BARE_POLICY_ARN}" \
  aws iam get-policy --policy-arn "${BARE_POLICY_ARN}"
rm -f "${STEP6E_ERR}"
echo "[verify] step 6e ok: role ${ROLE_ID_BEFORE} and policy reverted in place, no bare-name copies"

# Issue #4081: detection on the same records. They still hold the BARE template
# names with no observed baseline while AWS holds the prefixed ones, which
# `cdkd drift` reported as a name drift on every run (the revert above leaves
# the name alone and records nothing). Both preconditions are asserted first,
# or a clean result would prove nothing. The two resources must be COMPARED
# (drifted or clean, not skipped) and neither may carry a name change; other
# resources' verdicts are not this step's subject, so the exit code is only
# required to be a verdict (0 / 1 / 2).
echo "[verify] step 6f: issue #4081 — no name drift on a legacy-prefixed name"
${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const r=(JSON.parse(b).state??JSON.parse(b)).resources;for(const [p,t,k,n] of [["DriftNamedRole","AWS::IAM::Role","RoleName",process.argv[1]],["DriftNamedPolicy","AWS::IAM::ManagedPolicy","ManagedPolicyName",process.argv[2]]]){const ids=Object.keys(r).filter(id=>id.startsWith(p)&&r[id].resourceType===t);if(ids.length!==1)throw new Error(`expected one ${t} ${p}, found ${ids.length}`);const rec=r[ids[0]];if(rec.observedProperties!==undefined)throw new Error(`${ids[0]} has observedProperties again: the name check below would be vacuous`);if(rec.properties?.[k]!==n)throw new Error(`${ids[0]} records ${k}=${JSON.stringify(rec.properties?.[k])}, expected the bare template name ${n}`);}})' \
  "${BARE_ROLE}" "${BARE_POLICY}"
STEP6F_JSON="$(mktemp)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}" --json >"${STEP6F_JSON}"
rc=$?
set -e
case "${rc}" in
  0 | 1 | 2) ;;
  *)
    echo "[verify] FAIL step 6f: cdkd drift --json exited ${rc}" >&2
    exit 1
    ;;
esac
node -e 'const fs=require("fs");const [s]=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const all=[...s.drifted.map(d=>({...d,kind:"drifted"})),...s.clean.map(c=>({...c,changes:[],kind:"clean"}))];for(const [p,t,k] of [["DriftNamedRole","AWS::IAM::Role","RoleName"],["DriftNamedPolicy","AWS::IAM::ManagedPolicy","ManagedPolicyName"]]){const hits=all.filter(o=>o.logicalId.startsWith(p)&&o.type===t);if(hits.length!==1)throw new Error(`expected ${p} (${t}) compared exactly once, found ${hits.length}: ${JSON.stringify(s)}`);const named=hits[0].changes.filter(c=>c.path===k||c.path.startsWith(k+"."));if(named.length>0)throw new Error(`${hits[0].logicalId} reports a ${k} drift: ${JSON.stringify(named)}`);console.log(`[verify] step 6f: ${hits[0].logicalId} ${hits[0].kind}, no ${k} change`);}' \
  "${STEP6F_JSON}"
rm -f "${STEP6F_JSON}"
echo "[verify] step 6f ok: no name drift for the legacy-prefixed role / policy"

# Issue #4283: a resource deleted OUTSIDE cdkd is drift. It used to read back
# as `undefined` and land in `notSupported` ("provider does not support drift
# detection yet") with exit 0, so a CI gate stayed green over a missing
# resource. Delete the Glue database out of band, then: detection reports it
# under `deleted` and exits 1; `--revert` and `--accept` each refuse it by name
# and exit 2, and neither recreates it nor drops its state record. Last before
# the destroy, which tolerates the missing database (the Glue delete is
# not-found idempotent).
echo "[verify] step 6g: issue #4283 — a resource deleted out of band is reported as deleted"
GLUE_DB="cdkd_drift_revert_db"
aws glue delete-database --name "${GLUE_DB}"
assert_gone "out-of-band delete of Glue database ${GLUE_DB} did not take" \
  aws glue get-database --name "${GLUE_DB}"
STEP6G_OUT="$(mktemp)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}" --json >"${STEP6G_OUT}"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL step 6g: cdkd drift over a deleted resource exited ${rc}, expected 1" >&2
  cat "${STEP6G_OUT}" >&2
  exit 1
fi
node -e 'const fs=require("fs");const [s]=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const t="AWS::Glue::Database";const del=(s.deleted??[]).filter(o=>o.type===t&&o.logicalId.startsWith("DriftGlueDatabase"));if(del.length!==1)throw new Error(`expected DriftGlueDatabase under deleted, found ${JSON.stringify(s.deleted)}: ${JSON.stringify(s)}`);if(s.notSupported.some(o=>o.type===t))throw new Error(`the deleted Glue database is still reported notSupported: ${JSON.stringify(s.notSupported)}`);console.log(`[verify] step 6g: ${del[0].logicalId} reported deleted`);' \
  "${STEP6G_OUT}"
glue_db_record() { # prints the deleted Glue database's state record, key-sorted
  ${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const r=(JSON.parse(b).state??JSON.parse(b)).resources;const ids=Object.keys(r).filter(id=>id.startsWith("DriftGlueDatabase")&&r[id].resourceType==="AWS::Glue::Database");if(ids.length!==1)throw new Error(`expected one DriftGlueDatabase record, found ${ids.length}`);const sort=(v)=>Array.isArray(v)?v.map(sort):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;process.stdout.write(JSON.stringify(sort(r[ids[0]])));})'
}
GLUE_RECORD_BEFORE="$(glue_db_record)"
for mode in revert accept; do
  set +e
  ${CLI} drift "${STACK}" "--${mode}" -y --state-bucket "${STATE_BUCKET}" >"${STEP6G_OUT}" 2>&1
  rc=$?
  set -e
  cat "${STEP6G_OUT}"
  if [ "${rc}" -ne 2 ]; then
    echo "[verify] FAIL step 6g: cdkd drift --${mode} over a deleted resource exited ${rc}, expected 2" >&2
    exit 1
  fi
  if ! grep -qE "DriftGlueDatabase[^ ]* \(AWS::Glue::Database\): NOT ${mode}ed" "${STEP6G_OUT}"; then
    echo "[verify] FAIL step 6g: --${mode} did not refuse the deleted Glue database by name" >&2
    exit 1
  fi
  assert_gone "--${mode} recreated the out-of-band-deleted Glue database ${GLUE_DB}" \
    aws glue get-database --name "${GLUE_DB}"
done
if [ "$(glue_db_record)" != "${GLUE_RECORD_BEFORE}" ]; then
  echo "[verify] FAIL step 6g: --revert / --accept changed the deleted Glue database's state record" >&2
  exit 1
fi
# Both runs released their locks (the refusal path takes none for this
# resource, and the writes for the other resources release theirs).
assert_gone "a drift --revert / --accept run left the stack lock behind" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/lock.json"
rm -f "${STEP6G_OUT}"
echo "[verify] step 6g ok: deleted -> exit 1; --revert / --accept refuse it (exit 2) and change nothing"

echo "[verify] step 7: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

trap - EXIT INT TERM
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
echo "[verify] PASS"

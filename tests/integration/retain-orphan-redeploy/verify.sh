#!/usr/bin/env bash
# verify.sh — cdkd retain-orphan-redeploy integ test (issue #2902).
#
# The reported loop: a rollback leaves a `DeletionPolicy: Retain` resource in
# AWS and drops its state record (CloudFormation semantics, deliberate), and
# cdkd's generated names carry no random component — so the next deploy asks
# AWS for a name the orphan still holds, fails, rolls back, and repeats. The
# reporter's only way out was hand-deleting resources through the AWS API.
#
# PASS CONDITION is not "the deploy succeeds" — a redeploy over an orphan MUST
# fail. What this asserts is that cdkd NAMES the cause and that the remedy it
# prints actually WORKS:
#
#   1. deploy               — a role under a cdkd-GENERATED name
#   2. state orphan         — drop the record, leave the role in AWS
#   3. redeploy             — must FAIL, and must print the diagnosis + command
#   4. run THAT command     — parsed out of the message, not hand-written
#   5. redeploy             — must now SUCCEED (the loop is broken)
#   6. destroy + gone probe
#
# Step 4 is the point. A message naming a remedy whose precondition the code
# never checks is issue #2610's defect class, so this runs the command the
# message emitted rather than a command the fixture author believed in.
#
# `cdkd state orphan` is used rather than an injected rollback: it reaches the
# same end state (resource live, record gone) deterministically, where a
# failure injection's timing would decide what got created.
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

# The orphaned queue's existence, retried: SQS answers a just-deleted queue for
# up to 60 s, and a throttle is not an answer. `queue_state <url> exists`
# returns 0 once the queue answers and 1 on NonExistentQueue; `queue_state
# <url> gone` returns 0 once it reports NonExistentQueue. Anything still
# undetermined after ~90 s FAILs the run.
queue_state() { # usage: queue_state <url> <exists|gone>
  local url="$1" want="$2" out="" i
  for i in $(seq 1 15); do
    if out="$(aws sqs get-queue-attributes --queue-url "${url}" --attribute-names QueueArn 2>&1)"; then
      [ "${want}" = exists ] && return 0
    elif printf '%s' "${out}" | grep -qiE 'NonExistentQueue|does not exist'; then
      [ "${want}" = gone ] && return 0
      return 1
    fi
    sleep 6
  done
  echo "FAIL: queue ${url} is still not '${want}' after ~90 s: ${out:-it still answers}" >&2
  exit 1
}

cd "$(dirname "$0")"

export AWS_PAGER=""

STACK="CdkdRetainOrphanRedeployExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved post-deploy; used by assertions + cleanup.
ROLE_NAME=""
ROLE_LOGICAL_ID=""
REDEPLOY_LOG=""
# The adoption arm (issue #2934) — a SECOND stack, so its own names.
ADOPT_STACK="CdkdRetainOrphanAdoptExample"
ADOPT_STATE_KEY="cdkd/${ADOPT_STACK}/${REGION}/state.json"
ADOPT_ROLE_NAME=""
ADOPT_LOGICAL_ID=""
ADOPT_LOG=""
# The single-record orphan arm (go-to-k/cdkd#4602) — a THIRD stack.
ORPHAN_STACK="CdkdRetainOrphanResourceExample"
ORPHAN_STATE_KEY="cdkd/${ORPHAN_STACK}/${REGION}/state.json"
ORPHAN_QUEUE_URL=""
REFUSE_LOG=""
REDEPLOY_ORPHAN_LOG=""
DESTROY_ORPHAN_LOG=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  # Belt-and-suspenders: the whole point of this fixture is a state record that
  # no longer names the live role, so `state destroy` can legitimately miss it.
  if [ -n "${ROLE_NAME}" ]; then
    for p in $(aws iam list-role-policies --role-name "${ROLE_NAME}" \
      --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${p}" >/dev/null 2>&1
    done
    for a in $(aws iam list-attached-role-policies --role-name "${ROLE_NAME}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${ROLE_NAME}" --policy-arn "${a}" >/dev/null 2>&1
    done
    aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
  fi
  # The adoption arm's stack. Its role carries RETAIN, so `state destroy`
  # deliberately leaves it standing — the by-name delete below is the only
  # thing that stops this fixture leaking a role per run.
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${ADOPT_STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  if [ -n "${ADOPT_ROLE_NAME}" ]; then
    for p in $(aws iam list-role-policies --role-name "${ADOPT_ROLE_NAME}" \
      --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${ADOPT_ROLE_NAME}" --policy-name "${p}" >/dev/null 2>&1
    done
    for a in $(aws iam list-attached-role-policies --role-name "${ADOPT_ROLE_NAME}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${ADOPT_ROLE_NAME}" --policy-arn "${a}" >/dev/null 2>&1
    done
    aws iam delete-role --role-name "${ADOPT_ROLE_NAME}" >/dev/null 2>&1
  fi
  # The single-record arm's stack, then its queue: `state orphan --resource`
  # drops the queue's record on purpose, so no destroy can reach it and the
  # by-URL delete below is the only thing that stops a leak.
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${ORPHAN_STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  if [ -n "${ORPHAN_QUEUE_URL}" ]; then
    aws sqs delete-queue --queue-url "${ORPHAN_QUEUE_URL}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${ORPHAN_STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/${ADOPT_STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${ADOPT_STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  rm -f "${REDEPLOY_LOG:-}" "${ADOPT_LOG:-}" "${REFUSE_LOG:-}" "${REDEPLOY_ORPHAN_LOG:-}" "${DESTROY_ORPHAN_LOG:-}"
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET is required" >&2
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

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy (role under a cdkd-GENERATED name)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
# Resolved from state by TYPE, never hardcoded: CDK appends a path-derived hash
# to the construct id (`OrphanedRole` synthesizes as `OrphanedRole<8 hex>`), so
# a literal would break the moment the construct or stack id changes -- and it
# would break as a confusing "not found" rather than as a clear failure. The
# stack declares exactly one role, which is what makes the by-type read exact.
ROLE_LOGICAL_ID=$(echo "${STATE}" | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role") | .key] | first // ""')
ROLE_NAME=$(echo "${STATE}" | jq -r --arg k "${ROLE_LOGICAL_ID}" '.resources[$k].physicalId // ""')
if [ -z "${ROLE_LOGICAL_ID}" ] || [ -z "${ROLE_NAME}" ] || [ "${ROLE_NAME}" = "null" ]; then
  echo "FAIL: could not resolve the role's logical id / physical id from state" >&2
  echo "${STATE}" | jq '{resources: (.resources | keys)}' >&2
  exit 1
fi
echo "    logicalId=${ROLE_LOGICAL_ID} role=${ROLE_NAME}"

# The diagnosis under test only fires for a name cdkd DERIVED, so a fixture
# whose role came out template-named would assert nothing. Pin the premise.
case "${ROLE_NAME}" in
  "${STACK}-${ROLE_LOGICAL_ID}"*) ;;
  *)
    echo "FAIL: '${ROLE_NAME}' is not the cdkd derivation of ${STACK}/${ROLE_LOGICAL_ID} —" >&2
    echo "      the collision diagnosis under test would not fire for it" >&2
    exit 1
    ;;
esac

# --- Phase 2: manufacture the orphan -----------------------------------
echo "==> Phase 2: drop the state record, leave the role in AWS"
node "${LOCAL_DIST}" state orphan "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if ! aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "FAIL: 'cdkd state orphan' deleted the AWS role — it must only drop state" >&2
  exit 1
fi
echo "    OK: role still live, state record gone"

# --- Phase 3: the redeploy must FAIL, and must explain itself ----------
echo "==> Phase 3: redeploy over the orphan (must fail WITH a diagnosis)"
REDEPLOY_LOG="$(mktemp)"
if node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes > "${REDEPLOY_LOG}" 2>&1; then
  echo "FAIL: the redeploy SUCCEEDED over a live orphan — expected an already-exists failure" >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi

# Sentinel: distinguishes "cdkd said nothing" from "this grep stopped parsing".
# The AWS sentence is the independent marker — it is not the string under test,
# and a redeploy that reached AWS at all must carry it.
if ! grep -q "already exists" "${REDEPLOY_LOG}"; then
  echo "FAIL: the redeploy failed WITHOUT an already-exists error — wrong failure" >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi
if ! grep -q "is one cdkd DERIVED from" "${REDEPLOY_LOG}"; then
  echo "FAIL: cdkd printed no orphan diagnosis for a collision on its own generated name." >&2
  echo "      The AWS error IS present, so this is a missing/reworded diagnosis," >&2
  echo "      not an absent condition (issue #2902)." >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: redeploy failed AND named the cause"

# --- Phase 4: run the command the MESSAGE printed ----------------------
echo "==> Phase 4: follow cdkd's own remedy"
# Parsed out of the message rather than hand-written: this is what makes the
# assertion about the ADVICE and not about a command the author believed in.
# The argument is SINGLE-QUOTED in the message (`shellQuote`, so a name
# carrying shell metacharacters pastes inertly), and the quotes are part of what
# the user would paste -- so the pattern accepts them and `eval` below re-parses
# them exactly as a shell would. Matching the unquoted form is what the first
# version did, and it broke the moment the quoting landed: the fixture caught
# its own PR's change, which is the point of parsing the message rather than
# rebuilding the command.
#
# `|| true` is load-bearing, not defensive: `grep -o` exits 1 on no match and
# `pipefail` carries that past `head`, so errexit killed the script here and the
# loud branch below -- the whole point of this phase -- never printed.
IMPORT_ARG=$(grep -o -- "--resource '\?${ROLE_LOGICAL_ID}=[A-Za-z0-9_+=,.@-]*'\?" "${REDEPLOY_LOG}" | head -1 || true)
if [ -z "${IMPORT_ARG}" ]; then
  echo "FAIL: the diagnosis carried no '--resource ${ROLE_LOGICAL_ID}=<name>' argument to run" >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi
echo "    running: cdkd import ${STACK} ${IMPORT_ARG} --yes"
# `eval` because the captured text carries the message's own single quotes, and
# the command under test is what a user PASTES -- so the shell must re-parse
# them the same way. The captured value is constrained by the grep pattern
# above to `--resource` plus the IAM name charset plus the quotes, so nothing
# else can reach the shell here.
# shellcheck disable=SC2086,SC2294
# NOTE: `cdkd import` declares no `--region`; it reads AWS_REGION / the profile.
# Stated because every OTHER invocation here passes one, and the state key
# asserted just below is region-scoped -- so the asymmetry is deliberate, not an
# omission to "fix".
eval node '"${LOCAL_DIST}"' import '"${STACK}"' "${IMPORT_ARG}" \
  --state-bucket '"${STATE_BUCKET}"' --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
REIMPORTED=$(echo "${STATE}" | jq -r --arg k "${ROLE_LOGICAL_ID}" '.resources[$k].physicalId // ""')
if [ "${REIMPORTED}" != "${ROLE_NAME}" ]; then
  echo "FAIL: after the advised import, state names '${REIMPORTED}', expected '${ROLE_NAME}'" >&2
  exit 1
fi
echo "    OK: the advised command adopted the orphan back into state"

# --- Phase 5: the loop is broken ---------------------------------------
echo "==> Phase 5: redeploy again (must now SUCCEED)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes; then
  echo "FAIL: the deploy still fails after following cdkd's own remedy — the remedy does not work" >&2
  exit 1
fi
echo "    OK: deploy succeeds; the redeploy loop is broken"

# --- Phase 6: destroy --------------------------------------------------
echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"
assert_gone "IAM role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
echo "    OK: role gone"

# Nothing left for the cleanup trap to delete.
ROLE_NAME=""

# ---------------------------------------------------------------------------
# The ADOPTION arm (issue #2934).
#
# Everything above proves the go-to-k/cdkd#2916 DIAGNOSIS: an orphan cdkd holds
# no record for still stops the deploy, with advice. This arm proves the thing
# that record buys — that a real rollback's orphan is re-adopted automatically
# and the redeploy just works.
#
# The difference between the two arms is the difference the feature rests on:
# above, the orphan is manufactured with `cdkd state orphan`, which writes NO
# record. Here it comes from an actual failed deploy, which does.
# ---------------------------------------------------------------------------

echo ""
echo "==> Phase 7: deploy the adoption stack with a resource that FAILS"
ADOPT_LOG="$(mktemp)"
# Expected to fail: the queue's MessageRetentionPeriod is out of range, and the
# role it depends on is created first. `|| true` because the non-zero exit IS
# the expected outcome; the assertions below decide pass/fail, not this line.
CDKD_TEST_ADOPT=fail node "${LOCAL_DIST}" deploy "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${ADOPT_LOG}" 2>&1 || true

# Read the name from the RECORD the rollback just wrote, never construct it:
# CDK appends a hash to the logical id (`AdoptedRole` becomes
# `AdoptedRole72C57DEE`), so a hand-built name is wrong AND the mistake reads
# as "the role is missing" — accusing the feature instead of the fixture.
# Taking it from the record also means these phases exercise the record itself.
ADOPT_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${ADOPT_STATE_KEY}" - 2>/dev/null || echo '{}')"
read -r ADOPT_LOGICAL_ID ADOPT_ROLE_NAME <<EOF
$(printf '%s' "${ADOPT_STATE}" | node -e '
let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
  const first = (parsed.orphans ?? [])[0];
  process.stdout.write((first?.logicalId ?? "") + " " + (first?.state?.physicalId ?? ""));
});')
EOF
if [ -z "${ADOPT_ROLE_NAME}" ]; then
  echo "FAIL: the rollback wrote no orphan record to ${ADOPT_STATE_KEY}."
  echo "      Without it the redeploy cannot adopt and would collide instead,"
  echo "      so a missing record means the feature is not wired."
  printf '%s\n' "${ADOPT_STATE}" | head -40
  tail -40 "${ADOPT_LOG}"
  exit 1
fi
if ! aws iam get-role --role-name "${ADOPT_ROLE_NAME}" >/dev/null 2>&1; then
  echo "FAIL: the Retain role ${ADOPT_ROLE_NAME} is not in AWS after the failed deploy."
  echo "      Either the role was never created (the queue failed first, so the"
  echo "      dependsOn is not holding) or the rollback deleted it despite Retain."
  echo "      Either way the rest of this arm would assert nothing."
  tail -40 "${ADOPT_LOG}"
  exit 1
fi
echo "    OK: ${ADOPT_ROLE_NAME} survived the rollback"

echo "==> Phase 8: the rollback must have RECORDED exactly one orphan"
ORPHAN_COUNT="$(printf '%s' "${ADOPT_STATE}" | node -e '
let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
  process.stdout.write(String((parsed.orphans ?? []).length));
});')"
if [ "${ORPHAN_COUNT}" != "1" ]; then
  echo "FAIL: expected exactly 1 orphan record in ${ADOPT_STATE_KEY}, got ${ORPHAN_COUNT}."
  echo "      Without the record the redeploy below cannot adopt, and would"
  echo "      collide instead — so a 0 here means the feature is not wired."
  printf '%s\n' "${ADOPT_STATE}" | head -40
  exit 1
fi
echo "    OK: state carries 1 orphan record"

# --- Phase 8b: the PREVIEW must agree with the deploy -------------------
# go-to-k/cdkd#2943. The state now holds a verified-adoptable record and the
# role is live in AWS, which is the only window where this can be measured:
# before the rollback there is no record, and after Phase 9 the record is
# consumed. Unit tests stub the pre-pass; this is the arm where `provider.
# import()` really runs against AWS from the diff path.
echo "==> Phase 8b: cdkd diff must preview the adoption, not a create"
DIFF_LOG="$(mktemp)"
# `|| DIFF_RC=$?`, not a bare `$?` on the next line: `set -e` is armed, so a
# non-zero exit aborts the script BEFORE the assignment and every diagnostic
# below is dead code. Seeded to 0 because the `||` arm does not run on success.
DIFF_RC=0
CDKD_TEST_ADOPT=fixed node "${LOCAL_DIST}" diff "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${DIFF_LOG}" 2>&1 || DIFF_RC=$?
if [ "${DIFF_RC}" != "0" ]; then
  echo "FAIL: cdkd diff exited ${DIFF_RC}; expected 0 (nothing here is refused —"
  echo "      no sibling stack claims this role). A 3 would mean the refusal"
  echo "      path fired on a record this run created and owns."
  tail -40 "${DIFF_LOG}"
  rm -f "${DIFF_LOG}"
  exit 1
fi
# The annotation, not merely "an update appeared": a stack whose other
# resources changed would show updates anyway, so the token is what ties the
# row to the orphan record.
# The SUMMARY line, not the per-row annotation. This fixture's adopted role
# already matches the template, so its row is NO_CHANGE and renders nothing —
# which is how the first version of this phase failed against real AWS while
# every unit test was green, and why the summary line exists at all.
if ! grep -q "resource(s) to adopt from a previous rollback" "${DIFF_LOG}"; then
  echo "FAIL: cdkd diff did not report the adoption in its summary line. Without"
  echo "      the pre-pass the diff reports a CREATE for a resource the deploy"
  echo "      adopts — the preview/apply divergence go-to-k/cdkd#2943 closes."
  echo "      Sentinel check follows: if the summary count below IS present,"
  echo "      the diff ran and the adoption simply did not happen."
  grep -c "to create, " "${DIFF_LOG}" || echo "      (no diff summary line at all - the run did not produce a preview)"
  tail -40 "${DIFF_LOG}"
  rm -f "${DIFF_LOG}"
  exit 1
fi
echo "    OK: cdkd diff previewed the adoption"
rm -f "${DIFF_LOG}"

echo "==> Phase 9: redeploy with the failure repaired (must SUCCEED by adopting)"
CDKD_TEST_ADOPT=fixed node "${LOCAL_DIST}" deploy "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${ADOPT_LOG}" 2>&1 || {
  echo "FAIL: the redeploy did not succeed. This is the loop the feature closes —"
  echo "      an already-exists collision here means adoption never fired."
  tail -40 "${ADOPT_LOG}"
  exit 1
}
if ! grep -q "Adopting ${ADOPT_LOGICAL_ID}" "${ADOPT_LOG}"; then
  echo "FAIL: the redeploy succeeded but never announced the adoption."
  echo "      A green deploy alone does not discriminate: it also passes if the"
  echo "      role had been deleted and simply re-created, which is the outcome"
  echo "      this feature exists to avoid."
  tail -40 "${ADOPT_LOG}"
  exit 1
fi
echo "    OK: redeploy succeeded and announced the adoption"

echo "==> Phase 10: the record is consumed and the role is managed again"
ADOPT_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${ADOPT_STATE_KEY}" - 2>/dev/null || echo '{}')"
AFTER="$(printf '%s' "${ADOPT_STATE}" | node -e '
let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
  const orphans = (parsed.orphans ?? []).length;
  const adopted = parsed.resources?.[process.argv[1]] ? "yes" : "no";
  process.stdout.write(orphans + " " + adopted);
});' "${ADOPT_LOGICAL_ID}")"
if [ "${AFTER}" != "0 yes" ]; then
  echo "FAIL: expected '0 yes' (record consumed, role back under management), got '${AFTER}'."
  printf '%s\n' "${ADOPT_STATE}" | head -40
  exit 1
fi
echo "    OK: record consumed, AdoptedRole is in resources"

echo "==> Phase 11: destroy the adoption stack"
node "${LOCAL_DIST}" destroy "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
# The role carries RETAIN, so destroy leaves it: that is correct behaviour, not
# a leak to assert against. The cleanup trap deletes it by name.
assert_gone "state file s3://${STATE_BUCKET}/${ADOPT_STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${ADOPT_STATE_KEY}"
echo "    OK: adoption-arm state file is gone"

# ---------------------------------------------------------------------------
# The SINGLE-RECORD orphan arm (go-to-k/cdkd#4602).
#
# `cdkd state orphan <stack> --resource <logicalId>` drops ONE record of a
# stack that stays deployed, without the CDK app. Asserted: only that record
# goes, a surviving record's dependency on it is rewritten out, the resource
# stays in AWS, and the next deploy — with the construct gone from the
# template, the case the option exists for — leaves it alone rather than
# deleting it, because cdkd no longer holds a record of it.
# ---------------------------------------------------------------------------

echo ""
echo "==> Phase 12: deploy the single-record arm (a queue + a parameter that depends on it)"
CDKD_TEST_ORPHAN_RESOURCE=with node "${LOCAL_DIST}" deploy "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ORPHAN_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY}" - 2>/dev/null || echo '{}')"
QUEUE_LOGICAL_ID=$(printf '%s' "${ORPHAN_STATE}" | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::SQS::Queue") | .key] | first // ""')
KEEPER_LOGICAL_ID=$(printf '%s' "${ORPHAN_STATE}" | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::SSM::Parameter") | .key] | first // ""')
ORPHAN_QUEUE_URL=$(printf '%s' "${ORPHAN_STATE}" | jq -r --arg k "${QUEUE_LOGICAL_ID}" '.resources[$k].physicalId // ""')
KEEPER_NAME=$(printf '%s' "${ORPHAN_STATE}" | jq -r --arg k "${KEEPER_LOGICAL_ID}" '.resources[$k].physicalId // ""')
BEFORE_KEYS=$(printf '%s' "${ORPHAN_STATE}" | jq -c '.resources | keys')
if [ -z "${QUEUE_LOGICAL_ID}" ] || [ -z "${KEEPER_LOGICAL_ID}" ] || [ -z "${ORPHAN_QUEUE_URL}" ] || [ -z "${KEEPER_NAME}" ]; then
  echo "FAIL: could not resolve the queue / parameter records from ${ORPHAN_STATE_KEY}" >&2
  printf '%s\n' "${ORPHAN_STATE}" | jq '{resources: (.resources | keys)}' >&2
  exit 1
fi
# Premise: the parameter's record DEPENDS on the queue, or the rewrite asserted
# below has nothing to rewrite and passes vacuously.
if ! printf '%s' "${ORPHAN_STATE}" | jq -e --arg k "${KEEPER_LOGICAL_ID}" --arg q "${QUEUE_LOGICAL_ID}" \
  '.resources[$k].dependencies | index($q) != null' >/dev/null; then
  echo "FAIL: premise: ${KEEPER_LOGICAL_ID}'s record does not list ${QUEUE_LOGICAL_ID} in its dependencies" >&2
  printf '%s\n' "${ORPHAN_STATE}" | jq --arg k "${KEEPER_LOGICAL_ID}" '.resources[$k]' >&2
  exit 1
fi
echo "    queue=${QUEUE_LOGICAL_ID} parameter=${KEEPER_LOGICAL_ID} (depends on the queue)"

echo "==> Phase 13: an unknown --resource refuses and writes nothing"
REFUSE_LOG="$(mktemp)"
if node "${LOCAL_DIST}" state orphan "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" \
  --resource NoSuchLogicalId4602 --yes > "${REFUSE_LOG}" 2>&1; then
  echo "FAIL: 'state orphan --resource NoSuchLogicalId4602' succeeded; it must refuse an id the record does not hold" >&2
  cat "${REFUSE_LOG}" >&2
  exit 1
fi
# The REASON, not just the exit code: a flag typo, a bucket miss or a crash
# also exits non-zero.
if ! grep -q "Resource(s) not in state for" "${REFUSE_LOG}"; then
  echo "FAIL: the refusal is not the unknown-logical-id one" >&2
  cat "${REFUSE_LOG}" >&2
  exit 1
fi
AFTER_KEYS=$(aws s3 cp "s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY}" - 2>/dev/null | jq -c '.resources | keys')
if [ "${AFTER_KEYS}" != "${BEFORE_KEYS}" ]; then
  echo "FAIL: the refused run changed the record: ${BEFORE_KEYS} -> ${AFTER_KEYS}" >&2
  exit 1
fi
echo "    OK: refused, record unchanged"

echo "==> Phase 14: state orphan --resource ${QUEUE_LOGICAL_ID} (drop ONLY the queue's record)"
node "${LOCAL_DIST}" state orphan "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" \
  --resource "${QUEUE_LOGICAL_ID}" --yes

ORPHAN_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY}" - 2>/dev/null || echo '{}')"
EXPECTED_KEYS=$(printf '%s' "${BEFORE_KEYS}" | jq -c --arg q "${QUEUE_LOGICAL_ID}" 'map(select(. != $q))')
AFTER_KEYS=$(printf '%s' "${ORPHAN_STATE}" | jq -c '.resources | keys')
if [ "${AFTER_KEYS}" != "${EXPECTED_KEYS}" ]; then
  echo "FAIL: expected exactly the queue's record to go: ${BEFORE_KEYS} -> ${AFTER_KEYS} (wanted ${EXPECTED_KEYS})" >&2
  exit 1
fi
if printf '%s' "${ORPHAN_STATE}" | jq -e --arg k "${KEEPER_LOGICAL_ID}" --arg q "${QUEUE_LOGICAL_ID}" \
  '.resources[$k].dependencies | index($q) != null' >/dev/null; then
  echo "FAIL: ${KEEPER_LOGICAL_ID}'s record still depends on the removed ${QUEUE_LOGICAL_ID}" >&2
  exit 1
fi
if [ "$(printf '%s' "${ORPHAN_STATE}" | jq -r --arg k "${KEEPER_LOGICAL_ID}" '.resources[$k].physicalId // ""')" != "${KEEPER_NAME}" ]; then
  echo "FAIL: the surviving parameter's record lost its physical id" >&2
  exit 1
fi
# The surviving record's value names the queue's URL, not a {Ref} to a
# record that no longer exists.
KEEPER_RECORDED=$(printf '%s' "${ORPHAN_STATE}" | jq -c --arg k "${KEEPER_LOGICAL_ID}" '.resources[$k].properties.Value')
if [ "${KEEPER_RECORDED}" != "$(jq -cn --arg u "${ORPHAN_QUEUE_URL}" '$u')" ]; then
  echo "FAIL: ${KEEPER_LOGICAL_ID}'s recorded Value is ${KEEPER_RECORDED}, expected the queue URL" >&2
  exit 1
fi
if ! queue_state "${ORPHAN_QUEUE_URL}" exists; then
  echo "FAIL: 'state orphan --resource' deleted the queue — it must only drop the record" >&2
  exit 1
fi
echo "    OK: only the queue's record is gone, the dependency is rewritten, the queue is live"

echo "==> Phase 15: redeploy with the queue gone from the template (must leave the queue alone)"
REDEPLOY_ORPHAN_LOG="$(mktemp)"
CDKD_TEST_ORPHAN_RESOURCE=without node "${LOCAL_DIST}" deploy "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${REDEPLOY_ORPHAN_LOG}"
# The deploy must not even PLAN the queue: it holds no record of it.
# ONE process: under pipefail a `grep | grep -q` whose first stage takes
# SIGPIPE reads as no match, which is the failure this assertion exists for.
# A line carrying the queue URL is skipped: the URL holds the logical id
# (cdkd's generated name), so the survivor's old value would match otherwise.
if awk -v id="${QUEUE_LOGICAL_ID}" -v url="${ORPHAN_QUEUE_URL}" 'index($0, id) && !index($0, url) && tolower($0) ~ /delet/ {f = 1} END {exit !f}' \
  "${REDEPLOY_ORPHAN_LOG}"; then
  echo "FAIL: the redeploy planned or ran a delete of ${QUEUE_LOGICAL_ID}, whose record was orphaned" >&2
  rm -f "${REDEPLOY_ORPHAN_LOG}"
  exit 1
fi
rm -f "${REDEPLOY_ORPHAN_LOG}"
if ! queue_state "${ORPHAN_QUEUE_URL}" exists; then
  echo "FAIL: the redeploy deleted the orphaned queue; with no record cdkd must leave it alone" >&2
  exit 1
fi
KEEPER_VALUE=$(aws ssm get-parameter --name "${KEEPER_NAME}" --query 'Parameter.Value' --output text)
if [ "${KEEPER_VALUE}" != "detached" ]; then
  echo "FAIL: the surviving parameter was not updated by the redeploy (value: ${KEEPER_VALUE})" >&2
  exit 1
fi
echo "    OK: redeploy updated the survivor and left the orphaned queue in place"

echo "==> Phase 16: destroy the single-record arm, then delete the orphaned queue by URL"
DESTROY_ORPHAN_LOG="$(mktemp)"
CDKD_TEST_ORPHAN_RESOURCE=without node "${LOCAL_DIST}" destroy "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1 | tee "${DESTROY_ORPHAN_LOG}"
# The LOG, as in Phase 15: `queue_state exists` cannot catch a wrong delete,
# since SQS answers a just-deleted queue for up to 60 s.
if awk -v id="${QUEUE_LOGICAL_ID}" -v url="${ORPHAN_QUEUE_URL}" 'index($0, id) && !index($0, url) && tolower($0) ~ /delet/ {f = 1} END {exit !f}' \
  "${DESTROY_ORPHAN_LOG}"; then
  echo "FAIL: the destroy deleted ${QUEUE_LOGICAL_ID}, whose record was orphaned" >&2
  exit 1
fi
assert_gone "state file s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${ORPHAN_STATE_KEY}"
assert_gone "SSM parameter ${KEEPER_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${KEEPER_NAME}"
# The destroy holds no record of the queue, so it must still be there (the
# log check above is the discriminating one; this catches a delete by other
# means once SQS stops answering).
if ! queue_state "${ORPHAN_QUEUE_URL}" exists; then
  echo "FAIL: the destroy deleted the orphaned queue, which no record names" >&2
  exit 1
fi
aws sqs delete-queue --queue-url "${ORPHAN_QUEUE_URL}"
queue_state "${ORPHAN_QUEUE_URL}" gone
ORPHAN_QUEUE_URL=""
echo "    OK: stack destroyed, orphaned queue deleted by URL"

cleanup
trap - EXIT INT TERM

echo ""
echo "=== PASS: retain-orphan-redeploy integ (orphan diagnosed + advised remedy recovers; a recorded orphan is re-adopted automatically; state orphan --resource drops one record) ==="

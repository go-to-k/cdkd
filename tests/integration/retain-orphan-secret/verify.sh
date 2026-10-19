#!/usr/bin/env bash
# verify.sh — does the rollback-orphan record leak a secret? (issue #2934)
#
# The record added by #2934 carries a whole `ResourceState` — `properties` and
# `attributes` — on a NEW TOP-LEVEL field of `state.json`. Two facts make that
# the shape of a disclosure rather than a bookkeeping detail:
#
#   - `redactStateForPersist` walks `resources` and `outputs`. Everything else
#     rides its `...state` spread UNTOUCHED, so a new top-level field is
#     redacted only if someone wrote an arm for it.
#   - the AUTOMATIC rollback captures the record from the IN-MEMORY map, which
#     holds REAL resolved values deliberately (`Fn::GetAtt` serves them to
#     dependents in the same run). Masking happens at the persist choke point.
#
# That is GHSA-p5qg-v9gv-hc7w's shape, one field over. Reasoning about the arm
# is not evidence; this fixture is the measurement.
#
# PASS CONDITION is not "the deploy works". It is that a KNOWN plaintext, put
# into a resource a rollback then orphans, appears in NO byte S3 holds — not in
# the current `state.json`, and not in any NONCURRENT VERSION of it. The second
# half matters because `cdkd bootstrap` enables versioning on the state bucket,
# so `aws s3 rm` writes a delete marker and every prior version stays readable
# via `s3:GetObjectVersion`. A fixture that checked only the current object
# would report clean over a live disclosure.
#
# It measures BOTH deploys that write the record:
#
#   Phase 3  the ROLLBACK writes it       (the automatic-rollback capture)
#   Phase 6  the REDEPLOY re-persists it  (on a stack with a stack instance id
#                                          the orphan is NOT adopted,
#                                          go-to-k/cdkd#5064: the record is
#                                          carried, and a NEW parameter under
#                                          the next name generation's name is
#                                          created beside the orphan, its own
#                                          record holding the same reference)
#
# Both parameters are RETAIN and hold the resolved plaintext in SSM, so the
# fixture deletes each by name once it has asserted on it.
#
# Environment:
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

cd "$(dirname "$0")"
. ../s3-versions.sh

export AWS_PAGER=""

STACK="CdkdRetainOrphanSecretExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The canary. Created by THIS SCRIPT as a real Secrets Manager secret, and
# referenced from the template only as `{{resolve:secretsmanager:...}}`.
#
# Seeding it through the template is what the first version of this fixture did
# (`SecretValue.unsafePlainText`), and it measured the wrong thing: that API
# embeds the literal in the TEMPLATE, cdkd persists resolved template values,
# and the plaintext landed in that secret's OWN record regardless of anything
# issue #2934 does — so the run reported a leak this feature had not caused.
#
# Created out of band, the only route from this string into `state.json` runs
# through the code under test.
PLAINTEXT="cdkd-2934-orphan-leak-canary-9f3a7c1e"
CANARY_ID="cdkd-2934-canary-$$"
export CDKD_TEST_SECRET_NAME="${CANARY_ID}"

PARAM_NAME=""
# The parameter phase 5's redeploy creates beside the orphan (RETAIN too).
PARAM_NAME_2=""
LOG=""

# The 12-hex suffix cdkd gives a generated name at name generation <g> of
# <logicalId> (go-to-k/cdkd#5064): sha256(id NUL logicalId)[:12] at 0,
# sha256(id NUL logicalId NUL g)[:12] above, the id being state.json's
# stackInstanceId. Read from S3 into node's stdin: the id is never printed.
state_name_suffix() { # usage: state_name_suffix <logicalId> <generation>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | node -e '
const { createHash } = require("node:crypto");
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  const [logicalId, generation] = process.argv.slice(1);
  const id = JSON.parse(raw).stackInstanceId;
  if (typeof id !== "string" || id === "" || !/^(0|[1-9][0-9]*)$/.test(generation ?? "")) {
    process.stderr.write("state.json carries no stackInstanceId, or the generation is not a number\n");
    process.exit(1);
  }
  const hash = createHash("sha256").update(id).update("\0").update(logicalId);
  if (generation !== "0") hash.update("\0").update(generation);
  process.stdout.write(hash.digest("hex").slice(0, 12));
});' "$1" "$2"
}

cleanup() {
  echo "==> Cleanup: dropping leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  # The parameter carries RETAIN, so `state destroy` deliberately leaves it.
  # This by-name delete is the only thing that stops a leak of one per run.
  if [ -n "${PARAM_NAME}" ]; then
    aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${PARAM_NAME_2}" ]; then
    aws ssm delete-parameter --name "${PARAM_NAME_2}" --region "${REGION}" >/dev/null 2>&1
  fi
  # Secrets Manager keeps a deleted secret for a recovery window by default, and
  # that retained copy holds the plaintext — so force it, or the canary outlives
  # the run in a service this fixture never checks again.
  aws secretsmanager delete-secret --secret-id "${CANARY_ID}" --region "${REGION}" \
    --force-delete-without-recovery >/dev/null 2>&1
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  rm -f "${LOG:-}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Pre-run: a previous run's versions would make the assertions below pass or
# fail for reasons that have nothing to do with this run.
cleanup

# Greps every version S3 still holds under the prefix, not just the current
# object. Returns 0 when the plaintext is found ANYWHERE — the leak condition.
plaintext_survives_in_s3() {
  local found=1
  local key version

  # The LISTING gets the same treatment as the per-object read below, and for
  # the same reason. Silencing it (`2>/dev/null` feeding the loop) makes a
  # throttle or a permission gap yield zero rows: the loop body never runs,
  # `found` stays 1, and the function reports NO LEAK having examined nothing.
  # That is the #1097 pattern-2 defect sitting INSIDE the assertion this fixture
  # exists for — and the careful stderr handling on the read does not protect
  # it, because the read is never reached.
  local listing listing_err
  listing_err="$(mktemp)"
  if ! listing="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
    --prefix "${STATE_PREFIX}" --region "${REGION}" \
    --query 'Versions[].[Key,VersionId]' --output text 2>"${listing_err}")"; then
    echo "FAIL: could not list object versions under ${STATE_PREFIX} — this" >&2
    echo "      assertion cannot conclude anything about versions it never saw:" >&2
    cat "${listing_err}" >&2
    rm -f "${listing_err}"
    exit 1
  fi
  rm -f "${listing_err}"

  # A SUCCESSFUL listing that returns nothing is a different claim from a failed
  # one, and it is legitimate only before anything has been written. Every call
  # site here runs after a deploy, so zero rows means the prefix is wrong — the
  # truthful `0` about the wrong key space that the repo's s3-versions helpers
  # refuse for exactly this reason.
  if [ -z "${listing}" ] || [ "${listing}" = "None" ]; then
    echo "FAIL: no object versions under ${STATE_PREFIX} after a deploy." >&2
    echo "      A clean scan over an empty key space proves nothing; the prefix" >&2
    echo "      is almost certainly wrong." >&2
    exit 1
  fi

  while IFS=$'\t' read -r key version || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    # NO `2>/dev/null` on this read. Swallowing its stderr makes a version that
    # could not be FETCHED — a throttle, a permission gap, a transient 5xx —
    # indistinguishable from a version that was fetched and held no plaintext,
    # so the fixture would report "no leak" over bytes it never looked at. That
    # is the #1097 pattern-2 defect, and it is the exact failure mode this
    # fixture exists to rule out, one layer up.
    local body err
    err="$(mktemp)"
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
      --version-id "${version}" --region "${REGION}" /dev/stdout 2>"${err}")"; then
      echo "FAIL: could not read ${key} (version ${version}) — this assertion" >&2
      echo "      cannot conclude anything about a version it never fetched:" >&2
      cat "${err}" >&2
      rm -f "${err}"
      exit 1
    fi
    rm -f "${err}"
    if printf '%s' "${body}" | grep -qF "${PLAINTEXT}"; then
      echo "    LEAKED in ${key} (version ${version})" >&2
      found=0
    fi
  done <<< "${listing}"
  return "${found}"
}

command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }

echo "==> Phase 0: create the canary out of band"
aws secretsmanager create-secret --name "${CANARY_ID}" --region "${REGION}" \
  --secret-string "${PLAINTEXT}" >/dev/null
echo "    OK: ${CANARY_ID} created"

echo "==> Phase 1: deploy with a resource that FAILS after the parameter is created"
LOG="$(mktemp)"
# Expected to fail: the queue's MessageRetentionPeriod is out of range and the
# parameter it depends on is created first. The assertions decide pass/fail.
CDKD_TEST_SECRET_ORPHAN=fail node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${LOG}" 2>&1 || true

echo "==> Phase 2: the rollback must have ORPHANED the parameter and recorded it"
STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null || echo '{}')"
read -r ORPHAN_COUNT PARAM_NAME PARAM_LOGICAL_ID <<EOF
$(printf '%s' "${STATE}" | node -e '
let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
  const orphans = parsed.orphans ?? [];
  process.stdout.write(orphans.length + " " + (orphans[0]?.state?.physicalId ?? "") + " " + (orphans[0]?.logicalId ?? ""));
});')
EOF
if [ "${ORPHAN_COUNT}" != "1" ] || [ -z "${PARAM_NAME}" ] || [ -z "${PARAM_LOGICAL_ID}" ]; then
  echo "FAIL: expected exactly 1 orphan record in ${STATE_KEY}, got '${ORPHAN_COUNT}'."
  echo "      With no record there is nothing to leak, so every assertion below"
  echo "      would pass VACUOUSLY — this fixture would report clean over an"
  echo "      untested code path."
  printf '%s\n' "${STATE}" | head -40
  tail -40 "${LOG}"
  exit 1
fi
if ! aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ${PARAM_NAME} is not in AWS — either it was never created (the"
  echo "      addDependency is not holding) or the rollback deleted it despite"
  echo "      RETAIN. Either way the record describes nothing."
  exit 1
fi
# Vacuity guard, and it must precede every leak assertion. If cdkd did NOT
# resolve the reference (a wrong name, a permission gap), it stores the literal
# expression, no plaintext ever exists in this run, and every assertion below
# passes having handled no secret at all. Reading the LIVE PARAMETER proves the
# resolution happened — and does so through the resource under test rather than
# by fetching the secret.
if ! aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null | grep -qF "${PLAINTEXT}"; then
  echo "FAIL: the live parameter does not carry the resolved canary."
  echo "      cdkd never turned the dynamic reference into plaintext, so the"
  echo "      leak assertions below would pass VACUOUSLY."
  exit 1
fi
echo "    OK: 1 orphan record; ${PARAM_NAME} is live and carries the resolved canary"

echo "==> Phase 3: the record must hold the EXPRESSION, never the plaintext"
RECORDED_VALUE="$(printf '%s' "${STATE}" | node -e '
let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
  process.stdout.write(String((parsed.orphans ?? [])[0]?.state?.properties?.Value ?? ""));
});')"
case "${RECORDED_VALUE}" in
  *'{{resolve:secretsmanager:'*) ;;
  *)
    echo "FAIL: the orphan record's Value is not a redacted dynamic reference."
    echo "      got: ${RECORDED_VALUE}"
    echo "      cdkd resolved the secret to call AWS; the persisted record must"
    echo "      carry the EXPRESSION back, as it does for \`resources\`."
    exit 1
    ;;
esac
echo "    OK: record holds the {{resolve:secretsmanager:...}} expression"

echo "==> Phase 4: the plaintext must be in NO S3 object version"
# This is the assertion the whole fixture exists for. It reads every VERSION,
# not the current object, because the state bucket is versioned and a delete
# marker hides nothing from `s3:GetObjectVersion`.
if plaintext_survives_in_s3; then
  echo "FAIL: the seeded plaintext is readable in the state bucket after the"
  echo "      rollback. The orphan record is not going through redaction."
  exit 1
fi
echo "    OK: plaintext absent from every version under ${STATE_PREFIX}"

# go-to-k/cdkd#5064: the orphan holds the generation-0 name derived from the
# stack instance id, and the rollback retired that generation, so phase 5's
# create takes generation 1 — a name predicted here, before the deploy.
PARAM_SUFFIX_G0="$(state_name_suffix "${PARAM_LOGICAL_ID}" 0)" || exit 1
if [ "${PARAM_NAME##*-}" != "${PARAM_SUFFIX_G0}" ]; then
  echo "FAIL: the orphan ${PARAM_NAME} is not ${PARAM_LOGICAL_ID}'s generation-0 name (suffix derived from state.json's stackInstanceId: ${PARAM_SUFFIX_G0})"
  exit 1
fi
if [ "$(printf '%s' "${STATE}" | jq -r --arg k "${PARAM_LOGICAL_ID}" '.retiredNameGenerations[$k] // "none"')" != "0" ]; then
  echo "FAIL: the rollback did not retire ${PARAM_LOGICAL_ID} at generation 0 (retiredNameGenerations)"
  exit 1
fi
PARAM_SUFFIX_G1="$(state_name_suffix "${PARAM_LOGICAL_ID}" 1)" || exit 1
PARAM_EXPECTED_G1="${PARAM_NAME%-*}-${PARAM_SUFFIX_G1}"
# Registered for the cleanup BEFORE the deploy: a deploy that fails after
# creating it would otherwise leave a Retain parameter holding the canary.
PARAM_NAME_2="${PARAM_EXPECTED_G1}"
PARAM_ORPHAN_MODIFIED="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.LastModifiedDate' --output text)"

echo "==> Phase 5: redeploy with the failure repaired (a NEW parameter; the orphan is not taken back)"
CDKD_TEST_SECRET_ORPHAN=fixed node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${LOG}" 2>&1 || {
  echo "FAIL: the redeploy did not succeed — on a stack with a stack instance id"
  echo "      the create asks for the next generation's name, so nothing should"
  echo "      collide; phase 6 would measure the wrong path."
  tail -40 "${LOG}"
  exit 1
}
# The warning: the sentinel is its `cdkd import` remedy clause, the markers are
# the "does not take it back" statement and the orphan's name, all on the
# warning's one line.
if ! grep -qF "adopt it with 'cdkd import'" "${LOG}"; then
  echo "FAIL: the redeploy did not warn that the rollback's orphan is not taken back (no 'cdkd import' remedy line)"
  tail -40 "${LOG}"
  exit 1
fi
if ! grep -F "adopt it with 'cdkd import'" "${LOG}" | grep -F "This deploy does not take it back" | grep -qF "${PARAM_NAME}"; then
  echo "FAIL: a 'cdkd import' remedy line is present but is not the orphan warning naming ${PARAM_NAME} (wording drifted?):"
  grep -F "adopt it with 'cdkd import'" "${LOG}" | sed 's/^/  /'
  exit 1
fi
if grep -q "Adopting " "${LOG}"; then
  echo "FAIL: the redeploy adopted the rollback orphan on a stack with a stack instance id"
  tail -40 "${LOG}"
  exit 1
fi
STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
PARAM_NAME_2="$(printf '%s' "${STATE}" | jq -r --arg k "${PARAM_LOGICAL_ID}" '.resources[$k].physicalId // ""')"
if [ "${PARAM_NAME_2}" != "${PARAM_EXPECTED_G1}" ]; then
  echo "FAIL: state records ${PARAM_LOGICAL_ID} as '${PARAM_NAME_2}', expected the generation-1 name ${PARAM_EXPECTED_G1}"
  exit 1
fi
# The new parameter resolved the canary too, so phase 6 measures a second
# secret-bearing record rather than one that never held the plaintext.
if ! aws ssm get-parameter --name "${PARAM_NAME_2}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null | grep -qF "${PLAINTEXT}"; then
  echo "FAIL: the new parameter ${PARAM_NAME_2} does not carry the resolved canary."
  exit 1
fi
if [ "$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.LastModifiedDate' --output text)" != "${PARAM_ORPHAN_MODIFIED}" ]; then
  echo "FAIL: the redeploy wrote to the orphan ${PARAM_NAME} — it must leave it alone"
  exit 1
fi
echo "    OK: ${PARAM_NAME_2} created beside the untouched orphan ${PARAM_NAME}, with the warning"

echo "==> Phase 6: the REDEPLOY's writes must not leak either"
# The redeploy re-persists the carried orphan record and writes the new
# parameter's record, whose readback merges AWS-side values. Both are new
# writes of a secret-bearing record, so the leak question is re-asked here
# rather than assumed settled by phase 4.
if plaintext_survives_in_s3; then
  echo "FAIL: the seeded plaintext became readable after the REDEPLOY."
  echo "      The rollback write was clean but the redeploy's write is not."
  exit 1
fi
echo "    OK: plaintext still absent after the redeploy"
# The orphan has served its purpose: no record will ever delete it, and it
# holds the resolved plaintext.
aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "the orphaned parameter ${PARAM_NAME} survived its own delete" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
PARAM_NAME=""

echo "==> Phase 7: destroy, then prove the versions are gone too"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# RETAIN: the destroy keeps the new parameter, which holds the resolved
# plaintext, so the fixture deletes it.
aws ssm delete-parameter --name "${PARAM_NAME_2}" --region "${REGION}"
assert_gone "the retained parameter ${PARAM_NAME_2} survived its own delete" \
  aws ssm get-parameter --name "${PARAM_NAME_2}" --region "${REGION}"
PARAM_NAME_2=""

cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "retain-orphan-secret state teardown"
echo "    OK: no versions survive"

echo ""
echo "=== PASS: retain-orphan-secret integ (the orphan record carries the expression, and the seeded plaintext is readable in no S3 version after either the rollback write or the redeploy write; the orphan is left alone and a new parameter takes the next name generation) ==="

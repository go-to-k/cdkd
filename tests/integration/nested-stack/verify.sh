#!/usr/bin/env bash
# Integration test for NestedStackProvider.delete's child-result propagation.
#
# Issue https://github.com/go-to-k/cdkd/issues/1777 (the errorCount half).
#
# PROVENANCE: this fixture had NO verify.sh before this change — the integ
# ledger records it as mode `standard`, i.e. /run-integ drove it with the plain
# synth -> deploy -> destroy flow, and "a clean child still reports deleted" was
# only ever an IMPLICIT consequence of that flow exiting 0. Phase C below makes
# it an explicit assertion. From now on the ledger's mode column reads
# `verify.sh` for this test, because /run-integ dispatches to a fixture's
# verify.sh when one exists.
#
# The defect: `NestedStackProvider.delete` runs the child stack's destroy
# through a nested DestroyRunner and used to inspect only `skippedCount`. When a
# child resource genuinely FAILED to delete, the parent printed
# `✓ Child (AWS::CloudFormation::Stack) deleted`, DROPPED the child's row from
# parent state and — with the parent's own errorCount still 0 — deleted the
# parent's `state.json` and the exports index outright, exiting 0. The child's
# own `state.json` sat there preserved describing live resources, with nothing
# left naming it. It now THROWS, so the parent's nested-stack row FAILS.
#
# How the failure is provoked without changing the CDK app: the child's S3
# bucket is created WITHOUT `autoDeleteObjects`, so cdkd's CloudFormation-parity
# data guard (issue #1340) refuses to delete it while it holds an object. We PUT
# one object, destroy, and assert the failure propagates; then we empty the
# bucket and destroy again to assert the clean path is unchanged.
#
# What this exercises, in one run:
#   Phase A (deploy)        - parent + child state files written.
#   Phase A2 (drift, #2141) - `cdkd drift` over the parent; the summary counts
#                             ONLY the SSM parameter as checked and reports the
#                             nested stack separately as unsupported. This
#                             parent is the discriminating shape: one readable
#                             resource, one that reaches `unsupported` with no
#                             AWS read attempted.
#   Phase B (POSITIVE arm)  - a genuinely failing child delete => parent exits
#                             non-zero, prints NO `Child ... deleted` line, and
#                             PRESERVES the parent state.json WITH its Child row
#                             plus the child's own state.json.
#   Phase C (NEGATIVE ctrl) - with the bucket emptied, the same destroy reports
#                             the child deleted and removes both state files.
#
# The Phase B assertions deliberately exclude the PRE-fix outcome: an assertion
# that only checked the exit code would pass against the un-fixed binary too
# (the run would exit 0). The state-file + state-row assertions are what
# discriminate.

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

# The INVERSE assertion, and it needs the same three-way discipline for the
# same reason: a wrapped `if ! aws ...` reports "GONE" on ANY probe failure --
# throttle, expired creds, a transient 5xx -- which here means ACCUSING the fix
# of deleting state it actually preserved. It fails closed (never a false PASS),
# but a false FAIL on an unrelated AWS blip is its own kind of wrong.
# assert_exists returns 0 when the probe succeeds (resource confirmed present),
# FAILs with the caller's description when the probe reports not-found, and
# hard-FAILs as UNDETERMINED on any other probe failure without blaming the
# code under test.
assert_exists() { # usage: assert_exists "<missing description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  [ "${1:-}" = "aws" ] || { echo "FAIL: assert_exists: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 0
  fi
  if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
  echo "FAIL: exists-probe undetermined ($*): ${out}" >&2
  exit 1
}

cd "$(dirname "$0")"

export AWS_PAGER=""

LOCAL_DIST="../../../dist/cli.js"
REGION="${AWS_REGION:-us-east-1}"
BUCKET="${STATE_BUCKET:?STATE_BUCKET is required}"
STACK="NestedStackExample"
CHILD_STACK="${STACK}~Child"
PARENT_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
PROBE_KEY="cdkd-1777-probe.txt"

# Set once the child bucket name is known, so cleanup can empty it.
CHILD_BUCKET=""

# Per-run scratch dir: two concurrent runs of this fixture (parallel lanes, a
# re-run started before the first finished) would clobber each other's captured
# destroy output on fixed /tmp paths, and the assertions read those files.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-1777-XXXXXX")"

echo "=== Nested-stack child-result propagation integ (issue #1777) ==="
echo "Stack:        ${STACK}"
echo "Child stack:  ${CHILD_STACK}"
echo "Region:       ${REGION}"
echo "State bucket: ${BUCKET}"

# ANSI is emitted unconditionally by cdkd's status lines, so every grep over
# captured output reads the stripped text (what a user sees in a CI log).
strip_ansi() { sed -e $'s/\033\\[[0-9;]*m//g'; }

# Best-effort teardown. Marked `set +eu` in a SUBSHELL body so calling it from
# the trap can never re-arm strict mode mid-sweep.
cleanup() {
  (
    set +eu
    echo "=== cleanup: emptying child bucket + destroying ${STACK} ==="
    if [ -n "${CHILD_BUCKET}" ]; then
      aws s3 rm "s3://${CHILD_BUCKET}" --recursive --region "${REGION}"
    fi
    node "${LOCAL_DIST}" destroy "${STACK}" \
      --region "${REGION}" --state-bucket "${BUCKET:-}" --force
    node "${LOCAL_DIST}" state destroy "${CHILD_STACK}" \
      --state-bucket "${BUCKET:-}" --region "${REGION}" --yes
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${BUCKET:-}" --region "${REGION}" --yes
    rm -rf "${WORK_DIR:-}"
  )
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# ---------------------------------------------------------------------------
# Phase A: deploy
# ---------------------------------------------------------------------------
echo "=== Phase A: deploying ${STACK} ==="
node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" --state-bucket "${BUCKET}"

assert_exists "the parent state.json was not written by the deploy" \
  aws s3api head-object --bucket "${BUCKET}" --key "${PARENT_KEY}" --region "${REGION}"
assert_exists "the child state.json was not written by the deploy" \
  aws s3api head-object --bucket "${BUCKET}" --key "${CHILD_KEY}" --region "${REGION}"
echo "PASS: parent + child state files exist after deploy"

child_state="$(aws s3 cp "s3://${BUCKET}/${CHILD_KEY}" - --region "${REGION}")"
CHILD_BUCKET="$(printf '%s' "${child_state}" | python3 -c '
import json, sys
s = json.load(sys.stdin)
for v in s["resources"].values():
    if v["resourceType"] == "AWS::S3::Bucket":
        print(v["physicalId"])
        break
')"
if [ -z "${CHILD_BUCKET}" ]; then
  echo "FAIL: child state has no AWS::S3::Bucket entry" >&2
  exit 1
fi
echo "PASS: child bucket resolved from child state: ${CHILD_BUCKET}"

# ---------------------------------------------------------------------------
# Phase A2: the drift summary counts only what cdkd READ (issue #2141).
# ---------------------------------------------------------------------------
# This parent is the discriminating shape, and it is why the arm lives here
# rather than in a drift fixture: it holds exactly TWO resources, one of each
# kind. `ParentReferenceToChildBucket` is an SSM parameter whose provider
# implements `readCurrentState`, so it is genuinely compared; `Child` is an
# `AWS::CloudFormation::Stack`, whose NestedStackProvider has no
# `readCurrentState` AND which is on `CC_API_FALLBACK_DENY_LIST`, so it
# short-circuits to `unsupported` with no AWS read attempted at all. A fixture
# whose resources are all readable cannot tell the two arithmetics apart.
#
# Before #2141 the summary read `2 resources checked, 1 unsupported` -- it
# counted `Child`, which cdkd never read. THE DISCRIMINATOR is the
# `1 resource checked` half; the `1 unsupported` half is printed from a
# different variable that the change does not touch, so asserting it alone
# would pass under both arithmetics.
#
# Placed after Phase A and before Phase B deliberately: Phase B seeds an object
# to provoke a FAILING destroy, so this is the last point at which the stack is
# in its ordinary deployed state and a drift run must report nothing wrong.
# `cdkd drift` detection takes no lock and writes nothing, so it cannot disturb
# Phase B's premise.
#
# COUPLING THIS CREATES, stated so a future failure is not misread: the
# `drift_rc -ne 0` check below ties this fixture -- a merge gate for the
# nested-stack path -- to `AWS::SSM::Parameter` drift stability. If that
# provider ever reports phantom drift, THIS test reds rather than a drift
# fixture. The rc check is kept anyway because without it a run that died
# before printing its summary would satisfy the greps below by never reaching
# them.
echo "=== Phase A2: drift counts only the resource cdkd actually read ==="
set +e
drift_out="$(node "${LOCAL_DIST}" drift "${STACK}" \
  --region "${REGION}" --state-bucket "${BUCKET}" 2>&1)"
drift_rc=$?
set -e
printf '%s\n' "${drift_out}"

# Nothing has been changed out of band yet, so this must be a clean exit.
# Asserted FIRST so a run that died before printing its summary cannot satisfy
# the string checks below by never reaching them.
if [ "${drift_rc}" -ne 0 ]; then
  echo "FAIL: drift exited ${drift_rc}, expected 0 (nothing drifted, nothing refused)" >&2
  exit 1
fi

if ! printf '%s' "${drift_out}" | grep -qF 'no drift detected (1 resource checked, 1 unsupported)'; then
  echo "FAIL: drift summary did not read '1 resource checked, 1 unsupported' (issue #2141)" >&2
  echo "      the pre-#2141 arithmetic renders '2 resources checked, 1 unsupported'" >&2
  exit 1
fi
echo "PASS: the summary counts only the SSM parameter as checked"

# The premise, stated positively. Without this, `1 resource checked` is also
# what a report that LOST the nested stack entirely would print -- the number
# would be right by accident, over a run that silently dropped a resource.
if ! printf '%s' "${drift_out}" | grep -qF '? Child (AWS::CloudFormation::Stack)'; then
  echo "FAIL: Child was not reported as drift unknown -- the count above is unearned" >&2
  exit 1
fi
echo "PASS: the uncounted resource is on record as unsupported"

# NEGATIVE CONTROL: the SSM parameter must NOT also be unsupported. A change
# that made EVERY resource unsupported would print a self-consistent summary
# and satisfy both assertions above, so the arm has to pin which side each
# resource landed on.
if printf '%s' "${drift_out}" | grep -qF '? ParentReferenceToChildBucket'; then
  echo "FAIL: the parent SSM parameter reported as unsupported -- it has readCurrentState" >&2
  exit 1
fi
echo "PASS: the parameter is the checked one, the nested stack the unsupported one"

# ---------------------------------------------------------------------------
# Phase B: make the child's bucket delete FAIL, then destroy the parent.
# ---------------------------------------------------------------------------
echo "=== Phase B: seeding an object so the child's bucket delete fails ==="
printf 'cdkd issue 1777 probe object\n' > "${WORK_DIR}/probe.txt"
aws s3api put-object \
  --bucket "${CHILD_BUCKET}" --key "${PROBE_KEY}" \
  --body "${WORK_DIR}/probe.txt" --region "${REGION}" >/dev/null
echo "PASS: probe object PUT into ${CHILD_BUCKET}"

echo "=== Phase B: destroying ${STACK} (expected to FAIL) ==="
rc=0
node "${LOCAL_DIST}" destroy "${STACK}" \
  --region "${REGION}" --state-bucket "${BUCKET}" --force \
  > "${WORK_DIR}/destroy-fail.log" 2>&1 || rc=$?
strip_ansi < "${WORK_DIR}/destroy-fail.log" > "${WORK_DIR}/destroy-fail.txt"
cat "${WORK_DIR}/destroy-fail.txt"

# Exit code 2 is cdkd's "state preserved, stack not destroyed" contract
# (PartialFailureError). Pre-fix this run exited 0.
if [ "${rc}" -ne 2 ]; then
  echo "FAIL: expected exit code 2 from the failing destroy, got ${rc}" >&2
  exit 1
fi
echo "PASS: failing destroy exited 2 (PartialFailureError)"

# The line the issue is about: the parent must NOT assert the child is gone.
if grep -qE '✓ Child \(AWS::CloudFormation::Stack\) deleted' "${WORK_DIR}/destroy-fail.txt"; then
  echo "FAIL: parent reported the nested stack DELETED while the child failed" >&2
  exit 1
fi
echo "PASS: no '✓ Child (AWS::CloudFormation::Stack) deleted' line on the failing run"

if ! grep -q "Nested stack ${CHILD_STACK} failed to destroy" "${WORK_DIR}/destroy-fail.txt"; then
  echo "FAIL: the parent's failure did not name the child stack's destroy failure" >&2
  exit 1
fi
echo "PASS: the failure names the child stack"

# The last-resort remedy must name the CHILD's state target, not the parent's.
# This is the half of the fix that is easiest to regress silently: following a
# parent-named `cdkd state orphan NestedStackExample` would drop the `Child`
# row, i.e. destroy the exact pointer the throw above exists to preserve. The
# negative half is what makes this discriminating -- pre-fix the summary named
# the parent, so asserting only the child form could pass on a line that named
# both.
if ! grep -q "cdkd state orphan ${CHILD_STACK}" "${WORK_DIR}/destroy-fail.txt"; then
  echo "FAIL: the failed-delete remedy did not name the child's state target" >&2
  echo "      (expected 'cdkd state orphan ${CHILD_STACK}')" >&2
  exit 1
fi
if grep -q "cdkd state orphan ${STACK}'" "${WORK_DIR}/destroy-fail.txt"; then
  echo "FAIL: the remedy still names the PARENT state target -- following it" >&2
  echo "      would drop the Child row this fix preserves" >&2
  exit 1
fi
echo "PASS: the failed-delete remedy names the child's state target, not the parent's"

# The three things the pre-fix path destroyed: the parent state file, the
# parent's row pointing at the child, and the child's own state file.
# Routed through assert_exists, not a bare call or a blind `if !`: the first
# aborts on a raw AWS error, and the second would accuse the fix of deleting
# state whenever the probe merely failed to answer.
assert_exists "the parent state.json was DELETED by the failing destroy" \
  aws s3api head-object --bucket "${BUCKET}" --key "${PARENT_KEY}" --region "${REGION}"
assert_exists "the child state.json was DELETED by the failing destroy" \
  aws s3api head-object --bucket "${BUCKET}" --key "${CHILD_KEY}" --region "${REGION}"
echo "PASS: parent AND child state files both survived the failed destroy"

parent_state="$(aws s3 cp "s3://${BUCKET}/${PARENT_KEY}" - --region "${REGION}")"
has_child_row="$(printf '%s' "${parent_state}" | python3 -c '
import json, sys
s = json.load(sys.stdin)
row = s["resources"].get("Child")
print("yes" if row and row["resourceType"] == "AWS::CloudFormation::Stack" else "no")
')"
if [ "${has_child_row}" != "yes" ]; then
  echo "FAIL: the parent state no longer carries its Child (AWS::CloudFormation::Stack) row" >&2
  exit 1
fi
echo "PASS: the parent's pointer to the child stack is preserved"

# The child state file EXISTING is not discriminating on its own — the child
# runner preserved it pre-fix too (its own errorCount was non-zero). What the
# fix has to buy is that the still-live BUCKET is still listed in it, so the
# user has an id to go and delete.
child_state_after="$(aws s3 cp "s3://${BUCKET}/${CHILD_KEY}" - --region "${REGION}")"
child_bucket_row="$(printf '%s' "${child_state_after}" | python3 -c '
import json, sys
s = json.load(sys.stdin)
for v in s["resources"].values():
    if v["resourceType"] == "AWS::S3::Bucket":
        print(v["physicalId"])
        break
')"
if [ "${child_bucket_row}" != "${CHILD_BUCKET}" ]; then
  echo "FAIL: the child state no longer lists the un-deleted bucket (got '${child_bucket_row}', want '${CHILD_BUCKET}')" >&2
  exit 1
fi
echo "PASS: the child state still lists the un-deleted bucket ${CHILD_BUCKET}"

# ---------------------------------------------------------------------------
# Phase C: negative control — with the blocker removed, the destroy is clean.
# ---------------------------------------------------------------------------
echo "=== Phase C: emptying the child bucket and re-destroying (clean path) ==="
aws s3api delete-object \
  --bucket "${CHILD_BUCKET}" --key "${PROBE_KEY}" --region "${REGION}" >/dev/null

node "${LOCAL_DIST}" destroy "${STACK}" \
  --region "${REGION}" --state-bucket "${BUCKET}" --force \
  > "${WORK_DIR}/destroy-ok.log" 2>&1
strip_ansi < "${WORK_DIR}/destroy-ok.log" > "${WORK_DIR}/destroy-ok.txt"
cat "${WORK_DIR}/destroy-ok.txt"

# The negative control this fixture has always carried: a CLEAN child still
# reports deleted. Without it, "never report a nested stack deleted" would pass
# every Phase B assertion while breaking every ordinary nested-stack destroy.
if ! grep -qE '✓ Child \(AWS::CloudFormation::Stack\) deleted' "${WORK_DIR}/destroy-ok.txt"; then
  echo "FAIL: a clean child destroy no longer reports the nested stack deleted" >&2
  exit 1
fi
echo "PASS: a clean child destroy still reports '✓ Child (AWS::CloudFormation::Stack) deleted'"

assert_gone "parent state.json survived a CLEAN destroy" \
  aws s3api head-object --bucket "${BUCKET}" --key "${PARENT_KEY}" --region "${REGION}"
assert_gone "child state.json survived a CLEAN destroy" \
  aws s3api head-object --bucket "${BUCKET}" --key "${CHILD_KEY}" --region "${REGION}"
assert_gone "child bucket ${CHILD_BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${CHILD_BUCKET}" --region "${REGION}"
echo "PASS: both state files and the child bucket are gone after the clean destroy"

CHILD_BUCKET=""
trap - EXIT INT TERM
rm -rf "${WORK_DIR}"
echo "=== nested-stack (issue #1777) integ PASSED ==="

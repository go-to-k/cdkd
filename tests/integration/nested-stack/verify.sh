#!/usr/bin/env bash
# Integration test for NestedStackProvider.delete's child-result propagation.
#
# Issue https://github.com/go-to-k/cdkd/issues/1777 (the errorCount half) plus
# the #1752 / #1774 negative control this fixture already carried ("a clean
# child still reports deleted").
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

aws s3api head-object --bucket "${BUCKET}" --key "${PARENT_KEY}" --region "${REGION}" >/dev/null
aws s3api head-object --bucket "${BUCKET}" --key "${CHILD_KEY}" --region "${REGION}" >/dev/null
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
# Phase B: make the child's bucket delete FAIL, then destroy the parent.
# ---------------------------------------------------------------------------
echo "=== Phase B: seeding an object so the child's bucket delete fails ==="
printf 'cdkd issue 1777 probe object\n' > /tmp/cdkd-1777-probe.txt
aws s3api put-object \
  --bucket "${CHILD_BUCKET}" --key "${PROBE_KEY}" \
  --body /tmp/cdkd-1777-probe.txt --region "${REGION}" >/dev/null
echo "PASS: probe object PUT into ${CHILD_BUCKET}"

echo "=== Phase B: destroying ${STACK} (expected to FAIL) ==="
rc=0
node "${LOCAL_DIST}" destroy "${STACK}" \
  --region "${REGION}" --state-bucket "${BUCKET}" --force \
  > /tmp/cdkd-1777-destroy-fail.log 2>&1 || rc=$?
strip_ansi < /tmp/cdkd-1777-destroy-fail.log > /tmp/cdkd-1777-destroy-fail.txt
cat /tmp/cdkd-1777-destroy-fail.txt

# Exit code 2 is cdkd's "state preserved, stack not destroyed" contract
# (PartialFailureError). Pre-fix this run exited 0.
if [ "${rc}" -ne 2 ]; then
  echo "FAIL: expected exit code 2 from the failing destroy, got ${rc}" >&2
  exit 1
fi
echo "PASS: failing destroy exited 2 (PartialFailureError)"

# The line the issue is about: the parent must NOT assert the child is gone.
if grep -qE '✓ Child \(AWS::CloudFormation::Stack\) deleted' /tmp/cdkd-1777-destroy-fail.txt; then
  echo "FAIL: parent reported the nested stack DELETED while the child failed" >&2
  exit 1
fi
echo "PASS: no '✓ Child (AWS::CloudFormation::Stack) deleted' line on the failing run"

if ! grep -q "Nested stack ${CHILD_STACK} failed to destroy" /tmp/cdkd-1777-destroy-fail.txt; then
  echo "FAIL: the parent's failure did not name the child stack's destroy failure" >&2
  exit 1
fi
echo "PASS: the failure names the child stack"

# The three things the pre-fix path destroyed: the parent state file, the
# parent's row pointing at the child, and the child's own state file.
aws s3api head-object --bucket "${BUCKET}" --key "${PARENT_KEY}" --region "${REGION}" >/dev/null
aws s3api head-object --bucket "${BUCKET}" --key "${CHILD_KEY}" --region "${REGION}" >/dev/null
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

# ---------------------------------------------------------------------------
# Phase C: negative control — with the blocker removed, the destroy is clean.
# ---------------------------------------------------------------------------
echo "=== Phase C: emptying the child bucket and re-destroying (clean path) ==="
aws s3api delete-object \
  --bucket "${CHILD_BUCKET}" --key "${PROBE_KEY}" --region "${REGION}" >/dev/null

node "${LOCAL_DIST}" destroy "${STACK}" \
  --region "${REGION}" --state-bucket "${BUCKET}" --force \
  > /tmp/cdkd-1777-destroy-ok.log 2>&1
strip_ansi < /tmp/cdkd-1777-destroy-ok.log > /tmp/cdkd-1777-destroy-ok.txt
cat /tmp/cdkd-1777-destroy-ok.txt

# The negative control this fixture has always carried: a CLEAN child still
# reports deleted. Without it, "never report a nested stack deleted" would pass
# every Phase B assertion while breaking every ordinary nested-stack destroy.
if ! grep -qE '✓ Child \(AWS::CloudFormation::Stack\) deleted' /tmp/cdkd-1777-destroy-ok.txt; then
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
rm -f /tmp/cdkd-1777-probe.txt /tmp/cdkd-1777-destroy-*.log /tmp/cdkd-1777-destroy-*.txt
echo "=== nested-stack (issue #1777) integ PASSED ==="

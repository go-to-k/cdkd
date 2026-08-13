#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt unknown-attribute ARN-shape guard (issue #1106)
# + --strict-getatt / deploy-summary fallback line (issue #1111).
# ERROR-PATH fixture, six phases (1-4 error-path, 5-6 the positive
# issue-1824 arms):
#   1. `Fn::GetAtt [Probe, BogusArn]` on AWS::SSM::Parameter reaches the
#      resolver's unknown-attribute fallback, where the physicalId (the
#      parameter NAME) is not ARN-shaped — the deploy must FAIL with the
#      actionable guard error instead of shipping the wrong value.
#   2. GUARD_PHASE=warn switches the bogus attribute to `BogusName` (a
#      non-Arn suffix that default mode warn-passes); with --strict-getatt
#      the deploy must FAIL on the promoted fallback error.
#   3. Same warn shape WITHOUT the flag: the deploy must SUCCEED, warn
#      "Unknown attribute BogusName", and print the one-line deploy-summary
#      fallback count pointing at --strict-getatt.
#   4. GUARD_PHASE=output-strict puts the ONLY bogus GetAtt in a stack
#      Output (resource properties all valid) and deploys a FRESH stack
#      with --strict-getatt: the deploy must FAIL after provisioning, the
#      state file must EXIST recording the created resources (the review
#      blocker: a strict output failure on a first deploy must not skip
#      state persistence — invisible orphans otherwise), and `cdkd
#      destroy` must clean them via that state.
#   5. GUARD_PHASE=arn-resolves (issue 1824) is the POSITIVE phase: the
#      Consumer's Value is `Fn::GetAtt [Probe, Arn]`, a REAL attribute the
#      SSM provider now caches, so the deploy must SUCCEED and the
#      consumer parameter's live value must equal the probe parameter's
#      live `Parameter.ARN` BYTE FOR BYTE. Run for a FLAT name and for a
#      HIERARCHICAL (leading-`/`) one, because the leading-slash fold into
#      the ARN's `parameter/` separator is exactly where a CONSTRUCTED ARN
#      goes wrong and every other phase uses a flat name only.
#      This phase is why the fixture is load-bearing for issue 1824 at all:
#      the ARN is CONSTRUCTED (PutParameter reports none), so a mocked unit
#      test asserts the same formula the provider used and would agree with
#      a wrong wire assumption. Only AWS's own answer settles it.
#   6. GUARD_PHASE=arn-resolves-update re-deploys the same shape with the
#      probes' VALUES changed, so each Probe takes the UPDATE path. An
#      update result's attributes REPLACE the state record's, so this
#      asserts `attributes.Arn` in the REAL persisted state.json is
#      unchanged across the update (and still equals the live ARN) — the
#      wipe that the update-side re-report exists to prevent. The rotation
#      (non-vacuity) check runs for BOTH probes: on the flat one alone, the
#      HIERARCHICAL before/after equality could pass with HierProbe never
#      taking the UPDATE path — and that arm is the one this phase exists
#      for.
# In phases 1-3 the bogus GetAtt is a RESOURCE property (a second
# parameter's Value), not an Output, because output-resolution failures are
# warn-and-continue in default mode and would not make the deploy exit
# non-zero.
# Asserts: per-phase exit codes + messages, then destroy / direct-cleanup
# fallback, zero leftover parameters, state gone.

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

STACK="CdkdGetattFallbackGuardExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM="${STACK}-param"
CONSUMER_PARAM="${STACK}-param-consumer"
# The hierarchical (leading-`/`) pair, present only in the two `arn-resolves`
# phases (issue 1824). Named here so `cleanup` sweeps them on every path,
# including a run that fails before phase 5 ever creates them.
HIER_PROBE_PARAM="/${STACK}/hier/probe"
HIER_CONSUMER_PARAM="/${STACK}/hier/consumer"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${CONSUMER_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${HIER_PROBE_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${HIER_CONSUMER_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

echo "==> Synth"
node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null

echo "==> Deploy (EXPECTED to fail on the Fn::GetAtt ARN-shape guard)"
DEPLOY_RC=0
DEPLOY_OUT="$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || DEPLOY_RC=$?
printf '%s\n' "${DEPLOY_OUT}"
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: deploy exited 0 — the Fn::GetAtt ARN-shape guard did not fire" >&2
  exit 1
fi
for needle in 'Cannot resolve Fn::GetAtt' 'is not an ARN' 'https://github.com/go-to-k/cdkd/issues'; do
  if ! printf '%s' "${DEPLOY_OUT}" | grep -qF "${needle}"; then
    echo "FAIL: deploy output lacks guard message fragment: ${needle}" >&2
    exit 1
  fi
done
echo "    OK: deploy failed (rc=${DEPLOY_RC}) with the actionable guard error"

echo "==> Destroy"
# Primary path: cdkd destroy against whatever state the failed deploy left
# (the Probe parameter is created before the Consumer's resolution fails;
# with default rollback the deploy may already have deleted it and possibly
# the state file too).
DESTROY_RC=0
DESTROY_OUT="$(node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1)" || DESTROY_RC=$?
printf '%s\n' "${DESTROY_OUT}"
if [ "${DESTROY_RC}" -ne 0 ] || printf '%s' "${DESTROY_OUT}" | grep -qi 'No state found'; then
  echo "    WARN: cdkd destroy had nothing to destroy (or failed); best-effort direct cleanup"
  aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${CONSUMER_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
fi

assert_gone "SSM parameter ${PARAM} still exists after destroy" aws ssm get-parameter --name "${PARAM}" --region "${REGION}"
echo "    OK: probe parameter gone"
assert_gone "SSM parameter ${CONSUMER_PARAM} exists (guard fired too late?)" aws ssm get-parameter --name "${CONSUMER_PARAM}" --region "${REGION}"
echo "    OK: consumer parameter gone (was never created)"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"

# --- Phase 2 (issue #1111): --strict-getatt promotes a warn-path fallback ----
# GUARD_PHASE=warn switches the bogus attribute to `BogusName`, whose
# physicalId fallback default mode accepts with a warning; --strict-getatt
# must reject it and fail the deploy.
echo "==> Deploy --strict-getatt on the warn-shape attribute (EXPECTED to fail)"
STRICT_RC=0
STRICT_OUT="$(GUARD_PHASE=warn node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --strict-getatt --yes 2>&1)" || STRICT_RC=$?
printf '%s\n' "${STRICT_OUT}"
if [ "${STRICT_RC}" -eq 0 ]; then
  echo "FAIL: deploy --strict-getatt exited 0 — the strict fallback promotion did not fire" >&2
  exit 1
fi
for needle in 'Cannot resolve Fn::GetAtt' 'BogusName' '--strict-getatt'; do
  if ! printf '%s' "${STRICT_OUT}" | grep -qF -- "${needle}"; then
    echo "FAIL: strict deploy output lacks message fragment: ${needle}" >&2
    exit 1
  fi
done
echo "    OK: strict deploy failed (rc=${STRICT_RC}) with the promoted fallback error"

# Normalize whatever the failed strict deploy left behind (rollback usually
# removes the Probe + state, but do not rely on it).
STRICT_DESTROY_RC=0
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >/dev/null 2>&1 || STRICT_DESTROY_RC=$?
if [ "${STRICT_DESTROY_RC}" -ne 0 ]; then
  aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${CONSUMER_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
fi

# --- Phase 3 (issue #1111): default mode warn-passes + summary line ----------
echo "==> Deploy default mode on the warn-shape attribute (EXPECTED to succeed)"
WARN_RC=0
WARN_OUT="$(GUARD_PHASE=warn node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || WARN_RC=$?
printf '%s\n' "${WARN_OUT}"
if [ "${WARN_RC}" -ne 0 ]; then
  echo "FAIL: default-mode deploy of the warn-shape attribute exited ${WARN_RC} (expected success)" >&2
  exit 1
fi
for needle in 'Unknown attribute BogusName' 'fell back to the physical ID' '--strict-getatt'; do
  if ! printf '%s' "${WARN_OUT}" | grep -qF -- "${needle}"; then
    echo "FAIL: default-mode deploy output lacks fragment: ${needle}" >&2
    exit 1
  fi
done
if ! printf '%s' "${WARN_OUT}" | grep -qE '[1-9][0-9]* attribute resolution\(s\) fell back to the physical ID'; then
  echo "FAIL: deploy-summary fallback line missing its non-zero count" >&2
  exit 1
fi
echo "    OK: default deploy succeeded with the warn + deploy-summary fallback line"

echo "==> Destroy (phase 3)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "SSM parameter ${PARAM} still exists after phase-3 destroy" aws ssm get-parameter --name "${PARAM}" --region "${REGION}"
assert_gone "SSM parameter ${CONSUMER_PARAM} still exists after phase-3 destroy" aws ssm get-parameter --name "${CONSUMER_PARAM}" --region "${REGION}"
assert_gone "state remains after phase-3 destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: phase-3 resources + state gone"

# --- Phase 4 (issue #1111 review blocker): strict Output failure must persist
# state. GUARD_PHASE=output-strict makes every resource property valid and
# puts the only bogus GetAtt in a stack Output; on a FRESH stack the
# incremental per-resource saves are no-ops (no prior ETag), so the
# post-provisioning persist is the ONLY thing standing between the created
# resources and zero state (invisible orphans; re-runs collide with
# "already exists").
echo "==> Deploy --strict-getatt with the bogus GetAtt ONLY in an Output (EXPECTED to fail, state persisted)"
OUTPUT_RC=0
OUTPUT_OUT="$(GUARD_PHASE=output-strict node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --strict-getatt --yes 2>&1)" || OUTPUT_RC=$?
printf '%s\n' "${OUTPUT_OUT}"
if [ "${OUTPUT_RC}" -eq 0 ]; then
  echo "FAIL: strict deploy with a bogus Output exited 0 — the output promotion did not fire" >&2
  exit 1
fi
for needle in 'Failed to resolve output BadOutput' '--strict-getatt'; do
  if ! printf '%s' "${OUTPUT_OUT}" | grep -qF -- "${needle}"; then
    echo "FAIL: output-strict deploy output lacks fragment: ${needle}" >&2
    exit 1
  fi
done
# State-persistence guarantee (fail-closed existence check, not a gone-probe:
# the state file must EXIST here). Without the persist-before-rethrow fix
# this head-object fails and the created parameters are invisible orphans.
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file missing after the strict output failure — created resources are invisible orphans" >&2
  exit 1
fi
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)" || { echo "FAIL: could not read the persisted state file for content assertions" >&2; exit 1; }
for needle in '"Probe"' '"Consumer"' "${PARAM}" "${CONSUMER_PARAM}"; do
  if ! printf '%s' "${STATE_JSON}" | grep -qF -- "${needle}"; then
    echo "FAIL: persisted state lacks ${needle} after the strict output failure" >&2
    exit 1
  fi
done
echo "    OK: strict output failure exited non-zero (rc=${OUTPUT_RC}) with state recording the created resources"

echo "==> Destroy (phase 4 — proves the persisted state cleans up the resources)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "SSM parameter ${PARAM} still exists after phase-4 destroy" aws ssm get-parameter --name "${PARAM}" --region "${REGION}"
assert_gone "SSM parameter ${CONSUMER_PARAM} still exists after phase-4 destroy" aws ssm get-parameter --name "${CONSUMER_PARAM}" --region "${REGION}"
assert_gone "state remains after phase-4 destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: phase-4 resources + state gone"

# --- Phase 5 (issue 1824): the POSITIVE arn-resolves phase -------------------
# `Fn::GetAtt [Probe, Arn]` names a REAL attribute the SSM provider now caches,
# so this deploy must SUCCEED. What it writes into the consumer parameter is the
# CACHED value — and for SSM that value is CONSTRUCTED (`PutParameter` reports no
# ARN), so construction and any unit assertion share one formula. Comparing it to
# what AWS itself reports is the only check that can catch a wrong formula, which
# is the whole reason this phase is here rather than only in the unit suite.
#
# Helpers first, so both the flat and the hierarchical pair use one comparison.
assert_arn_matches() { # usage: assert_arn_matches <label> <probe param> <consumer param>
  local label="$1" probe="$2" consumer="$3" probe_arn consumer_value
  # Strict captures (no `|| true` fallback): a throttle / auth failure must abort
  # the run, never read as an empty ARN that some later compare calls equal.
  #
  # Each capture is tested in an `if !` CONDITION rather than carrying a bare
  # `|| return 1`. The status has to be inspected to say anything about it: this
  # function is called as a plain statement, so a non-zero return aborts the whole
  # script through `set -e` with NO `FAIL:` line at all, leaving the reader unable
  # to tell a throttled / unauthorized probe from a real ARN mismatch. Every arm
  # below prints the values it compared for the same reason.
  if ! probe_arn="$(aws ssm get-parameter --name "${probe}" --region "${REGION}" --query 'Parameter.ARN' --output text)"; then
    echo "FAIL: ${label}: could not read Parameter.ARN for probe '${probe}' (get-parameter failed)" >&2
    exit 1
  fi
  if ! consumer_value="$(aws ssm get-parameter --name "${consumer}" --region "${REGION}" --query 'Parameter.Value' --output text)"; then
    echo "FAIL: ${label}: could not read Parameter.Value for consumer '${consumer}' (get-parameter failed; probe ARN was '${probe_arn}')" >&2
    exit 1
  fi
  case "${probe_arn}" in
    arn:*:ssm:*:parameter/*) ;;
    *)
      echo "FAIL: ${label}: GetParameter reported no usable ARN for ${probe}: '${probe_arn}'" >&2
      exit 1
      ;;
  esac
  # BYTE FOR BYTE — a case-folded region, a doubled `parameter//` separator or a
  # wrong partition all show up here and nowhere else.
  if [ "${consumer_value}" != "${probe_arn}" ]; then
    echo "FAIL: ${label}: consumer value '${consumer_value}' != live Parameter.ARN '${probe_arn}'" >&2
    echo "       (the CONSTRUCTED Arn attribute does not match the ARN AWS holds)" >&2
    exit 1
  fi
  echo "    OK: ${label}: consumer value == live Parameter.ARN (${probe_arn})"
}

state_arn_for() { # usage: state_arn_for <physicalId> -> that resource's attributes.Arn
  local physical="$1" state
  # `return 1` (not `exit 1`) is required here, unlike in `assert_arn_matches`
  # above: this one is a VALUE wrapper called as `V="$(state_arn_for ...)"`, and
  # errexit is CLEARED inside `$( )`, so the explicit non-zero return is what
  # propagates the failure to the caller's `set -e`. The stderr line is what keeps
  # that abort diagnosable.
  if ! state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"; then
    echo "FAIL: could not read the persisted state file to read attributes.Arn for '${physical}'" >&2
    return 1
  fi
  printf '%s' "${state}" | jq -r --arg pid "${physical}" \
    '[.resources | to_entries[] | select(.value.physicalId == $pid) | .value.attributes.Arn // ""] | first // ""'
}

echo "==> Deploy GUARD_PHASE=arn-resolves (EXPECTED to succeed — Fn::GetAtt Arn resolves)"
ARN_RC=0
ARN_OUT="$(GUARD_PHASE=arn-resolves node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || ARN_RC=$?
printf '%s\n' "${ARN_OUT}"
if [ "${ARN_RC}" -ne 0 ]; then
  echo "FAIL: arn-resolves deploy exited ${ARN_RC}; Fn::GetAtt [Probe, Arn] must resolve now" >&2
  exit 1
fi
if printf '%s' "${ARN_OUT}" | grep -qF 'is not an ARN'; then
  echo "FAIL: arn-resolves deploy hit the *Arn shape guard — the Arn attribute is not cached" >&2
  exit 1
fi
echo "    OK: arn-resolves deploy succeeded without reaching the shape guard"

assert_arn_matches "flat name" "${PARAM}" "${CONSUMER_PARAM}"
assert_arn_matches "hierarchical name" "${HIER_PROBE_PARAM}" "${HIER_CONSUMER_PARAM}"

# Baseline for phase 6, read out of the REAL persisted state record.
ARN_BEFORE="$(state_arn_for "${PARAM}")"
HIER_ARN_BEFORE="$(state_arn_for "${HIER_PROBE_PARAM}")"
if [ -z "${ARN_BEFORE}" ] || [ -z "${HIER_ARN_BEFORE}" ]; then
  echo "FAIL: state.json records no attributes.Arn after the arn-resolves deploy (flat='${ARN_BEFORE}' hier='${HIER_ARN_BEFORE}')" >&2
  exit 1
fi
echo "    OK: state.json records attributes.Arn for both probes"

# --- Phase 6 (issue 1824): the UPDATE path must not WIPE attributes.Arn ------
# An update result's `attributes` REPLACE the state record's rather than merging,
# so a provider returning only `{Type, Value}` deletes the create-time ARN. Both
# probes' VALUES change here, so each takes the UPDATE path; the consumers do not
# change (the ARN is the same), which is exactly the shape that made the wipe
# invisible before.
echo "==> Deploy GUARD_PHASE=arn-resolves-update (probe VALUES change -> UPDATE path)"
UPDATE_RC=0
UPDATE_OUT="$(GUARD_PHASE=arn-resolves-update node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || UPDATE_RC=$?
printf '%s\n' "${UPDATE_OUT}"
if [ "${UPDATE_RC}" -ne 0 ]; then
  echo "FAIL: arn-resolves-update deploy exited ${UPDATE_RC} (expected success)" >&2
  exit 1
fi

# The UPDATE really fired — otherwise "the ARN survived" passes vacuously. Asserted
# for BOTH probes, not just the flat one: the hierarchical pair is the arm this
# phase exists for (the leading-`/` fold is where a constructed ARN goes wrong),
# so checking rotation on `${PARAM}` alone would let the hierarchical
# before/after ARN equality pass with HierProbe never taking the UPDATE path at
# all — the exact vacuity this block is here to rule out.
assert_value_rotated() { # usage: assert_value_rotated <label> <param>
  local label="$1" param="$2" value
  # Same `if !` reasoning as `assert_arn_matches`: a bare tail would abort with no
  # FAIL line, so a failed probe would read as a fixture bug rather than as a
  # probe failure.
  if ! value="$(aws ssm get-parameter --name "${param}" --region "${REGION}" --query 'Parameter.Value' --output text)"; then
    echo "FAIL: ${label}: could not read Parameter.Value for '${param}' (get-parameter failed)" >&2
    exit 1
  fi
  if [ "${value}" != "guard-probe-updated" ]; then
    echo "FAIL: ${label}: probe parameter '${param}' value is '${value}', expected 'guard-probe-updated' — the UPDATE path never ran, so the wipe assertion below would be vacuous" >&2
    exit 1
  fi
  echo "    OK: ${label}: probe parameter value rotated (UPDATE path ran)"
}
assert_value_rotated "flat name" "${PARAM}"
assert_value_rotated "hierarchical name" "${HIER_PROBE_PARAM}"

ARN_AFTER="$(state_arn_for "${PARAM}")"
HIER_ARN_AFTER="$(state_arn_for "${HIER_PROBE_PARAM}")"
if [ -z "${ARN_AFTER}" ] || [ -z "${HIER_ARN_AFTER}" ]; then
  echo "FAIL: the update WIPED attributes.Arn from the state record (flat='${ARN_AFTER}' hier='${HIER_ARN_AFTER}')" >&2
  exit 1
fi
if [ "${ARN_AFTER}" != "${ARN_BEFORE}" ] || [ "${HIER_ARN_AFTER}" != "${HIER_ARN_BEFORE}" ]; then
  echo "FAIL: attributes.Arn changed across an in-place update (flat '${ARN_BEFORE}' -> '${ARN_AFTER}', hier '${HIER_ARN_BEFORE}' -> '${HIER_ARN_AFTER}')" >&2
  exit 1
fi
echo "    OK: attributes.Arn survived the update unchanged in the persisted state record"

# ...and it still equals what AWS holds, so the update re-reported the RIGHT ARN
# rather than merely keeping some string in place.
assert_arn_matches "flat name after update" "${PARAM}" "${CONSUMER_PARAM}"
assert_arn_matches "hierarchical name after update" "${HIER_PROBE_PARAM}" "${HIER_CONSUMER_PARAM}"

echo "==> Destroy (phases 5-6)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "SSM parameter ${PARAM} still exists after the arn-resolves destroy" aws ssm get-parameter --name "${PARAM}" --region "${REGION}"
assert_gone "SSM parameter ${CONSUMER_PARAM} still exists after the arn-resolves destroy" aws ssm get-parameter --name "${CONSUMER_PARAM}" --region "${REGION}"
assert_gone "SSM parameter ${HIER_PROBE_PARAM} still exists after the arn-resolves destroy" aws ssm get-parameter --name "${HIER_PROBE_PARAM}" --region "${REGION}"
assert_gone "SSM parameter ${HIER_CONSUMER_PARAM} still exists after the arn-resolves destroy" aws ssm get-parameter --name "${HIER_CONSUMER_PARAM}" --region "${REGION}"
assert_gone "state remains after the arn-resolves destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: phase 5-6 resources + state gone"

echo ""
echo "[verify] PASS — getatt-fallback-guard: ARN-shape hard-fail, --strict-getatt promotion, default-mode summary line, strict-output state persistence, and the issue-1824 positive Arn resolution (flat + hierarchical, create + update) all verified, cleanup clean"

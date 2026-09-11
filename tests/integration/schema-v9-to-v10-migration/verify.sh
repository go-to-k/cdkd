#!/usr/bin/env bash
# verify.sh — cdkd state schema v9 -> v10 migration round-trip integ test
# (issue #2944).
#
# Proves BOTH halves, because the `integ-schema-migration` gate only checks
# that a clean `schema-v9-to-v10-migration` run happened — nothing but this
# script stops it passing while the feature is dead.
#
# MIGRATION HALF (mirrors tests/integration/schema-v8-to-v9-migration):
#   a state file written by the last v9 binary (@go-to-k/cdkd@0.288.7) is read
#   by the local v10 binary with NO user action, reading alone does not rewrite
#   it, and the next WRITE persists `version: 10`. Every version assertion is
#   taken from the S3 JSON (`aws s3 cp ... | jq -r .version`), never from a log
#   line.
#
# FEATURE HALF (`ResourceState.observedBaselineRefused`, schema v10+):
#   `cdkd import` refuses an `observedProperties` baseline when it cannot vouch
#   that the recorded `properties` still SPELL the template's dynamic
#   reference. Before v10 that refusal left only `observedProperties:
#   undefined`, and the writers whose job is to FILL a missing baseline refilled
#   it against those untrustworthy properties — persisting the DECRYPTED secret.
#
# THE SHAPE, in one paragraph. `MarkedProbe`'s `Value` is an `Fn::If` on a
# condition `cdkd import` cannot evaluate (its parameter has no `Default`, and
# `cdkd import` accepts no parameter values), whose TRUE branch is a
# `{{resolve:secretsmanager:...}}` reference and whose FALSE branch is a
# placeholder literal. The live parameter is created OUT OF BAND holding the
# real secret plaintext — the "deployed branch" — so the recorded properties
# hold `dev-placeholder` while AWS holds the secret. `ControlProbe` is an
# ordinary literal parameter that is never refused; it sits beside every skip
# assertion so a green run is distinguishable from a run that did nothing.
#
# PHASES
#   0  create the secret + both parameters out of band; assert the PREMISE
#      (the live marked parameter really holds the plaintext).
#   1  import under the v9 binary -> `version: 9`, marked record REFUSED
#      (no baseline) and carrying NO `observedBaselineRefused` field, control
#      record carrying a baseline, no plaintext in state.
#   2  THE BUG, under the v9 binary: `cdkd state refresh-observed` refills the
#      refused baseline and the secret PLAINTEXT lands in state.json. If this
#      does not reproduce the run FAILS naming the pin — a fixture that cannot
#      show the bug cannot show the fix.
#   3  reset: orphan the poisoned record and sweep every S3 object VERSION of
#      it, so the plaintext leaves the bucket at the earliest possible point.
#   4  re-import under the v9 binary -> a CLEAN `version: 9` refused record,
#      which is the pre-v10 state the migration must handle.
#   5  the local v10 binary READS that record (`state show`) — no user action,
#      and reading alone must not rewrite it.
#   6  `cdkd import` under the LOCAL binary -> `version: 10` (the migration
#      write) AND `observedBaselineRefused: true` set by the REAL import, never
#      hand-planted; control gets a fresh baseline carrying the value AWS holds
#      RIGHT NOW, so the capture provably ran.
#   7  `cdkd state refresh-observed` under the local binary honours the marker:
#      marked untouched, control refreshed to the next out-of-band value.
#   8  `cdkd deploy` under the local binary exercises the DEPLOY-START
#      auto-refresh arm: the marked resource is NO_CHANGE (proved by the live
#      parameter still holding the plaintext afterwards — an update would have
#      written the placeholder to AWS) and stays unrefreshed, while the control
#      — whose baseline is removed first, the pre-v3-shaped record that arm
#      exists for — is refreshed in the same run.
#   9  the CLEAR: a deploy that genuinely UPDATES the marked resource must drop
#      the marker and land a real baseline.
#  10  destroy; both parameters, the secret and the state file are gone.
#  11  sweep every S3 object VERSION and assert zero survive.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# The cdkd `/run-integ` skill exports both before invoking verify.sh.

set -euo pipefail

cd "$(dirname "$0")"

# A pager on any `aws` call would block a non-interactive run forever.
export AWS_PAGER=""

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

# The state bucket is VERSIONED, and this fixture SEEDS A KNOWN SECRET
# PLAINTEXT into AWS and (deliberately, in Phase 2) into state.json. `aws s3 rm`
# would leave every prior version readable via `s3:GetObjectVersion`, so the
# version sweep is mandatory here rather than optional.
. ../s3-versions.sh

STACK="CdkdSchemaV9ToV10Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# Must match lib/schema-migration-stack.ts. A drift here is caught by the
# import itself (the physical id would not resolve), not silently tolerated.
MARKED_PARAM_NAME="/cdkd/schema-v9-to-v10-migration/marked"
CONTROL_PARAM_NAME="/cdkd/schema-v9-to-v10-migration/control"
SECRET_NAME="cdkd/schema-v9-to-v10-migration/secret"
CONTROL_TEMPLATE_VALUE="control-template-literal"
FALSE_BRANCH_LITERAL="dev-placeholder"
FALSE_BRANCH_LITERAL_UPDATED="dev-placeholder-updated"
MARKED_LOGICAL_ID="MarkedProbe"
CONTROL_LOGICAL_ID="ControlProbe"

# The control's LIVE value is moved away from the template literal before each
# refresh, and to a DIFFERENT value each time. That is what makes "the control
# was refreshed in this run" a real measurement rather than a tautology: the
# baseline can only carry these strings if the command actually read AWS during
# that phase. The template value never changes, so the deploy diff (template vs
# state `properties`) stays NO_CHANGE throughout.
CONTROL_LIVE_A="control-live-value-a"
CONTROL_LIVE_B="control-live-value-b"
CONTROL_LIVE_C="control-live-value-c"

# The LAST v9-shipped cdkd version on npm at the time this integ was written.
# It writes real `version: 9` state files AND already carries the issue #2828
# import-time refusal (commit 114d3db0 / PR #2842, an ancestor of the 0.288.7
# release commit 11641d2c) — so it produces a REFUSED record with NO
# `observedBaselineRefused` field, which is exactly the pre-v10 shape the
# migration must handle. Phase 1 asserts both halves of that, so a wrong pin
# fails loudly instead of quietly testing something else.
V9_CDKD_VERSION="0.288.7"
V9_TMPDIR=""
STATE_FILE=""
STATE_EDIT_FILE=""

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# THE NEEDLE, generated PER RUN. Unique and high-entropy on purpose: a fixed
# needle could collide with a leftover from an earlier run (making the leak
# check fire on a clean run) and gives no evidence that THIS run's readback is
# what reached state. Generated rather than read back out of AWS, so a failed
# read can never look like a passing leak check — this script is the authority
# on the value and PUTS it into AWS in Phase 0.
if ! command -v openssl >/dev/null 2>&1; then
  echo "FAIL: openssl is required to generate this fixture's unique secret plaintext" >&2
  exit 1
fi
SECRET_PLAINTEXT="cdkd-2944-needle-$(openssl rand -hex 16)"

# Bumped by every substantive assertion; floored at the end. A literal floor,
# maintained by hand: a derived total would move with the pool, so a deleted
# assertion block would lower the bar instead of reddening the run.
ASSERTIONS_RUN=0

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"

  # SCOPE GUARD. `STATE_PREFIX` below is derived from `${STACK}`, and this
  # function runs under `set +eu` on every exit path — so an unset or reassigned
  # STACK must not be allowed to widen anything. The accepting arm comes FIRST
  # (bash takes the first match) and the catch-all RETURNS after re-arming, so
  # nothing can fall through into the teardown.
  case "${STACK}" in
    CdkdSchemaV9ToV10?*) ;;
    *)
      echo "WARN: teardown sweep refused -- STACK='${STACK}' is outside this fixture's scope" >&2
      # RE-ARM before returning: this `return` skips the function tail where the
      # re-arm lives, so without it the guard-rejection path would leave the
      # CALLER running with `set +eu`.
      set -eu
      return
      ;;
  esac

  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi

  # Direct API fallback. Every AWS object this fixture creates has a FIXED,
  # fully-known name, so deleting them by name is complete — there is
  # deliberately no list-under-a-prefix sweep here, because a prefix sweep that
  # buys nothing is a destructive operation with a widening failure mode.
  for param in "${MARKED_PARAM_NAME}" "${CONTROL_PARAM_NAME}"; do
    aws ssm delete-parameter --name "${param}" --region "${REGION}" >/dev/null 2>&1
  done
  # FORCE-DELETE, never a recovery window: this secret's plaintext is the
  # fixture's needle, and a 30-day recoverable secret is exactly the disclosure
  # that outlives the run.
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1

  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/state.json" >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1

  # NONCURRENT only from here. `cleanup` runs from the failure traps too, where
  # a live state.json may be the only record of standing AWS resources; the
  # full `all` sweep belongs on the success path (Phase 11) and at Phase 3,
  # where the record has just been deliberately dropped.
  s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true

  if [ -n "${V9_TMPDIR}" ] && [ -d "${V9_TMPDIR}" ]; then
    rm -rf "${V9_TMPDIR}"
  fi
  rm -f "${STATE_FILE:-}" "${STATE_EDIT_FILE:-}"

  # RE-ARM, and it must be the LAST line of this function rather than something
  # the call site does. The pre-run `cleanup || true` executes in the CURRENT
  # shell, so without this every line after it would run with errexit and
  # nounset OFF and an assertion that exits non-zero without an explicit `exit`
  # would simply be stepped over.
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
  echo "FAIL: local v10 binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup (drop any stranded state / AWS objects from a prior failed integ)"
cleanup || true

# AFTER the pre-run cleanup, which `rm -f`s both paths: created above, they
# would be deleted before their first use and the shape would read as working
# only because `aws s3 cp` recreates one of them.
STATE_FILE="$(mktemp)"
STATE_EDIT_FILE="$(mktemp)"

# --- assertion helpers ------------------------------------------------------
# Every one of these reads the state file fetched by `fetch_state`, so a phase
# asserts against the bytes S3 holds rather than against anything a log said.
#
# NOTHING BELOW PRINTS THE NEEDLE. Phase 2 deliberately puts the secret
# plaintext into state.json, so a diagnostic that dumps the record — the obvious
# thing to reach for on a failed assertion — would publish the secret to the CI
# log of a run whose entire subject is keeping it out of one. So the failure
# paths print a key-only summary, a needle-masked record, or the PATHS at which
# the needle was found, and never the document.

mask_needle() { # usage: mask_needle <text>
  printf '%s' "${1//${SECRET_PLAINTEXT}/<SECRET-PLAINTEXT-REDACTED>}"
}

state_summary() { # keys and version only — structurally incapable of carrying a value
  jq '{version, stackName, region, resources: (.resources | keys)}' "${STATE_FILE}"
}

redacted_row() { # usage: redacted_row <logicalId>
  jq --arg lid "$1" --arg needle "${SECRET_PLAINTEXT}" \
    '.resources[$lid] | walk(if type == "string" then gsub($needle; "<SECRET-PLAINTEXT-REDACTED>") else . end)' \
    "${STATE_FILE}"
}

needle_paths() { # the dotted paths whose scalar contains the needle — paths only, never values
  jq -r --arg needle "${SECRET_PLAINTEXT}" \
    '[paths(scalars) as $p | select(getpath($p) | tostring | contains($needle)) | ($p | map(tostring) | join("."))] | .[]' \
    "${STATE_FILE}"
}

fetch_state() { # usage: fetch_state <label>
  # STRICT: no `2>/dev/null`, no `|| true`. A throttled or unauthorized read
  # aborts under `set -e` instead of reading as "the field is absent".
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_FILE}" >/dev/null
  if [ ! -s "${STATE_FILE}" ]; then
    echo "FAIL: $1: s3://${STATE_BUCKET}/${STATE_KEY} is empty" >&2
    exit 1
  fi
}

assert_version() { # usage: assert_version <label> <expected>
  local v
  v="$(jq -r '.version' "${STATE_FILE}")"
  if [ "${v}" != "$2" ]; then
    echo "FAIL: $1: state.version is ${v}, expected $2" >&2
    state_summary >&2
    exit 1
  fi
  echo "    OK: $1: state.version == $2"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}

assert_resource_present() { # usage: assert_resource_present <label> <logicalId>
  local t
  t="$(jq -r --arg lid "$2" '.resources[$lid].resourceType // "absent"' "${STATE_FILE}")"
  if [ "${t}" != "AWS::SSM::Parameter" ]; then
    echo "FAIL: $1: resource '$2' is not in state as an SSM parameter (resourceType=${t})" >&2
    state_summary >&2
    exit 1
  fi
  echo "    OK: $1: resource '$2' is in state"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}

assert_marker() { # usage: assert_marker <label> <logicalId> <true|absent>
  local m
  m="$(jq -r --arg lid "$2" '.resources[$lid].observedBaselineRefused // "absent"' "${STATE_FILE}")"
  if [ "${m}" != "$3" ]; then
    echo "FAIL: $1: ${2}.observedBaselineRefused is '${m}', expected '$3'" >&2
    redacted_row "$2" >&2
    exit 1
  fi
  echo "    OK: $1: ${2}.observedBaselineRefused == $3"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}

assert_observed_present() { # usage: assert_observed_present <label> <logicalId> <true|false>
  local h
  h="$(jq -r --arg lid "$2" '.resources[$lid] | has("observedProperties")' "${STATE_FILE}")"
  if [ "${h}" != "$3" ]; then
    echo "FAIL: $1: ${2} has(observedProperties) is '${h}', expected '$3'" >&2
    redacted_row "$2" >&2
    exit 1
  fi
  echo "    OK: $1: ${2} has(observedProperties) == $3"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}

assert_observed_value() { # usage: assert_observed_value <label> <logicalId> <expected>
  local v
  v="$(jq -r --arg lid "$2" '.resources[$lid].observedProperties.Value // "absent"' "${STATE_FILE}")"
  if [ "${v}" != "$3" ]; then
    # Masked on BOTH sides: Phase 2 asserts this value IS the needle, so the
    # expected side carries it, and a later phase's actual side can too.
    echo "FAIL: $1: ${2}.observedProperties.Value is '$(mask_needle "${v}")', expected '$(mask_needle "$3")'" >&2
    redacted_row "$2" >&2
    exit 1
  fi
  echo "    OK: $1: ${2}.observedProperties.Value == $3"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}

assert_properties_value() { # usage: assert_properties_value <label> <logicalId> <expected>
  local v
  v="$(jq -r --arg lid "$2" '.resources[$lid].properties.Value // "absent"' "${STATE_FILE}")"
  if [ "${v}" != "$3" ]; then
    echo "FAIL: $1: ${2}.properties.Value is '$(mask_needle "${v}")', expected '$(mask_needle "$3")'" >&2
    redacted_row "$2" >&2
    exit 1
  fi
  echo "    OK: $1: ${2}.properties.Value == $3"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}

assert_no_plaintext() { # usage: assert_no_plaintext <label>
  if grep -qF -- "${SECRET_PLAINTEXT}" "${STATE_FILE}"; then
    echo "FAIL: $1: the secret PLAINTEXT is present in state.json (GHSA-p5qg-v9gv-hc7w direction)" >&2
    echo "      leaking path(s) — the VALUES are deliberately not printed:" >&2
    needle_paths >&2
    exit 1
  fi
  echo "    OK: $1: no secret plaintext anywhere in state.json"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}

assert_has_plaintext() { # usage: assert_has_plaintext <label> <why-this-is-the-bug>
  if ! grep -qF -- "${SECRET_PLAINTEXT}" "${STATE_FILE}"; then
    echo "FAIL: $1: the secret plaintext did NOT reach state.json, so the bug this" >&2
    echo "      fixture reproduces is not reproducible under the pinned binary" >&2
    echo "      @go-to-k/cdkd@${V9_CDKD_VERSION}. $2" >&2
    echo "      A fixture that cannot show the bug cannot show the fix — check V9_CDKD_VERSION." >&2
    state_summary >&2
    exit 1
  fi
  echo "    OK (bug reproduced): $1: the secret plaintext IS in the v9 state.json"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}

assert_param_value() { # usage: assert_param_value <label> <param-name> <expected>
  local v
  # The read's own status is BRANCHED ON, not swallowed: errexit is cleared
  # inside `$( )`, so a throttled or unauthorized read would otherwise leave `v`
  # empty and be reported as a wrong VALUE rather than as a failed probe.
  if ! v="$(aws ssm get-parameter --name "$2" --region "${REGION}" \
    --query 'Parameter.Value' --output text)"; then
    echo "FAIL: $1: could not read live parameter '$2'" >&2
    exit 1
  fi
  if [ "${v}" != "$3" ]; then
    # Both sides masked: the EXPECTED value is the needle in two of the four
    # call sites, so an unmasked message would print the secret on failure.
    echo "FAIL: $1: live parameter '$2' holds '$(mask_needle "${v}")', expected '$(mask_needle "$3")'" >&2
    exit 1
  fi
  echo "    OK: $1: live parameter '$2' holds the expected value"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}

put_control_value() { # usage: put_control_value <value>
  aws ssm put-parameter --name "${CONTROL_PARAM_NAME}" --type String \
    --value "$1" --overwrite --region "${REGION}" >/dev/null
}

# ---------------------------------------------------------------------------
echo "==> Phase 0: create the secret + both parameters OUT OF BAND"
# ---------------------------------------------------------------------------
# `cdkd import` ADOPTS rather than creates, so the resources must already exist
# — and the marked one must already hold the value the DEPLOYED (true) branch
# would have produced, which is the whole premise of the leak.
#
# WAIT FOR THE PRE-RUN DELETE TO SETTLE FIRST. `DeleteSecret` is ASYNCHRONOUS
# even with `--force-delete-without-recovery`, so back-to-back runs would race:
# `CreateSecret` on a name still being deleted fails with "already scheduled for
# deletion", and a blind retry loop around it would swallow every other cause.
# `gone_probe` is the canonical helper — it hard-FAILs an undetermined probe
# rather than reading a throttle as "gone".
SECRET_READY=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws secretsmanager describe-secret \
       --secret-id "${SECRET_NAME}" --region "${REGION}"; then
    SECRET_READY=1
    break
  fi
  sleep 5
done
if [ "${SECRET_READY}" -ne 1 ]; then
  echo "FAIL: secret ${SECRET_NAME} still exists 60s into the run — a previous run's" >&2
  echo "      teardown did not settle, and creating it now would fail on a name that" >&2
  echo "      is still being deleted." >&2
  exit 1
fi

aws secretsmanager create-secret --name "${SECRET_NAME}" \
  --description "cdkd schema v9->v10 migration integ fixture (issue #2944)" \
  --secret-string "${SECRET_PLAINTEXT}" --region "${REGION}" >/dev/null

aws ssm put-parameter --name "${MARKED_PARAM_NAME}" --type String \
  --value "${SECRET_PLAINTEXT}" --overwrite --region "${REGION}" >/dev/null

put_control_value "${CONTROL_TEMPLATE_VALUE}"

# THE PREMISE. Without this the fixture is vacuous in the most dangerous
# direction: if the live parameter did not hold the plaintext, every "no
# plaintext in state" assertion below would pass while nothing was ever at risk.
assert_param_value "premise" "${MARKED_PARAM_NAME}" "${SECRET_PLAINTEXT}"

# ---------------------------------------------------------------------------
echo "==> Phase 1: import under the v9 binary (@go-to-k/cdkd@${V9_CDKD_VERSION})"
# ---------------------------------------------------------------------------
V9_TMPDIR=$(mktemp -d)
echo "    installing @go-to-k/cdkd@${V9_CDKD_VERSION} into ${V9_TMPDIR}"
( cd "${V9_TMPDIR}" && npm init -y >/dev/null && npm install --no-audit --no-fund "@go-to-k/cdkd@${V9_CDKD_VERSION}" >/dev/null )
V9_BIN="${V9_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
if [ ! -f "${V9_BIN}" ]; then
  echo "FAIL: v9 binary not found at ${V9_BIN} after install" >&2
  exit 1
fi

# `cdkd import` is the one command that does NOT declare `--region` (issue
# #1097), so the region rides on AWS_REGION — the convention every import
# fixture in this tree uses.
CDKD_TEST_SCHEMA_PHASE=import AWS_REGION="${REGION}" node "${V9_BIN}" import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes

fetch_state "v9 import"
assert_version "v9 import" 9
assert_resource_present "v9 import" "${MARKED_LOGICAL_ID}"
assert_resource_present "v9 import" "${CONTROL_LOGICAL_ID}"

# THE REFUSAL ITSELF, under v9: the marked record has NO baseline...
assert_observed_present "v9 import" "${MARKED_LOGICAL_ID}" false
# ...and the persisted properties hold the DOWNGRADED false-branch literal,
# which is what makes the refill in Phase 2 a disclosure rather than a no-op.
assert_properties_value "v9 import" "${MARKED_LOGICAL_ID}" "${FALSE_BRANCH_LITERAL}"
# THE PIN CHECK. A v9 binary cannot know about `observedBaselineRefused`; if it
# wrote one, V9_CDKD_VERSION is actually a v10+ release and the migration this
# fixture claims to exercise never happens.
assert_marker "v9 import (pin check)" "${MARKED_LOGICAL_ID}" absent
# The control is NOT refused even under v9 — its baseline is there.
assert_observed_present "v9 import" "${CONTROL_LOGICAL_ID}" true
assert_observed_value "v9 import" "${CONTROL_LOGICAL_ID}" "${CONTROL_TEMPLATE_VALUE}"
# The import's own refusal already works at v9 (issue #2828), so nothing has
# leaked yet. This is the baseline the next phase moves away from.
assert_no_plaintext "v9 import"

# ---------------------------------------------------------------------------
echo "==> Phase 2: THE BUG — 'state refresh-observed' under the v9 binary refills the refused baseline"
# ---------------------------------------------------------------------------
# `cdkd state refresh-observed` selects EVERY resource and positions the AWS
# readback against this record's `properties`. After the refusal those hold
# `dev-placeholder`, and a literal source leaf against a string readback PAIRS
# as an ordinary drifted literal — so the redaction walk has nothing to refuse
# on and the decrypted value is persisted. That is issue #2944.
AWS_REGION="${REGION}" node "${V9_BIN}" state refresh-observed "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --yes

fetch_state "v9 refresh-observed"
assert_version "v9 refresh-observed" 9
assert_has_plaintext "v9 refresh-observed" \
  "Expected the refused baseline to be refilled with the live parameter's value."
# Named position, not just "somewhere in the file": the leak is the refused
# resource's own baseline.
assert_observed_value "v9 refresh-observed (leak position)" "${MARKED_LOGICAL_ID}" "${SECRET_PLAINTEXT}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: reset — drop the poisoned record and sweep its object VERSIONS"
# ---------------------------------------------------------------------------
# The remaining phases need a CLEAN v9 record, and the plaintext must leave the
# bucket at the earliest possible moment rather than waiting for the success
# path. `all` (not `noncurrent`) is correct HERE for the same reason it is on
# the success path: the record has just been deliberately dropped, and every AWS
# object this fixture owns has a fixed name `cleanup` deletes directly — so
# losing the state record cannot orphan anything.
node "${LOCAL_DIST}" state orphan "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --force

s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "schema-v9-to-v10-migration poisoned-v9-record reset"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# ---------------------------------------------------------------------------
echo "==> Phase 4: re-import under the v9 binary — the CLEAN pre-v10 record"
# ---------------------------------------------------------------------------
CDKD_TEST_SCHEMA_PHASE=import AWS_REGION="${REGION}" node "${V9_BIN}" import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes

fetch_state "v9 re-import"
assert_version "v9 re-import" 9
assert_observed_present "v9 re-import" "${MARKED_LOGICAL_ID}" false
assert_marker "v9 re-import (pin check)" "${MARKED_LOGICAL_ID}" absent
assert_no_plaintext "v9 re-import"

# ---------------------------------------------------------------------------
echo "==> Phase 5: the local v10 binary READS the v9 record (no user action, no rewrite)"
# ---------------------------------------------------------------------------
node "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" >/dev/null
echo "    OK: v10 binary read the v9 state cleanly"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

fetch_state "v10 read-only state show"
assert_version "v10 read-only state show" 9

# ---------------------------------------------------------------------------
echo "==> Phase 6: import under the LOCAL binary — version 10 AND the marker, set by the REAL import"
# ---------------------------------------------------------------------------
# The marker is NEVER hand-planted. A planted blob would leave the setter
# untested and both skips below dead; this is the actual refusal firing inside
# `resolveImportedProperties` / `captureObservedForImportedResources`.
#
# The control's LIVE value is moved off the template literal first, so its fresh
# baseline can only carry CONTROL_LIVE_A if this import really read AWS.
put_control_value "${CONTROL_LIVE_A}"

CDKD_TEST_SCHEMA_PHASE=import AWS_REGION="${REGION}" node "${LOCAL_DIST}" import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --force --yes

fetch_state "v10 import"
# THE MIGRATION WRITE: a v9 record, upgraded with no user action.
assert_version "v10 import" 10
assert_resource_present "v10 import" "${MARKED_LOGICAL_ID}"
assert_resource_present "v10 import" "${CONTROL_LOGICAL_ID}"
# THE FEATURE: the refusal is now RECORDED, and still no baseline.
assert_marker "v10 import" "${MARKED_LOGICAL_ID}" true
assert_observed_present "v10 import" "${MARKED_LOGICAL_ID}" false
assert_properties_value "v10 import" "${MARKED_LOGICAL_ID}" "${FALSE_BRANCH_LITERAL}"
# THE CONTROL, in the same run: unmarked, and its baseline carries what AWS
# holds RIGHT NOW — so the capture provably ran rather than being skipped too.
assert_marker "v10 import (control)" "${CONTROL_LOGICAL_ID}" absent
assert_observed_present "v10 import (control)" "${CONTROL_LOGICAL_ID}" true
assert_observed_value "v10 import (control)" "${CONTROL_LOGICAL_ID}" "${CONTROL_LIVE_A}"
assert_no_plaintext "v10 import"

# ---------------------------------------------------------------------------
echo "==> Phase 7: 'state refresh-observed' under the local binary honours the marker"
# ---------------------------------------------------------------------------
put_control_value "${CONTROL_LIVE_B}"

AWS_REGION="${REGION}" node "${LOCAL_DIST}" state refresh-observed "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --yes

fetch_state "v10 refresh-observed"
assert_version "v10 refresh-observed" 10
# The marked resource: still marked, still no baseline — the refill that
# Phase 2 performed under v9 does NOT happen here.
assert_marker "v10 refresh-observed" "${MARKED_LOGICAL_ID}" true
assert_observed_present "v10 refresh-observed" "${MARKED_LOGICAL_ID}" false
# THE CONTROL, in the SAME run: refreshed to the value AWS holds now. Without
# this the assertions above would pass equally if the command had failed
# outright, refused every resource, or never reached AWS.
assert_observed_value "v10 refresh-observed (control)" "${CONTROL_LOGICAL_ID}" "${CONTROL_LIVE_B}"
assert_no_plaintext "v10 refresh-observed"

# ---------------------------------------------------------------------------
echo "==> Phase 8: the DEPLOY-START auto-refresh arm"
# ---------------------------------------------------------------------------
# `DeployEngine.kickOffAutoRefreshObservedProperties` selects exactly the
# records with `observedProperties === undefined`. The marked record is in that
# population and must be SKIPPED on the marker; the control is not in it at all
# right now, because Phase 7 gave it a baseline.
#
# So the control's baseline is removed first, reconstructing the pre-v3-shaped
# record ("no baseline, not refused") that this arm exists to fill. That edit
# constructs the CONTROL CONDITION — it never touches the subject, and the guard
# below proves the marked row came through byte-identical, so nothing about the
# marker is planted or altered by it.
jq --arg lid "${CONTROL_LOGICAL_ID}" 'del(.resources[$lid].observedProperties)' \
  "${STATE_FILE}" > "${STATE_EDIT_FILE}"

MARKED_ROW_BEFORE="$(jq -c --arg lid "${MARKED_LOGICAL_ID}" '.resources[$lid]' "${STATE_FILE}")"
MARKED_ROW_AFTER="$(jq -c --arg lid "${MARKED_LOGICAL_ID}" '.resources[$lid]' "${STATE_EDIT_FILE}")"
if [ "${MARKED_ROW_BEFORE}" != "${MARKED_ROW_AFTER}" ]; then
  echo "FAIL: the control-condition edit changed the MARKED row — it must touch only the control" >&2
  echo "      before: ${MARKED_ROW_BEFORE}" >&2
  echo "      after : ${MARKED_ROW_AFTER}" >&2
  exit 1
fi
if [ "$(jq -r --arg lid "${CONTROL_LOGICAL_ID}" '.resources[$lid] | has("observedProperties")' "${STATE_EDIT_FILE}")" != "false" ]; then
  echo "FAIL: the control-condition edit did not remove the control's baseline, so the" >&2
  echo "      auto-refresh arm below would have no candidate and its control would be vacuous" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
aws s3 cp "${STATE_EDIT_FILE}" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null

put_control_value "${CONTROL_LIVE_C}"

# `deploy` phase: `SecretsEnabled` gains `Default: 'false'`, so the condition
# resolves to the SAME verdict the import downgraded to and every resolved
# property is byte-identical to what state holds — a NO_CHANGE deploy, which is
# the precondition for this arm (an UPDATE would legitimately overwrite the
# baseline and the skip would never be exercised).
CDKD_TEST_SCHEMA_PHASE=deploy node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# THE NO_CHANGE PROOF, taken from AWS rather than from a log line: had cdkd
# updated the marked parameter, AWS would now hold the placeholder literal
# instead of the secret the out-of-band seed put there.
assert_param_value "phase 8 no-change proof" "${MARKED_PARAM_NAME}" "${SECRET_PLAINTEXT}"

fetch_state "v10 deploy (auto-refresh)"
assert_version "v10 deploy (auto-refresh)" 10
# The marked record: the auto-refresh saw `observedProperties === undefined` and
# declined on the marker.
assert_marker "v10 deploy (auto-refresh)" "${MARKED_LOGICAL_ID}" true
assert_observed_present "v10 deploy (auto-refresh)" "${MARKED_LOGICAL_ID}" false
# THE CONTROL, in the SAME run: same population, no marker, refreshed to the
# value AWS holds now — so the arm demonstrably ran.
assert_observed_value "v10 deploy (auto-refresh control)" "${CONTROL_LOGICAL_ID}" "${CONTROL_LIVE_C}"
assert_no_plaintext "v10 deploy (auto-refresh)"

# ---------------------------------------------------------------------------
echo "==> Phase 9: the CLEAR — a deploy that genuinely UPDATES the marked resource"
# ---------------------------------------------------------------------------
# The marker is a refusal RECORD, not a permanent brand: a deploy that CREATEs
# or UPDATEs the resource holds the template evidence the import lacked, rebuilds
# the record (dropping the field) and captures a real baseline.
CDKD_TEST_SCHEMA_PHASE=deploy-update node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# The update really reached AWS (and, incidentally, took the plaintext off the
# parameter — the template is the desired state).
assert_param_value "v10 deploy (update)" "${MARKED_PARAM_NAME}" "${FALSE_BRANCH_LITERAL_UPDATED}"

fetch_state "v10 deploy (update)"
assert_version "v10 deploy (update)" 10
assert_marker "v10 deploy (update)" "${MARKED_LOGICAL_ID}" absent
assert_observed_present "v10 deploy (update)" "${MARKED_LOGICAL_ID}" true
assert_observed_value "v10 deploy (update)" "${MARKED_LOGICAL_ID}" "${FALSE_BRANCH_LITERAL_UPDATED}"
assert_properties_value "v10 deploy (update)" "${MARKED_LOGICAL_ID}" "${FALSE_BRANCH_LITERAL_UPDATED}"
assert_no_plaintext "v10 deploy (update)"

# ---------------------------------------------------------------------------
echo "==> Phase 10: destroy"
# ---------------------------------------------------------------------------
CDKD_TEST_SCHEMA_PHASE=deploy-update node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "marked parameter still exists after destroy" \
  aws ssm get-parameter --name "${MARKED_PARAM_NAME}" --region "${REGION}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
assert_gone "control parameter still exists after destroy" \
  aws ssm get-parameter --name "${CONTROL_PARAM_NAME}" --region "${REGION}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# The SECRET is not cdkd-managed (this fixture created it out of band), so
# destroy cannot have removed it. Force-delete it here rather than leaving the
# needle restorable for 30 days, and POLL — `DeleteSecret` is asynchronous, so a
# single gone-probe FALSE-FAILS.
aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
  --force-delete-without-recovery --region "${REGION}" >/dev/null
SECRET_GONE=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws secretsmanager describe-secret \
       --secret-id "${SECRET_NAME}" --region "${REGION}"; then
    SECRET_GONE=1
    break
  fi
  sleep 5
done
if [ "${SECRET_GONE}" -ne 1 ]; then
  echo "FAIL: secret ${SECRET_NAME} still exists 60s after the force-delete" >&2
  exit 1
fi
echo "    OK: the seeded secret is force-deleted (no recovery window)"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# ---------------------------------------------------------------------------
echo "==> Phase 11: sweep every object VERSION and assert zero survive"
# ---------------------------------------------------------------------------
# The canonical shape: run cleanup on the SUCCESS path, THEN disarm, THEN the
# full sweep and the assertion. Order is load-bearing — a sweep living only in
# the trap runs on the FAILURE path and never on the normal one.
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "schema-v9-to-v10-migration state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# THE EXECUTED-ASSERTION FLOOR. A literal, maintained by hand: a derived total
# would move with the pool, so a deleted assertion block would lower the bar
# instead of reddening the run.
if [ "${ASSERTIONS_RUN:-0}" -lt 54 ]; then
  echo "FAIL: only ${ASSERTIONS_RUN:-0} of 54 assertions executed — a block was skipped," >&2
  echo "      so this run proves less than it claims." >&2
  exit 1
fi

echo ""
echo "==> schema-v9-to-v10-migration test passed (v9 refill reproduced, v9 -> v10 transparent auto-migration, observedBaselineRefused set by import / honoured by refresh-observed + deploy auto-refresh / cleared by a real UPDATE); ${ASSERTIONS_RUN} assertions executed"

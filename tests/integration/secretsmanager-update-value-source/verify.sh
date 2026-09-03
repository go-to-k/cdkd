#!/usr/bin/env bash
# verify.sh — AWS::SecretsManager::Secret in-place UPDATE value-source integ
# (issue #2472).
#
# `SecretsManagerSecretProvider.update()` used to re-run its local generator
# on EVERY in-place update of a `GenerateSecretString` secret and re-send an
# unchanged literal `SecretString`, so a Tags-only deploy minted a fresh
# password and staged it AWSCURRENT (a database seeded from the old value
# then rejected every consumer reading the new one). The fix sends a value
# only when its SOURCE changed. Nothing but a real UpdateSecret proves which
# version AWS ends up serving, so this fixture reads the version ledger back.
#
# Phases:
#   1. Deploy (no env): two secrets, one per value source. Record each one's
#      AWSCURRENT VersionId and assert exactly one version exists.
#   2. UPDATE (CDKD_TEST_UPDATE=true): a tag is added to both secrets and
#      nothing else. Assert the tag reached AWS, AWSCURRENT is the SAME
#      VersionId on both, and each still has exactly one version — pre-fix
#      both got a second version and AWSCURRENT moved.
#   3. UPDATE (CDKD_TEST_UPDATE=regen), the positive control: the
#      `GenerateSecretString` block changes (PasswordLength 32 -> 40) and the
#      literal changes. Assert BOTH values moved — a new AWSCURRENT, the old
#      one now AWSPREVIOUS, two versions each — so Phase 2 cannot pass on a
#      provider that simply never sends a value.
#   4. Destroy; assert both secrets are gone (or scheduled for deletion), the
#      state file is removed, and the state bucket's object versions are
#      swept (the literal marker lands in state.json verbatim).
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

cd "$(dirname "$0")"

# The literal secret's marker string is persisted into state.json verbatim, and
# the state bucket is versioned, so teardown must sweep object VERSIONS (issue
# #2096) — `aws s3 rm` alone leaves every version readable.
. ../s3-versions.sh

STACK="CdkdSecretsmanagerUpdateValueSourceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
GENERATED_NAME="${STACK}-generated"
LITERAL_NAME="${STACK}-literal"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # A stale lock from a killed previous run would make `state destroy` refuse
  # (the record is then KEPT, below), so drop it first.
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Best-effort delete by fixed name in case state destroy missed them.
  for name in "${GENERATED_NAME}" "${LITERAL_NAME}"; do
    aws secretsmanager delete-secret --secret-id "${name}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    # The state record is removed ONLY after `state destroy` succeeded: on a
    # failed destroy it is still the record of resources that may be standing,
    # and the noncurrent purge below would otherwise reap it the moment the
    # `rm` turned it into a noncurrent version.
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    # `noncurrent` here: cleanup runs on the FAILURE path too, where the
    # current state.json is kept (above). The success path below purges `all`
    # after destroy has been asserted.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" noncurrent || true
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
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required (version-ledger assertions parse JSON)" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- version-ledger probes -------------------------------------------------
# `list-secret-version-ids --include-deprecated` returns every version AWS
# still holds with its staging labels; no secret VALUE is read anywhere in
# this fixture. The JSON goes through jq rather than `--query length(...)`
# under `--output text` (see s3-versions.sh for why that count is unreliable).
versions_json() { # usage: versions_json <secret-name>
  aws secretsmanager list-secret-version-ids --secret-id "$1" --include-deprecated \
    --region "${REGION}" --output json || return 1
}
current_version_id() { # usage: current_version_id <secret-name>
  local out
  out="$(versions_json "$1")" || return 1
  printf '%s' "${out}" | jq -r '[.Versions[] | select(.VersionStages | index("AWSCURRENT")) | .VersionId] | first // ""'
}
previous_version_id() { # usage: previous_version_id <secret-name>
  local out
  out="$(versions_json "$1")" || return 1
  printf '%s' "${out}" | jq -r '[.Versions[] | select(.VersionStages | index("AWSPREVIOUS")) | .VersionId] | first // ""'
}
version_count() { # usage: version_count <secret-name>
  local out
  out="$(versions_json "$1")" || return 1
  printf '%s' "${out}" | jq -r '.Versions | length'
}
probe_tag_value() { # usage: probe_tag_value <secret-name> -> value of cdkd-update-probe or ""
  aws secretsmanager describe-secret --secret-id "$1" --region "${REGION}" \
    --query "Tags[?Key=='cdkd-update-probe'].Value | [0]" --output text || return 1
}
assert_eq() { # usage: assert_eq "<what>" <expected> <actual>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected '$2', got '$3'" >&2
    exit 1
  fi
}
assert_nonempty() { # usage: assert_nonempty "<what>" <value>
  if [ -z "$2" ]; then
    echo "FAIL: $1 is empty — the assertion built on it would be vacuous" >&2
    exit 1
  fi
}

# --- Phase 1: baseline deploy -----------------------------------------------
echo "==> Phase 1: deploy baseline (generated + literal secret, no tag)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

GEN_V1="$(current_version_id "${GENERATED_NAME}")"
LIT_V1="$(current_version_id "${LITERAL_NAME}")"
assert_nonempty "Phase 1 generated AWSCURRENT VersionId" "${GEN_V1}"
assert_nonempty "Phase 1 literal AWSCURRENT VersionId" "${LIT_V1}"
assert_eq "Phase 1 generated version count" "1" "$(version_count "${GENERATED_NAME}")"
assert_eq "Phase 1 literal version count" "1" "$(version_count "${LITERAL_NAME}")"
assert_eq "Phase 1 generated probe tag (must be absent)" "None" "$(probe_tag_value "${GENERATED_NAME}")"
echo "    generated AWSCURRENT=${GEN_V1}, literal AWSCURRENT=${LIT_V1}, one version each"

# --- Phase 2: Tags-only UPDATE — the value must NOT move ---------------------
echo "==> Phase 2: re-deploy with a tag added to both secrets (Tags-only in-place UPDATE)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# The update REACHED AWS (so a no-op deploy cannot pass this phase)...
assert_eq "Phase 2 generated probe tag" "true" "$(probe_tag_value "${GENERATED_NAME}")"
assert_eq "Phase 2 literal probe tag" "true" "$(probe_tag_value "${LITERAL_NAME}")"
# ...and the VALUE did not: same AWSCURRENT, still exactly one version. Pre-fix
# the generated secret got a fresh password (new VersionId, count 2) and the
# literal got a redundant version (count 2, AWSCURRENT moved).
GEN_V2="$(current_version_id "${GENERATED_NAME}")"
LIT_V2="$(current_version_id "${LITERAL_NAME}")"
assert_eq "Phase 2 generated AWSCURRENT (issue #2472: a Tags-only update re-rolled the password)" "${GEN_V1}" "${GEN_V2}"
assert_eq "Phase 2 literal AWSCURRENT (issue #2472: an unchanged literal was re-sent)" "${LIT_V1}" "${LIT_V2}"
assert_eq "Phase 2 generated version count" "1" "$(version_count "${GENERATED_NAME}")"
assert_eq "Phase 2 literal version count" "1" "$(version_count "${LITERAL_NAME}")"
echo "    tag reached AWS; AWSCURRENT unchanged on both secrets; still one version each"

# --- Phase 3: source CHANGED — the value MUST move (positive control) --------
echo "==> Phase 3: re-deploy with GenerateSecretString changed (PasswordLength 40) and a new literal"
CDKD_TEST_UPDATE=regen node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

GEN_V3="$(current_version_id "${GENERATED_NAME}")"
LIT_V3="$(current_version_id "${LITERAL_NAME}")"
assert_nonempty "Phase 3 generated AWSCURRENT VersionId" "${GEN_V3}"
assert_nonempty "Phase 3 literal AWSCURRENT VersionId" "${LIT_V3}"
if [ "${GEN_V3}" = "${GEN_V2}" ]; then
  echo "FAIL: Phase 3 generated AWSCURRENT did not move (${GEN_V3}) although the GenerateSecretString block changed — the Phase 2 assertion is vacuous" >&2
  exit 1
fi
if [ "${LIT_V3}" = "${LIT_V2}" ]; then
  echo "FAIL: Phase 3 literal AWSCURRENT did not move (${LIT_V3}) although the literal changed — the Phase 2 assertion is vacuous" >&2
  exit 1
fi
assert_eq "Phase 3 generated AWSPREVIOUS (the Phase 2 current)" "${GEN_V2}" "$(previous_version_id "${GENERATED_NAME}")"
assert_eq "Phase 3 literal AWSPREVIOUS (the Phase 2 current)" "${LIT_V2}" "$(previous_version_id "${LITERAL_NAME}")"
assert_eq "Phase 3 generated version count" "2" "$(version_count "${GENERATED_NAME}")"
assert_eq "Phase 3 literal version count" "2" "$(version_count "${LITERAL_NAME}")"
echo "    both values moved: new AWSCURRENT, previous current is AWSPREVIOUS, two versions each"

# --- Phase 4: destroy --------------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Each secret must be gone (ResourceNotFound) or scheduled for deletion —
# `DeleteSecret` without force leaves it describable with a DeletedDate.
for name in "${GENERATED_NAME}" "${LITERAL_NAME}"; do
  if gone_probe aws secretsmanager describe-secret --secret-id "${name}" --region "${REGION}"; then
    DELETED_DATE="GONE"
  elif ! DELETED_DATE="$(aws secretsmanager describe-secret --secret-id "${name}" --region "${REGION}" \
      --query 'DeletedDate' --output text 2>&1)"; then
    # TOCTOU: the secret can vanish between gone_probe and this requery.
    printf '%s' "${DELETED_DATE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
      && DELETED_DATE="GONE" \
      || { echo "FAIL: describe-secret requery undetermined for ${name}: ${DELETED_DATE}" >&2; exit 1; }
  fi
  if [ "${DELETED_DATE}" = "None" ]; then
    echo "FAIL: secret ${name} still live (not deleted/scheduled) after destroy" >&2
    exit 1
  fi
  echo "    secret ${name} deleted (state: ${DELETED_DATE})"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

# Success path: nothing needs the state any more, so purge EVERY version and
# delete marker under the stack prefix, then assert the sweep (issue #2096).
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "secretsmanager-update-value-source state teardown"
echo "    state bucket versions swept"

echo "[verify] PASS — Secrets Manager in-place UPDATE keeps the value unless its source changed (issue #2472)"

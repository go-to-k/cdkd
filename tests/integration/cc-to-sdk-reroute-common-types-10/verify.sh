#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route integ for AWS::WAFv2::WebACL
# (REGIONAL and CLOUDFRONT) and AWS::CodeCommit::Repository (issue 6490,
# batch 10).
#
# Admission evidence for each type's `'sdk-coverage'` sticky exemption. Both
# are recorded under DIFFERENT ids by the two layers, and neither SDK id is
# inside the Cloud Control one: a web ACL's ARN is built from the stack's region,
# account and partition, a repository's name is read from its record. Phases:
# deploy on the SDK route -> force each resource onto Cloud Control
# (--recreate-via-cc-api) and see Cloud Control's form -> the plan announces each
# return -> --pin-cc-api declines them -> redeploy with a real change: each id
# in the SDK form and equal to the live one, each record flipped to 'sdk', each
# update reached AWS on the same resource -> drift clean, then exactly the
# out-of-band changes -> destroy on the flipped records.

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
# assert_gone, plus the not-found error AWS answers for that type: the shared
# signature alone would also accept another not-found (a wrong scope, say).
assert_gone_as() { # usage: assert_gone_as "<leak description>" <ErrorCode> aws <service> <read-verb> [args...]
  local desc="$1" code="$2" out
  shift 2
  assert_gone "${desc}" "$@"
  out=$("$@" 2>&1 >/dev/null || true)
  grep -qF "${code}" <<<"${out}" || { echo "FAIL: ${desc}: the gone-probe answered without ${code}: ${out}" >&2; exit 1; }
}
cd "$(dirname "$0")"

STACK="CdkdCcToSdkRerouteCommonTypes10Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# The names the stack declares (lib/cc-to-sdk-reroute-common-types-10-stack.ts).
REGIONAL_ACL_NAME="cdkd-reroute-ct10-acl"
CLOUDFRONT_ACL_NAME="cdkd-reroute-ct10-cfacl"
REPO_NAME="cdkd-reroute-ct10-repo"
# A WAFv2 web ACL id and a CodeCommit RepositoryId: a lowercase UUID (measured
# us-east-1, 2026-11-17).
UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

# The resources under test, by the logical ids the stack fixes with
# overrideLogicalId. Every per-type helper below has an arm for each.
SUBJECTS=(
  RerouteRegionalWebAcl
  RerouteCloudFrontWebAcl
  RerouteRepository
)

type_of() { # usage: type_of <logicalId>
  case "$1" in
    RerouteRegionalWebAcl | RerouteCloudFrontWebAcl) printf 'AWS::WAFv2::WebACL' ;;
    RerouteRepository) printf 'AWS::CodeCommit::Repository' ;;
    *) echo "FAIL: type_of has no arm for $1" >&2; return 1 ;;
  esac
}

# A web ACL's name, scope and the ARN path segment its scope takes.
acl_name() { # usage: acl_name <logicalId>
  case "$1" in
    RerouteRegionalWebAcl) printf '%s' "${REGIONAL_ACL_NAME}" ;;
    RerouteCloudFrontWebAcl) printf '%s' "${CLOUDFRONT_ACL_NAME}" ;;
    *) echo "FAIL: acl_name has no arm for $1" >&2; return 1 ;;
  esac
}
acl_scope() { # usage: acl_scope <logicalId>
  case "$1" in
    RerouteRegionalWebAcl) printf 'REGIONAL' ;;
    RerouteCloudFrontWebAcl) printf 'CLOUDFRONT' ;;
    *) echo "FAIL: acl_scope has no arm for $1" >&2; return 1 ;;
  esac
}
acl_kind() { # usage: acl_kind <logicalId>
  case "$1" in
    RerouteRegionalWebAcl) printf 'regional' ;;
    RerouteCloudFrontWebAcl) printf 'global' ;;
    *) echo "FAIL: acl_kind has no arm for $1" >&2; return 1 ;;
  esac
}

STATE_JSON=""
load_state() {
  STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
  [ -n "${STATE_JSON}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
}

# The state record for one resource under test, read from the last load_state.
# A missing record would make every assertion below read `null` and pass
# vacuously, so an empty match hard-fails.
record() { # usage: record <logicalId> <jq-expression-over-the-resource-object>
  printf '%s' "${STATE_JSON}" | jq -e --arg k "$1" '.resources[$k]' >/dev/null || {
    echo "FAIL: no state resource $1" >&2
    exit 1
  }
  printf '%s' "${STATE_JSON}" | jq -r --arg k "$1" ".resources[\$k] | $2"
}

output() { # usage: output <OutputKey>
  printf '%s' "${STATE_JSON}" | jq -r --arg k "$1" '.outputs[$k]'
}

# Set before phase 1; never changes.
ACCOUNT=""

# The id form a layer records. `sdk`: the web ACL ARN in this region and
# account, and the repository name. `cc` (measured us-east-1, 2026-11-17):
# `<Name>|<Id>|<Scope>` for a web ACL, the RepositoryId UUID for a repository.
form_ok() { # usage: form_ok <sdk|cc> <logicalId> <physicalId>
  local name scope kind
  case "$2" in
    RerouteRegionalWebAcl | RerouteCloudFrontWebAcl)
      name=$(acl_name "$2") || return 1
      scope=$(acl_scope "$2") || return 1
      kind=$(acl_kind "$2") || return 1
      case "$1" in
        sdk) grep -qE "^arn:aws(-[a-z]+)*:wafv2:${REGION}:${ACCOUNT}:${kind}/webacl/${name}/${UUID}\$" <<<"$3" ;;
        cc) grep -qE "^${name}\\|${UUID}\\|${scope}\$" <<<"$3" ;;
        *) echo "FAIL: form_ok has no arm for $1:$2" >&2; return 1 ;;
      esac ;;
    RerouteRepository)
      case "$1" in
        sdk) [ "$3" = "${REPO_NAME}" ] ;;
        cc) grep -qE "^${UUID}\$" <<<"$3" ;;
        *) echo "FAIL: form_ok has no arm for $1:$2" >&2; return 1 ;;
      esac ;;
    *) echo "FAIL: form_ok has no arm for $1:$2" >&2; return 1 ;;
  esac
}

# A web ACL's id, from either recorded form: the ARN's last segment, or the
# middle segment of Cloud Control's composite.
acl_id() { # usage: acl_id <physicalId>
  case "$1" in
    arn:*) printf '%s' "${1##*/}" ;;
    *) printf '%s' "$1" | cut -d'|' -f2 ;;
  esac
}

# The repository name AWS addresses it by: the SDK id itself; for Cloud
# Control's RepositoryId, the name the template declares (the witness then
# proves that name holds that id).
repo_name_of() { # usage: repo_name_of <physicalId>
  if grep -qE "^${UUID}\$" <<<"$1"; then printf '%s' "${REPO_NAME}"; else printf '%s' "$1"; fi
}

get_acl() { # usage: get_acl <logicalId> <physicalId> <--query expression>
  local name scope id
  name=$(acl_name "$1") || return 1
  scope=$(acl_scope "$1") || return 1
  id=$(acl_id "$2") || return 1
  aws wafv2 get-web-acl --name "${name}" --scope "${scope}" --id "${id}" \
    --region "${REGION}" --query "$3" --output text
}

get_repo() { # usage: get_repo <physicalId> <--query expression>
  aws codecommit get-repository --repository-name "$(repo_name_of "$1")" \
    --region "${REGION}" --query "$2" --output text
}

# The value AWS holds for the mutable property, read through the recorded id.
live_value() { # usage: live_value <logicalId> <physicalId>
  case "$1" in
    RerouteRegionalWebAcl | RerouteCloudFrontWebAcl) get_acl "$1" "$2" WebACL.Description ;;
    RerouteRepository) get_repo "$2" repositoryMetadata.repositoryDescription ;;
    *) echo "FAIL: live_value has no arm for $1" >&2; return 1 ;;
  esac
}

# The id of the web ACL that holds a name, as ListWebACLs reports it: read
# by NAME, so the answer does not depend on the id the record holds. Pages are
# followed by NextMarker; no listing for the name prints nothing.
listed_acl_id() { # usage: listed_acl_id <logicalId>
  local name scope marker="" page ids
  name=$(acl_name "$1") || return 1
  scope=$(acl_scope "$1") || return 1
  while :; do
    if [ -n "${marker}" ]; then
      page=$(aws wafv2 list-web-acls --scope "${scope}" --region "${REGION}" --limit 100 --next-marker "${marker}" --output json) || return 1
    else
      page=$(aws wafv2 list-web-acls --scope "${scope}" --region "${REGION}" --limit 100 --output json) || return 1
    fi
    ids=$(jq -r --arg n "${name}" '.WebACLs[] | select(.Name == $n) | .Id' <<<"${page}") || return 1
    [ -n "${ids}" ] && { printf '%s' "${ids}"; return 0; }
    marker=$(jq -r '.NextMarker // empty' <<<"${page}") || return 1
    [ -n "${marker}" ] || return 0
  done
}

# IDENTITY WITNESS, AWS-minted (a re-created web ACL or repository of the same
# name gets a new one, measured us-east-1, 2026-11-17). For a web ACL: the id
# ListWebACLs reports for its name, which must also be the id the record
# holds, so a read through the record's id cannot merely echo it. For a
# repository: the RepositoryId GetRepository reports for the name the record
# addresses.
witness() { # usage: witness <logicalId> <physicalId>
  local listed
  case "$1" in
    RerouteRegionalWebAcl | RerouteCloudFrontWebAcl)
      listed=$(listed_acl_id "$1") || { echo "FAIL: cannot list $1's web ACL by name" >&2; return 1; }
      [ -n "${listed}" ] || { echo "FAIL: no web ACL named $(acl_name "$1") is listed for $1" >&2; return 1; }
      [ "${listed}" = "$(acl_id "$2")" ] || {
        echo "FAIL: $1's name is held by web ACL '${listed}', not by the recorded $2" >&2
        return 1
      }
      printf '%s' "${listed}" ;;
    RerouteRepository) get_repo "$2" repositoryMetadata.repositoryId ;;
    *) echo "FAIL: witness has no arm for $1" >&2; return 1 ;;
  esac
}

# Names the subject and phase of a read that failed, then fails the caller.
cannot_read() { # usage: cannot_read <message>
  echo "FAIL: $1" >&2
  return 1
}

witness_ok() { # usage: witness_ok <witness>
  [ -n "$1" ] && [ "$1" != "None" ]
}

# Every resource's live value must be the phase's.
assert_live_values() { # usage: assert_live_values <phase-label> <a|b>
  local id pid got
  for id in "${SUBJECTS[@]}"; do
    pid=$(record "${id}" '.physicalId')
    got=$(live_value "${id}" "${pid}") || { echo "FAIL: $1: cannot read ${id}'s live value through ${pid}" >&2; exit 1; }
    [ "${got}" = "phase-$2" ] || { echo "FAIL: $1: ${id} (${pid}) holds '${got}', expected 'phase-$2'" >&2; exit 1; }
  done
}

assert_layers() { # usage: assert_layers <phase-label> <sdk|cc-api>
  local id layer
  for id in "${SUBJECTS[@]}"; do
    layer=$(record "${id}" '.provisionedBy')
    [ "${layer}" = "$2" ] || { echo "FAIL: $1: ${id} recorded provisionedBy=${layer}, expected $2" >&2; exit 1; }
  done
}

assert_forms() { # usage: assert_forms <phase-label> <sdk|cc>
  local id pid
  for id in "${SUBJECTS[@]}"; do
    pid=$(record "${id}" '.physicalId')
    form_ok "$2" "${id}" "${pid}" || { echo "FAIL: $1: ${id} recorded '${pid}', not the $2 form" >&2; exit 1; }
  done
}

# Each Ref / GetAtt the stack outputs must be what CloudFormation returns, on
# either layer, read back from AWS: a web ACL's Ref is `<Name>|<Id>|<Scope>`
# (the Cloud Control id itself, then the compound cdkd rebuilds from the ARN),
# its Arn and Id the live ones; a repository's Ref is its RepositoryId (the
# Cloud Control id itself, then the recorded attribute the flip carries over),
# its Name and Arn the live ones.
assert_refs() { # usage: assert_refs <phase-label>
  local id key pid name scope live_id live_arn repo_id repo_arn
  for id in RerouteRegionalWebAcl RerouteCloudFrontWebAcl; do
    key="${id#Reroute}"
    pid=$(record "${id}" '.physicalId') || cannot_read "$1: cannot read ${id}'s state record" || return 1
    name=$(acl_name "${id}") || return 1
    scope=$(acl_scope "${id}") || return 1
    live_id=$(get_acl "${id}" "${pid}" WebACL.Id) || cannot_read "$1: cannot read ${id}'s id from WAFv2 through ${pid}" || return 1
    live_arn=$(get_acl "${id}" "${pid}" WebACL.ARN) || cannot_read "$1: cannot read ${id}'s ARN from WAFv2 through ${pid}" || return 1
    [ "$(output "${key}Ref")" = "${name}|${live_id}|${scope}" ] || {
      echo "FAIL: $1: Ref of ${id} resolved to '$(output "${key}Ref")', expected ${name}|${live_id}|${scope}" >&2
      exit 1
    }
    [ "$(output "${key}Arn")" = "${live_arn}" ] || {
      echo "FAIL: $1: GetAtt ${id}.Arn resolved to '$(output "${key}Arn")', expected ${live_arn}" >&2
      exit 1
    }
    [ "$(output "${key}Id")" = "${live_id}" ] || {
      echo "FAIL: $1: GetAtt ${id}.Id resolved to '$(output "${key}Id")', expected ${live_id}" >&2
      exit 1
    }
  done
  pid=$(record RerouteRepository '.physicalId') || cannot_read "$1: cannot read RerouteRepository's state record" || return 1
  repo_id=$(get_repo "${pid}" repositoryMetadata.repositoryId) || cannot_read "$1: cannot read RerouteRepository's id from CodeCommit" || return 1
  repo_arn=$(get_repo "${pid}" repositoryMetadata.Arn) || cannot_read "$1: cannot read RerouteRepository's ARN from CodeCommit" || return 1
  [ "$(output RepositoryRef)" = "${repo_id}" ] || {
    echo "FAIL: $1: Ref of RerouteRepository resolved to '$(output RepositoryRef)', expected its RepositoryId ${repo_id}" >&2
    exit 1
  }
  [ "$(output RepositoryName)" = "${REPO_NAME}" ] || {
    echo "FAIL: $1: GetAtt RerouteRepository.Name resolved to '$(output RepositoryName)', expected ${REPO_NAME}" >&2
    exit 1
  }
  [ "$(output RepositoryArn)" = "${repo_arn}" ] || {
    echo "FAIL: $1: GetAtt RerouteRepository.Arn resolved to '$(output RepositoryArn)', expected ${repo_arn}" >&2
    exit 1
  }
}

# The per-resource routing flags, one per resource under test.
RECREATE_FLAGS=()
PIN_FLAGS=()
for id in "${SUBJECTS[@]}"; do
  RECREATE_FLAGS+=(--recreate-via-cc-api "${id}")
  PIN_FLAGS+=(--pin-cc-api "${id}")
done

# Per-phase ids and witnesses, indexed like SUBJECTS (bash 3.2 has no
# associative arrays).
W0=()
W1=()
P1=()

cleanup() {
  echo "==> Cleanup"
  set +eu
  local destroy_rc=1 destroy_out=""
  if [ -f "${LOCAL_DIST}" ]; then
    destroy_out=$(node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes 2>&1)
    destroy_rc=$?
    # No state is the normal pre-run and post-destroy answer, not a failed teardown.
    if [ "${destroy_rc}" -ne 0 ] && ! grep -q 'No state found' <<<"${destroy_out}"; then
      echo "WARN: cdkd state destroy exited ${destroy_rc}; state was kept, so check the account for leftovers" >&2
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
# AWS serves a CLOUDFRONT web ACL only from us-east-1.
[ "${REGION}" = "us-east-1" ] || { echo "FAIL: this fixture runs in us-east-1 only (got ${REGION}): its CLOUDFRONT web ACL exists nowhere else" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
grep -qE '^[0-9]{12}$' <<<"${ACCOUNT}" || { echo "FAIL: cannot read the account id (got '${ACCOUNT}')" >&2; exit 1; }

# `--recreate-via-cc-api` validates its arguments against the template's own
# logical ids, so a SUBJECTS entry the stack does not declare fails here, not as
# a confusing refusal mid-run.
node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
for id in "${SUBJECTS[@]}"; do
  jq -e --arg k "${id}" --arg t "$(type_of "${id}")" '.Resources[$k].Type == $t' "${TEMPLATE}" >/dev/null ||
    { echo "FAIL: ${TEMPLATE} declares no ${id} of type $(type_of "${id}")" >&2; exit 1; }
done

echo "==> Phase 1: Deploy (SDK route by default -- no type under test has SDK-unwired properties)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
assert_layers "phase 1 (fresh deploy)" sdk
assert_forms "phase 1 (fresh deploy)" sdk
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  W0[$i]=$(witness "${id}" "$(record "${id}" '.physicalId')") ||
    { echo "FAIL: phase 1: cannot read ${id}'s identity witness" >&2; exit 1; }
  witness_ok "${W0[$i]}" || { echo "FAIL: no identity witness for ${id}" >&2; exit 1; }
done
assert_live_values "phase 1 (SDK create)" a
assert_refs "phase 1"
echo "    OK: all ${#SUBJECTS[@]} created on the SDK route"

echo "==> Phase 2: force each resource onto Cloud Control (--recreate-via-cc-api)"
# A CodeCommit repository is a stateful type (it holds the commits), and cdkd
# refuses to recreate one without --force-stateful-recreation. It holds none.
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    "${RECREATE_FLAGS[@]}" --force-stateful-recreation --yes
load_state
# Without this every assertion below would be vacuous.
assert_layers "phase 2 (after --recreate-via-cc-api)" cc-api
# THE MEASURED FORMS. Were any of them the SDK id, the type would need no
# normalizer and phase 5 would not exercise it.
assert_forms "phase 2 (after --recreate-via-cc-api)" cc
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  P1[$i]=$(record "${id}" '.physicalId')
  W1[$i]=$(witness "${id}" "${P1[$i]}") ||
    { echo "FAIL: phase 2: cannot read ${id}'s identity witness through ${P1[$i]}" >&2; exit 1; }
  witness_ok "${W1[$i]}" || { echo "FAIL: no identity witness for ${id} after the recreate" >&2; exit 1; }
  [ "${W1[$i]}" != "${W0[$i]}" ] || {
    echo "FAIL: the recreate kept ${id}'s witness (${W0[$i]}); it was not recreated, so the witness cannot prove phase 5" >&2
    exit 1
  }
done
# The Cloud Control id IS the RepositoryId: the repository the name reaches
# holds it, so the name phase 5 addresses is this repository's.
[ "${W1[2]}" = "${P1[2]}" ] || {
  echo "FAIL: phase 2: repository ${REPO_NAME} holds RepositoryId ${W1[2]}, but Cloud Control recorded ${P1[2]}" >&2
  exit 1
}
assert_live_values "phase 2 (CC recreate)" b
assert_refs "phase 2"
echo "    OK: all ${#SUBJECTS[@]} pinned to Cloud Control under its own id form, with fresh witnesses"

echo "==> Phase 3: the plan ANNOUNCES each return"
# `pinned`, not `flip`: the seed already declares flip's values, and cdkd diff
# renders the routing token only on a changed resource.
DIFF_OUT=$(env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)
for id in "${SUBJECTS[@]}"; do
  # The change row names the logical id and its type; the token rides on it.
  # A row without the token is the routing annotation missing or reworded.
  row=$(grep -F "] ${id} (AWS::" <<<"${DIFF_OUT}" || true)
  [ -n "${row}" ] || { echo "FAIL: cdkd diff shows no change row for ${id}" >&2; printf '%s\n' "${DIFF_OUT}" >&2; exit 1; }
  grep -qF '[returning to SDK provider]' <<<"${row}" || {
    echo "FAIL: cdkd diff did not announce ${id}'s return: ${row}" >&2
    exit 1
  }
done
if grep -q 'via CC API: sticky' <<<"${DIFF_OUT}"; then
  echo "FAIL: cdkd diff still renders the sticky tag for a resource about to leave Cloud Control" >&2
  printf '%s\n' "${DIFF_OUT}" >&2
  exit 1
fi
echo "    OK: plan says 'returning to SDK provider' for all ${#SUBJECTS[@]}"

echo "==> Phase 4: --pin-cc-api DECLINES each flip"
env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    "${PIN_FLAGS[@]}" --yes
load_state
assert_layers "phase 4 (--pin-cc-api)" cc-api
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  [ "$(record "${id}" '.physicalId')" = "${P1[$i]}" ] || { echo "FAIL: the pinned deploy changed ${id}'s id" >&2; exit 1; }
  w=$(witness "${id}" "${P1[$i]}") ||
    { echo "FAIL: phase 4: cannot read ${id}'s identity witness through ${P1[$i]}" >&2; exit 1; }
  [ "${w}" = "${W1[$i]}" ] || {
    echo "FAIL: the pinned Cloud Control update replaced ${id} (its witness changed)" >&2
    exit 1
  }
done
# Without this, "still cc-api" is equally explained by a NO_CHANGE deploy.
assert_live_values "phase 4 (CC update)" a
echo "    OK: all ${#SUBJECTS[@]} still on Cloud Control, updates applied via CC"

echo "==> Phase 5: THE ARM -- redeploy unpinned; each flip must be churn-free"
FLIP_OUT=$(env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee /dev/stderr)
# Each type announces its id moving to the SDK form; each line names its
# logical id. Each id's lines captured first, then matched with a here-string:
# under pipefail a `grep -q` closing the pipe early can SIGPIPE the grep
# feeding it.
for id in "${SUBJECTS[@]}"; do
  lines=$(grep -F "${id} (AWS::" <<<"${FLIP_OUT}" || true)
  grep -qF "takes the SDK provider's form" <<<"${lines}" || {
    echo "FAIL: the flip did not announce ${id}'s id moving to the SDK form" >&2
    exit 1
  }
done
load_state
assert_layers "phase 5 (flip)" sdk
assert_forms "phase 5 (flip)" sdk
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  p2=$(record "${id}" '.physicalId')
  w2=$(witness "${id}" "${p2}") ||
    { echo "FAIL: phase 5: cannot read ${id}'s identity witness through the flipped id ${p2}" >&2; exit 1; }
  [ "${w2}" = "${W1[$i]}" ] || {
    echo "FAIL: ${id}'s witness changed across the flip (${W1[$i]} -> ${w2}); the SDK provider replaced it" >&2
    exit 1
  }
done
# THE NORMALIZER'S OUTPUT, observed equal to the live SDK id: each web ACL's
# flipped ARN is the one WAFv2 reports for the Cloud Control id's web ACL, and
# the repository's flipped name reaches the repository whose RepositoryId
# Cloud Control recorded.
for i in 0 1; do
  id=${SUBJECTS[$i]}
  p2=$(record "${id}" '.physicalId')
  live_arn=$(get_acl "${id}" "${P1[$i]}" WebACL.ARN) ||
    { echo "FAIL: phase 5: cannot read ${id}'s ARN through Cloud Control's ${P1[$i]}" >&2; exit 1; }
  [ "${p2}" = "${live_arn}" ] || {
    echo "FAIL: ${id}'s flipped id is ${p2}, but the web ACL Cloud Control recorded as ${P1[$i]} has ARN ${live_arn}" >&2
    exit 1
  }
done
[ "$(record RerouteRepository '.physicalId')" = "${REPO_NAME}" ] || {
  echo "FAIL: RerouteRepository's flipped id is $(record RerouteRepository '.physicalId'), expected ${REPO_NAME}" >&2
  exit 1
}
# Independently of the template's name: the repository CodeCommit lists under
# Cloud Control's RepositoryId is the one the flipped id names.
listed=$(aws codecommit list-repositories --region "${REGION}" \
  --query "repositories[?repositoryId=='${P1[2]}'].repositoryName" --output text) ||
  { echo "FAIL: phase 5: cannot list repositories to find RerouteRepository's RepositoryId ${P1[2]}" >&2; exit 1; }
[ "${listed}" = "$(record RerouteRepository '.physicalId')" ] || {
  echo "FAIL: phase 5: RerouteRepository's flipped id is $(record RerouteRepository '.physicalId'), but RepositoryId ${P1[2]} is listed as '${listed}'" >&2
  exit 1
}
# The update reached AWS through the id the flip recorded.
assert_live_values "phase 5 (SDK update)" b
assert_refs "phase 5"
echo "    OK: SDK-form ids equal to the live ones, same witnesses, all ${#SUBJECTS[@]} records flipped to sdk, updates applied in place"

echo "==> Phase 6: drift on the flipped records"
# cdkd drift compares AWS with the snapshot each deploy reads back
# (observedProperties). 6a: nothing changed since the flip, so all must be
# clean: each flipped record's snapshot matches what AWS holds. 6b: with the
# description of each changed out of band, each must drift by that property
# alone, which proves drift reads every live resource through its flipped
# record rather than skipping it.
DRIFT_OUT=""
DRIFT_RC=0
run_drift() {
  set +e
  DRIFT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --stack-region "${REGION}" --json 2>/dev/null)
  DRIFT_RC=$?
  set -e
}
# The report bucket(s) a logical id lands in, comma-joined.
drift_bucket() { # usage: drift_bucket <logicalId>
  jq -r --arg id "$1" '[.. | objects | to_entries[]
    | select((.value | type) == "array") | .key as $bucket
    | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' \
    <<<"${DRIFT_OUT}" 2>/dev/null || true
}
drift_fail() { # usage: drift_fail <message>
  echo "FAIL: $1" >&2
  printf '%s\n' "${DRIFT_OUT}" >&2
  exit 1
}

run_drift
for id in "${SUBJECTS[@]}"; do
  bucket=$(drift_bucket "${id}")
  [ "${bucket}" = "clean" ] || drift_fail "6a: cdkd drift put ${id} in bucket '${bucket}', expected clean"
done
jq -e '[.[].drifted[]] | length == 0' <<<"${DRIFT_OUT}" >/dev/null ||
  drift_fail "6a: cdkd drift reports a drifted resource beside the subjects"
# rc after the buckets, so a non-zero rc names its own cause.
[ "${DRIFT_RC}" -eq 0 ] || drift_fail "6a: cdkd drift exited ${DRIFT_RC} although every subject is clean"
echo "    OK (6a): cdkd drift reported all ${#SUBJECTS[@]} clean (rc=0)"

# The out-of-band change for each subject, and the property path it drifts.
oob_change() { # usage: oob_change <logicalId> <physicalId>
  local name scope id token
  case "$1" in
    RerouteRegionalWebAcl | RerouteCloudFrontWebAcl)
      name=$(acl_name "$1") || return 1
      scope=$(acl_scope "$1") || return 1
      id=$(acl_id "$2") || return 1
      token=$(get_acl "$1" "$2" LockToken) || { echo "FAIL: 6b: cannot read $1's lock token" >&2; return 1; }
      # UpdateWebACL replaces the whole configuration: every other field is
      # sent as the template declares it.
      aws wafv2 update-web-acl --name "${name}" --scope "${scope}" --id "${id}" --lock-token "${token}" \
        --default-action 'Allow={}' \
        --visibility-config "SampledRequestsEnabled=false,CloudWatchMetricsEnabled=false,MetricName=${name}" \
        --description oob --region "${REGION}" >/dev/null ;;
    RerouteRepository)
      aws codecommit update-repository-description --repository-name "$2" \
        --repository-description oob --region "${REGION}" >/dev/null ;;
    *) echo "FAIL: oob_change has no arm for $1" >&2; return 1 ;;
  esac
}
oob_path() { # usage: oob_path <logicalId>
  case "$1" in
    RerouteRegionalWebAcl | RerouteCloudFrontWebAcl) printf 'Description' ;;
    RerouteRepository) printf 'RepositoryDescription' ;;
    *) echo "FAIL: oob_path has no arm for $1" >&2; return 1 ;;
  esac
}

for id in "${SUBJECTS[@]}"; do
  oob_change "${id}" "$(record "${id}" '.physicalId')" || { echo "FAIL: 6b: the out-of-band change of ${id} failed" >&2; exit 1; }
done
run_drift
for id in "${SUBJECTS[@]}"; do
  bucket=$(drift_bucket "${id}")
  [ "${bucket}" = "drifted" ] || drift_fail "6b: cdkd drift put ${id} in bucket '${bucket}', expected drifted by its out-of-band $(oob_path "${id}") change"
  want=$(oob_path "${id}")
  paths=$(jq -c --arg id "${id}" '[.[].drifted[] | select(.logicalId == $id) | .changes[].path]' <<<"${DRIFT_OUT}") ||
    drift_fail "6b: cdkd drift's JSON report is unreadable for ${id}"
  jq -e --arg p "${want}" 'length > 0 and all(. == $p)' <<<"${paths}" >/dev/null ||
    drift_fail "6b: ${id} drifted by ${paths}, expected only ${want}"
done
jq -e --argjson n "${#SUBJECTS[@]}" '[.[].drifted[]] | length == $n' <<<"${DRIFT_OUT}" >/dev/null ||
  drift_fail "6b: cdkd drift reports a drifted resource other than the ${#SUBJECTS[@]} subjects"
[ "${DRIFT_RC}" -ne 0 ] || drift_fail "6b: cdkd drift exited 0 although it reports every subject drifted"
echo "    OK (6b): each subject drifted by its out-of-band description change alone (rc=${DRIFT_RC})"

echo "==> Phase 7: Destroy on the flipped records + gone-probes"
FLIPPED=()
for i in "${!SUBJECTS[@]}"; do
  FLIPPED[$i]=$(record "${SUBJECTS[$i]}" '.physicalId')
done
DESTROY_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee /dev/stderr)
DESTROY_PLAIN=$(sed $'s/\033\\[[0-9;]*m//g' <<<"${DESTROY_OUT}")
for id in "${SUBJECTS[@]}"; do
  type=$(type_of "${id}")
  grep -qF "${id} (${type})" <<<"${DESTROY_PLAIN}" || {
    echo "FAIL: the destroy printed no line for ${id} (${type})" >&2
    exit 1
  }
done
for i in 0 1; do
  id=${SUBJECTS[$i]}
  assert_gone_as "web ACL ${id} (${FLIPPED[$i]}) survived its delete under the flipped id" WAFNonexistentItemException \
    aws wafv2 get-web-acl --name "$(acl_name "${id}")" --scope "$(acl_scope "${id}")" \
      --id "$(acl_id "${FLIPPED[$i]}")" --region "${REGION}"
done
assert_gone_as "repository ${FLIPPED[2]} survived its delete under the flipped id" RepositoryDoesNotExistException \
  aws codecommit get-repository --repository-name "${FLIPPED[2]}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-common-types-10 (normalized ids observed equal to the live WAFv2 web ACL ARNs, REGIONAL and CLOUDFRONT, and the CodeCommit repository name)"

#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route integ for AWS::Events::Archive,
# AWS::Logs::DeliverySource, AWS::Logs::DeliveryDestination and
# AWS::Logs::Delivery (issue 6588).
#
# Admission evidence for each type's `'sdk-coverage'` sticky exemption. Both
# layers record the same id for each (the archive, source and destination
# names; the AWS-minted delivery id). Phases: deploy on the SDK route -> force
# each resource onto Cloud Control (--recreate-via-cc-api) under its
# generation-2 name, in one deploy -> the plan announces each return -> --pin-cc-api declines
# them -> an out-of-band tag on the source and the destination -> redeploy with
# a real change: each id unchanged, each record flipped to 'sdk', each update
# reached AWS on the same resource -> drift clean -> destroy on the flipped
# records.

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
# signature alone would also accept another not-found.
assert_gone_as() { # usage: assert_gone_as "<leak description>" <ErrorCode> aws <service> <read-verb> [args...]
  local desc="$1" code="$2" out
  shift 2
  assert_gone "${desc}" "$@"
  out=$("$@" 2>&1 >/dev/null || true)
  grep -qF "${code}" <<<"${out}" || { echo "FAIL: ${desc}: the gone-probe answered without ${code}: ${out}" >&2; exit 1; }
}
cd "$(dirname "$0")"

STACK="CdkdCcToSdkRerouteCommonTypes12Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# The names the stack declares (lib/cc-to-sdk-reroute-common-types-12-stack.ts),
# by generation: 1 for the SDK create, 2 from the Cloud Control recreate on.
ARCHIVE_PREFIX="cdkd-reroute-ct12-archive-"
SOURCE_PREFIX="cdkd-reroute-ct12-src-"
DESTINATION_PREFIX="cdkd-reroute-ct12-dst-"
BUS_PREFIX="cdkd-reroute-ct12-bus-"
GROUP_PREFIX="/aws/vendedlogs/cdkd-reroute-ct12-"
# The tag key the stack declares on the three Logs resources, and the one this
# script sets out of band as the source's and destination's identity witness.
TAG_KEY="cdkd-reroute"
WITNESS_KEY="cdkd-reroute-witness"
WITNESS_VALUE="run-$$-$(date +%s)"

# The resources under test, by the logical ids the stack fixes with
# overrideLogicalId. Every per-type helper below has an arm for each.
SUBJECTS=(
  RerouteArchive
  RerouteDeliverySource
  RerouteDeliveryDestination
  RerouteDelivery
)

type_of() { # usage: type_of <logicalId>
  case "$1" in
    RerouteArchive) printf 'AWS::Events::Archive' ;;
    RerouteDeliverySource) printf 'AWS::Logs::DeliverySource' ;;
    RerouteDeliveryDestination) printf 'AWS::Logs::DeliveryDestination' ;;
    RerouteDelivery) printf 'AWS::Logs::Delivery' ;;
    *) echo "FAIL: type_of has no arm for $1" >&2; return 1 ;;
  esac
}

# The name a named subject holds in a generation: its physical id on both
# layers. The delivery has no name; its id is AWS-minted.
name_of() { # usage: name_of <logicalId> <1|2>
  case "$1" in
    RerouteArchive) printf '%s%s' "${ARCHIVE_PREFIX}" "$2" ;;
    RerouteDeliverySource) printf '%s%s' "${SOURCE_PREFIX}" "$2" ;;
    RerouteDeliveryDestination) printf '%s%s' "${DESTINATION_PREFIX}" "$2" ;;
    *) echo "FAIL: name_of has no arm for $1" >&2; return 1 ;;
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

describe_archive() { # usage: describe_archive <name> <--query expression>
  aws events describe-archive --archive-name "$1" --region "${REGION}" --query "$2" --output text
}
get_source() { # usage: get_source <name> <--query expression>
  aws logs get-delivery-source --name "$1" --region "${REGION}" --query "deliverySource.$2" --output text
}
get_destination() { # usage: get_destination <name> <--query expression>
  aws logs get-delivery-destination --name "$1" --region "${REGION}" --query "deliveryDestination.$2" --output text
}
get_delivery() { # usage: get_delivery <id> <--query expression>
  aws logs get-delivery --id "$1" --region "${REGION}" --query "delivery.$2" --output text
}
# The ARN AWS reports for a subject, read through its recorded id.
arn_of() { # usage: arn_of <logicalId> <physicalId>
  case "$1" in
    RerouteArchive) describe_archive "$2" ArchiveArn ;;
    RerouteDeliverySource) get_source "$2" arn ;;
    RerouteDeliveryDestination) get_destination "$2" arn ;;
    RerouteDelivery) get_delivery "$2" arn ;;
    *) echo "FAIL: arn_of has no arm for $1" >&2; return 1 ;;
  esac
}
# The value of one tag on a Logs resource; `None` when it is absent.
tag_value() { # usage: tag_value <arn> <key>
  aws logs list-tags-for-resource --resource-arn "$1" --region "${REGION}" --query "tags.\"$2\"" --output text
}

# The value AWS holds for the mutable property, read through the recorded id:
# the archive's Description, each Logs resource's declared tag.
live_value() { # usage: live_value <logicalId> <physicalId>
  local arn
  case "$1" in
    RerouteArchive) describe_archive "$2" Description ;;
    RerouteDeliverySource | RerouteDeliveryDestination | RerouteDelivery)
      arn=$(arn_of "$1" "$2") || return 1
      tag_value "${arn}" "${TAG_KEY}" ;;
    *) echo "FAIL: live_value has no arm for $1" >&2; return 1 ;;
  esac
}
# The value (a|b) a phase declares on a subject, as the stack's
# VALUE_BY_PHASE / DELIVERY_VALUE_BY_PHASE do: the delivery keeps its value at
# `pinned`, because Cloud Control cannot update it.
value_of() { # usage: value_of <logicalId> <phase>
  case "$1:$2" in
    RerouteDelivery:pinned) printf 'b' ;;
    RerouteDelivery:flip) printf 'a' ;;
    *:base | *:announce | *:pinned) printf 'a' ;;
    *:seed | *:flip) printf 'b' ;;
    *) echo "FAIL: value_of has no arm for $1:$2" >&2; return 1 ;;
  esac
}
# The value the stack declares in a phase, in live_value's spelling.
declared_value() { # usage: declared_value <logicalId> <phase>
  local v
  v=$(value_of "$1" "$2") || return 1
  case "$1" in
    RerouteArchive) printf 'cdkd reroute ct12 %s' "${v}" ;;
    RerouteDeliverySource | RerouteDeliveryDestination | RerouteDelivery) printf '%s' "${v}" ;;
    *) echo "FAIL: declared_value has no arm for $1" >&2; return 1 ;;
  esac
}

# IDENTITY WITNESS, read from AWS by the recorded id so that it does not echo
# the record:
# - the archive: the CreationTime EventBridge reports (a re-created archive
#   gets a new one);
# - the delivery: the AWS-minted id inside the ARN GetDelivery reports (a
#   re-created delivery gets a new one, which phase 2 observes);
# - the source and the destination: the ARN. Their names, and so their ARNs,
#   survive a recreate, so phase 5 also requires the out-of-band tag set after
#   phase 4, which a re-created resource would not carry.
witness() { # usage: witness <logicalId> <physicalId>
  local v
  case "$1" in
    RerouteArchive) v=$(describe_archive "$2" CreationTime) || return 1 ;;
    RerouteDelivery)
      v=$(get_delivery "$2" arn) || return 1
      grep -qE "^arn:aws(-[a-z]+)*:logs:${REGION}:${ACCOUNT}:delivery:[A-Za-z0-9]+\$" <<<"${v}" ||
        { echo "FAIL: $1 ($2) reports ARN '${v}', not the measured form" >&2; return 1; }
      v=${v##*:} ;;
    RerouteDeliverySource | RerouteDeliveryDestination) v=$(arn_of "$1" "$2") || return 1 ;;
    *) echo "FAIL: witness has no arm for $1" >&2; return 1 ;;
  esac
  printf '%s' "${v}"
}

witness_ok() { # usage: witness_ok <witness>
  [ -n "$1" ] && [ "$1" != "None" ]
}

# Every resource's live value must be the phase's.
assert_live_values() { # usage: assert_live_values <phase-label> <phase>
  local id pid got want
  for id in "${SUBJECTS[@]}"; do
    pid=$(record "${id}" '.physicalId')
    want=$(declared_value "${id}" "$2") || exit 1
    got=$(live_value "${id}" "${pid}") || { echo "FAIL: $1: cannot read ${id}'s live value through ${pid}" >&2; exit 1; }
    [ "${got}" = "${want}" ] || { echo "FAIL: $1: ${id} (${pid}) holds '${got}', expected '${want}'" >&2; exit 1; }
  done
}

assert_layers() { # usage: assert_layers <phase-label> <sdk|cc-api>
  local id layer
  for id in "${SUBJECTS[@]}"; do
    layer=$(record "${id}" '.provisionedBy')
    [ "${layer}" = "$2" ] || { echo "FAIL: $1: ${id} recorded provisionedBy=${layer}, expected $2" >&2; exit 1; }
  done
}

# The named subjects record the generation's name, exactly; the delivery
# records the id GetDelivery reports for it, which must join the generation's
# source to its destination.
assert_ids() { # usage: assert_ids <phase-label> <1|2>
  local id pid want got
  for id in RerouteArchive RerouteDeliverySource RerouteDeliveryDestination; do
    pid=$(record "${id}" '.physicalId')
    want=$(name_of "${id}" "$2") || exit 1
    [ "${pid}" = "${want}" ] || { echo "FAIL: $1: ${id} recorded '${pid}', expected the name ${want}" >&2; exit 1; }
  done
  pid=$(record RerouteDelivery '.physicalId')
  got=$(get_delivery "${pid}" id) || { echo "FAIL: $1: cannot read RerouteDelivery through ${pid}" >&2; exit 1; }
  [ "${got}" = "${pid}" ] || { echo "FAIL: $1: RerouteDelivery recorded '${pid}', AWS reports id '${got}'" >&2; exit 1; }
  got=$(get_delivery "${pid}" deliverySourceName) || exit 1
  [ "${got}" = "$(name_of RerouteDeliverySource "$2")" ] ||
    { echo "FAIL: $1: delivery ${pid} reads source '${got}', expected $(name_of RerouteDeliverySource "$2")" >&2; exit 1; }
  got=$(get_delivery "${pid}" deliveryDestinationArn) || exit 1
  [ "${got}" = "$(get_destination "$(name_of RerouteDeliveryDestination "$2")" arn)" ] ||
    { echo "FAIL: $1: delivery ${pid} writes to '${got}', not the generation-$2 destination" >&2; exit 1; }
}

# Each Ref / GetAtt the stack outputs must be what CloudFormation returns, on
# either layer, read back from AWS: Ref is the physical id, Arn the live one.
assert_refs() { # usage: assert_refs <phase-label>
  local id pid arn key
  for id in "${SUBJECTS[@]}"; do
    case "${id}" in
      RerouteArchive) key=Archive ;;
      RerouteDeliverySource) key=Source ;;
      RerouteDeliveryDestination) key=Destination ;;
      RerouteDelivery) key=Delivery ;;
    esac
    pid=$(record "${id}" '.physicalId')
    arn=$(arn_of "${id}" "${pid}") || { echo "FAIL: $1: cannot read ${id}'s ARN through ${pid}" >&2; exit 1; }
    [ "$(output "${key}Ref")" = "${pid}" ] ||
      { echo "FAIL: $1: Ref of ${id} resolved to '$(output "${key}Ref")', expected ${pid}" >&2; exit 1; }
    [ "$(output "${key}Arn")" = "${arn}" ] ||
      { echo "FAIL: $1: GetAtt ${id}.Arn resolved to '$(output "${key}Arn")', expected ${arn}" >&2; exit 1; }
  done
}

# The per-resource pin flags, one per resource under test.
PIN_FLAGS=()
for id in "${SUBJECTS[@]}"; do
  PIN_FLAGS+=(--pin-cc-api "${id}")
done

# Per-phase witnesses and ids, indexed like SUBJECTS (bash 3.2 has no
# associative arrays).
W0=()
W1=()
P1=()

# Best-effort removal of everything the stack names, for a run that failed
# before its destroy. A missing resource is the normal answer.
delete_leftovers() { (
  set +eu
  # Deliveries first: CloudWatch Logs refuses to delete a source or a
  # destination a delivery still uses.
  for id in $(aws logs describe-deliveries --region "${REGION}" \
    --query "deliveries[?starts_with(deliverySourceName, '${SOURCE_PREFIX}')].id" --output text 2>/dev/null); do
    [ "${id}" = "None" ] || aws logs delete-delivery --id "${id}" --region "${REGION}" >/dev/null 2>&1
  done
  for gen in 1 2; do
    aws logs delete-delivery-source --name "${SOURCE_PREFIX}${gen}" --region "${REGION}" >/dev/null 2>&1
    aws logs delete-delivery-destination --name "${DESTINATION_PREFIX}${gen}" --region "${REGION}" >/dev/null 2>&1
    aws events delete-archive --archive-name "${ARCHIVE_PREFIX}${gen}" --region "${REGION}" >/dev/null 2>&1
    aws events delete-event-bus --name "${BUS_PREFIX}${gen}" --region "${REGION}" >/dev/null 2>&1
    aws logs delete-log-group --log-group-name "${GROUP_PREFIX}${gen}" --region "${REGION}" >/dev/null 2>&1
  done
) }

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
  delete_leftovers
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
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
assert_ids "phase 1 (fresh deploy)" 1
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  W0[$i]=$(witness "${id}" "$(record "${id}" '.physicalId')") ||
    { echo "FAIL: phase 1: cannot read ${id}'s identity witness" >&2; exit 1; }
  witness_ok "${W0[$i]}" || { echo "FAIL: no identity witness for ${id}" >&2; exit 1; }
done
assert_live_values "phase 1 (SDK create)" base
assert_refs "phase 1"
echo "    OK: all four created on the SDK route"

echo "==> Phase 2: force each resource onto Cloud Control (--recreate-via-cc-api)"
# The source and the destination take new names in the same deploy, so their
# recreates create first and delete the generation-1 resources once the
# delivery has moved (issue 6589). The archive is a stateful type, so its
# recreate needs the data-loss acknowledgement; it holds no events this run
# cares about.
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api RerouteArchive --recreate-via-cc-api RerouteDeliverySource \
    --recreate-via-cc-api RerouteDeliveryDestination --recreate-via-cc-api RerouteDelivery \
    --force-stateful-recreation --yes
load_state
# Without this every assertion below would be vacuous.
assert_layers "phase 2 (after --recreate-via-cc-api)" cc-api
# THE MEASURED FORM: Cloud Control records the names and the delivery id too.
assert_ids "phase 2 (after --recreate-via-cc-api)" 2
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
# The generation-1 resources were deleted.
assert_gone_as "generation-1 delivery ${W0[3]} survived its recreate" ResourceNotFoundException \
  aws logs get-delivery --id "${W0[3]}" --region "${REGION}"
assert_gone_as "generation-1 source $(name_of RerouteDeliverySource 1) survived its recreate" ResourceNotFoundException \
  aws logs get-delivery-source --name "$(name_of RerouteDeliverySource 1)" --region "${REGION}"
assert_gone_as "generation-1 destination $(name_of RerouteDeliveryDestination 1) survived its recreate" ResourceNotFoundException \
  aws logs get-delivery-destination --name "$(name_of RerouteDeliveryDestination 1)" --region "${REGION}"
assert_gone_as "generation-1 archive $(name_of RerouteArchive 1) survived its recreate" ResourceNotFoundException \
  aws events describe-archive --archive-name "$(name_of RerouteArchive 1)" --region "${REGION}"
assert_live_values "phase 2 (CC recreate)" seed
assert_refs "phase 2"
echo "    OK: all four pinned to Cloud Control under the SDK-form id, with fresh witnesses"

echo "==> Phase 3: the plan ANNOUNCES each return"
# `announce`, a template no phase deploys: it changes all four, and cdkd diff
# renders the routing token only on a changed resource.
DIFF_OUT=$(env CDKD_TEST_PHASE=announce \
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
echo "    OK: plan says 'returning to SDK provider' for all four"

echo "==> Phase 4: --pin-cc-api DECLINES each flip"
# The delivery is unchanged here: Cloud Control's update handler refuses every
# update of a delivery to a log group (see DELIVERY_VALUE_BY_PHASE in the
# stack), so only the other three exercise the pin.
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
# Without this, "still cc-api" is equally explained by a NO_CHANGE deploy (as
# it is, by design, for the delivery).
assert_live_values "phase 4 (CC update)" pinned
echo "    OK: all four still on Cloud Control, the three updates applied via CC"

# The source and the destination keep their names, and so their ARNs, across a
# recreate: a tag cdkd does not manage, set now, is what a recreate in phase 5
# would lose. Set after phase 4 so that only the flip's update can touch it.
for id in RerouteDeliverySource RerouteDeliveryDestination; do
  arn=$(arn_of "${id}" "$(record "${id}" '.physicalId')")
  aws logs tag-resource --resource-arn "${arn}" --tags "${WITNESS_KEY}=${WITNESS_VALUE}" --region "${REGION}"
  [ "$(tag_value "${arn}" "${WITNESS_KEY}")" = "${WITNESS_VALUE}" ] ||
    { echo "FAIL: the out-of-band witness tag did not land on ${id} (${arn})" >&2; exit 1; }
done

echo "==> Phase 5: THE ARM -- redeploy unpinned; each flip must be churn-free"
env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
assert_layers "phase 5 (flip)" sdk
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  p2=$(record "${id}" '.physicalId')
  [ "${p2}" = "${P1[$i]}" ] || {
    echo "FAIL: PHYSICAL ID CHURN across ${id}'s flip: ${P1[$i]} -> ${p2}. This type must not carry an 'sdk-coverage' exemption." >&2
    exit 1
  }
  w2=$(witness "${id}" "${p2}") ||
    { echo "FAIL: phase 5: cannot read ${id}'s identity witness through the flipped id ${p2}" >&2; exit 1; }
  [ "${w2}" = "${W1[$i]}" ] || {
    echo "FAIL: ${id}'s witness changed across the flip (${W1[$i]} -> ${w2}); the SDK provider replaced it" >&2
    exit 1
  }
done
for id in RerouteDeliverySource RerouteDeliveryDestination; do
  arn=$(arn_of "${id}" "$(record "${id}" '.physicalId')")
  got=$(tag_value "${arn}" "${WITNESS_KEY}")
  [ "${got}" = "${WITNESS_VALUE}" ] || {
    echo "FAIL: ${id} lost its out-of-band witness tag across the flip (now '${got}'); the SDK provider replaced it" >&2
    exit 1
  }
done
assert_ids "phase 5 (flip)" 2
# The update reached AWS through the id Cloud Control recorded.
assert_live_values "phase 5 (SDK update)" flip
assert_refs "phase 5"
echo "    OK: same ids and witnesses, all four records flipped to sdk, updates applied in place"

echo "==> Phase 6: drift on the flipped records"
# cdkd drift compares AWS with the snapshot each deploy reads back
# (observedProperties). Nothing changed since the flip, so all four must be
# clean: drift reads each live resource through its flipped record.
set +e
DRIFT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --stack-region "${REGION}" --json 2>/dev/null)
DRIFT_RC=$?
set -e
drift_fail() { # usage: drift_fail <message>
  echo "FAIL: $1" >&2
  printf '%s\n' "${DRIFT_OUT}" >&2
  exit 1
}
for id in "${SUBJECTS[@]}"; do
  bucket=$(jq -r --arg id "${id}" '[.. | objects | to_entries[]
    | select((.value | type) == "array") | .key as $bucket
    | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' \
    <<<"${DRIFT_OUT}" 2>/dev/null || true)
  [ "${bucket}" = "clean" ] || drift_fail "cdkd drift put ${id} in bucket '${bucket}', expected clean"
done
jq -e '[.[].drifted[]] | length == 0' <<<"${DRIFT_OUT}" >/dev/null ||
  drift_fail "cdkd drift reports a drifted resource beside the subjects"
# rc after the buckets, so a non-zero rc names its own cause.
[ "${DRIFT_RC}" -eq 0 ] || drift_fail "cdkd drift exited ${DRIFT_RC} although every subject is clean"
echo "    OK: cdkd drift reported all four clean (rc=0)"

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
assert_gone_as "delivery ${FLIPPED[3]} survived its delete under the flipped id" ResourceNotFoundException \
  aws logs get-delivery --id "${FLIPPED[3]}" --region "${REGION}"
assert_gone_as "source ${FLIPPED[1]} survived its delete under the flipped id" ResourceNotFoundException \
  aws logs get-delivery-source --name "${FLIPPED[1]}" --region "${REGION}"
assert_gone_as "destination ${FLIPPED[2]} survived its delete under the flipped id" ResourceNotFoundException \
  aws logs get-delivery-destination --name "${FLIPPED[2]}" --region "${REGION}"
assert_gone_as "archive ${FLIPPED[0]} survived its delete under the flipped id" ResourceNotFoundException \
  aws events describe-archive --archive-name "${FLIPPED[0]}" --region "${REGION}"
for gen in 1 2; do
  assert_gone_as "event bus ${BUS_PREFIX}${gen} survived the destroy" ResourceNotFoundException \
    aws events describe-event-bus --name "${BUS_PREFIX}${gen}" --region "${REGION}"
  assert_gone_as "log group ${GROUP_PREFIX}${gen} survived the destroy" ResourceNotFoundException \
    aws logs list-tags-log-group --log-group-name "${GROUP_PREFIX}${gen}" --region "${REGION}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-common-types-12 (the archive and the three Logs delivery resources flipped in place under the id both layers record)"

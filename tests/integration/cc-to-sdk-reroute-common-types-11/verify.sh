#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route integ for AWS::RDS::DBProxy and
# AWS::RDS::DBProxyEndpoint (issue 6490, batch 11).
#
# Admission evidence for each type's `'sdk-coverage'` sticky exemption. Both
# layers record the same id for each (the proxy name, the endpoint name).
# Phases: deploy on the SDK route -> force each resource onto Cloud Control
# (--recreate-via-cc-api) under its generation-2 name -> the plan announces
# each return -> --pin-cc-api declines them -> redeploy with a real change:
# each id unchanged, each record flipped to 'sdk', each update reached AWS on
# the same resource and waited for it to be `available` -> drift clean, then
# exactly the out-of-band changes -> destroy on the flipped records.

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

STACK="CdkdCcToSdkRerouteCommonTypes11Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# The names the stack declares (lib/cc-to-sdk-reroute-common-types-11-stack.ts),
# by generation: 1 for the SDK create, 2 from the Cloud Control recreate on.
PROXY_PREFIX="cdkd-reroute-ct11-proxy-"
ENDPOINT_PREFIX="cdkd-reroute-ct11-ep-"
# The IdleClientTimeout the stack declares for each phase value.
IDLE_A=1800
IDLE_B=1700
# How long an out-of-band modify may keep a resource from `available`.
SETTLE_SECONDS=600

# The resources under test, by the logical ids the stack fixes with
# overrideLogicalId. Every per-type helper below has an arm for each.
SUBJECTS=(
  RerouteDBProxy
  RerouteDBProxyEndpoint
)

type_of() { # usage: type_of <logicalId>
  case "$1" in
    RerouteDBProxy) printf 'AWS::RDS::DBProxy' ;;
    RerouteDBProxyEndpoint) printf 'AWS::RDS::DBProxyEndpoint' ;;
    *) echo "FAIL: type_of has no arm for $1" >&2; return 1 ;;
  esac
}

# The name a subject holds in a generation: its physical id on both layers.
name_of() { # usage: name_of <logicalId> <1|2>
  case "$1" in
    RerouteDBProxy) printf '%s%s' "${PROXY_PREFIX}" "$2" ;;
    RerouteDBProxyEndpoint) printf '%s%s' "${ENDPOINT_PREFIX}" "$2" ;;
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

describe_proxy() { # usage: describe_proxy <name> <--query expression>
  aws rds describe-db-proxies --db-proxy-name "$1" --region "${REGION}" --query "DBProxies[0].$2" --output text
}
describe_endpoint() { # usage: describe_endpoint <name> <--query expression>
  aws rds describe-db-proxy-endpoints --db-proxy-endpoint-name "$1" --region "${REGION}" \
    --query "DBProxyEndpoints[0].$2" --output text
}

# The value AWS holds for the mutable property, read through the recorded id:
# the proxy's IdleClientTimeout, the endpoint's security group list.
live_value() { # usage: live_value <logicalId> <physicalId>
  case "$1" in
    RerouteDBProxy) describe_proxy "$2" IdleClientTimeout ;;
    RerouteDBProxyEndpoint) describe_endpoint "$2" "join(' ', sort(VpcSecurityGroupIds || \`[]\`))" ;;
    *) echo "FAIL: live_value has no arm for $1" >&2; return 1 ;;
  esac
}
# The value the stack declares for a phase value, in live_value's spelling.
declared_value() { # usage: declared_value <logicalId> <a|b>
  case "$1:$2" in
    RerouteDBProxy:a) printf '%s' "${IDLE_A}" ;;
    RerouteDBProxy:b) printf '%s' "${IDLE_B}" ;;
    RerouteDBProxyEndpoint:a) output EndpointSgAId ;;
    RerouteDBProxyEndpoint:b) output EndpointSgBId ;;
    *) echo "FAIL: declared_value has no arm for $1:$2" >&2; return 1 ;;
  esac
}

# IDENTITY WITNESS, AWS-minted: the resource id inside the ARN RDS reports for
# the name (`prx-...` for a proxy, `prx-endpoint-...` for an endpoint; a
# re-created proxy or endpoint gets a new one). Read by NAME, so it does not
# echo the record; the record's own ARN attribute must name the same id.
witness() { # usage: witness <logicalId> <physicalId>
  local arn want
  case "$1" in
    RerouteDBProxy)
      arn=$(describe_proxy "$2" DBProxyArn) || return 1
      want="^arn:aws(-[a-z]+)*:rds:${REGION}:${ACCOUNT}:db-proxy:prx-[0-9a-z]+\$" ;;
    RerouteDBProxyEndpoint)
      arn=$(describe_endpoint "$2" DBProxyEndpointArn) || return 1
      want="^arn:aws(-[a-z]+)*:rds:${REGION}:${ACCOUNT}:db-proxy-endpoint:prx-endpoint-[0-9a-z]+\$" ;;
    *) echo "FAIL: witness has no arm for $1" >&2; return 1 ;;
  esac
  grep -qE "${want}" <<<"${arn}" || { echo "FAIL: $1 ($2) reports ARN '${arn}', not the measured form" >&2; return 1; }
  printf '%s' "${arn##*:}"
}

witness_ok() { # usage: witness_ok <witness>
  [ -n "$1" ] && [ "$1" != "None" ]
}

# Names the subject and phase of a read that failed, then fails the caller.
cannot_read() { # usage: cannot_read <message>
  echo "FAIL: $1" >&2
  return 1
}

# Every resource's live value must be the phase's.
assert_live_values() { # usage: assert_live_values <phase-label> <a|b>
  local id pid got want
  for id in "${SUBJECTS[@]}"; do
    pid=$(record "${id}" '.physicalId')
    want=$(declared_value "${id}" "$2") || exit 1
    got=$(live_value "${id}" "${pid}") || { echo "FAIL: $1: cannot read ${id}'s live value through ${pid}" >&2; exit 1; }
    [ "${got}" = "${want}" ] || { echo "FAIL: $1: ${id} (${pid}) holds '${got}', expected '${want}'" >&2; exit 1; }
  done
}

# Each resource must be `available` the moment the deploy returns: Cloud
# Control's handlers wait for it on a create and an update, and so must the
# SDK provider that takes over.
assert_available() { # usage: assert_available <phase-label>
  local id pid st
  for id in "${SUBJECTS[@]}"; do
    pid=$(record "${id}" '.physicalId')
    case "${id}" in
      RerouteDBProxy) st=$(describe_proxy "${pid}" Status) ;;
      RerouteDBProxyEndpoint) st=$(describe_endpoint "${pid}" Status) ;;
    esac || { echo "FAIL: $1: cannot read ${id}'s status through ${pid}" >&2; exit 1; }
    [ "${st}" = "available" ] || { echo "FAIL: $1: ${id} (${pid}) is '${st}' when the deploy returned, not available" >&2; exit 1; }
  done
}

assert_layers() { # usage: assert_layers <phase-label> <sdk|cc-api>
  local id layer
  for id in "${SUBJECTS[@]}"; do
    layer=$(record "${id}" '.provisionedBy')
    [ "${layer}" = "$2" ] || { echo "FAIL: $1: ${id} recorded provisionedBy=${layer}, expected $2" >&2; exit 1; }
  done
}

# Both layers record the name: the generation's, exactly.
assert_names() { # usage: assert_names <phase-label> <1|2>
  local id pid want
  for id in "${SUBJECTS[@]}"; do
    pid=$(record "${id}" '.physicalId')
    want=$(name_of "${id}" "$2") || exit 1
    [ "${pid}" = "${want}" ] || { echo "FAIL: $1: ${id} recorded '${pid}', expected the name ${want}" >&2; exit 1; }
  done
}

# Each Ref / GetAtt the stack outputs must be what CloudFormation returns, on
# either layer, read back from AWS: Ref is the name, the ARN and Endpoint the
# live ones.
assert_refs() { # usage: assert_refs <phase-label>
  local pid arn host
  pid=$(record RerouteDBProxy '.physicalId') || cannot_read "$1: cannot read RerouteDBProxy's state record" || return 1
  arn=$(describe_proxy "${pid}" DBProxyArn) || cannot_read "$1: cannot read RerouteDBProxy's ARN through ${pid}" || return 1
  host=$(describe_proxy "${pid}" Endpoint) || cannot_read "$1: cannot read RerouteDBProxy's Endpoint through ${pid}" || return 1
  [ "$(output ProxyRef)" = "${pid}" ] || { echo "FAIL: $1: Ref of RerouteDBProxy resolved to '$(output ProxyRef)', expected ${pid}" >&2; exit 1; }
  [ "$(output ProxyArn)" = "${arn}" ] || { echo "FAIL: $1: GetAtt RerouteDBProxy.DBProxyArn resolved to '$(output ProxyArn)', expected ${arn}" >&2; exit 1; }
  [ "$(output ProxyEndpoint)" = "${host}" ] || { echo "FAIL: $1: GetAtt RerouteDBProxy.Endpoint resolved to '$(output ProxyEndpoint)', expected ${host}" >&2; exit 1; }
  pid=$(record RerouteDBProxyEndpoint '.physicalId') || cannot_read "$1: cannot read RerouteDBProxyEndpoint's state record" || return 1
  arn=$(describe_endpoint "${pid}" DBProxyEndpointArn) || cannot_read "$1: cannot read RerouteDBProxyEndpoint's ARN through ${pid}" || return 1
  host=$(describe_endpoint "${pid}" Endpoint) || cannot_read "$1: cannot read RerouteDBProxyEndpoint's Endpoint through ${pid}" || return 1
  [ "$(output EndpointRef)" = "${pid}" ] || { echo "FAIL: $1: Ref of RerouteDBProxyEndpoint resolved to '$(output EndpointRef)', expected ${pid}" >&2; exit 1; }
  [ "$(output EndpointArn)" = "${arn}" ] || { echo "FAIL: $1: GetAtt RerouteDBProxyEndpoint.DBProxyEndpointArn resolved to '$(output EndpointArn)', expected ${arn}" >&2; exit 1; }
  [ "$(output EndpointEndpoint)" = "${host}" ] || { echo "FAIL: $1: GetAtt RerouteDBProxyEndpoint.Endpoint resolved to '$(output EndpointEndpoint)', expected ${host}" >&2; exit 1; }
  # The endpoint lives on the proxy under test.
  [ "$(describe_endpoint "${pid}" DBProxyName)" = "$(record RerouteDBProxy '.physicalId')" ] || {
    echo "FAIL: $1: RerouteDBProxyEndpoint (${pid}) is not on the proxy $(record RerouteDBProxy '.physicalId')" >&2
    exit 1
  }
}

# Waits for a resource an out-of-band modify left `modifying` to be
# `available` again: the next modify, and the destroy, are refused until then.
wait_available() { # usage: wait_available <logicalId> <physicalId>
  local deadline=$(( $(date +%s) + SETTLE_SECONDS )) st
  while :; do
    case "$1" in
      RerouteDBProxy) st=$(describe_proxy "$2" Status) ;;
      RerouteDBProxyEndpoint) st=$(describe_endpoint "$2" Status) ;;
    esac || { echo "FAIL: cannot read $1's status through $2" >&2; return 1; }
    [ "${st}" = "available" ] && return 0
    [ "$(date +%s)" -lt "${deadline}" ] || { echo "FAIL: $1 ($2) is still '${st}' ${SETTLE_SECONDS}s after its out-of-band change" >&2; return 1; }
    sleep 10
  done
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
# The proxy secret, read from the stack's outputs once it is deployed.
SECRET_ARN=""

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
  # The secret is deleted without a recovery window; one a failed run left in
  # recovery is removed for good, so the next run's create is not refused.
  if [ -n "${SECRET_ARN}" ]; then
    aws secretsmanager delete-secret --secret-id "${SECRET_ARN}" --force-delete-without-recovery \
      --region "${REGION}" >/dev/null 2>&1
  fi
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
SECRET_ARN=$(output ProxySecretArn)
assert_layers "phase 1 (fresh deploy)" sdk
assert_names "phase 1 (fresh deploy)" 1
assert_available "phase 1 (SDK create)"
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  W0[$i]=$(witness "${id}" "$(record "${id}" '.physicalId')") ||
    { echo "FAIL: phase 1: cannot read ${id}'s identity witness" >&2; exit 1; }
  witness_ok "${W0[$i]}" || { echo "FAIL: no identity witness for ${id}" >&2; exit 1; }
done
assert_live_values "phase 1 (SDK create)" a
assert_refs "phase 1"
echo "    OK: both created on the SDK route"

echo "==> Phase 2: force each resource onto Cloud Control (--recreate-via-cc-api)"
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    "${RECREATE_FLAGS[@]}" --yes
load_state
# Without this every assertion below would be vacuous.
assert_layers "phase 2 (after --recreate-via-cc-api)" cc-api
# THE MEASURED FORM: Cloud Control records the name too.
assert_names "phase 2 (after --recreate-via-cc-api)" 2
assert_available "phase 2 (CC recreate)"
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
# The generation-1 pair was deleted by the recreate.
assert_gone_as "generation-1 endpoint $(name_of RerouteDBProxyEndpoint 1) survived its recreate" DBProxyEndpointNotFoundFault \
  aws rds describe-db-proxy-endpoints --db-proxy-endpoint-name "$(name_of RerouteDBProxyEndpoint 1)" --region "${REGION}"
assert_gone_as "generation-1 proxy $(name_of RerouteDBProxy 1) survived its recreate" DBProxyNotFoundFault \
  aws rds describe-db-proxies --db-proxy-name "$(name_of RerouteDBProxy 1)" --region "${REGION}"
assert_live_values "phase 2 (CC recreate)" b
assert_refs "phase 2"
echo "    OK: both pinned to Cloud Control under the name, with fresh witnesses"

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
echo "    OK: plan says 'returning to SDK provider' for both"

echo "==> Phase 4: --pin-cc-api DECLINES each flip"
env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    "${PIN_FLAGS[@]}" --yes
load_state
assert_layers "phase 4 (--pin-cc-api)" cc-api
assert_available "phase 4 (CC update)"
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
echo "    OK: both still on Cloud Control, updates applied via CC"

echo "==> Phase 5: THE ARM -- redeploy unpinned; each flip must be churn-free"
env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
assert_layers "phase 5 (flip)" sdk
# Wait parity: the SDK update returned only once each resource was available.
assert_available "phase 5 (SDK update)"
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
# The update reached AWS through the id Cloud Control recorded.
assert_live_values "phase 5 (SDK update)" b
assert_refs "phase 5"
echo "    OK: same ids and witnesses, both records flipped to sdk, updates applied in place"

echo "==> Phase 6: drift on the flipped records"
# cdkd drift compares AWS with the snapshot each deploy reads back
# (observedProperties). 6a: nothing changed since the flip, so both must be
# clean. 6b: with the mutable property of each changed out of band, each must
# drift by that property alone, which proves drift reads every live resource
# through its flipped record rather than skipping it.
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
echo "    OK (6a): cdkd drift reported both clean (rc=0)"

# The out-of-band change for each subject, and the property path it drifts.
# Each waits for its resource to be available again, as the destroy needs.
oob_change() { # usage: oob_change <logicalId> <physicalId>
  case "$1" in
    RerouteDBProxy)
      aws rds modify-db-proxy --db-proxy-name "$2" --idle-client-timeout 1500 --region "${REGION}" >/dev/null || return 1 ;;
    RerouteDBProxyEndpoint)
      aws rds modify-db-proxy-endpoint --db-proxy-endpoint-name "$2" \
        --vpc-security-group-ids "$(output EndpointSgAId)" --region "${REGION}" >/dev/null || return 1 ;;
    *) echo "FAIL: oob_change has no arm for $1" >&2; return 1 ;;
  esac
  wait_available "$1" "$2"
}
oob_path() { # usage: oob_path <logicalId>
  case "$1" in
    RerouteDBProxy) printf 'IdleClientTimeout' ;;
    RerouteDBProxyEndpoint) printf 'VpcSecurityGroupIds' ;;
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
  # A list property drifts by its index paths (VpcSecurityGroupIds.0) or as a whole.
  jq -e --arg p "${want}" 'length > 0 and all(. == $p or startswith($p + "."))' <<<"${paths}" >/dev/null ||
    drift_fail "6b: ${id} drifted by ${paths}, expected only ${want}"
done
jq -e --argjson n "${#SUBJECTS[@]}" '[.[].drifted[]] | length == $n' <<<"${DRIFT_OUT}" >/dev/null ||
  drift_fail "6b: cdkd drift reports a drifted resource other than the ${#SUBJECTS[@]} subjects"
[ "${DRIFT_RC}" -ne 0 ] || drift_fail "6b: cdkd drift exited 0 although it reports every subject drifted"
echo "    OK (6b): each subject drifted by its out-of-band change alone (rc=${DRIFT_RC})"

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
assert_gone_as "endpoint ${FLIPPED[1]} survived its delete under the flipped id" DBProxyEndpointNotFoundFault \
  aws rds describe-db-proxy-endpoints --db-proxy-endpoint-name "${FLIPPED[1]}" --region "${REGION}"
assert_gone_as "proxy ${FLIPPED[0]} survived its delete under the flipped id" DBProxyNotFoundFault \
  aws rds describe-db-proxies --db-proxy-name "${FLIPPED[0]}" --region "${REGION}"
# The secret goes without a recovery window: one left in recovery would be
# a leak, and would refuse the next run's create of the same name.
assert_gone_as "proxy secret ${SECRET_ARN} survived the destroy (or is in recovery)" ResourceNotFoundException \
  aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-common-types-11 (the RDS proxy and its endpoint flipped in place under the name both layers record, each available when its update returned)"

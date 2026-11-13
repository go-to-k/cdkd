#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt RDS DBInstance DbiResourceId /
# Endpoint.HostedZoneId / CertificateDetails (issue #6242).
#
# Each used to resolve to the DB instance identifier with only a warning. CDK's
# `instanceResourceId` is `DbiResourceId`, and `grantConnect` builds its
# `rds-db:connect` ARN from it. Asserts every output and the granted ARN match
# `DescribeDBInstances`, then destroys clean. No UPDATE phase: none of these
# attributes changes on an in-place update, and an RDS modify is slow.
# Runtime: ~15 min (an RDS instance create + delete).

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
cd "$(dirname "$0")"

STACK="CdkdRdsDbinstanceGetattAttributesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
DB_ID="cdkdrdsdbinstancegetattattributesexample-db"
ROLE_NAME="${STACK}-app"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws rds delete-db-instance --region "${REGION}" --db-instance-identifier "${DB_ID}" \
    --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1 || true
  for p in $(aws iam list-role-policies --role-name "${ROLE_NAME}" --query 'PolicyNames' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${p}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
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

output_of() { # usage: output_of <output key>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${state}"
}

expect_eq() { # usage: expect_eq <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 is '$2', expected '$3' (physical-id fallback?)" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

echo "==> Deploy"
DEPLOY_LOG="$(mktemp)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
if grep -E 'Unknown attribute (DbiResourceId|Endpoint\.HostedZoneId|CertificateDetails)' "${DEPLOY_LOG}"; then
  echo "FAIL: a physical-id fallback warning was printed (see above)" >&2
  exit 1
fi
rm -f "${DEPLOY_LOG}"

# The fix is on the SDK provider's path; a Cloud Control record carries every
# attribute and would pass this fixture without exercising it.
ROUTE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '[.resources[] | select(.resourceType == "AWS::RDS::DBInstance") | .provisionedBy // "sdk"] | first // empty')"
if [ "${ROUTE}" = "cc-api" ] || [ -z "${ROUTE}" ]; then
  echo "FAIL: the DB instance was provisioned by '${ROUTE:-<none>}', not the SDK provider" >&2
  exit 1
fi
echo "    OK: DB instance provisioned by the SDK provider (${ROUTE})"

DESCRIBED="$(aws rds describe-db-instances --region "${REGION}" --db-instance-identifier "${DB_ID}" \
  --query 'DBInstances[0]' --output json)"
LIVE_DBI="$(jq -r '.DbiResourceId' <<<"${DESCRIBED}")"
case "${LIVE_DBI}" in db-?*) ;; *) echo "FAIL: live DbiResourceId '${LIVE_DBI}'" >&2; exit 1 ;; esac

expect_eq "DbiResourceId output" "$(output_of DbiResourceId)" "${LIVE_DBI}"
expect_eq "EndpointHostedZoneId output" "$(output_of EndpointHostedZoneId)" "$(jq -r '.Endpoint.HostedZoneId' <<<"${DESCRIBED}")"
expect_eq "CertCA output" "$(output_of CertCA)" "$(jq -r '.CertificateDetails.CAIdentifier' <<<"${DESCRIBED}")"

# CloudFormation renders ValidTill as Java's Instant.toString(): UTC, `Z`,
# no fraction when it is zero.
VALID_TILL="$(output_of CertValidTill)"
LIVE_VALID_TILL="$(jq -r '.CertificateDetails.ValidTill' <<<"${DESCRIBED}")"
EXPECTED_VALID_TILL="$(node -e 'process.stdout.write(new Date(process.argv[1]).toISOString().replace(".000Z", "Z"))' "${LIVE_VALID_TILL}")"
expect_eq "CertValidTill output" "${VALID_TILL}" "${EXPECTED_VALID_TILL}"

# The granted ARN names the resource id, not the identifier.
POLICY_NAME="$(aws iam list-role-policies --role-name "${ROLE_NAME}" --query 'PolicyNames[0]' --output text)"
GRANTED="$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name "${POLICY_NAME}" \
  --query 'PolicyDocument.Statement[?Action==`rds-db:connect`].Resource | [0]' --output text)"
case "${GRANTED}" in
  *":dbuser:${LIVE_DBI}/app") echo "    OK: grantConnect ARN names ${LIVE_DBI}" ;;
  *) echo "FAIL: grantConnect ARN '${GRANTED}' does not name ${LIVE_DBI}" >&2; exit 1 ;;
esac

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "DB instance ${DB_ID} still exists after destroy" aws rds describe-db-instances --region "${REGION}" --db-instance-identifier "${DB_ID}"
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: DB instance, role and state gone"

echo ""
echo "[verify] PASS — rds-dbinstance-getatt-attributes: DbiResourceId, Endpoint.HostedZoneId and CertificateDetails match DescribeDBInstances, and grantConnect names the resource id"

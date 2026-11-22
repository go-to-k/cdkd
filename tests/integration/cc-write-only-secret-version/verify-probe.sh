#!/usr/bin/env bash
# verify.sh -- a Cloud Control update leaves an unchanged secret-referenced
# write-only password unsent ONLY at the secret version the state record
# attests was last sent (go-to-k/cdkd#6824).
#
# A Redshift Serverless namespace's AdminUserPassword is a CDK-generated secret
# passed as {{resolve:secretsmanager:...}}; its re-send makes UpdateNamespace
# re-set the password. Every "the password is in effect" check LOGS IN through
# the Redshift Data API with the secret's CURRENT value (--secret-arn).
#
#   1  deploy; login works.
#   2  Tags-only deploy: the password is left out (cdkd's debug line), and
#      CloudTrail records no UpdateNamespace carrying adminUserPassword.
#   3  put-secret-value (V2), Tags-only deploy: re-sent; login with V2 works.
#   4  AWSCURRENT moved back to V1, Tags-only deploy: re-sent; login works.
#   5  rotate (V3), deploy with a queue failing AFTER the namespace update: the
#      rollback restores the recorded version (login at V3 fails), then a
#      Tags-only deploy re-sends; login works.
#   6  rotate (V4), deploy whose namespace update applies the password and then
#      fails (an aws:-prefixed tag): the record written AHEAD names no version.
#      The journal is removed (a killed deploy writes none), AWSCURRENT moved
#      back to V3, Tags-only deploy: re-sent; login works.
#   7  a record as an older cdkd wrote it (the attestation stripped from
#      state.json): the first Tags-only deploy re-sends, the next leaves it out.
#   8  CloudTrail anchor: phase 3's re-send is recorded, phases 2 and 7b's
#      windows hold no password call.
#
# Secret values are generated and compared inside node and never printed.

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
. ../s3-versions.sh

STACK="CdkdCcWriteOnlySecretVersionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
NS_NAME="cdkd-wo-secret-ns"
WG_NAME="cdkd-wo-secret-wg"
QUEUE_NAME="CdkdCcWriteOnlySecretVersion-failing"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"
SECRET_ARN=""
SKIP_LINE="AdminUserPassword is left out of the patch"

state_output() { # state_output <output name>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).outputs?.[process.argv[1]];process.stdout.write(v===undefined?"":String(v))})' "$1"
}
current_version() { # the secret's AWSCURRENT version id (metadata, not a value)
  aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" --region "${REGION}" \
    --output json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).VersionIdsToStages??{};const c=Object.keys(v).filter(k=>v[k].includes("AWSCURRENT"));process.stdout.write(c.length===1?c[0]:"")})'
}
rotate() { # put a new generated password (never printed); prints the new version id
  local body
  body="$(node -e 'const c=require("crypto");process.stdout.write(JSON.stringify({username:"cdkdadmin",password:"Rt9"+c.randomBytes(12).toString("hex")+"Qz"}))')"
  # On stdin, never in argv (visible to `ps`).
  printf '%s' "${body}" | aws secretsmanager put-secret-value --secret-id "${SECRET_ARN}" \
    --secret-string file:///dev/stdin --region "${REGION}" --query VersionId --output text
}
stage_back() { # stage_back <version id>: move AWSCURRENT to it
  local to="$1" from
  from="$(current_version)"
  aws secretsmanager update-secret-version-stage --secret-id "${SECRET_ARN}" \
    --version-stage AWSCURRENT --move-to-version-id "${to}" --remove-from-version-id "${from}" \
    --region "${REGION}" >/dev/null
  [ "$(current_version)" = "${to}" ] || { echo "FAIL: AWSCURRENT did not move to the old version" >&2; exit 1; }
}
login() { # prints "ok" when the Data API logs in with the secret's CURRENT value, "refused" on an auth failure; returns 1 when undetermined
  local id status err i
  id="$(aws redshift-data execute-statement --workgroup-name "${WG_NAME}" --database dev \
    --secret-arn "${SECRET_ARN}" --sql 'select 1' --region "${REGION}" --query Id --output text)" || return 1
  for i in $(seq 1 60); do
    status="$(aws redshift-data describe-statement --id "${id}" --region "${REGION}" --query Status --output text)" || return 1
    case "${status}" in
      FINISHED) echo ok; return 0 ;;
      FAILED | ABORTED)
        err="$(aws redshift-data describe-statement --id "${id}" --region "${REGION}" --query Error --output text)" || return 1
        if grep -qiE 'password|authenticat' <<<"${err}"; then echo refused; return 0; fi
        echo "login undetermined (${status}): ${err}" >&2
        return 1
        ;;
    esac
    sleep 5
  done
  echo "login statement ${id} did not finish" >&2
  return 1
}
login_result() { # login_result: "ok" / "refused", hard-failing the run when undetermined
  local r
  r="$(login)" || { echo "FAIL: the login check could not be determined" >&2; exit 1; }
  printf '%s' "${r}"
}
expect_login() {
  local n r
  for n in $(seq 1 12); do r="$(login_result)"; echo "    [probe] $1 attempt $n at $(date -u +%T): $r"; [ "$r" = ok ] && { echo "    OK: $1"; return 0; }; sleep 30; done
  echo "FAIL: $1 (login refused after 6 tries)" >&2; exit 1
}
expect_login_refused() {
  local n r
  for n in $(seq 1 12); do r="$(login_result)"; echo "    [probe] $1 attempt $n at $(date -u +%T): $r"; [ "$r" = refused ] && { echo "    OK: $1"; return 0; }; sleep 30; done
  echo "FAIL: $1 (login accepted after 12 tries)" >&2; exit 1
}
deploy() { # deploy <log name> <tag> [fail mode]; returns cdkd's exit code
  local log="$1" tag="$2" fail="${3:-}" rc
  set +e
  if [ -n "${fail}" ]; then
    WOS_TAG="${tag}" WOS_FAIL="${fail}" node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose >"${LOG_DIR}/${log}.log" 2>&1
  else
    env -u WOS_FAIL WOS_TAG="${tag}" node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose >"${LOG_DIR}/${log}.log" 2>&1
  fi
  rc=$?
  set -e
  grep -E 'Deploy|deploy|FAIL|Error|error|rolled|Rollback' "${LOG_DIR}/${log}.log" | tail -20 | sed 's/^/  /' || true
  return "${rc}"
}
expect_deploy() { # expect_deploy <log name> <tag>
  deploy "$1" "$2" || { echo "FAIL: deploy $1 failed" >&2; exit 1; }
}
expect_skipped() { # expect_skipped <log name>
  if grep -qF -- "${SKIP_LINE}" "${LOG_DIR}/$1.log"; then echo "    OK: $1 left the password out"
  else echo "FAIL: $1 re-sent an unchanged password" >&2; exit 1; fi
}
expect_sent() { # expect_sent <log name>
  if grep -qF -- "${SKIP_LINE}" "${LOG_DIR}/$1.log"; then
    echo "FAIL: $1 left the password out although it must be re-sent" >&2
    exit 1
  fi
  echo "    OK: $1 re-sent the password"
}
recorded_versions() { # the state record's versions for the password token ("" when none)
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).resources?.Ns?.referenceProvenance??{};const e=Object.entries(p).find(([t])=>t.includes("SecretString:password"));process.stdout.write(e&&Array.isArray(e[1].versions)?e[1].versions.join(","):"")})'
}
no_plaintext_in() { # no_plaintext_in <log name>: the secret's current value never reaches a log
  local raw
  raw="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ARN}" --region "${REGION}" --query SecretString --output text)" || return 1
  # The value reaches node on stdin, never as an argument (argv is visible to `ps`).
  if printf '%s' "${raw}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).password;process.exit(require("fs").readFileSync(process.argv[1],"utf8").includes(p)?0:1)})' "${LOG_DIR}/$1.log"; then
    echo "FAIL: $1's log carries the secret's plaintext" >&2
    exit 1
  fi
}
password_calls() { # password_calls <start epoch> <end epoch>: UpdateNamespace calls carrying adminUserPassword
  aws cloudtrail lookup-events --region "${REGION}" \
    --lookup-attributes AttributeKey=EventName,AttributeValue=UpdateNamespace \
    --start-time "$1" --end-time "$2" --output json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).Events.map(e=>JSON.parse(e.CloudTrailEvent)).filter(e=>e.requestParameters?.namespaceName===process.argv[1]&&Object.hasOwn(e.requestParameters,"adminUserPassword")).length;process.stdout.write(String(n))})' "${NS_NAME}"
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && env -u WOS_FAIL node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  if aws redshift-serverless get-workgroup --workgroup-name "${WG_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    aws redshift-serverless delete-workgroup --workgroup-name "${WG_NAME}" --region "${REGION}" >/dev/null 2>&1
    for _ in $(seq 1 60); do
      gone_probe aws redshift-serverless get-workgroup --workgroup-name "${WG_NAME}" --region "${REGION}" && break
      sleep 10
    done
  fi
  if aws redshift-serverless get-namespace --namespace-name "${NS_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    aws redshift-serverless delete-namespace --namespace-name "${NS_NAME}" --region "${REGION}" >/dev/null 2>&1
  fi
  [ -n "${SECRET_ARN}" ] && aws secretsmanager delete-secret --secret-id "${SECRET_ARN}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
  local url
  url="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)"
  [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null 2>&1 || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  fi
  rm -rf "${LOG_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
LOG_DIR="$(mktemp -d)"

echo "==> Phase 1: deploy (generated secret, namespace, workgroup)"
expect_deploy p1 one
SECRET_ARN="$(state_output SecretArn)"
[ -n "${SECRET_ARN}" ] || { echo "FAIL: SecretArn output missing" >&2; exit 1; }
V1="$(current_version)"
[ -n "${V1}" ] || { echo "FAIL: no single AWSCURRENT version" >&2; exit 1; }
expect_login "login with the generated password"
[ "$(recorded_versions)" = "${V1}" ] || { echo "FAIL: the record does not name the sent version" >&2; exit 1; }
echo "    OK: the record names the version it sent"

echo "==> Phase 2: Tags-only deploy -- the unchanged password is left out"
P2_START="$(date -u +%s)"
expect_deploy p2 two
P2_END="$(date -u +%s)"
expect_skipped p2
expect_login "login after the Tags-only deploy"

echo "==> Phase 3: put-secret-value, Tags-only deploy -- re-sent, the new password is in effect"
V2="$(rotate)"
P3_START="$(date -u +%s)"
expect_deploy p3 three
P3_END="$(date -u +%s)"
expect_sent p3
expect_login "login with the rotated password"
[ "$(recorded_versions)" = "${V2}" ] || { echo "FAIL: the record does not name the rotated version" >&2; exit 1; }

echo "==> Phase 4: AWSCURRENT moved back to the old version -- re-sent"
stage_back "${V1}"
expect_deploy p4 four
expect_sent p4
expect_login "login after the stage moved back"

echo "==> Phase 5: rotate, deploy failing AFTER the namespace update -- expect FAILURE and a rollback"
V3="$(rotate)"
if deploy p5 five after; then
  echo "FAIL: the deploy unexpectedly SUCCEEDED (the failing queue did not fail)" >&2
  exit 1
fi
echo "    OK: the deploy failed"
expect_login_refused "the rollback restored the recorded (pre-rotation) password, so the current one is refused"
if ! gone_probe aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"; then
  echo "FAIL: failing queue ${QUEUE_NAME} exists -- the invalid CreateQueue should have been rejected" >&2
  exit 1
fi
expect_deploy p5b six
expect_sent p5b
expect_login "login after the deploy following the rollback"

echo "==> Phase 6: rotate, the namespace update applies the password then fails -- the partial apply"
V3_NOW="$(current_version)"
V4="$(rotate)"
if deploy p6 seven tag; then
  echo "FAIL: the deploy unexpectedly SUCCEEDED (the aws: tag was accepted)" >&2
  exit 1
fi
echo "    OK: the deploy failed"
# The premise: the failed update DID apply the rotated password. Without it
# this phase proves nothing about a partial apply.
expect_login "premise: the failed update applied the rotated password"
[ -z "$(recorded_versions)" ] || { echo "FAIL: the record still names a version after a failed rotated send (no write-ahead)" >&2; exit 1; }
echo "    OK: the record written ahead names no version"
# A killed deploy writes no journal; the record written ahead is then the only guard.
aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY}" --region "${REGION}" >/dev/null
stage_back "${V3_NOW}"
expect_deploy p6b eight
expect_sent p6b
expect_login "login at the moved-back version after the partial apply"
[ "${V4}" != "${V3_NOW}" ] || { echo "FAIL: rotate did not change the version" >&2; exit 1; }

echo "==> Phase 7: a record an older cdkd wrote (no attestation) -- the first deploy re-sends"
expect_deploy p7 nine
expect_skipped p7
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s);let n=0;for(const e of Object.values(st.resources?.Ns?.referenceProvenance??{})){if(e&&e.versionsSent){delete e.versionsSent;n++}}if(n===0){console.error("FAIL: no attestation to strip");process.exit(1)}process.stdout.write(JSON.stringify(st))})' \
  >"${LOG_DIR}/legacy-state.json"
aws s3 cp "${LOG_DIR}/legacy-state.json" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
expect_deploy p7a ten
expect_sent p7a
P7B_START="$(date -u +%s)"
expect_deploy p7b eleven
P7B_END="$(date -u +%s)"
expect_skipped p7b
expect_login "login after the legacy-record deploys"

for log in p1 p2 p3 p4 p5 p5b p6 p6b p7 p7a p7b; do no_plaintext_in "${log}"; done
echo "    OK: no log carries the secret's current plaintext"

echo "==> Phase 8: CloudTrail -- the re-send is recorded, the left-out windows hold none"
P3_CALLS=0
for _ in $(seq 1 40); do
  P3_CALLS="$(password_calls "${P3_START}" "${P3_END}")"
  [ "${P3_CALLS}" -ge 1 ] && break
  sleep 30
done
[ "${P3_CALLS}" -ge 1 ] || { echo "FAIL: CloudTrail never recorded phase 3's password re-send (anchor)" >&2; exit 1; }
echo "    OK: phase 3's re-send is in CloudTrail (${P3_CALLS})"
[ "$(password_calls "${P2_START}" "${P2_END}")" = "0" ] || { echo "FAIL: phase 2 sent the password" >&2; exit 1; }
[ "$(password_calls "${P7B_START}" "${P7B_END}")" = "0" ] || { echo "FAIL: phase 7b sent the password" >&2; exit 1; }
echo "    OK: no password call in the left-out windows"

echo "==> Destroy"
env -u WOS_FAIL node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "workgroup ${WG_NAME} still exists after destroy" \
  aws redshift-serverless get-workgroup --workgroup-name "${WG_NAME}" --region "${REGION}"
assert_gone "namespace ${NS_NAME} still exists after destroy" \
  aws redshift-serverless get-namespace --namespace-name "${NS_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true

trap - EXIT INT TERM
cleanup
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "cc-write-only-secret-version state teardown"
echo "[verify] PASS -- an unchanged secret-referenced password is left out only at its attested version (go-to-k/cdkd#6824)"

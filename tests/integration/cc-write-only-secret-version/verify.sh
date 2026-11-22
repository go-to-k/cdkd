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
#   5  rotate (V3), deploy with a queue failing AFTER the namespace update
#      (--no-rollback), then `cdkd rollback`: it restores the recorded version
#      (login at V3 fails), then a Tags-only deploy re-sends; login works.
#   6  rotate (V4), kill -9 cdkd once UpdateNamespace applied it: the record on
#      disk is the one written AHEAD (no version) and no journal exists.
#      AWSCURRENT moved back to V3, Tags-only deploy: re-sent; login works.
#   5  (also: AWSCURRENT moved to the recorded version logs in, so the
#      rollback restored exactly that password.)
#   7  a record as a v12-v17 cdkd wrote it (the attestation stripped) and as a
#      v11 cdkd wrote it (no referenceProvenance): each first Tags-only deploy
#      re-sends, the next leaves it out.
#   9  a final rotation and re-send, the CloudTrail anchor.
#   8  CloudTrail (checked last): phases 3, 7a, 7c and 9 re-sent, phases 2
#      and 7b's windows hold no password call.
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
# A Redshift Serverless password change takes minutes to reach logins after
# UpdateNamespace returns (measured ~2 min), so each expectation is retried
# for up to 10 minutes before it fails.
await_login() { # await_login <ok|refused> <description>
  local i got
  for i in $(seq 1 20); do
    got="$(login_result)"
    [ "${got}" = "$1" ] && { echo "    OK: $2 (attempt ${i})"; return 0; }
    sleep 30
  done
  echo "FAIL: $2 (login ${got} after 20 tries)" >&2
  exit 1
}
expect_login() { await_login ok "$1"; }
expect_login_refused() { await_login refused "$1"; }
ns_status() { # the namespace's status, "GONE" when it does not exist; returns 1 on another failure
  local out
  if out="$(aws redshift-serverless get-namespace --namespace-name "${NS_NAME}" --region "${REGION}" \
    --query namespace.status --output text 2>&1)"; then
    printf '%s' "${out}"
    return 0
  fi
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}" || return 1
  printf 'GONE'
}
ns_available() { # wait until the namespace settles: a password change keeps it MODIFYING for minutes
  local i st
  for i in $(seq 1 90); do
    st="$(ns_status)" || { echo "FAIL: namespace status undetermined" >&2; exit 1; }
    case "${st}" in AVAILABLE | GONE) return 0 ;; esac
    sleep 10
  done
  echo "FAIL: namespace ${NS_NAME} did not settle (status ${st})" >&2
  exit 1
}
deploy() { # deploy <log name> <tag> [fail mode] [extra flag]; returns cdkd's exit code
  local log="$1" tag="$2" fail="${3:-}" extra="${4:-}" rc
  ns_available
  set +e
  if [ -n "${fail}" ] && [ -n "${extra}" ]; then
    WOS_TAG="${tag}" WOS_FAIL="${fail}" node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose "${extra}" >"${LOG_DIR}/${log}.log" 2>&1
  elif [ -n "${fail}" ]; then
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
  ns_settled_after_change
}
ns_settled_after_change() { # a re-sent password flips the namespace to MODIFYING a little AFTER
  # the update returns; an update sent before it settles waits on it until the
  # handler gives up ("Exceeded attempts to wait", measured). Wait for the flip
  # (up to 2 min), then for AVAILABLE.
  local i st
  for i in $(seq 1 24); do
    st="$(ns_status)" || { echo "FAIL: namespace status undetermined" >&2; exit 1; }
    [ "${st}" != AVAILABLE ] && break
    sleep 5
  done
  ns_available
}
state_body() { # the state.json body; returns 1 on a read failure
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")" || return 1
  printf '%s' "${body}"
}
recorded_versions() { # the state record's versions for the password token ("" when none); exits on a read failure
  local body
  body="$(state_body)" || { echo "FAIL: could not read ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${body}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).resources?.Ns?.referenceProvenance??{};const e=Object.entries(p).find(([t])=>t.includes("SecretString:password"));process.stdout.write(e&&Array.isArray(e[1].versions)?e[1].versions.join(","):"")})'
}
expect_recorded() { # expect_recorded <description> <expected versions ("" for none)>
  local got
  got="$(recorded_versions)" || exit 1
  [ "${got}" = "$2" ] || { echo "FAIL: $1 (recorded: '${got}')" >&2; exit 1; }
  echo "    OK: $1"
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
    # Not gone_probe: it exits on an undetermined probe, which would skip the
    # rest of this teardown. Report it and carry on instead.
    local wg_out
    for _ in $(seq 1 60); do
      if wg_out="$(aws redshift-serverless get-workgroup --workgroup-name "${WG_NAME}" --region "${REGION}" 2>&1)"; then
        sleep 10
        continue
      fi
      grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${wg_out}" \
        || echo "WARN: cleanup: workgroup ${WG_NAME} probe undetermined: ${wg_out}" >&2
      break
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
expect_recorded "the record names the version it sent" "${V1}"

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
expect_recorded "the record names the rotated version" "${V2}"

echo "==> Phase 4: AWSCURRENT moved back to the old version -- re-sent"
stage_back "${V1}"
expect_deploy p4 four
expect_sent p4
expect_login "login after the stage moved back"

echo "==> Phase 5: rotate, deploy failing AFTER the namespace update (--no-rollback), then cdkd rollback"
# Not the automatic rollback: a password change keeps the namespace MODIFYING
# for minutes, and the Cloud Control handler's revert, sent seconds after the
# forward update, waits on it and gives up ("Exceeded attempts to wait"; it never
# calls UpdateNamespace). Measured twice. `--no-rollback` then `cdkd rollback`
# once the namespace settles reaches the same restore (the journaled pre-op
# record, pinned to its recorded version).
V3="$(rotate)"
if deploy p5 five after --no-rollback; then
  echo "FAIL: the deploy unexpectedly SUCCEEDED (the failing queue did not fail)" >&2
  exit 1
fi
echo "    OK: the deploy failed"
ns_available
set +e
node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose \
  >"${LOG_DIR}/p5r.log" 2>&1
RB_RC=$?
set -e
grep -E 'Rollback|rollback|FAIL|Error|error' "${LOG_DIR}/p5r.log" | tail -10 | sed 's/^/  /' || true
[ "${RB_RC}" -eq 0 ] || { echo "FAIL: cdkd rollback exited ${RB_RC}" >&2; exit 1; }
ns_available
expect_login_refused "the rollback restored the recorded (pre-rotation) password, so the current one is refused"
# ...and positively: the restored password IS the recorded version's.
stage_back "${V1}"
expect_login "login with the recorded version after the rollback"
stage_back "${V3}"
if ! gone_probe aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"; then
  echo "FAIL: failing queue ${QUEUE_NAME} exists -- the invalid CreateQueue should have been rejected" >&2
  exit 1
fi
expect_deploy p5b six
expect_sent p5b
expect_login "login after the deploy following the rollback"

echo "==> Phase 6: rotate, kill cdkd once AWS applied the password -- the partial apply"
# No AWS-side refusal makes this update fail AFTER UpdateNamespace: the handler
# validates every field (an aws:-prefixed tag included) before it writes
# (measured). A killed deploy is the case the write-ahead exists for anyway: it
# writes no journal and no failure save, so the record on disk is the one saved
# ahead. The kill lands once the namespace leaves AVAILABLE, which only
# UpdateNamespace does, and before cdkd records the update (Cloud Control
# answers a few seconds later).
V3_NOW="$(current_version)"
V4="$(rotate)"
ns_available
env -u WOS_FAIL WOS_TAG=seven perl -e 'setpgrp(0,0); exec @ARGV or die' \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --yes --verbose >"${LOG_DIR}/p6.log" 2>&1 &
P6_PID=$!
P6_STATUS=AVAILABLE
for _ in $(seq 1 1200); do
  kill -0 "${P6_PID}" 2>/dev/null || break
  P6_STATUS="$(ns_status)" || { echo "FAIL: namespace status undetermined" >&2; exit 1; }
  [ "${P6_STATUS}" != AVAILABLE ] && break
  sleep 0.5
done
kill -9 -- "-${P6_PID}" 2>/dev/null || true
wait "${P6_PID}" 2>/dev/null || true
[ "${P6_STATUS}" != AVAILABLE ] || { echo "FAIL: premise: the namespace never left AVAILABLE before the deploy ended" >&2; exit 1; }
echo "    OK: killed the deploy after UpdateNamespace (namespace ${P6_STATUS})"
# The premise, from the record: the kill landed before cdkd recorded the update.
expect_recorded "premise and guard: the record on disk is the one written ahead (no version)" ""
# The update kept running in AWS after the kill: the rotated password is live.
ns_available
expect_login "premise: AWS applied the rotated password before the kill"
BODY="$(state_body)" || { echo "FAIL: could not read ${STATE_KEY}" >&2; exit 1; }
if printf '%s' "${BODY}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=JSON.parse(s).resources?.Ns?.unsettledProperties??[];process.exit(u.includes("AdminUserPassword")?0:1)})'; then
  echo "FAIL: AdminUserPassword is unsettled, so the unsettled arm, not the write-ahead, would re-send it" >&2
  exit 1
fi
echo "    OK: AdminUserPassword is not unsettled (the write-ahead alone guards the next deploy)"
assert_gone "a rollback journal exists, so the journal arm, not the write-ahead, would re-send" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}" --region "${REGION}"
echo "    OK: the kill wrote no journal"
# The killed run's own lock (expiresAt in the future) would refuse the next deploy.
node "${LOCAL_DIST}" force-unlock "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --yes >/dev/null
stage_back "${V3_NOW}"
expect_deploy p6b eight
expect_sent p6b
expect_login "login at the moved-back version after the partial apply"
[ "${V4}" != "${V3_NOW}" ] || { echo "FAIL: rotate did not change the version" >&2; exit 1; }

echo "==> Phase 7: a record an older cdkd wrote (no attestation) -- the first deploy re-sends"
expect_deploy p7 nine
expect_skipped p7
# rewrite_state <node expression over st>: edit state.json in place (an older binary's shape).
rewrite_state() {
  local body
  body="$(state_body)" || { echo "FAIL: could not read ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${body}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s);const n=new Function("st",process.argv[1])(st);if(!n){console.error("FAIL: nothing to rewrite");process.exit(1)}process.stdout.write(JSON.stringify(st))})' "$1" \
    >"${LOG_DIR}/legacy-state.json"
  aws s3 cp "${LOG_DIR}/legacy-state.json" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
}
# 7a: a plain singleton (a v12-v17 binary's write): the attestation stripped.
rewrite_state 'let n=0;for(const e of Object.values(st.resources?.Ns?.referenceProvenance??{})){if(e&&e.versionsSent){delete e.versionsSent;n++}}st.version=17;return n'
P7A_START="$(date -u +%s)"
expect_deploy p7a ten
P7A_END="$(date -u +%s)"
expect_sent p7a
P7B_START="$(date -u +%s)"
expect_deploy p7b eleven
P7B_END="$(date -u +%s)"
expect_skipped p7b
# 7c: a v11 record (no referenceProvenance at all). The version label stays
# what it is: every reader keys on the FIELD (absent = the v11 path), never on
# `version`, so the record body is exactly what a v11 binary left.
rewrite_state 'const r=st.resources?.Ns;if(!r||r.referenceProvenance===undefined)return 0;delete r.referenceProvenance;st.version=17;return 1'
P7C_START="$(date -u +%s)"
expect_deploy p7c twelve
P7C_END="$(date -u +%s)"
expect_sent p7c
expect_deploy p7d thirteen
expect_skipped p7d
expect_login "login after the legacy-record deploys"

echo "==> Phase 9: a final rotation -- its re-send is the CloudTrail anchor (it lands after every window below)"
rotate >/dev/null
P9_START="$(date -u +%s)"
expect_deploy p9 fourteen
P9_END="$(date -u +%s)"
expect_sent p9
expect_login "login after the final rotation"

for log in p1 p2 p3 p4 p5 p5r p5b p6 p6b p7 p7a p7b p7c p7d p9; do no_plaintext_in "${log}"; done
echo "    OK: no log carries the secret's current plaintext"

echo "==> Phase 8: CloudTrail -- re-sends recorded, the left-out windows hold none"
# The LAST re-send is the anchor: once it is delivered, every earlier window is.
P9_CALLS=0
for _ in $(seq 1 40); do
  P9_CALLS="$(password_calls "${P9_START}" "${P9_END}")"
  [ "${P9_CALLS}" -ge 1 ] && break
  sleep 30
done
[ "${P9_CALLS}" -ge 1 ] || { echo "FAIL: CloudTrail never recorded phase 9's password re-send (anchor)" >&2; exit 1; }
echo "    OK: phase 9's re-send is in CloudTrail (${P9_CALLS})"
for w in "3 ${P3_START} ${P3_END}" "7a ${P7A_START} ${P7A_END}" "7c ${P7C_START} ${P7C_END}"; do
  set -- ${w}
  [ "$(password_calls "$2" "$3")" -ge 1 ] || { echo "FAIL: phase $1 re-sent no password in CloudTrail" >&2; exit 1; }
  echo "    OK: phase $1's re-send is in CloudTrail"
done
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

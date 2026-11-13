#!/usr/bin/env bash
# verify.sh -- cdkd NoEcho value MACs on a RestApi Body (go-to-k/cdkd#6146).
# The OpenAPI Body embeds a NoEcho parameter's value and is write-only, so cdkd
# decides whether to put it again from the KMS MAC of the value it last sent.
# A put in overwrite mode deletes every resource outside the definition, so a
# resource added out of band is the probe: it survives a deploy that does not
# put the Body and is deleted by one that does.
#
# Phase 0 makes sure the region's MAC key exists (`cdkd bootstrap --no-assets`
# on the existing state bucket creates only what is missing; the key is
# bootstrap infrastructure and is kept). Phase 1 creates the API with value A
# and records a MAC. Phase 2 redeploys value A with an ordinary Description
# change: the Body is NOT put (the probe survives, no stop-gap warning).
# Phase 3 deploys value B: the Body IS put (the probe is gone).
#
# go-to-k/cdkd#6209: the Body also reads the queue's Fn::GetAtt Arn, so a MAC
# match settles it only through the input fingerprint bound to the MAC entry
# (`cdkd:inputs`). Phase 2b redeploys the phase 2 template unchanged: no put,
# no stop-gap warning. Before #6209 both phases fell back to the stop-gap.
# Phase 4 keeps value B and moves only the GetAtt input the binding alone can
# see: the queue's recorded Arn is edited out of band and the Body's #4543
# input fingerprint dropped (as an older writer leaves it), so the deploy
# re-baselines that one to today's inputs. The MAC matches, the binding does
# not: the Body takes the stop-gap (the `readsOther` line, no put, never a
# skip). A binding that ignored its inputs would settle it silently instead.

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

STACK="CdkdNoechoRestapiBodyMac"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
API_NAME="${STACK}-api"
RUN_ID="${RUN_ID:-$(date +%s)}"
VALUE_A="noecho-mac-a-${RUN_ID}"
VALUE_B="noecho-mac-b-${RUN_ID}"
# Unique per run: SQS refuses to re-create a name deleted under 60 s ago.
QUEUE_NAME="${STACK}-q-${RUN_ID}"
export CDKD_TEST_NOECHO_MAC_QUEUE="${QUEUE_NAME}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

api_ids_named() { # every id of an API with this name (names are not unique)
  aws apigateway get-rest-apis --region "${REGION}" --limit 500 \
    --query "items[?name=='$1'].id" --output text 2>/dev/null
}
one_api_id() {
  local id; id="$(aws apigateway get-rest-apis --region "${REGION}" --limit 500 \
    --query "items[?name=='$1'].id | [0]" --output text)"
  if [ -z "${id}" ] || [ "${id}" = "None" ]; then
    echo "FAIL: no REST API named '$1'" >&2; exit 1
  fi
  printf '%s' "${id}"
}
paths_of() { aws apigateway get-resources --rest-api-id "$1" --region "${REGION}" --query 'items[].path' --output text | tr '\t' '\n' | sort | tr '\n' ' '; }
expect_eq() { # expect_eq <description> <actual> <expected>
  if [ "$2" != "$3" ]; then echo "FAIL: $1: expected '$3', got '$2'" >&2; exit 1; fi
  echo "    OK: $1 = '$3'"
}
body_mac() { # the recorded MAC of Token for the API's Body ('' when none)
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).resources.Api;process.stdout.write(String(r?.noEchoValueMacs?.Body?.Token??""))})'
}
body_binding() { # the input fingerprint bound to the Body's MAC entry ('' when none)
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).resources.Api;process.stdout.write(String(r?.noEchoValueMacs?.Body?.["cdkd:inputs"]?.fingerprint??""))})'
}
expect_settled() { # expect_settled <phase> <log>: the Body was decided by its MAC and bound inputs
  if grep -qF 'could not compare with the value it last sent' "$2"; then
    echo "FAIL: $1 fell back to the no-MAC stop-gap" >&2; exit 1
  fi
  # Sentinel for the line below: the MAC-match line is printed on every MAC
  # match, so a reworded or missing one fails here instead of passing as absent.
  if ! grep -qF 'carry the NoEcho parameter values they were last sent' "$2"; then
    echo "FAIL: $1 printed no MAC match line (wording drifted, or the MAC was not compared)" >&2; exit 1
  fi
  if grep -qF 'also read a value their MACs do not cover' "$2"; then
    echo "FAIL: $1 did not settle the GetAtt-reading Body by its bound input fingerprint" >&2; exit 1
  fi
}
expect_no_plaintext() { # expect_no_plaintext <description> <file>
  if grep -qF -e "${VALUE_A}" -e "${VALUE_B}" "$2"; then echo "FAIL: $1 holds a NoEcho value" >&2; exit 1; fi
  echo "    OK: $1 holds no NoEcho value"
}
deploy_with() { # deploy_with <value> <update:true|false> <log>
  if [ "$2" = "true" ]; then
    CDKD_TEST_NOECHO_MAC_TOKEN="$1" CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose >"$3" 2>&1 \
      || { tail -40 "$3" >&2; echo "FAIL: deploy failed" >&2; exit 1; }
  else
    env -u CDKD_TEST_UPDATE CDKD_TEST_NOECHO_MAC_TOKEN="$1" node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose >"$3" 2>&1 \
      || { tail -40 "$3" >&2; echo "FAIL: deploy failed" >&2; exit 1; }
  fi
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && CDKD_TEST_NOECHO_MAC_TOKEN="${VALUE_A}" node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  local id
  # This run's queue only, by its exact name: a concurrent run's is its own.
  local url
  url="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)"
  case "${url}" in
    "https://"*"/${QUEUE_NAME}") aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 ;;
  esac
  for id in $(api_ids_named "${API_NAME}"); do
    # DeleteRestApi allows one call per 30 s per account.
    aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1 \
      || { sleep 31; aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1; }
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

echo "==> Phase 0: the region's NoEcho value MAC key"
node "${LOCAL_DIST}" bootstrap --no-assets --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${LOG_DIR}/p0.log" 2>&1 \
  || { tail -40 "${LOG_DIR}/p0.log" >&2; echo "FAIL: bootstrap failed" >&2; exit 1; }
if grep -qF 'Created the NoEcho value MAC key' "${LOG_DIR}/p0.log"; then echo "    key: created by this run"
elif grep -qF 'NoEcho value MAC key alias/cdkd-noecho-mac already exists' "${LOG_DIR}/p0.log"; then echo "    key: already existed"
else tail -20 "${LOG_DIR}/p0.log" >&2; echo "FAIL: bootstrap reported neither a created nor an existing MAC key" >&2; exit 1; fi
expect_eq "MAC key spec" "$(aws kms describe-key --key-id alias/cdkd-noecho-mac --region "${REGION}" --query 'KeyMetadata.[KeySpec,KeyState]' --output text | tr '\t' ' ')" "HMAC_256 Enabled"
# The key policy, on every run (a key an earlier run created is checked too):
# the account root, administration plus kms:GenerateMac, never kms:VerifyMac,
# kms:CreateGrant or a wildcard.
KEY_ID="$(aws kms describe-key --key-id alias/cdkd-noecho-mac --region "${REGION}" --query KeyMetadata.KeyId --output text)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
aws kms get-key-policy --key-id "${KEY_ID}" --policy-name default --region "${REGION}" --query Policy --output text >"${LOG_DIR}/key-policy.json"
node -e '
  const [file, account] = process.argv.slice(1);
  const policy = JSON.parse(require("fs").readFileSync(file, "utf8"));
  const admin = ["kms:DescribeKey","kms:GetKeyPolicy","kms:PutKeyPolicy","kms:ListResourceTags","kms:ListGrants","kms:RevokeGrant","kms:CreateAlias","kms:UpdateAlias","kms:DeleteAlias","kms:EnableKey","kms:DisableKey","kms:UpdateKeyDescription","kms:TagResource","kms:UntagResource","kms:ScheduleKeyDeletion","kms:CancelKeyDeletion"];
  const actions = new Set();
  for (const st of policy.Statement) {
    const who = [st.Principal && st.Principal.AWS].flat();
    if (st.Effect !== "Allow" || who.length !== 1 || !/^arn:aws[a-z-]*:iam::\d{12}:root$/.test(who[0]) || !who[0].includes(account)) {
      console.error("FAIL: key policy statement not limited to this account root: " + JSON.stringify(st)); process.exit(1);
    }
    for (const a of [st.Action].flat()) actions.add(a);
  }
  const want = new Set([...admin, "kms:GenerateMac"]);
  const extra = [...actions].filter((a) => !want.has(a));
  const missing = [...want].filter((a) => !actions.has(a));
  if (extra.length || missing.length) { console.error("FAIL: key policy actions differ: extra " + extra + " missing " + missing); process.exit(1); }
  console.log("    OK: key policy is the account root, administration plus kms:GenerateMac only");
' "${LOG_DIR}/key-policy.json" "${ACCOUNT}"

echo "==> Phase 1: create with value A"
deploy_with "${VALUE_A}" false "${LOG_DIR}/p1.log"
API_ID="$(one_api_id "${API_NAME}")"
MAC_A="$(body_mac)"
case "${MAC_A}" in
  kms-hmac-sha256:arn:aws*:kms:*) echo "    OK: the Body's MAC is recorded" ;;
  *) echo "FAIL: no Body MAC recorded after the create (got '${MAC_A}')" >&2; exit 1 ;;
esac
BINDING_A="$(body_binding)"
case "${BINDING_A}" in
  inputs-sha256:*+sha256:*) echo "    OK: the Body's MAC entry is bound to its input fingerprint" ;;
  *) echo "FAIL: no input binding beside the Body MAC (got '${BINDING_A}')" >&2; exit 1 ;;
esac
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${LOG_DIR}/state-1.json" --region "${REGION}" >/dev/null
expect_no_plaintext "state.json" "${LOG_DIR}/state-1.json"
# Positive control: the log being scanned is the deploy's, not an empty file.
grep -qF "${STACK}" "${LOG_DIR}/p1.log" || { echo "FAIL: the phase 1 log does not name the stack" >&2; exit 1; }
expect_no_plaintext "the phase 1 deploy log" "${LOG_DIR}/p1.log"
# GenerateMac ran under the real key policy: the MAC above was recorded, and no
# KMS failure line was printed.
if grep -qF 'NoEcho value MACs unavailable' "${LOG_DIR}/p1.log"; then echo "FAIL: phase 1 could not call kms:GenerateMac" >&2; exit 1; fi

# The probe: a resource the stack does not declare. Only an overwrite put of
# the definition deletes it.
ROOT_ID="$(aws apigateway get-resources --rest-api-id "${API_ID}" --region "${REGION}" --query "items[?path=='/'].id | [0]" --output text)"
aws apigateway create-resource --rest-api-id "${API_ID}" --parent-id "${ROOT_ID}" --path-part probe --region "${REGION}" >/dev/null
expect_eq "paths with the probe" "$(paths_of "${API_ID}")" "/ /probe /spec "

echo "==> Phase 2: value A again, Description changed (the Body must not be put)"
deploy_with "${VALUE_A}" true "${LOG_DIR}/p2.log"
expect_eq "Description updated (the API was updated)" "$(aws apigateway get-rest-api --rest-api-id "${API_ID}" --region "${REGION}" --query description --output text)" "phase-2"
expect_eq "probe survives (no Body put)" "$(paths_of "${API_ID}")" "/ /probe /spec "
# The stop-gap's warning would mean the MAC was not used.
expect_settled "phase 2" "${LOG_DIR}/p2.log"
expect_eq "MAC unchanged" "$(body_mac)" "${MAC_A}"
expect_no_plaintext "the phase 2 deploy log" "${LOG_DIR}/p2.log"

echo "==> Phase 2b: the phase 2 template unchanged (no put, no stop-gap warning)"
deploy_with "${VALUE_A}" true "${LOG_DIR}/p2b.log"
expect_eq "probe survives (no Body put)" "$(paths_of "${API_ID}")" "/ /probe /spec "
expect_settled "phase 2b" "${LOG_DIR}/p2b.log"
expect_eq "MAC unchanged" "$(body_mac)" "${MAC_A}"
expect_eq "input binding unchanged" "$(body_binding)" "${BINDING_A}"
expect_no_plaintext "the phase 2b deploy log" "${LOG_DIR}/p2b.log"

echo "==> Phase 3 preview: cdkd diff with value B names the Body (diff/deploy parity)"
CDKD_TEST_NOECHO_MAC_TOKEN="${VALUE_B}" CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${LOG_DIR}/p3-diff.log" 2>&1 \
  || { tail -40 "${LOG_DIR}/p3-diff.log" >&2; echo "FAIL: cdkd diff failed" >&2; exit 1; }
# Sentinel: the note's second half, so a reworded note fails loudly instead of passing as absent.
if ! grep -qF 'Api.Body read a NoEcho parameter whose value changed' "${LOG_DIR}/p3-diff.log"; then
  if grep -qF 'its recorded MAC differs' "${LOG_DIR}/p3-diff.log"; then
    echo "FAIL: the diff's MAC note was reworded; update this grep" >&2
  else
    echo "FAIL: cdkd diff did not report the changed NoEcho value in the Body" >&2
  fi
  exit 1
fi
expect_no_plaintext "the phase 3 diff output" "${LOG_DIR}/p3-diff.log"

echo "==> Phase 3: value B (the Body must be put)"
deploy_with "${VALUE_B}" true "${LOG_DIR}/p3.log"
if ! grep -qF 'changed since the last deploy' "${LOG_DIR}/p3.log"; then
  echo "FAIL: phase 3 did not report the changed NoEcho value" >&2; exit 1
fi
expect_eq "probe deleted (the Body was put in overwrite mode)" "$(paths_of "${API_ID}")" "/ /spec "
MAC_B="$(body_mac)"
if [ -z "${MAC_B}" ] || [ "${MAC_B}" = "${MAC_A}" ]; then
  echo "FAIL: the MAC did not move with the value" >&2; exit 1
fi
echo "    OK: the MAC moved with the value"
# No log carries a MAC's bytes.
for mac in "${MAC_A##*:}" "${MAC_B##*:}"; do
  if grep -qF -e "${mac}" "${LOG_DIR}"/p*.log; then echo "FAIL: a deploy or diff log holds a MAC" >&2; exit 1; fi
done
echo "    OK: no log holds a MAC"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${LOG_DIR}/state-3.json" --region "${REGION}" >/dev/null
expect_no_plaintext "state.json" "${LOG_DIR}/state-3.json"
expect_no_plaintext "the phase 3 deploy log" "${LOG_DIR}/p3.log"

echo "==> Phase 4: value B again, the queue Arn moved where only the binding sees it (stop-gap, never a skip)"
aws apigateway create-resource --rest-api-id "${API_ID}" --parent-id "${ROOT_ID}" --path-part probe --region "${REGION}" >/dev/null
expect_eq "paths with the probe again" "$(paths_of "${API_ID}")" "/ /probe /spec "
BINDING_3="$(body_binding)"
[ -n "${BINDING_3}" ] || { echo "FAIL: no input binding before phase 4 (two empty values would compare equal)" >&2; exit 1; }
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${LOG_DIR}/state-4-in.json" --region "${REGION}" >/dev/null
node -e '
  const fs = require("fs");
  const [file, out, suffix] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const queue = s.resources.Queue, api = s.resources.Api;
  if (!queue || typeof queue.attributes?.Arn !== "string" || !api?.maskedPropertyInputFingerprints?.Body) {
    console.error("FAIL: phase 4 seed: the state lacks the Queue Arn or the Body input fingerprint"); process.exit(1);
  }
  queue.attributes.Arn = queue.attributes.Arn + suffix;
  delete api.maskedPropertyInputFingerprints;
  fs.writeFileSync(out, JSON.stringify(s));
' "${LOG_DIR}/state-4-in.json" "${LOG_DIR}/state-4-seed.json" "-moved-${RUN_ID}"
aws s3 cp "${LOG_DIR}/state-4-seed.json" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" --content-type application/json >/dev/null
deploy_with "${VALUE_B}" true "${LOG_DIR}/p4.log"
# The verdict was reached and the binding rejected: the readsOther line names
# the Body (positive grep: a reworded line fails here), and no MAC match.
if ! grep -qF 'also read a value their MACs do not cover' "${LOG_DIR}/p4.log"; then
  echo "FAIL: phase 4 printed no readsOther line (the binding was not rejected, or the wording drifted)" >&2; exit 1
fi
if grep -qF 'carry the NoEcho parameter values they were last sent' "${LOG_DIR}/p4.log"; then
  echo "FAIL: phase 4 settled the Body by its MAC though its GetAtt input moved" >&2; exit 1
fi
if ! grep -qF 'could not compare with the value it last sent' "${LOG_DIR}/p4.log"; then
  echo "FAIL: phase 4 did not take the stop-gap (no warning)" >&2; exit 1
fi
expect_eq "probe survives (the stop-gap does not put)" "$(paths_of "${API_ID}")" "/ /probe /spec "
expect_eq "MAC unchanged (same value)" "$(body_mac)" "${MAC_B}"
expect_eq "input binding kept with the unsent Body" "$(body_binding)" "${BINDING_3}"
expect_no_plaintext "the phase 4 deploy log" "${LOG_DIR}/p4.log"
if grep -qF -e "${MAC_B##*:}" "${LOG_DIR}/p4.log"; then echo "FAIL: the phase 4 deploy log holds a MAC" >&2; exit 1; fi

echo "==> Destroy"
CDKD_TEST_NOECHO_MAC_TOKEN="${VALUE_B}" node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "REST API ${API_ID} still exists after destroy" aws apigateway get-rest-api --rest-api-id "${API_ID}" --region "${REGION}"
# DeleteQueue takes up to 60 s to take effect: poll the strict probe.
queue_gone=false
for _ in $(seq 1 18); do
  if gone_probe aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"; then queue_gone=true; break; fi
  sleep 5
done
[ "${queue_gone}" = true ] || { echo "FAIL: queue ${QUEUE_NAME} still exists 90 s after destroy" >&2; exit 1; }
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "noecho-restapi-body-mac state teardown"

echo ""
echo "[verify] PASS — noecho-restapi-body-mac: the NoEcho-fed Body is put only when the value changed"

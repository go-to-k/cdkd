---
title: Integration fixture conventions
description: "The rules a cdkd integration fixture follows — verify.sh signal traps, gone-probes, CLI flags, removal policies, S3 version sweeps, destructive prefix-sweep guards, and the unit-test priming conventions."
unlisted: true
---

# Integration fixture conventions

The rules a `tests/integration/<name>/` fixture and its `verify.sh` follow, and
the two unit-test conventions that go with them. Almost all are enforced by a
checker under `tests/unit/scripts/`, so a violation fails CI rather than
surfacing as a leaked AWS resource or a test that passes without testing
anything. Not all: ["Sort both sides of a list
readback"](#sort-both-sides-of-a-list-readback) is deliberately unenforced, and
["A destructive prefix sweep must refuse a widened
scope"](#a-destructive-prefix-sweep-must-refuse-a-widened-scope) is
convention-only — every sweep whose filter collapses to the empty string follows
it today, but nothing mechanical stops the next one from omitting it, ordering
its arms so the guard never fires, or wording its refusal so no future checker
can find it. That checker is issue
[#2690](https://github.com/go-to-k/cdkd/issues/2690).

This page is for contributors writing or reviewing a fixture. Start from
[Testing](testing.md), which walks a fixture end to end; come here when you are
writing one.

## Signal traps in `verify.sh`

Every fixture that provisions real AWS resources arms a `cleanup` trap so a
failed run tears its resources down. That trap MUST be armed for the signal
paths as well, in the exiting form:

```bash
cleanup() { ... }             # destroy + state/orphan sweep
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM
```

Two forms are wrong and both let a run leak billable resources:

- **No `INT` / `TERM` handler.** Ctrl-C or a harness timeout terminates the
  script without running the `EXIT` trap, so the stack survives.
- **`trap cleanup EXIT INT TERM`** (the bare-function form). A bash signal
  handler *returns to the interrupted point* instead of exiting, so `cleanup`
  runs and the script then **resumes the interrupted phase**, walks into the
  next one and can `exit 0` — reporting PASS. Worse, when only the script PID
  is signalled the `node deploy` child survives, so `cleanup` deletes resources
  concurrently with a live deploy.

The `(exit N)` seed is load-bearing, not decoration. Many fixtures' `cleanup`
opens with `rc=$?` and gates the whole teardown on it:

```bash
cleanup() { rc=$?; if [ "${rc}" -eq 0 ]; then exit 0; fi; ...destroy...; }
```

Inside a signal handler `$?` is the **interrupted command's** status, not the
signal. Without the seed, an interrupted run can see `rc=0`, skip the teardown
entirely and exit 0 — reintroducing the very bug the signal trap was added to
prevent. `(exit N)` sets `$?` to the signal's code, so both `rc=$?` and
`${1:-$?}` cleanups tear down correctly.

A disarm must release the signal traps too — `trap - EXIT INT TERM`, not
`trap - EXIT` — otherwise a Ctrl-C after the fixture's own successful teardown
re-runs `cleanup`.

`tests/unit/scripts/integ-verify-signal-traps.test.ts` enforces this across the
whole fixture tree (issue #1097).

## Gone-probes in `verify.sh`

A "resource is gone after destroy" assertion must never be built on a silenced
AWS CLI read probe. Both of these are the same bug (issue #1097 pattern 2):

```bash
# WRONG: ANY probe failure (throttle, expired credentials, network) lands in
# the else-branch and reports "gone" -- a leaked resource passes silently.
if aws lambda get-function --function-name "${FN}" >/dev/null 2>&1; then
  echo "FAIL: function still exists after destroy" >&2; exit 1
fi

# WRONG (inverse spelling): any failure is read as "gone".
if ! aws dynamodb describe-table --table-name "${TABLE}" >/dev/null 2>&1; then
  TABLE_GONE=1
fi
```

The list-operator spellings (`aws <probe> ... && { FAIL still exists; }` and
`aws <probe> ... || { GONE=1; break; }`) are the same bug and equally banned.

Instead, every fixture that asserts deletion carries the canonical helper block
(verbatim; see `scripts/check-integ-probe-not-found.ts` for the source of
truth) and routes probes through it:

```bash
# Simple leak assertion: fails on "still exists" AND on an undetermined probe.
assert_gone "function ${FN} still exists after destroy" aws lambda get-function --function-name "${FN}" --region "${REGION}"

# Branching form (orphan counters, wait-until-gone polls, status checks):
# 0 = confirmed not-found, 1 = still exists, hard-FAIL on anything else.
if ! gone_probe aws iam get-role --role-name "${ROLE}"; then
  ORPHANS=$((ORPHANS + 1))
fi
```

The helpers grep the probe's stderr for the ONE canonical not-found signature
(`'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'`, case-insensitive)
and refuse to report PASS on any other failure. Notes:

- Only READ-verb probes (`describe|get|head|list|batch-get`, `aws s3 ls`) used
  as existence checks are in scope. A mutation such as
  `if ! aws fsx delete-backup ...` legitimately treats non-zero as "the delete
  failed" and stays as-is; so do fail-closed existence checks
  (`if ! aws ...; then FAIL`), pre-flight "already exists, clean up first"
  guards, and best-effort cleanup guards.
- Probe state files with `aws s3api head-object --bucket ... --key ...`, not
  `aws s3 ls`: `s3 ls` exits 1 with EMPTY output for "no keys", which is
  indistinguishable from a silenced error.

The same defect hides in two more spellings, both banned (issue #1120):

- **Capture-form fallbacks**: a read-verb command substitution with an
  error-swallowing fallback, e.g. `N=$(aws ... --output text 2>/dev/null ||
  echo 0)` or `... || true`, reads a throttle as "0 remaining" / "None" /
  empty. Drop the silencing and the fallback (a plain `VAR=$(aws ...)` under
  `set -e` hard-fails loudly on a probe error), or, when not-found is a
  legitimate outcome (async deletes, recovery-window secrets), branch on
  `gone_probe` first and then read the value with a strict capture. A plain
  silenced capture with no fallback and the strict stderr-capture idiom
  (`$(cmd 2>&1 >/dev/null || true)`, error text lands in the value for
  inspection) stay legal.
- **Function wrappers**: a function body carrying a silenced read probe whose
  error cannot fail loudly — the exit-status shape (`ssm_exists() { aws ssm
  get-parameter ... >/dev/null 2>&1; }`) or a value wrapper with a swallow
  tail (`... --output text 2>/dev/null || true`). Both make `$(fn)` /
  `if fn` read a throttle as "gone". Tail-less value wrappers are legal
  **only when the probe is the LAST command of the body**: `$(fn)` returns the
  last command's status, so `set -e` fails the caller loudly.

**Intermediate captures inside a value wrapper need `|| return 1`.** Bash
clears errexit inside `$( )` command substitutions (no
`shopt -s inherit_errexit`), so in a multi-statement wrapper called as
`V="$(fn)"` an intermediate `out="$(aws ...)"` failure does NOT abort the
body: the remaining statements run and the function returns the last
command's status (typically 0 via a `|| true` formatting tail), silently
reading a throttle as "nothing found":

```bash
find_ids() {
  local out
  out="$(aws ec2 describe-vpcs ... --output text)" || return 1  # load-bearing
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -v '^$' || true
}
```

The `|| return 1` routes the probe error through the function's exit status to
the caller's `set -e`. (A `local V=$(aws ...)` declaration-assignment masks
the status entirely, since `local` exits 0, so split the declaration from the
assignment. A status-consuming tail like `out="$(aws ...)" && rc=0 || rc=$?`
is already strict.)

When a `gone_probe` branch precedes a strict value requery, guard the requery
against the probe-to-requery race (TOCTOU): on a requery failure whose stderr
matches the canonical not-found signature, treat it as gone; hard-fail on
anything else (`elif ! v=$(aws ... 2>&1); then printf '%s' "$v" | grep -qiE
'<canonical signature>' && v=GONE || { echo FAIL...; exit 1; }`).

Best-effort cleanup code is exempt structurally: lines inside a
`set +e`/`set +eu` ... `set -e`/`set -eu` span (bounded by the enclosing
function) are skipped, matching the cleanup convention above — mark a
best-effort cleanup helper with `set +eu` rather than silencing its probes.
Run the helper's body in a subshell (`fn() { ( set +eu; ... ) }`) so calling
it from a `set +eu` cleanup trap can never RE-ARM strict mode in the caller
(a trailing `set -eu` in a plain body would abort the rest of the sweep on
the next probe error).

`tests/unit/scripts/integ-verify-probe-not-found.test.ts` enforces all of this
across the whole fixture tree (issue #1097 pattern 2 + issue #1120), including
bash-level behavioral tests against a stubbed `aws` (helpers: success /
not-found / throttle; strict captures: value propagation vs loud throttle
failure).

## CLI flags a fixture passes

Every flag a fixture passes must be declared on the **subcommand it targets**.
The originating case: a fixture passed `--region` to `cdkd import`, which died
with `error: unknown option '--region'` — so the import round-trip that fixture
exists to exercise had never executed once. `--region` is declared in
`src/cli/options.ts` and accepted by roughly ten sibling commands (`deploy`,
`destroy`, `diff`, `drift`, `export`, `events`, `list`, `synth`, `orphan`, and
every `state` subcommand); `import` is the only one that never attaches it, so
the flag looked correct by analogy with its neighbours.

Two traps when auditing this by hand:

- **Hidden options do not appear in `--help`**, so help text alone is not
  decisive — the option set has to come from the command tree itself.
- **`--region` is not a no-op** on the commands that accept it. It is the
  highest-precedence region source (see [CLI Reference](cli-reference.md)),
  so "cleaning up" deprecated `--region` flags would silently change region
  resolution.

`tests/unit/scripts/integ-cli-flags.test.ts` enforces this across the fixture
tree. It reads the real Commander tree through `buildProgram()`
(`src/cli/program.ts`) — not `--help`, and not `src/cli/options.ts`, which is a
flat global list with no command attachment and therefore cannot express this
class of bug at all. A flag counts as accepted when the target command **or any
ancestor** declares it, matching Commander's own lookup (`cdkd events prune
--state-bucket` is valid because `events` declares it).

The check also asserts coverage floors — total invocations parsed, flags seen,
distinct subcommands reached, plus at least one invocation of each supported
call shape — so a parser regression that stops matching fails loudly rather than
passing vacuously. That is not hypothetical: two separate iterations of this
lint were green while silently skipping most of the tree (first every
env-prefixed `CDKD_TEST_UPDATE=true ...` deploy, then every
`node "${LOCAL_DIST}" ...` call site — 135 of 195 fixtures). Current coverage:
195 fixtures, ~830 invocations, ~2,160 flags, 25 command paths.

## No Lambda published-version literals

Lambda version counters are monotonic per function name (and per layer name)
and never reset — not even across a delete + re-create. A fixture with a fixed
function name that probes `"${FN}:1"` or asserts an alias's `FunctionVersion`
equals `"2"` therefore passes exactly once (the first run ever in the account)
and fails every re-run with `ResourceNotFoundException` while the deploy itself
is clean. Three fixtures shipped this trap before it was made mechanical
(issue #1324).

The correct shape reads the published version from the live alias and asserts
the rotation relatively:

```bash
V1="$(aws lambda get-alias --function-name "${FN}" --name live \
  --query 'FunctionVersion' --output text)"
case "${V1}" in ''|*[!0-9]*) echo "FAIL: non-numeric version" >&2; exit 1 ;; esac
# ... update deploy ...
EXPECTED=$((V1 + 1))
V2="$(aws lambda get-alias --function-name "${FN}" --name live \
  --query 'FunctionVersion' --output text)"
[ "${V2}" = "${EXPECTED}" ] || { echo "FAIL: expected ${EXPECTED}" >&2; exit 1; }
```

`tests/unit/scripts/integ-verify-version-literals.test.ts` enforces this across
the fixture tree (classifier: `scripts/check-integ-version-literals.ts`). It
flags digits-literal qualifiers on `aws lambda` commands (`--function-name
"${FN}:1"`, ARN `...:function:fn:3`, `--qualifier 5`), digits-literal
`--version-number` args, and integer-literal comparisons of variables captured
from a version-ish `--query` (`FunctionVersion`, `.Version`). Alias qualifiers
(`:live`, `:$LATEST`), variable qualifiers, relative compares, count queries
(`length(...)`), and non-Lambda commands stay legal. For a genuinely fixed
version (e.g. a public cross-account layer ARN pinned by its owner), append
`# allow-version-literal: <reason>` to the line. The check carries per-shape
coverage floors and was verified to fail against real injected regressions
before landing, per the checker rules above.

## A mode-gated resource must survive the later steps

Multi-step fixtures drive each phase with
`CDKD_TEST_UPDATE=<comma,separated,modes>`, and the fixture stack branches on
`updateMode.includes('x')`. Adding a scenario by gating a **new resource** on a
**new token** is the natural spelling, and it is wrong whenever a later deploy
in the same `verify.sh` uses a mode list that omits the token: the resource
leaves the synthesized template and cdkd correctly issues a DELETE for it. A
per-step conditional in a long fixture is really a *step function over the whole
run*, not a flag scoped to your step.

The originating case (issue #1512), caught by review before the run reached it:
the new `OnDemandReplicaTable` gated its `eu-west-1` replica on
`cross-region-ondemand*`, used by steps 12g/h/i. The fixture then deploys six
more times (`deletion-protection,autoscaling,ttl,tags`, then five `ttl,tags,...`
rounds), none carrying the token — so step 12f would have removed the replica
**from a still-live table**. That is precisely the operation that arms
DynamoDB's 24-hour source-region delete lock; an earlier probe wedged a table in
`UPDATING` for over 90 minutes that way (#1442). The fixture's own comments, the
commit message and the issue comment had already claimed the design "only ever
ADDs" — nothing would have contradicted them.

Make the token **monotonic** by carrying it forward in a shell suffix: set the
variable once the resource exists, and append it to the mode list of every later
deploy.

```bash
OD_MODE_SUFFIX=""                               # seeded with the other run vars
...
OD_MODE_SUFFIX=",cross-region-ondemand-dropped" # set right after the rounds
...
CDKD_TEST_UPDATE=ttl,tags${OD_MODE_SUFFIX} ${CLI} deploy ...
```

The suffix stays empty when the scenario is not gated on, so the default flow is
byte-for-byte unchanged. Only `cdkd destroy` then removes the resource — which
for a GlobalTable deletes every replica as one resource and never issues a
standalone replica-delete.

Do **not** instead key presence on a run-scoped environment variable. It is the
tempting one-line fix and it stops the deletion, but it silently changes what
the test tests: the resource is then declared from step 1, so it is created
*with* its parent and the step you meant to exercise becomes an UPDATE. That is
how this very fixture briefly stopped covering `addReplica` while its assertion
still passed — the assertion only checks the resulting value. Reserve the
env-var form for presence that no step needs to transition.

Before adding a mode-gated resource, enumerate every deploy and read the mode
list of each one that runs **after** your steps; any that omits your token
deletes your resource there. Grep for the invocation rather than for a
single-line pattern — fixtures wrap long mode lists with a trailing `\`, so the
env prefix and `${CLI} deploy` land on different lines and a one-line
`grep 'CDKD_TEST_UPDATE=.*deploy'` misses them. That gap is what let a run
report PASS while still performing the live replica-delete.

Then weigh what the deletion costs — free for a plain queue, the whole problem
for a DynamoDB replica, RDS instance or stateful store. Verify by synthesizing
the **later** modes: the check that catches this is `cdk synth` under `ttl,tags`
showing the resource still intact, not `cdk synth` under your own mode showing
it created. Finally, make sure some assertion would *notice* a drop — a
post-destroy "it is gone" check passes vacuously when the resource was deleted
mid-run, so it is not a guard.

Mechanically enforced since issue
[#1543](https://github.com/go-to-k/cdkd/issues/1543). Unlike the
order-insensitivity convention above, this one is a genuine checker rather than
a judgment call — the ordered mode lists and the token-gated declarations are
both statically extractable.

`scripts/check-integ-mode-gated-resources.ts` reads the ordered per-deploy mode
lists out of `verify.sh` (resolving the monotonic-suffix `${VAR}` idiom above in
source order) plus the condition behind each gated declaration in the fixture
stack, and reports any declaration that is present at one step and absent at a
later one. Only create-shaped gates block — a construct, or an entry in a
resource list such as `replicas: [...]`; a scalar property gate is reported for
visibility only, since flipping a property back off is an ordinary update test.
A deliberate removal is marked on the declaration with
`// allow-mode-gated-drop: <reason>`; the reason is mandatory.

## Stateful L2 constructs need an explicit removal policy

Stateful CDK L2 constructs — `kinesis.Stream`, `dynamodb.Table` / `TableV2`,
`s3.Bucket`, `logs.LogGroup`, `kms.Key`, `rds.DatabaseInstance` /
`DatabaseCluster`, `efs.FileSystem`, `opensearchservice.Domain`,
`ecr.Repository`, `cognito.UserPool`, `backup.BackupVault` — default to
`RemovalPolicy.RETAIN`, which synthesizes `DeletionPolicy: Retain`. Both
CloudFormation and cdkd honor it, so a fixture that omits the policy leaks the
resource on **every** deploy/destroy cycle while the destroy still reports
success. The originating incident (issue #1326): the `sqs-cloudwatch` fixture's
Kinesis Stream carried no `removalPolicy`, and a month of benchmark runs in
`us-west-2` accumulated 14 billed PROVISIONED streams before a cleanup sweep
caught them. The lint then immediately found a second live case — the
`log-pipeline` fixture's Stream, present since the initial commit.

Every instantiation of those constructs under `tests/integration/*/{lib,bin}`
must do one of:

- pass an explicit `removalPolicy` in its props (an intentional `RETAIN` is
  fine — it has to be a visible decision, not a silent default);
- call `applyRemovalPolicy(...)` on the assigned variable / property elsewhere
  in the same file;
- carry an `// allow-default-removal-policy: <reason>` comment on the
  statement, for fixtures that intentionally exercise the default (the test
  caps how many of these may exist, so the escape hatch stays rare).

A props object passed as a same-file variable is resolved through the variable;
a spread (`{ ...base }`) does **not** count — restate the policy visibly. L1
`Cfn*` constructs are out of scope because their template default is `Delete`.

`tests/unit/scripts/integ-fixture-removal-policy.test.ts` enforces this across
the fixture tree (classifier: `scripts/check-fixture-removal-policy.ts`), with
coverage floors per constructor-reference shape and per construct kind so a
parser regression fails loudly rather than passing vacuously. Baseline
2026-07-31: 523 fixture files scanned, 120 stateful-L2 instantiations.

## A `PendingDeletion` KMS key is not an orphan

A customer-managed KMS key cannot be deleted synchronously. Seven days is the
AWS **minimum** pending window, and `RemovalPolicy.DESTROY` schedules the
deletion rather than performing it — so `PendingDeletion` is the terminal state
of a *successfully deleted* key, not a leak.

A fixture that needs a CMK may therefore just create one per run:

```ts
const key = new kms.Key(this, 'Key', {
  description: 'cdkd <what this covers> integ',
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  pendingWindow: cdk.Duration.days(7), // the minimum; the default is 30
});
```

and assert the state after destroy, accepting `GONE` for a window that already
elapsed in an earlier run:

```bash
KEY_STATE="$(aws kms describe-key --key-id "${KEY_ARN}" --region "${REGION}" \
  --query 'KeyMetadata.KeyState' --output text 2>&1)" || {
  if echo "${KEY_STATE}" | grep -q "NotFoundException"; then
    KEY_STATE="GONE"
  else
    echo "FAIL: describe-key failed unexpectedly: ${KEY_STATE}" >&2
    exit 1
  fi
}
[ "${KEY_STATE}" = "PendingDeletion" ] || [ "${KEY_STATE}" = "GONE" ] || {
  echo "FAIL: expected PendingDeletion after destroy, got '${KEY_STATE}'" >&2
  exit 1
}
```

`loggroup-kms-associate`, `propagation-races-2` and `s3-vectors` have done this
since issue #958; `cloudtrail-trail` and `s3-replication-and-filter` joined them
in issues #1533 / #1523. Do **not** build a long-lived, alias-referenced key and
an account-bootstrap step to avoid the pending window — that makes every
affected fixture fail on a fresh account in order to dodge a non-problem.

Two caveats. The key does keep **billing** through its pending window; that is
a cost, not an orphan, and is not a reason to skip coverage. And the `/cleanup`
sweep's caution still applies to keys it did not create: only ever schedule
deletion for `KeyManager == CUSTOMER` + `KeyState == Enabled` keys with a
cdkd-shaped description, never one carrying live grants or aliases.

## Never call an `aws` verb the CLI does not have

A `verify.sh` must not call an `aws <service> <verb>` that is not a real AWS
CLI subcommand. The trap is that such a verb can look completely legitimate:
the AWS CLI **removes** a set of operations from its command table
(`awscli/customizations/removals.py`) that still exist in the API, so the AWS
SDKs, the API reference, and anything generated from them all offer it.

The originating case (2026-08-09) is `aws emr list-instance-groups`, which
forced two EMR fixtures to be rewritten. Its symptom was misleading:

```text
Warning: Input is not a terminal (fd=0).
aws: [ERROR]: [Errno 22] Invalid argument
```

and, without a `</dev/null`, a hang. That reads like an interactive
"customization", and it was originally written up that way — but the real cause
is simpler and more general:

1. `list-instance-groups` is on the CLI's removal list, so the CLI's answer is
   just `Found invalid choice 'list-instance-groups'`.
2. The `Errno 22` / hang is what `cli_auto_prompt` (`on-partial` in the
   maintainer's `~/.aws/config`) does to **any** invalid-choice error: the CLI
   tries to open its interactive prompter, which cannot attach to a
   non-terminal stdin. With `AWS_CLI_AUTO_PROMPT=off` the same call fails fast
   and legibly.

The corollary matters when picking a replacement verb: **the neighbours are
usually fine.** `aws emr list-instance-fleets` and `aws emr list-instances` are
NOT removed and work non-interactively, so "the `list-instance-*` family is
suspect" was the wrong generalization. The unit of the defect is the
(service, verb) pair.

Enforced by `tests/unit/scripts/integ-aws-commands.test.ts` (classifier:
`scripts/check-integ-aws-commands.ts`), which checks every `aws <service>
<verb>` in the fixture tree against the captured removal table
`tests/fixtures/aws-cli-removed-commands.json`. The table is a checked-in
capture rather than a live `aws` invocation so the check stays offline and
deterministic — a checker that skips when its oracle is missing is a vacuous
pass. Refresh it with `vp run gen:aws-cli-removals` after an AWS CLI upgrade.
Escape hatch (only when you have PROVEN the call works):
`# allow-unavailable-aws-command: <reason>` on the invocation's line or the
line above.

When the verb you wanted is unavailable, call the AWS SDK directly from
`verify.sh` rather than substituting a different CLI verb that happens to work
but returns less data. The repo root already depends on every
`@aws-sdk/client-*` cdkd uses, so a `node --input-type=module -e` one-liner run
from the repo root needs no extra install. Two details in the reference shape
are load-bearing: a `|| return 1` so an SDK failure reaches the caller's
`set -e` (otherwise an empty result silently satisfies a `// empty`-defaulted
`jq` assertion), and a pagination loop matching whatever the provider under
test does (a partial first page is a silent false pass). See
`tests/integration/emr-cluster/verify.sh` and
`tests/integration/emr-instance-configs/verify.sh` for the full helper.

A pager invoked non-interactively is a separate route to a hang, so
`export AWS_PAGER=""` near the top of a fixture is cheap insurance. Treat this
as a recommendation for new and affected fixtures rather than a tree-wide
invariant — most existing fixtures do not set it and are fine.
`tests/integration/emr-instance-configs/verify.sh` is the reference.

## Pin and resolve a fixture-local `cdk` CLI

A fixture whose `verify.sh` shells out to the upstream `cdk` CLI must be
hermetic about which `cdk` it gets. Four requirements (enforced by
`tests/unit/scripts/integ-cdk-cli-pins.test.ts`, classifier
`scripts/check-integ-cdk-cli-pins.ts`):

1. Pin `aws-cdk` in the fixture's `package.json` at a real version range
   whose cloud-assembly schema support covers the fixture's `aws-cdk-lib`
   (`*` / `latest` are rejected — they re-admit the skew).
2. Install the **fixture's own** deps. `node_modules` is gitignored and the
   repo-root `pnpm install` does not populate fixture dirs, so a root install
   alone leaves the pin inert.
3. Guard a conditional install on the cdk **binary**, not on the directory: a
   `node_modules` left from before the pin exists but contains no `cdk`, so
   `[ -d node_modules ]` skips the very install that would fix it. An
   unconditional install needs no guard.
4. Resolve the local CLI on every invocation, by PATH prepend or an explicit
   local bin path:

   ```bash
   [ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || (cd "${TEST_DIR}" && npm install)
   export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"
   ```

Why: a bare `cdk deploy` (or `npx cdk` with no local install) silently takes
the machine's global CLI. When that CLI lags the fixture's `aws-cdk-lib`, the
run fails with `Cloud assembly schema version mismatch` — which is how
`import-nested-stack` failed on the 2026-08-10 staleness sweep even though its
`package.json` pinned `aws-cdk` (the pin was never on the resolution path).

The check reads code, never prose: heredoc bodies and comments (including
trailing ones) are stripped, and each line is split quote-aware into
command-position segments, so a `cdk deploy` inside an `echo` string or a
`grep` pattern is not an invocation — and equally, an `npm install` mentioned
in a comment does not satisfy requirement 2.

## Sort both sides of a list readback

AWS does not preserve the submitted order of list-valued members when you read
them back, so an assertion that string-compares a joined list against the order
you sent is flaky — and because it fails on a correct implementation, its error
message accuses the fix. Seen 2026-08-09 in the `lambda-esm-self-managed-kafka`
fixture: cdkd submitted two Kafka bootstrap servers in one order,
`list-event-source-mappings` returned them in the other, and the run reported
"issue #1384 NOT closed" while the fix was working.

Sort both sides in the query, unless the list is genuinely order-significant:

```bash
--query "join(' ', sort(Path.To.List || `[]`))"
```

This mirrors what `src/analyzer/drift-normalize.ts` does for the drift
comparator — it canonicalizes tag lists and resource-id/ARN arrays on both
sides for the same reason. The same caveat applies too: a list whose order
carries meaning (DNS resolver lists, preference orders) must NOT be sorted,
because sorting would hide a real regression rather than reveal one.

## `state destroy` must pass `--state-bucket`

The harness exports the state bucket as `STATE_BUCKET`, but the CLI's own
environment fallback is `CDKD_STATE_BUCKET` — a **different** name. So a
`cleanup()` sweep spelled

```bash
node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes
```

never reads the harness's bucket at all. Resolution is CLI flag >
`CDKD_STATE_BUCKET` > `cdk.json` `context.cdkd.stateBucket` > STS-derived
default, so the omission lands in one of two wrong places:

- **109 fixture `cdk.json` files declare `context.cdkd.stateBucket`**, and
  `verify.sh` runs the CLI from the fixture directory — so the sweep resolved
  that name (`your-cdkd-state-bucket`, `cdkd-state-test`) and died with
  `StateError: State bucket '...' does not exist`, swallowed by the call's own
  `>/dev/null 2>&1`. Those cleanups had been failing on **every run**,
  invisibly.
- **The rest** fell through to the STS default `cdkd-state-{accountId}`, which
  is the harness bucket on a default setup — so they worked by coincidence.
  Point `STATE_BUCKET` anywhere else (a per-run isolated bucket, a
  second-account run, the legacy region-suffixed bucket) and the sweep silently
  no-ops: destroys nothing, reports success, and only the fixture's own
  tag-based AWS sweeps clean up.

Either way the state record survives and wedges the next run of that fixture.

Pass the bucket explicitly, in the `set -u`-safe form:

```bash
node "${LOCAL_DIST}" state destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
```

`"${STATE_BUCKET:-}"` rather than `"${STATE_BUCKET}"` is load-bearing: `cleanup`
is trap-installed, so it can run **before** the script's own
`if [ -z "${STATE_BUCKET:-}" ]` guard has rejected an unset variable, and a
cleanup that only does `set +e` (not `set +eu`) would abort teardown mid-sweep
on the unguarded form. An empty value is safe — the resolver treats `''` as "not
supplied" and falls back exactly as omitting the flag does, so the guarded form
is never worse than the status quo.

Note the asymmetry this convention corrects: `deploy` (335 call sites) and
`destroy` (228) already passed the flag everywhere; only `state destroy` had
drifted, at 96 of 171 call sites across 94 fixtures. `deploy` deliberately keeps
the strict `"${STATE_BUCKET}"` form — there an unset bucket is a harness
misconfiguration that should fail loudly rather than silently target the default.

Enforced by `tests/unit/scripts/integ-state-bucket.test.ts` (classifier:
`scripts/check-integ-state-bucket.ts`), which evaluates code only — heredoc
bodies, comments and `echo` arguments are stripped, so a remediation hint that
prints the command is not treated as an invocation.

## Sweep S3 object versions, and assert the count is zero

`cdkd bootstrap` turns **versioning on** for the state bucket
(`src/cli/commands/bootstrap.ts`). On a versioned bucket `aws s3 rm` writes a
DELETE MARKER; it removes nothing. So this, which most fixtures end with,

```bash
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
```

is a statement about the CURRENT object only. Every earlier version of that key
is still readable by anyone with `s3:GetObjectVersion`.

For most fixtures that is litter. For a fixture that puts a **known secret
plaintext** into state it is a disclosure that outlives the run — and several
do, for good reasons: an `unsafePlainText` secret in the fixture's own template,
a literal `masterUserPassword`, an IAM `SecretAccessKey` cached in `attributes`,
or a deliberately seeded pre-GHSA record. Measured 2026-08-20 for issue
[#2096](https://github.com/go-to-k/cdkd/issues/2096), right after green runs:

| key | surviving entries | carrying the fixture's plaintext |
| --- | --- | --- |
| `cdkd/CdkdSecretsDynamicRefExample/us-east-1/state.json` | 304 versions + 43 markers | yes (`cdkd-known-pw-123`) |
| `cdkd/CdkdSecretsArrayNestedExample/us-east-1/state.json` | 7 versions + 3 markers | 5 of the 7 (`cdkd-array-nested-pw-789`) |
| `cdkd/CdkdDocdbNeptuneExample/us-east-1/state.json` | 64 | 16 of them (`TempPass1234!`) |
| `cdkd/CdkdEventbridgeApiDestinationExample/us-east-1/state.json` | 18 | 15 of them (`cdkd-integ-api-key`) |
| `cdkd/CognitoResourceServerStack/us-east-1/state.json` | 18 | 3 of them (a live Cognito `ClientSecret`) |
| `cdkd/AppSyncStack/us-east-1/state.json` | 557 | 17 of versions 12..45 (a live `da2-…` AppSync key) |
| `cdkd/CdkdApigwUsagePlanKeyExample/us-east-1/state.json` | 16 | 2 of them (a live 40-char API Gateway key `Value`) |

Sixteen fixtures do this today.

**When measuring a key, sample across the RANGE or grep the whole thing — never
the newest N.** The last two rows were each cleared as "no key material" by a
newest-N probe before being caught: AppSync's 12 newest versions carry nothing
while versions 12..45 do, and the API Gateway key sits in versions 7 and 8 of
16. The newest versions come from the most recent run, which is the one most
likely to be already-fixed or to have failed early — so a newest-N sample is
biased towards exactly the answer you do not want.

It is also not enough to grep `src/provisioning/providers/**` for a credential.
`AWS::ApiGateway::ApiKey` is registered to no provider, so it takes the generic
Cloud Control readback, whose resource model includes `Value`: the live key
lands in `attributes` with no provider code naming it. Note the third row's stack name: it is
`CognitoResourceServerStack`, **not** `CdkdCognitoResourceServerExample`. Read
the stack name from `verify.sh`'s `STACK=` line when auditing — several fixtures
do not follow the `Cdkd…Example` convention, and probing the convention-derived
name returns a clean-looking `0` for a key that does not exist.

Use the shared helpers in
[`tests/integration/s3-versions.sh`](https://github.com/go-to-k/cdkd/blob/main/tests/integration/s3-versions.sh)
rather than open-coding a sweep — the three traps below are written down there
once instead of once per fixture. Source it after the `cd` into the fixture dir:

```bash
cd "$(dirname "$0")"
. ../s3-versions.sh
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
```

**Sweep the PREFIX, never a list of keys.** Sweeping `state.json` by name is the
natural first instinct and it under-sweeps, because the plaintext is not only
there. `rollback-journal.json` stores
`failedOperations[].attemptedProperties` — the properties of the failed write,
verbatim — and four measured versions of
`CdkdDeletionPolicySnapshotHeavyExample`'s journal carried a literal
`"MasterUserPassword"`. `lock.json` USED to accumulate faster than anything
else (452 versions on one key) and still leaves a CURRENT delete marker per
stack — since issue [#2346](https://github.com/go-to-k/cdkd/issues/2346) site 5
cdkd purges the lock key's own noncurrent versions on release, so what survives
is that marker plus whatever a crashed run left un-reaped. `deployments/**` is
not delete-markered by `cdkd destroy` at all, so its objects survive as CURRENT
ones. One prefix covers
all four; a key list covers whichever ones its author thought of.

One blind spot to know: a nested-stack child lives at
`cdkd/<Parent>~<Child>/<region>/`, a SIBLING prefix rather than a descendant, so
one `s3_stack_prefix` call does not reach it. This USED to be recorded as "no
fixture in the swept set has one today"; that is no longer true.
`nested-stack-secret` is in the swept set, builds a real `cdk.NestedStack`, and
handles it the way a fixture must — by deriving a SECOND prefix for the child
and sweeping and asserting both:

```bash
CHILD_STACK="${STACK}~Child"
PARENT_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
CHILD_PREFIX="$(s3_stack_prefix "${CHILD_STACK}" "${REGION}")"
```

Copy that if your fixture gains a nested stack.

A second sibling prefix behaves the same way and is easier to miss: the shared
**exports index** at `cdkd/_index/<region>/exports.json`, which holds RESOLVED
Output values. No `s3_stack_prefix` reaches it, and it must never be swept with
a prefix-scoped `all` — it is shared with every other stack in the region, so
that would delete a concurrent lane's live index. Sweep it KEY-scoped and
`noncurrent` only, which leaves whatever is CURRENT intact:

```bash
INDEX_KEY="cdkd/_index/${REGION}/exports.json"
# In `sweep`/`cleanup` — safe on EVERY path, because `noncurrent` never touches
# the CURRENT object (which belongs to whichever stack wrote it last):
s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent || true
# ...and on the success path, ASSERT it, exactly like the prefix sweep:
s3_assert_key_versions_swept "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent \
  "<fixture> exports-index teardown"
```

Note the assertion's mode DEFAULTS to `noncurrent`, the opposite of
`s3_assert_versions_swept`'s: demanding zero versions of a key you share would
demand a state no correct run can reach. And put the purge in `sweep` /
`cleanup`, not only after the trap is disarmed — a failed or signalled run
writes index versions too, and those are the majority of the runs that write
them.

(`cross-stack-secret-import` does this. Asserting that the CURRENT index object
carries the `{{resolve:...}}` expression rather than a plaintext says nothing
about the versions behind it, which is the gap.) One more sidecar, stated so
nobody re-derives it: `custom-resource-responses/<id>.json` lives under a
stack's OWN prefix, so the ordinary sweep does reach it.

The wider fixture-tree work is
tracked in issue [#2107](https://github.com/go-to-k/cdkd/issues/2107).

In `cleanup`, purge NONCURRENT versions only — that function also runs from the
pre-run sweep and from the failure / INT / TERM traps, where a live `state.json`
may be the only record of resources that are still standing:

```bash
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
```

On the SUCCESS path, do the full sweep and **assert**. Which template you copy
depends on whether your `cleanup` ends by calling `exit`:

**Shape A — `cleanup` returns normally.** Call it, disarm the trap so nothing
can write a new delete marker after the count is taken, then sweep and assert.
This is what most sweeping fixtures do, and it needs no status capture: the
destroy it depends on already ran un-piped under `set -e` further up, so this
line is unreachable if it failed.

```bash
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "<fixture> state teardown"
```

**Shape B — `cleanup` ends with `exit "${rc}"`.** Then calling it from the
success path terminates the script, so a sweep placed after that call never
runs, and the mode choice has to live INSIDE `cleanup`. There, **gate the mode
on the DESTROY's status and not on the script's** (issue
[#2225](https://github.com/go-to-k/cdkd/issues/2225)). `rc` is the SCRIPT's
status on entry to `cleanup`: a run whose assertions ALL PASSED and whose
destroy then FAILED arrives with `rc` 0 and resources still standing, so gating
on `rc` alone takes the `all` branch and deletes the very `state.json` a later
`cdkd state destroy` needs — orphan resources with no way to reach them.

```bash
cleanup() {
  rc=$?
  set +e
  # PIPED destroy -> ${PIPESTATUS[0]}. NOT `$?`: the pipe to `tail` is exactly
  # what hides the failure, so `$?` would report tail's status and reproduce
  # the bug inside its own fix.
  ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1 | tail -5 || true
  destroy_rc=${PIPESTATUS[0]}
  # UNPIPED destroy -> plain `$?` is correct:
  #   node "${LOCAL_DIST}" destroy "${STACK}" ... >/dev/null 2>&1
  #   destroy_rc=$?
  # Either way write it as a PLAIN assignment. `local destroy_rc=$?` captures
  # `local`'s own exit status (it is itself a command) and so always reads 0 --
  # the same class of mistake as reading `$?` past a pipe. Declare with a bare
  # `local destroy_rc` on its own line first if you want it function-scoped.
  #
  # The capture must be the next thing that RUNS. Comments and blank lines are
  # fine; any command in between overwrites PIPESTATUS.

  if [ "${rc}" -eq 0 ] && [ "${destroy_rc}" -eq 0 ]; then
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
    s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "<fixture> state teardown"
  else
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" noncurrent || true
  fi
  exit "${rc}"
}
```

With more than one stack, capture one status per destroy and require all of
them (`rollback-cross-region-secret` gates on `rc` plus both of its per-region
destroy statuses).

`tests/unit/scripts/integ-s3-versions-harness.test.ts` enforces Shape B: inside
a `cleanup` that purges `all`, every cdkd destroy must have its status captured,
a piped one must use `${PIPESTATUS[0]}`, and the guard must actually read the
captured variable. Two further rules come with it: two destroys may not
CLOBBER each other by capturing into the same variable name (the guard then
reads one status and the other is lost), and an `aws s3 rm --recursive` over
the stack prefix may not run above the guard, since the delete marker it writes
demotes the live `state.json` to a noncurrent version the `all` branch then
deletes. It recognises the invocation spellings the tree uses (`${CDKD}`,
`${CLI}`, `node "${LOCAL_DIST}"`, `dist/cli.js`) and deliberately does NOT
count the AWS CDK CLI's own `cdk destroy`, whose status says nothing about
whether cdkd's state record is still needed.

Five shapes still slip past it, none live in the tree today and all tracked in
issue [#2304](https://github.com/go-to-k/cdkd/issues/2304): a one-line
`if …; then …; fi` (the `fi` is matched line-anchored, so it opens no depth), a
destroy inside a `for` / `while` loop (the clobber expressed by ITERATION
rather than by a second line), a purge inside a `case` arm, a conditional
`aws s3 rm` reported with the wrong reason, and a teardown factored out of the
lexical `cleanup()` body. Check those by hand until that issue lands.

Three traps make a sweep silently PARTIAL while the run still exits 0. Each was
observed live, and none is visible from reading the script:

1. **Sweeping only from the EXIT trap.** A fixture that ends with
   `trap - EXIT INT TERM` disarms the trap on the success path, so a trap-only
   sweep runs on the failure path and never on the normal one. One key reached
   30 versions that way (2026-08-19). Sweep on the success path too.
2. **Iterating with `printf '%s' | tr | while read`.** `out=$(aws ...)` strips
   the trailing newline, so the last field has no terminator, `read` returns
   non-zero on it, and the loop body never runs for it. Verified against real
   S3: on a key holding one version the broken form swept 0 of 1; on a
   347-entry listing it swept 346. Repeated passes take a key to 1 and stop.
   Use `printf '%s\n'` plus a `|| [ -n "${key}" ]` guard — **both**, and that
   is measured rather than belt-and-braces superstition: the harness's mutation
   probes show that removing EITHER guard alone still sweeps correctly, so only
   removing both exposes the trap. A probe that reintroduced just one would
   report a false all-clear.
3. **Counting with `length(...)` under `--output text`.** The AWS CLI applies
   `--query` PER PAGE and concatenates, so a listing over 1000 entries prints
   one number per page — measured `1000\n189`, not `1189`. `[ "$n" -ne 0 ]` on
   that is not a comparison, and the consequence is **worse than a crash**: the
   `[` builtin rejects the operand and returns non-zero, so the `if` is FALSE
   and the assertion falls straight through to announce a clean teardown —
   `exit 0`, `OK: 0 surviving object versions` — while 1189 versions are still
   in the bucket. A vacuous green, which is the failure mode this whole
   convention exists to remove. Count ROWS of a `[Key,VersionId]` projection
   instead; the pages concatenate into one row stream.

Two more details the helpers encode. The query is
`([Versions, DeleteMarkers][])[...]` and the **parentheses are load-bearing**:
`[Versions, DeleteMarkers][][?...]` returns empty because the flatten projection
swallows the filter (measured: 0 where the parenthesised form reported 347).
And the teardown sweep must NOT be `noncurrent` — after `aws s3 rm` the delete
marker is the entry carrying `IsLatest == true`, so a noncurrent-only sweep
leaves one marker per key behind forever and the zero-assertion never passes.

**Every entry point refuses a prefix that is not `cdkd/<stack>/<region>/` with
both segments non-empty** — the purge, the count, and the assertion alike. That
is a safety guard, not style, and it is needed on the READ side for a reason
that is easy to miss: `cdkd///` names no stack, so S3 lists nothing for it and
the count is a truthful `0` **about the wrong key space**. And because a purge that refuses cannot
abort its caller either — most call sites wrap it in `|| true`, and the three
that do not (`nested-stack-secret` twice, `stack-lock-renewal`) sit inside
`cleanup` under `set +e`, so the effect is the same — a mis-derived
`STATE_PREFIX` would print a refusal to stderr and let the fixture exit 0 with
the plaintext intact: the same vacuous green the whole convention exists to
remove, one level up. On the
purge side the guard also stops an unset `STACK` (recall `cleanup` runs under
`set +eu`) from widening the prefix and deleting another stack's LIVE state.

Deletes go through `DeleteObjects` in batches of 1000, the API maximum, so a
347-version key costs one CLI process rather than 347. A key or version id
carrying a quote or a backslash falls back to a single-object `delete-object`,
because the payload is assembled without `jq` — sourcing this file must not add
a `jq` dependency to the eighteen fixtures that source it. `Quiet: true` means a fully successful call
returns `{}`, so any `Errors` in the output is a per-object failure that the
call reported as overall success; it is surfaced as a WARN and the retry loop
plus the zero-assertion are the backstop. The call pins `--output json`, which
is load-bearing rather than tidy: the CLI's format is ambient
(`AWS_DEFAULT_OUTPUT`, or `output =` in the active profile), and under `text` /
`yaml` that same failure arrives as `ERRORS<TAB>…` / `Errors:`, the check never
matches, and the WARN is swallowed. On the success path the zero-assertion would
still catch the under-sweep; from `cleanup`, which purges `noncurrent` and
asserts nothing, it would not. Neither reader may inherit a format it does not
parse — which is why the listing pins `--output text` for the same reason.

Note also that the listing keeps **stderr out of the row stream**: a `2>&1`
there turns any benign CLI warning into a phantom surviving version, so an empty
bucket counts 1 and the assertion fails for no reason — and on the delete side
that warning text would be handed to `delete-object --key`.

Four lints see the helper — two STATIC, two EXECUTABLE, and knowing which owns
what is how you decide where to add a case.

Static: `tests/unit/scripts/integ-verify-bash-compat.test.ts` scans the shared
helpers in `tests/integration/*.sh` alongside every `verify.sh` — a bash-4-ism
in a file eighteen fixtures source is where it does the most damage and is least
likely to be noticed. `scripts/check-integ-aws-commands.ts` scans them too,
since a verb removed from the AWS CLI here breaks eighteen fixtures at once. Both
carry a per-shape floor, so a total swamped by 247 `verify.sh` files (across 287
fixture directories) cannot hide the helper going unread.

Executable, and the split matters:

- **`tests/unit/scripts/integ-s3-versions-helper.test.ts` owns the PREFIX
  GUARD.** It needs no AWS stand-in at all, and it pins the stronger property:
  that the guard fires **before any AWS call is even attempted**, proved with a
  fake `aws` that records its own invocation. Add a case here when you change
  `_s3v_check_prefix` or the set of prefixes that must be refused.
- **`tests/unit/scripts/integ-s3-versions-harness.test.ts` owns END-TO-END
  BEHAVIOUR.** It sources the real helper under `/bin/bash` against an emulated
  AWS CLI backed by a local version store, applying `--query` **per page** —
  which is not a detail, because trap 3 IS that per-page application, and a fake
  applying the query once would make the trap unreachable. It covers counting
  and sweeping, the `noncurrent` / `all` split, delete-marker-latest, exact-key
  scoping, pagination boundaries, listing failures, and the caller contract
  above; each of the three traps is reintroduced as a mutation probe and watched
  going red. Add a case here when you change what the helper DOES.

Where the two overlap on prefixes, the first owns "no request was issued" and
the second owns "and nothing was deleted"; neither is a copy of the other.

The harness is hermetic by construction: its child environment is built from an
allow-list rather than by inheriting the caller's, pinning `PATH`, `HOME`,
`TMPDIR`, `BASH_ENV` / `ENV`, `LC_ALL` / `LANG`, `TZ` and cwd, and forwarding no
`AWS_*` at all. Two axes are deliberately NOT pinned, and knowing why matters
if you add a case: a **process supervisor** (an agent sandbox, a debugger, a
profiler) injects variables into every spawned child *after* any env-building
function has run, so the leak check subtracts a CONTROL spawn rather than
naming them — an ignore-list would go quiet the moment a different supervisor
injected a different name. And the **filesystem layout** (`/bin/bash`,
`/usr/bin`, `/bin`) is assumed rather than pinned, failing loudly at the first
spawn if it is wrong. If you add a case, do not assert on a shell's DIAGNOSTIC
WORDING: an assertion on bash's `integer expression expected` passed under bash
3.2 and 5.x and failed in the full suite, where the resolved interpreter says
`Invalid integer` instead. Assert the observable — for that case, the vacuous
green itself. Its scratch root honours `CDKD_TEST_SCRATCH_DIR` (parallel agents
share `/tmp`) and prints a receipt naming the directory it used.

`tests/unit/scripts/integ-secret-fixture-sweep.test.ts` enforces the convention
itself, and it now has **two** ways to oblige a fixture to sweep.

**1. Declaring secret material.** A fixture whose `bin/**` or `lib/**`
TypeScript declares it — `unsafePlainText`, a hand-supplied `secretStringValue`
/ `secretObjectValue`, a templated `masterUserPassword`, `generateSecret: true`,
or an `iam.AccessKey` — must source the helper AND call
`s3_assert_versions_swept`. Both predicates read comment-stripped CODE: an early
cut matched the explanatory comment, so deleting the `source` line still read as
compliant.

**2. Resolving a secret DYNAMIC REFERENCE — a hard violation, not a soft note.**
A fixture whose sources carry `secretValueFromJson(...)`,
`SecretValue.secretsManager(...)`, `unsafeUnwrap()`, or a literal
`{{resolve:...}}` must sweep as well. That shape makes cdkd issue a real
`GetSecretValue` on the deploy path. On today's code the plaintext does not
reach state — the GHSA-p5qg-v9gv-hc7w fix rewrites each resolved value back to
its `{{resolve:...}}` expression before persisting, and the same redaction
covers the rollback journal's `attemptedProperties` — and that is a reason to
sweep rather than to skip: the redaction is a src-side invariant one bug away
from failing, and **object versions are forever**, so a single run under a
broken redaction leaves plaintext no later fix removes. Five of the six
fixtures in this class already swept; `rollback-cross-region-secret` was the
divergence and now sweeps both of its cross-region prefixes.

**What you have to do differently:** if your fixture reads a secret's VALUE into
a template property — not just its ARN — source the helper and assert, even
though nothing you can see puts a plaintext in `lib/*.ts`.

**`generateSecretString` is EXEMPT, and the exemption is fenced.** It looks like
it belongs beside `generateSecret: true` and does not. Issue
[#2212](https://github.com/go-to-k/cdkd/issues/2212) proposed adding it on the
premise that cdkd "persists that value into state.json exactly like a
hand-written one"; traced through `SecretsManagerSecretProvider`, that premise
does not hold. The value is minted LOCALLY from a CSPRNG into a local variable,
handed to `CreateSecret`, and never returned, read back, or written into the
properties bag: `create` / `update` return `attributes: { Id }` only, the
provider never issues `GetSecretValue`, and `getDriftUnknownPaths()` lists both
`SecretString` and `GenerateSecretString`. What state holds is the RECIPE.

So it lives in the lint's `EXEMPT_SHAPES` rather than in `SECRET_MATERIAL`, and
**each conjunct of that premise is asserted against the provider source**, so
the exemption fails loudly rather than rotting if any of them stops being true —
if that test goes red, re-open #2212 instead of relaxing it. The exemption is
also CONDITIONAL: it self-revokes for any fixture that ALSO consumes the
secret's value into a template property, which is rule 2 above. The four
fixtures it covers on its own (`composite-stack`, `event-driven`,
`full-stack-demo`, `secrets-rotation-schedule`) reference their secret by ARN
alone, which is why three of them legitimately have no `verify.sh` at all. A
fifth, `secretsmanager-update-value-source` (issue #2472), also carries a
`generateSecretString` secret but sweeps regardless: it declares a literal
`unsafePlainText` beside it, so rule 1 applies and it sits in the audited
seeding set.

It exists because a hand audit is not enough, and that is measured rather than
assumed: the #2096 audit read every fixture's `verify.sh` and still missed
`docdb-neptune`, `eventbridge-api-destination` and `cognito-resource-server` —
each the structural twin of one it did find — because the secret is declared in
`lib/*.ts`, where that audit never looked.

The lint names what it cannot see, and so should you: raw CloudFormation
fixtures whose template is a checked-in `.json` / `.yaml`; secrets seeded by the
SCRIPT rather than the app (`dynamic-ref-cross-region` writes a plaintext state
record with `aws s3 cp`); and service-generated credentials with no marker in
the source at all — Cognito's `ClientSecret` was that class and was found by
grepping the BUCKET, not the source. The per-fixture zero-assertion plus
periodic bucket inspection remain the backstop.

## A destructive prefix sweep must refuse a widened scope

A teardown that LISTS resources under a variable prefix and DELETES every name
the listing returns is one empty variable away from an account-wide delete:

```bash
for name in $(aws logs describe-log-groups \
    --log-group-name-prefix "${LG_PREFIX}" \
    --query 'logGroups[].logGroupName' --output text); do
  aws logs delete-log-group --log-group-name "${name}"
done
```

With `LG_PREFIX` empty or unset the filter is the empty string, which every log
group name matches, so the loop deletes every log group in the ACCOUNT. The
same collapse happens to a JMESPath filter — `starts_with(RoleName, '${STACK}')`
and `contains(RoleName, '${STACK}')` are true of every role when `STACK` is
empty — and teardown is exactly where it goes unnoticed, because `cleanup` runs
under `set +eu`: the one thing that would have caught the unset variable is
switched off two lines above.

**A literal anchor narrows the blast radius; it does not remove it.**
`--log-group-name-prefix "/aws/lambda/${STACK}"` with an empty `STACK` collapses
to the NAMESPACE rather than to the account — which is still every Lambda log
group in the region, cdkd's and everyone else's. Guard those too;
`iam-oidc-provider/verify.sh` keeps exactly that sweep inside its `case` arm for
this reason. Guard with a `case` that refuses anything outside the fixture's own
scope, ABOVE the first delete. It is the log-group / IAM twin of `_s3v_check_prefix`
(["Sweep S3 object versions"](#sweep-s3-object-versions-and-assert-the-count-is-zero)),
and like that one it is a safety guard, not style.

**Which refusal you write is decided by control flow, not taste.** In a
subshell-bodied sweep helper, refuse with `exit 0` — the exit ends the subshell
and the function returns, leaving the caller running:

```bash
sweep_log_groups() {
  ( set +eu
    case "${LG_PREFIX}" in
      /cdkd-integ/*/) ;;
      *) echo "    WARN: teardown sweep refused a prefix outside /cdkd-integ/: '${LG_PREFIX:-<empty>}'" >&2
         exit 0 ;;
    esac
    ...
  )
}
```

Inline in `cleanup` there is no subshell, so an `exit` would abandon the rest of
the teardown — every later `state destroy`, every later sweep. Wrap the sweep in
the `case` instead:

```bash
case "${STACK}" in
  Cdkd?*)
    for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, '${STACK}')].RoleName" --output text); do
      aws iam delete-role --role-name "${role}" || true
    done
    ;;
  *) echo "    WARN: teardown sweep refused a stack scope outside Cdkd*: '${STACK:-<empty>}'" >&2 ;;
esac
```

A third spelling appears where the sweep is neither in a subshell nor worth
wrapping — a plain early return at the top of the helper, which
`eventsourcemapping-race/verify.sh`'s `list_esms_for_function` uses:

```bash
list_esms_for_function() {
  local fn="$1"
  if [ -z "${fn}" ]; then
    echo "    WARN: teardown sweep refused an empty function scope" >&2
    return 0
  fi
  ...
}
```

It carries no pattern, so the "must not match the empty string" property below
has no analogue for it; what stands in is that the test is `-z` and the branch
LEAVES. Use it only where the whole function is the sweep — otherwise the
`return` skips work the caller still needs.

Four properties make the difference between a guard and a decoration:

- **It must DOMINATE the sweep.** A `case` sitting above the sweep is not
  enough: the sweep has to be inside a non-catch-all arm, or after an `esac`
  whose catch-all leaves via `exit` / `return`. A catch-all that warns and falls
  through stops nothing, and a `case` with no catch-all at all stops nothing
  either — bash falls straight through one that no arm matches.
- **The accepted pattern must not match the empty string, and it must match
  YOUR scope.** `*)`, `"")` and a pattern that is itself an expansion all admit
  the value the guard exists to exclude. Write **the shortest literal prefix
  your own scope actually has, plus `?*`** — `Cdkd?*` where the stack is
  `CdkdFooExample`, `ApiGateway?*` where it is `ApiGatewayStack`,
  `/cdkd-integ/*/` for a log-group prefix. `Cdkd?*` is NOT a house pattern —
  measured 2026-09-06, 36 of the 213 fixtures with a literal `STACK=` do not begin
  with `Cdkd` — and copy-pasting it into one of those refuses PERMANENTLY and
  silently: every delete here is `|| true`, so the run leaks and still exits 0
  with the WARN buried in an EXIT trap. Aim to exclude EMPTY, not to name the fixture exactly:
  an exact full literal goes stale on the next rename, and a stale guard is the
  same silent leak.
- **The refusal must WARN on stderr, with the words `teardown sweep refused`.**
  A silent `return` is indistinguishable from the sweep having run and found
  nothing, which is the difference between reading a failed teardown and
  re-running it blind. The exact phrase is a forward-looking convention rather
  than decoration: a checker has to FIND a guard before it can judge one, and
  issue [#2690](https://github.com/go-to-k/cdkd/issues/2690) will key on this
  phrase. Every guard added by issue
  [#2621](https://github.com/go-to-k/cdkd/issues/2621) uses it — but
  `s3-versions.sh`'s `_s3v_check_prefix`, the reference parameter-scoped guard
  described below, predates the convention and refuses with `FAIL: s3-versions:
  refusing to sweep …` instead. A checker keyed on the phrase alone would miss
  the reference implementation; #2690 has to decide how it finds a guard before
  it can judge one, and that is recorded there.
- **The accepting arm must come FIRST.** Bash takes the first matching arm, so
  a `*)` written above it swallows every scope and the sweep never runs — with
  every pattern still looking correct in review. Nothing checks this today;
  read the arms in order.

**A scope that arrives as a PARAMETER is guarded in the HELPER, on its own
parameter — not at the call sites.** A caller-side guard has to be repeated at
every call, and the one added next year is the one that forgets; a helper-side
guard cannot be forgotten. Every instance in this tree does it that way:
`tests/integration/s3-versions.sh`'s `s3_purge_prefix_versions` validates its
own `$2` with `_s3v_check_prefix` before doing anything, and its callers refuse
nothing (`s3_purge_key_versions` guards its own `$2` the same way); and
`eventsourcemapping-race/verify.sh`'s `list_esms_for_function` refuses an empty
`$1` before it lists.

**Where the convention is not yet applied.** Nearly all the namespace-anchored
sweeps (`--log-group-name-prefix "/aws/lambda/${STACK}"` and kin) carry no guard
— all unreachable today, since every scope variable is a literal, and one of
them is already inside `iam-oidc-provider`'s arm — and
`aws s3 rm "s3://${BUCKET}/${PREFIX}/" --recursive` puts the scope in a path
segment rather than a flag. Both are tracked in
[#2682](https://github.com/go-to-k/cdkd/issues/2682). Write the guard anyway if
you are adding one of those shapes: the rule above covers them, only the
back-fill does not.

## Unit tests: prime exactly what the code path consumes

`vi.clearAllMocks()` clears call RECORDS but does **not** drain the queue seeded
by `mockResolvedValueOnce` and its siblings. So a test that primes more
responses than its code path consumes leaves the remainder queued, and a later
test in the same file receives that leftover as one of its own responses — with
every later call shifted by the same offset.

The shifted test does not error. It reads a response describing a different
resource, takes a different branch, and then satisfies its own assertions,
because the assertions on that branch are usually ABSENCE assertions
(`toBeUndefined()`, `toHaveLength(0)`, `not.toHaveBeenCalled()`) and an absence
assertion is satisfied both by "the guard correctly declined" and by "the code
never got there". In issue #1588 the only symptom was a `logger.warn` that was
mysteriously never called, and locating it took a full instrumentation pass.

A runtime detector catches this (issue #1618). It is **off by default** so the
ordinary `vp run test` is unaffected; the CI job `once-leak-detect` runs the
suite a second time with it armed:

```bash
vp run test:once-leak        # the unit suite with the detector armed
```

What it flags is precisely a value **consumed by a different test than the one
that primed it**. The failure lands on the test whose result is corrupt, and
names the earlier test that primed the stale value:

```text
This test consumed a mock response primed by an EARLIER test.

  - primed by: over-primes and clearAllMocks does not drain it
  - mock: vi.fn()
```

Fix the EARLIER test: prime exactly what its code path consumes. If the extra
priming is deliberate, drain it with `mockReset()` in `beforeEach` (again:
`clearAllMocks` does not drain it).

Two things it deliberately does NOT flag, because neither corrupts a result: an
over-priming that no later test ever consumes, and a value primed in `beforeAll`
(which has no owning test to cross a boundary from).

The detector carries a canary — `tests/unit/scripts/once-leak-canary.test.ts`
leaks on purpose, and a CI step requires that running it with the allow-list
ignored still FAILS. That is what stops a silently-broken detector from looking
identical to a clean tree. Do not "fix" that suite's priming.

Three pre-existing files leaked when the detector landed and were grandfathered in
`tests/once-leak-allowlist.json`. All three were fixed by
[issue #1655](https://github.com/go-to-k/cdkd/issues/1655) and dropped from the
list, so it now holds nothing but the canary — the goal state. Fixing a file and
dropping its entry is the intended direction; adding an entry is not, and a new
test file that leaks fails CI. Regenerate the list with
`vp run gen:once-leak-allowlist`.

Worth knowing before you fix one, from the #1655 pass: in all three files the
over-priming described a call the code path never makes at all — a
`ListTagsForResource` gated on a field the mocked response omitted, three
policy/tag no-op responses for helpers that issue zero sends, and a
`DescribeTags` that `update()` never calls because it derives the tag diff from
the property bags. So the reliable fix is to MEASURE what the path consumes
rather than to trust the priming's own comment, all three of which were wrong.
Pinning the count with `expect(mockSend).toHaveBeenCalledTimes(N)` next to the
existing assertions is worth adding, but know what it does: it catches the code
path CHANGING how many calls it makes (the thing that silently invalidates a
priming), NOT a surplus primer — an unconsumed response leaves the count
unchanged. The detector is what catches the surplus, which is why dropping the
file from the allow-list is the load-bearing half of the fix.

Note what this deliberately does NOT do: it does not require `mockReset()` in
every suite that uses a `*Once` primer. That was the original proposal, and
measurement rejected it — 182 of the 265 `*Once`-using files have no reset, the
mechanical swap to `resetAllMocks()` breaks 1181 tests, and the presence of
`mockReset` is only a PROXY for the defect. Checking the defect directly
implicated a handful of files rather than 182, and needed no remediation batch
at all.

## Unit tests: a green run prints nothing

`tests/setup.ts` installs a **stream fence** (`tests/stream-fence.ts`) that
buffers direct `process.stdout` / `process.stderr` writes made inside a test and
replays them, headed by the test name, only if that test FAILS.

It exists because vitest attributes and suppresses `console.*` but a raw
`stream.write()` bypasses that entirely. Product code writes that way on purpose
where the logger is the wrong channel — the deprecated-`--region` notice in
`src/cli/options.ts`, the SIGINT notices in `src/provisioning/interrupt-watch.ts`
and `src/cli/commands/destroy-runner.ts`, the critic summaries under `scripts/` —
so any suite exercising those paths legitimately printed them. Measured on the
full suite before the fence: 108 such lines, ~20 KB of `vp test run`'s ~22 KB of
output, i.e. the reporter's own output was under a tenth of what a PASSING run
emitted. After: 616 bytes, 15 lines, for a full green run of 17,473 tests.

That is a correctness property, not a tidiness one. A green run's output is what
a person or an agent reads to decide whether to trust the run, and 20 KB of
notices from passing tests is 20 KB a real signal can hide in.

Two deliberate carve-outs:

- Writes **outside** a test body (module top level, `beforeAll` / `afterAll`)
  pass straight through. They are diagnostic about the FILE, and there is no
  failing test to attach them to. `beforeEach` / `afterEach` are INSIDE the
  fence, though — they bracket one specific test, and the fence stops at
  `onTestFinished`, which runs after `afterEach` — so their writes follow the
  same rule as the test body's: replayed on failure, dropped on a pass.
- `CDKD_TEST_STREAM_PASSTHROUGH=1` disables the fence entirely. Debugging a hang
  or a crash needs the writes as they happen: a run that never reaches the end of
  a test never reaches the replay either.

```bash
CDKD_TEST_STREAM_PASSTHROUGH=1 vp test run tests/unit/cli/destroy-runner-sigint.test.ts
```

A test that asserts on such a write is unaffected: the convention here is to
REPLACE `process.stderr.write` and restore it afterwards (see
`tests/unit/cli/options.test.ts` and
`tests/unit/provisioning/interrupt-watch.test.ts`, both of which note that
`vi.spyOn` does not intercept the stream cleanly under vitest's output capture).
A replacement sits above the fence, so the fence never sees those writes at all.

The capture is bounded by the test at BOTH ends. `onTestFinished` stops it while
keeping the buffer — vitest runs `afterEach` -> `onTestFinished` ->
`onTestFailed`, so the replay still finds something to replay, and everything
after that (a later `beforeAll`, `afterAll`, the next file's module top level in
a reused worker) writes straight through. An earlier cut of this fence started
the capture and never stopped it, which turned the carve-out above into a silent
swallow; `tests/unit/stream-fence.test.ts` fences that with an `afterAll` that
asserts the fence is no longer capturing.

One further assumption: one buffer per worker, so tests within a file must run
SERIALLY. `it.concurrent` would let one test's capture wipe a peer's buffer.
This repo uses none, and the same test file fails if that changes.

## Related

- [Testing](testing.md) — the end-to-end walkthrough these conventions apply to
- [Provider Development](provider-development.md) — writing the provider a
  fixture exercises
- [Supported Resources](supported-resources.md) — which types have an SDK
  provider

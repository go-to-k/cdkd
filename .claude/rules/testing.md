---
description: cdkd testing strategy (unit / integration / UPDATE / Rollback failure injection)
paths:
  - 'tests/**'
---

# Testing Strategy

## Unit Tests

- `tests/unit/**/*.test.ts`
- Uses Vitest
- **Import test APIs from `'vite-plus/test'`, never `'vitest'`** — vitest is a
  transitive dep bundled inside `vite-plus`, so a bare `'vitest'` specifier
  resolves locally (pnpm hoisting) but fails CI's `vp run typecheck:test` with
  TS2307 (PR #1226). Copy the import line from a sibling test. Enforced by
  `tests/unit/scripts/test-import-convention.test.ts` (fails the local test
  run, naming the offending file).
- Mocking: Mock AWS SDK with vi.mock()

### A `*Once` primer must be consumed by the test that primed it (mandatory)

`vi.clearAllMocks()` clears call RECORDS but does NOT drain the queue seeded by
`mockResolvedValueOnce` / `mockReturnValueOnce` / `mockRejectedValueOnce` /
`mockThrowOnce` / `mockImplementationOnce` (`@vitest/spy`: `mockReset` sets
`config.onceMockImplementations = []`, `mockClear` does not). A test that primes
more responses than its code path consumes leaks the remainder into the NEXT
test in its file, shifting every later call by the same offset.

The leak is dangerous rather than merely untidy because the shifted test still
PASSES: it takes a different branch and satisfies that branch's assertions,
which are usually ABSENCE assertions (`toBeUndefined()`, `toHaveLength(0)`,
`not.toHaveBeenCalled()`) — and an absence assertion is satisfied both by "the
guard correctly declined" and by "the code never got there". In issue #1588 the
only symptom was one `logger.warn` that was never called.

Enforced at RUNTIME, not by a lint, by `tests/once-leak-detector.ts` + the
`once-leak-detect` CI job (`vp run test:once-leak`). Every `*Once` spelling
funnels through `mock.mockImplementationOnce`, so instrumenting that one method
covers all five: each queued implementation is wrapped in a closure that
remembers WHICH test primed it, and the wrapper fires when the queue is actually
shifted (`@vitest/spy` dist line 303 shifts exactly once per invocation).

**What is flagged is a primed value CONSUMED BY A DIFFERENT TEST than the one
that primed it** — the defect itself. Three cheaper-looking proxies were tried
and are wrong; do not reintroduce them:

- **"the queue is non-empty when the test ends"** flags a suite that drains with
  `mockReset()` in `beforeEach` — i.e. the very remediation prescribed above —
  because a setup-file `afterEach` runs BEFORE the next test's `beforeEach`.
  This was measured on a probe suite, not reasoned about; it fired on the first
  try.
- **`calls.length` delta accounting** is wrong whenever priming and consumption
  interleave (prime 1, call 3x, prime 2 more leaks 2 but nets 0), and
  `mockClear()` resets `calls` out from under it.
- **a static lint requiring `mockReset()`** checks for the presence of a symbol,
  not for over-priming. Measured: 182 of the 265 `*Once`-using files have no
  reset and the mechanical swap breaks 1181 tests, so that lint needed a
  182-file remediation batch. Checking the real defect implicated THREE files
  (tracked by issue #1655) and needed none.

**The detector has its own canary**, because with the grandfather list honoured
"the detector went dead" and "the tree is clean" produce the identical green
result — the vacuous pass this file forbids elsewhere.
`tests/unit/scripts/once-leak-canary.test.ts` leaks deliberately (and is
therefore allow-listed, automatically, by the generator), and the CI step
`detector canary` re-runs that file alone with
`CDKD_ONCE_LEAK_IGNORE_ALLOWLIST=1` and requires a failure carrying the
detector's OWN wording (`primed by an EARLIER test`). Asserting only a non-zero
exit is NOT equivalent and must not be "simplified" back to it: a deleted or
renamed canary file makes `vp test run <path>` exit 1 with "No test files
found", and so do a syntax error and a failed install — each of which would let
the step pass while the detector is dead, which is the very hole it exists to
close. Do not "fix" that suite's priming either; it is not a defect.

Two more design points are decisions, not accidents:

- **It is OFF unless `CDKD_ONCE_LEAK_DETECT=1`.** Nothing is wrapped and no
  hooks are registered when off, so the default run is byte-for-byte unchanged.
  This is what let it land while other lanes were mid-flight; three earlier
  attempts at this issue stood down waiting for a "quiet tree" that a default-ON
  change would have required.
- **The allow-list grandfathers whole FILES.** Per-test entries go stale on any
  rewording. A grandfathered file gets no protection for its new tests either —
  accepted, and the ratchet direction is to fix a file and DROP its entry
  (`vp run gen:once-leak-allowlist`). `tests/unit/scripts/once-leak-allowlist.test.ts`
  fails an entry that no longer names an existing file or one that no longer
  primes anything, and caps the list so a runaway regeneration cannot exempt the
  tree.

## Integration Tests

- `tests/integration/**`
- Uses actual AWS account
- Environment variables: `STATE_BUCKET`, `AWS_REGION`
- Examples verified with real AWS deployments (see `tests/integration/` for full list)

### `verify.sh` signal traps (mandatory)

A fixture that provisions real AWS resources must arm its `cleanup` trap on the
signal paths too, in the **exiting** form:

```bash
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM
```

`trap cleanup EXIT INT TERM` is NOT equivalent and must never be used: a bash
signal handler returns to the interrupted point, so the script resumes the
interrupted phase after cleanup and can `exit 0` — reporting PASS while
`cleanup` raced a still-live deploy. Omitting `INT` / `TERM` entirely leaks the
stack on Ctrl-C or a harness timeout. Disarm with `trap - EXIT INT TERM`.

The `(exit N)` seed is load-bearing, not decoration. Many fixtures' `cleanup`
opens with `rc=$?` and gates the whole teardown on it (`if [ "${rc}" -eq 0 ];
then exit 0; fi`). Inside a handler `$?` is the **interrupted command's** status,
not the signal, so without the seed an interrupted run can see rc=0, skip the
teardown entirely and exit 0 — the exact bug this convention exists to prevent.
`(exit N)` sets `$?` to the signal's code, so `rc=$?` and `${1:-$?}` cleanups
both tear down correctly.

Enforced by `tests/unit/scripts/integ-verify-signal-traps.test.ts` (issue #1097);
the user-facing writeup is in [docs/testing.md](../../docs/testing.md).

### `verify.sh` gone-probes (mandatory)

A destroy/leak assertion must never be a silenced blind probe:
`if aws <read-probe> ... >/dev/null 2>&1; then FAIL` (and the inverse
`if ! aws ...; then <conclude gone>`) read ANY failure (throttle, auth,
network) as "gone" and silently pass the leak check (issue #1097 pattern 2).
Route probes through the canonical helper block every affected fixture carries
verbatim (source of truth: `scripts/check-integ-probe-not-found.ts`):

```bash
assert_gone "<leak description>" aws <service> <read-verb> [args...]
if ! gone_probe aws <service> <read-verb> [args...]; then ...still exists...; fi
```

`gone_probe` accepts ONLY the canonical not-found signature
(`'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'`) and hard-FAILs on
anything else. Probe state files via `s3api head-object`, never `aws s3 ls`
(which exits 1 with empty output for "no keys"). Out of scope: mutation probes,
fail-closed existence checks, pre-flight "already exists" guards, best-effort
cleanup guards.

Two more spellings of the same defect are banned (issue #1120): **capture-form
fallbacks** (`N=$(aws <read-verb> ... 2>/dev/null || echo 0)` / `|| true` —
a throttle reads as "0 remaining"; use a plain strict capture, or branch on
`gone_probe` when not-found is legitimate) and **silenced function wrappers**
(an exit-status wrapper `fn() { aws ... >/dev/null 2>&1; }` or a value wrapper
with a swallow tail). Tail-less silenced captures/wrappers stay legal (`set -e`
fails them loudly; for wrappers ONLY when the probe is the LAST command of the
body), as does the strict stderr-capture idiom
(`$(cmd 2>&1 >/dev/null || true)`).

**Intermediate captures inside a value wrapper need `|| return 1`**: errexit
is CLEARED inside `$( )` command substitutions, so in a multi-statement
wrapper called as `V="$(fn)"` an intermediate `out="$(aws ...)"` failure does
not abort the body and the function exits 0 via its formatting tail; the
explicit `|| return 1` propagates the probe error to the caller's `set -e`
(`local V=$(...)` masks the status entirely; split declaration from
assignment). A `gone_probe`-then-requery site must guard the requery against
the TOCTOU race: canonical not-found on the requery is still "gone", anything
else hard-fails. Best-effort cleanup is exempt via `set +e[u]` spans (bounded
by the enclosing function) — mark cleanup helpers with `set +eu` in a
SUBSHELL body (`fn() { ( set +eu; ... ) }`) instead of silencing probes, so
calling them from a `set +eu` cleanup trap never re-arms strict mode
mid-sweep. Enforced by
`tests/unit/scripts/integ-verify-probe-not-found.test.ts`; user-facing writeup
in [docs/testing.md](../../docs/testing.md).

### `verify.sh` CLI flags (mandatory)

Every flag a fixture passes must be declared on the **subcommand it targets**,
not merely somewhere in `src/cli/options.ts`. The originating case (issue #1097):
`cdkd import --region` died with `error: unknown option '--region'`, so the
import round-trip that fixture existed to exercise had never run once. `--region`
IS declared in options.ts and IS accepted by ~10 sibling commands — `import` is
the single one that never attaches it, so the flag looked right by analogy.

Two known traps when auditing by hand: `--help` omits hidden options (so help
text is not decisive), and `--region` is NOT a no-op on the commands that DO
accept it (it is the highest-precedence region source per
[cli-internals.md](cli-internals.md)) — "cleaning up" deprecated `--region`
flags would silently change region resolution.

Enforced by `tests/unit/scripts/integ-cli-flags.test.ts`, which walks the real
Commander tree via `buildProgram()` (`src/cli/program.ts`) rather than `--help`
or options.ts. A flag counts as accepted when the target command OR any ancestor
declares it, matching Commander's own lookup. The check carries coverage floors
(totals plus one per supported call shape), so a parser regression that stops
seeing invocations fails loudly instead of passing vacuously -- two iterations
of this lint were green while skipping most of the tree. The
`state-destroy-force-gate.sh` hook remains the commit-time guard for the
specific `state destroy --force` case; this lint generalizes it to every
subcommand and also catches pre-existing occurrences the hook cannot see.

### `verify.sh` version literals (mandatory)

Never hardcode a Lambda published-version literal in a fixture: version
counters are monotonic per function/layer NAME and never reset, so a
`"${FN}:1"` probe or a `[ "${V}" != "2" ]` assert passes only on the very
first run in the account and fails every re-run with
`ResourceNotFoundException` (issue #1324; third recurrence of the trap). Read
version N from the live alias (`--query 'FunctionVersion'`), guard it numeric
with a `case` pattern, and assert rotation as `EXPECTED=$((N + 1))` — see
`codedeploy-lambda-deployment-group/verify.sh` for the reference shape. Alias
qualifiers (`:live`, `:$LATEST`), variable qualifiers, relative compares, and
`length(...)` count queries stay legal; genuinely fixed versions (public
cross-account layer ARNs) take `# allow-version-literal: <reason>`. Enforced
by `tests/unit/scripts/integ-verify-version-literals.test.ts` (classifier:
`scripts/check-integ-version-literals.ts`); user-facing writeup in
[docs/testing.md](../../docs/testing.md).

### `verify.sh` must not call an `aws` verb the CLI does not have (mandatory)

A fixture must not call an `aws <service> <verb>` that is not a real AWS CLI
subcommand. The trap is that such a verb can look entirely legitimate: the AWS
CLI **removes** a set of operations from its command table
(`awscli/customizations/removals.py`) that still exist in the API, so the SDKs,
the API reference, and anything generated from them all offer it.

Originating case, verified 2026-08-09 against `aws-cli/2.35.13`:
`aws emr list-instance-groups`, which forced two EMR fixtures to be rewritten.
Its symptom was misleading —

```text
Warning: Input is not a terminal (fd=0).
aws: [ERROR]: [Errno 22] Invalid argument
```

plus a hang without `</dev/null`, and `--no-paginate --no-cli-pager` did not
help. That reads like an interactive "customization" and was first written up
that way. **That diagnosis was wrong.** The actual cause:

1. `list-instance-groups` is on the CLI's REMOVAL list — it is not an `aws emr`
   subcommand at all, and the CLI's own answer is
   `Found invalid choice 'list-instance-groups'`.
2. The `Errno 22` / hang is what `cli_auto_prompt` (`on-partial` in the
   maintainer's `~/.aws/config`) does to ANY invalid-choice error: the CLI
   opens its interactive prompter, which cannot attach to a non-terminal stdin.
   `AWS_CLI_AUTO_PROMPT=off` makes the same call fail fast and legibly.

The corollary changes how you pick a replacement: **the neighbouring verbs are
usually fine.** `aws emr list-instance-fleets` and `aws emr list-instances` are
NOT removed and work non-interactively — so "the `list-instance-*` family is
suspect" was the wrong generalization, and "assume any `aws emr` verb is
suspect" over-blocks (the EMR fixtures rely on `list-clusters` /
`describe-cluster` / `modify-cluster-attributes` / `terminate-clusters`). The
unit of the defect is the (service, verb) pair.

Enforced by `tests/unit/scripts/integ-aws-commands.test.ts` (classifier:
`scripts/check-integ-aws-commands.ts`) against the captured table
`tests/fixtures/aws-cli-removed-commands.json` (refresh:
`vp run gen:aws-cli-removals`). The table is a checked-in capture, not a live
`aws` call, so the check is offline + deterministic — a checker that skips when
its oracle is missing is the vacuous pass this file's checker rules forbid.
Escape hatch: `# allow-unavailable-aws-command: <reason>` on the invocation's
line or the line above.

**Probe before you rely on an unfamiliar verb.** `AWS_CLI_AUTO_PROMPT=off aws
<service> <verb> --help` settles existence in under a second; running it against
a bogus id settles behavior.

**When the verb is unavailable, call the SDK directly** rather than reaching
for a different CLI verb that happens to work but returns less. The repo root
already depends on every `@aws-sdk/client-*` cdkd uses, so a `node
--input-type=module -e` one-liner from `REPO_ROOT` needs no extra install, and
its response keys are the SDK's (PascalCase) shape:

```bash
REPO_ROOT="${PWD}/../../.."
list_instance_groups_json() { # $1 = cluster id -> JSON array of InstanceGroups
  ( cd "${REPO_ROOT}" && REGION="${REGION}" node --input-type=module -e "
import { EMRClient, ListInstanceGroupsCommand } from '@aws-sdk/client-emr';
const client = new EMRClient({ region: process.env.REGION });
const groups = [];
let marker;
do {
  const res = await client.send(
    new ListInstanceGroupsCommand({ ClusterId: process.argv[1], Marker: marker })
  );
  groups.push(...(res.InstanceGroups ?? []));
  marker = res.Marker;
} while (marker);
process.stdout.write(JSON.stringify(groups));
" "$1" ) || return 1
}
```

Two things in that shape are load-bearing, not decoration. The `|| return 1`
propagates a node/SDK failure to the caller's `set -e` — without it an empty
result silently satisfies a `// empty`-defaulted `jq` assertion (the
gone-probe rule's failure mode, one layer up). And the `Marker` loop matches
whatever pagination the provider under test does; a partial first page is a
silent false pass. Reference implementations:
`tests/integration/emr-cluster/verify.sh` and
`tests/integration/emr-instance-configs/verify.sh`.

A pager invoked non-interactively is a SEPARATE route to a hang, so
`export AWS_PAGER=""` near the top of a fixture is cheap insurance. This is a
recommendation for NEW and affected fixtures, not a tree-wide invariant — most
existing fixtures do not set it and are fine.
`tests/integration/emr-instance-configs/verify.sh` is the reference.

Mechanically enforced since issue
[#1402](https://github.com/go-to-k/cdkd/issues/1402) (see the lint named
above). User-facing writeup in [docs/testing.md](../../docs/testing.md).

### `verify.sh` upstream-cdk callers must pin AND resolve a fixture-local CLI (mandatory)

A fixture whose `verify.sh` invokes the upstream `cdk` CLI (bare `cdk deploy`,
`npx` / `pnpm exec` / `yarn cdk ...`, or a `CDK_BIN`-style variable) must:

1. pin `aws-cdk` at a real version range — `*` / `latest` re-admit the very
   skew this rule exists for;
2. install the FIXTURE's own deps. The `(cd "${REPO_ROOT}" && pnpm install)`
   nearly every verify.sh already carries installs the CLI's deps, not the
   fixture's, and does not count;
3. if that install is conditional, guard it on the cdk BIN, not on the
   directory — a `node_modules` left over from before the pin exists but has
   no `cdk` in it, so `[ -d node_modules ]` skips the install that would fix
   it. An unconditional install needs no guard; and
4. make every invocation resolve the fixture-local CLI. The canonical shape:

```bash
[ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || (cd "${TEST_DIR}" && npm install)
export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"
```

(an explicit `CDK_BIN="${TEST_DIR}/node_modules/.bin/cdk"` used for every
invocation is equally hermetic and needs no PATH prepend — but a `CDK_BIN`
holding an absolute path is resolved directly, so a prepended PATH never
redeems one pointing outside the fixture.)

A pin without resolution is dead weight: the run silently takes whatever
global `cdk` the machine has, and when that lags the fixture's `aws-cdk-lib`
the synth dies with a cloud-assembly schema-version mismatch.
`import-nested-stack` failed exactly this way on the 2026-08-10 staleness
sweep — its package.json pinned `aws-cdk` while its verify.sh logged
`using global cdk` — seven weeks after PR #1253 fixed the identical trap in
three other fixtures individually (issue #1485 closed the class). Enforced by
`tests/unit/scripts/integ-cdk-cli-pins.test.ts` (classifier:
`scripts/check-integ-cdk-cli-pins.ts`). The classifier strips heredoc bodies
and comments, then walks each line quote-aware, so neither an invocation nor
an install/prepend/guard signal is ever read out of an `echo` argument, a
`grep` pattern, or a trailing comment. User-facing writeup in
[docs/testing.md](../../docs/testing.md).

### `verify.sh` `state destroy` must pass `--state-bucket` (mandatory)

The harness exports `STATE_BUCKET`; the CLI's env fallback is
`CDKD_STATE_BUCKET` — a DIFFERENT name. A cleanup sweep that omits
`--state-bucket` therefore never reads the harness bucket at all. Resolution is
CLI flag > `CDKD_STATE_BUCKET` > `cdk.json` `context.cdkd.stateBucket` > STS
default (`resolveStateBucketWithSource`), so the omission lands in one of two
wrong places:

- **109 fixture `cdk.json` files declare `context.cdkd.stateBucket`** and
  `verify.sh` runs the CLI from the fixture directory, so the sweep resolved
  that name (`your-cdkd-state-bucket` / `cdkd-state-test`) and died with
  `StateError: State bucket '...' does not exist` — swallowed by the call's own
  `>/dev/null 2>&1`. Those cleanups had been failing on EVERY run, invisibly.
- **The rest** fell through to the STS default `cdkd-state-{accountId}`, which
  IS the harness bucket on a default setup — working by coincidence, and
  silently no-opping the moment `STATE_BUCKET` points anywhere else.

Either way the state record survives and wedges the fixture's next run.

```bash
node "${LOCAL_DIST}" state destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
```

`"${STATE_BUCKET:-}"` not `"${STATE_BUCKET}"`: `cleanup` is trap-installed and
can run BEFORE the script's own `[ -z "${STATE_BUCKET:-}" ]` guard rejects an
unset variable, and a cleanup that only does `set +e` (not `set +eu`) aborts
teardown mid-sweep on the unguarded form. Empty is safe — `resolveStateBucket()`
treats `''` as not-supplied and falls back exactly as omitting the flag does.

**`deploy` / `destroy` deliberately keep the strict `"${STATE_BUCKET}"` form.**
The two cases are not the same: in cleanup the guard prevents an abort that
would skip teardown, whereas on a deploy an unset bucket is a harness
misconfiguration that must fail loudly rather than silently target the default
bucket. Do not "normalize" the deploy sites to `:-`.

The measured asymmetry is what made this a lint rather than a one-time sweep
(issue [#1567](https://github.com/go-to-k/cdkd/issues/1567), 2026-08-11):
`deploy` passed the flag at all 335 call sites and `destroy` at all 228, while
`state destroy` had drifted at **96 of 171** call sites across 94 fixtures —
because nothing enforced it. Enforced by
`tests/unit/scripts/integ-state-bucket.test.ts` (classifier:
`scripts/check-integ-state-bucket.ts`), which strips heredocs, comments and
`echo` arguments so a remediation hint that PRINTS the command is not read as an
invocation. User-facing writeup in [docs/testing.md](../../docs/testing.md).

### `verify.sh` list readbacks must be order-insensitive (mandatory)

AWS does not preserve the submitted order of list-valued members on readback.
An assertion that string-compares a joined list against the submitted order is
flaky, and its failure message ACCUSES THE FIX — the worst kind of false
negative. Verified 2026-08-09 on the `lambda-esm-self-managed-kafka` fixture:
cdkd sent `Endpoints.KAFKA_BOOTSTRAP_SERVERS = [b-1…, b-2…]`,
`list-event-source-mappings` returned `[b-2…, b-1…]`, and the assertion
reported "issue #1384 NOT closed" while the fix was working perfectly.

Sort BOTH sides unless the list is genuinely order-significant:

```bash
--query "join(' ', sort(Path.To.List || \`[]\`))"
```

(The `|| \`[]\`` coalesce is the separate null-list guard the gone-probe rule
covers — keep both.)

This is the integ-side twin of `src/analyzer/drift-normalize.ts`, which
canonicalizes tag lists and resource-id/ARN arrays on BOTH comparison sides for
exactly this reason. The same judgment call applies: a list that IS
order-significant (DNS resolver lists, preference orders — see
`getDriftUnorderedPaths`) must stay unsorted, because sorting it would HIDE a
real regression.

NOT mechanically enforced — whether a given list is order-significant is a
judgment call a lint cannot make, so this one stays a read-it-and-follow-it
rule by design. User-facing writeup in
[docs/testing.md](../../docs/testing.md).

### A mode-gated fixture resource DISAPPEARS in every later step that omits the token (mandatory)

Multi-step fixtures drive each phase with
`CDKD_TEST_UPDATE=<comma,separated,modes>` and the stack reads
`updateMode.includes('x')`. The natural way to add a scenario is to gate the new
resource on a new token — and that is **wrong whenever a later deploy in the
same `verify.sh` uses a mode list without it**. The resource vanishes from the
template and cdkd correctly issues a DELETE for it. A per-step conditional in a
long fixture is really a *step function over the whole run*, not a flag for your
step.

Caught during issue #1512, before the run reached it. The new
`OnDemandReplicaTable` gated its `eu-west-1` replica on `cross-region-ondemand*`
(steps 12g/h/i). The fixture then keeps deploying — `deletion-protection,
autoscaling,ttl,tags` and five more `ttl,tags,...` rounds — none of which carry
the token, so step 12f would have removed the replica **from a still-live
table**. That is exactly the operation that arms DynamoDB's 24h source-region
delete lock (a probe wedged a table in `UPDATING` for 90+ minutes that way,
#1442), and the fixture's own comments, the commit message and the issue comment
had all already claimed the design "only ever ADDs".

**Make the token MONOTONIC — carry it forward in a shell suffix.** Set a
variable once the resource exists and append it to the mode list of every later
deploy:

```bash
OD_MODE_SUFFIX=""                              # seeded with the other run vars
...
OD_MODE_SUFFIX=",cross-region-ondemand-dropped" # set right after the rounds
...
CDKD_TEST_UPDATE=ttl,tags${OD_MODE_SUFFIX} ${CLI} deploy ...
```

The suffix stays empty when the scenario is not gated on, so the default flow is
byte-for-byte unchanged; only `cdkd destroy` then removes the resource — which
for a GlobalTable deletes every replica as ONE resource and never issues a
standalone replica-delete.

**Do NOT instead key presence on a run-scoped env var**, which is the tempting
one-line fix. It stops the deletion but silently changes what the test tests:
the resource is then declared from step 1, so it is created WITH its parent and
the step you meant to exercise becomes an UPDATE. That is how the #1512 fixture
briefly stopped covering `addReplica` while its assertion still passed — the
assertion only checked the resulting value. Use the env var only for presence
that no step needs to transition.

**Before adding a mode-gated resource to a multi-step fixture:**

- Enumerate every deploy and read the mode list of each one that runs AFTER your
  steps. Any that omits your token deletes your resource there. Grep for the
  invocation, **not** for a single-line pattern: fixtures wrap long mode lists
  with a trailing `\` so the env prefix and `${CLI} deploy` sit on DIFFERENT
  lines, and a one-line `grep 'CDKD_TEST_UPDATE=.*deploy'` silently misses those.
  That is exactly how #1512 shipped a run that still performed the live
  replica-delete while reporting PASS.
- Ask what that deletion COSTS. For a plain queue, nothing. For anything whose
  removal is slow, locked, or destructive (DynamoDB replicas, RDS, stateful
  storage) it is the whole point.
- Verify by synthesizing the LATER modes, not your own: the check that catches
  this is `cdk synth` under `ttl,tags` showing the resource still intact — not
  `cdk synth` under your own mode showing it created.
- Make sure some assertion would NOTICE the drop. A post-destroy "it is gone"
  check passes vacuously when the resource was deleted mid-run, so it is not a
  guard; assert presence at the point the resource must still exist.

Mechanically enforced since issue
[#1543](https://github.com/go-to-k/cdkd/issues/1543): both halves are statically
extractable, so unlike the order-insensitivity rule above this one is a checker
rather than a judgment call. `scripts/check-integ-mode-gated-resources.ts`
reads the ORDERED per-deploy mode lists out of `verify.sh` (including the
monotonic-suffix `${VAR}` idiom prescribed above, which it resolves in source
order) and the CONDITION behind each gated declaration in the fixture stack,
then reports a declaration that is present at one step and absent at a later
one. Enforced by `tests/unit/scripts/integ-mode-gated-resources.test.ts`.

Two things about its verdicts are worth knowing before you hit one:

- Only CREATE-shaped gates BLOCK — a construct, or an entry in a resource list
  such as `replicas: [...]`. A scalar property gate (`deletionProtection: true`)
  is reported for visibility only, because flipping a property back off is an
  ordinary in-place update test and this fixture does exactly that at its
  structural-teardown step.
- A deliberate removal takes `// allow-mode-gated-drop: <reason>` on the
  declaration. The reason is mandatory; a bare marker is rejected. The step-12d
  replica removal here carries one.

### Fixture stateful L2s need an explicit removalPolicy (mandatory)

Stateful CDK L2 constructs (`kinesis.Stream`, `dynamodb.Table`/`TableV2`,
`s3.Bucket`, `logs.LogGroup`, `kms.Key`, `rds.DatabaseInstance`/`Cluster`,
`efs.FileSystem`, `opensearchservice.Domain`, `ecr.Repository`,
`cognito.UserPool`, `backup.BackupVault`) default to
`RemovalPolicy.RETAIN` -> `DeletionPolicy: Retain` in the template. Both
CloudFormation and cdkd honor it, so a fixture that omits the policy leaks the
resource on EVERY deploy/destroy cycle while destroy still reports success.
Originating incident (issue #1326): the `sqs-cloudwatch` fixture's Kinesis
Stream leaked 14 billed PROVISIONED streams across a month of us-west-2
benchmark runs; the lint then immediately found a second live case
(`log-pipeline`).

Every instantiation of those constructs in `tests/integration/*/{lib,bin}`
must do ONE of: pass an explicit `removalPolicy` (RETAIN included -- it has to
be a decision, not a default), call `applyRemovalPolicy(...)` on the assigned
variable/property in the same file, or carry an
`// allow-default-removal-policy: <reason>` comment (for fixtures that
intentionally exercise the default; the count is capped by the test). A props
object passed as a same-file variable is resolved; a spread does NOT count --
restate the policy visibly.

Enforced by `tests/unit/scripts/integ-fixture-removal-policy.test.ts`
(classifier: `scripts/check-fixture-removal-policy.ts`); user-facing writeup
in [docs/testing.md](../../docs/testing.md). L1 `Cfn*` constructs are out of
scope (their template default is `Delete`).

### A `PendingDeletion` KMS key is NOT an orphan

A customer-managed KMS key cannot be deleted synchronously — 7 days is the
AWS **minimum** pending window, and `RemovalPolicy.DESTROY` schedules the
deletion rather than performing it. So `PendingDeletion` is the terminal state
of a *successfully deleted* key, and a fixture that needs a CMK may simply
create one per run, set `pendingWindow: cdk.Duration.days(7)` to avoid the
30-day default, and assert `PendingDeletion` (or `GONE`, for a window that
elapsed in an earlier run) after destroy. `loggroup-kms-associate`,
`propagation-races-2` and `s3-vectors` have done exactly this since #958;
`cloudtrail-trail` and `s3-replication-and-filter` joined them in #1533 /
#1523.

This is written down because the opposite belief cost two issues. #1523 and
#1533 were BOTH filed asserting that such a key "directly conflicts with the
repo's never-end-an-integ-run-with-orphan-resources rule, which is why it was
not simply added", and both proposed sourcing a long-lived, alias-referenced
key plus an account-bootstrap story as their preferred option — infrastructure
that would make every affected fixture fail on a fresh account, to avoid a
non-problem. Neither issue's premise survived one `grep` of the fixture tree.
The measurements they were blocking on then took a single afternoon.

Two things this rule does NOT say. The `/cleanup` skill's caution still
stands for keys it did not create: only ever schedule deletion for
`KeyManager == CUSTOMER` + `KeyState == Enabled` keys with a cdkd-shaped
description, never one with live grants or aliases. And a key does keep
BILLING through its pending window — that is a cost, not an orphan, and per
`feedback_integ_is_not_a_cost` it is not a reason to skip coverage.

The generalizable half: when an issue states a BLOCKER as settled fact, grep
the tree for the blocker before building around it. An issue records what its
author believed at filing time, and a sibling fixture may already have
disproven it. See also `feedback_verify_issue_root_cause_before_building_tooling`
and `feedback_umbrella_issue_row_can_be_already_fixed`.

User-facing writeup in [docs/testing.md](../../docs/testing.md).

### A checker must prove it sees its input

When writing a lint or codegen that SCANS files (verify.sh scripts, templates,
source), "0 violations" and "parsed nothing at all" produce the identical green
result. Assert coverage explicitly: how many items were parsed, how many
distinct kinds, and **a floor per input SHAPE the parser claims to handle** —
not just a grand total.

This is not hypothetical. The #1097 CLI-flag lint shipped this defect twice
while its suite was green:

1. it ignored inline env prefixes, missing every
   `CDKD_TEST_UPDATE=true node ... deploy` invocation (46 of them — the
   UPDATE-mode deploys, i.e. the ones most worth checking);
2. it required a literal `cli.js` in the `node <script>` token, so
   `node "${LOCAL_DIST}" ...` matched nothing — **135 of 195 fixtures**
   contributed zero. Coverage was 36% of the tree.

Neither was found by reading the code or by tests passing. Both were found by
instrumenting the checker to print what it actually parsed and reconciling that
against an independently-grepped denominator. A third variant then appeared in
the fix itself: an unanchored shape regex matched invocations that did not have
the shape, so a total regression of that branch would still have cleared a
`> 0` check.

Practical rules:

- before trusting a new checker, measure — count parsed items per shape and
  explain any gap against a rough independent count;
- encode the measurement as assertions with real numeric floors, anchored so a
  near-miss cannot satisfy them;
- aggregate floors alone are insufficient: one dead shape hides under them.

See `tests/unit/scripts/integ-cli-flags.test.ts` for the shape the assertions
take.

### A checker must also prove it FAILS — against real code

Coverage floors prove the checker SEES its input. They do not prove it still
REJECTS a violation. Those are different failures, and the second one is what
makes a green CI lie.

Synthetic unit fixtures cannot close it on their own, because a fixture encodes
the author's mental model of the defect — so a checker and its tests can share
the same blind spot and agree with each other. The only thing that proves
rejection is introducing a REAL regression into the REAL tree and watching the
checker exit non-zero.

This is not hypothetical. The `update-wrap-coverage` critic (#1269) shipped its
first version with a passing suite that included a dedicated
"flags an unguarded wrap" test. The test threw the typed error LEXICALLY inside
the `try`. Real providers do not: the wrap is at the boundary and the throw
lives in the delegated `applyUpdate()`. So against real code the check silently
reported green and enforced nothing on exactly the providers it existed to
protect. It was found by deleting the pass-through from the real
`LogsLogGroupProvider` and observing `rc=0` where `rc=1` was required.

Practical rules:

- for each CI-blocking verdict the checker can emit, introduce that violation
  into REAL repo code, confirm a non-zero exit naming the right target, then
  restore. Do this before trusting the checker, and record it in the PR;
- treat a synthetic fixture that passes as necessary but never sufficient —
  when the real-code probe disagrees with it, the FIXTURE is usually wrong;
- once a real-code probe finds a miss, add the shape it exercised as a
  synthetic regression test too, so the specific gap stays closed cheaply.

## UPDATE Testing

- Environment variable `CDKD_TEST_UPDATE=true` enables UPDATE test mode
- Example: `tests/integration/basic/lib/basic-stack.ts`
- Allows testing UPDATE operations without modifying code
- JSON Patch (RFC 6902) verified working for S3, Lambda, IAM resources

## REMOVAL Testing (CDKD_TEST_REMOVAL)

- Environment variable `CDKD_TEST_REMOVAL=true` makes a fixture synthesize a
  template that genuinely LACKS a property, which is the only way to exercise
  the #1160 absent-field removal class — `CDKD_TEST_UPDATE` changes a value,
  and a changed value never takes the removal branch
- Two conventions keep the assertion from being vacuous: the BASELINE phase
  must assert the property is live before the removal phase asserts it is
  gone (otherwise "gone" also passes when it never reached AWS), and a
  sibling must be RETAINED (otherwise a reset that clears everything passes
  too)
- The retained sibling is REQUIRED for a collection-valued property (a tag
  list, an attribute map) and does not apply when the removal empties the only
  value the fixture sets — `cloudfront-function-url` is that shape and
  correctly has no sibling. `alb` WAS listed here too until issue #1609 item 1
  gave it a collection-valued removal (`LoadBalancerAttributes`), where it now
  retains `routing.http2.enabled` while dropping `idle_timeout` — the sibling
  must be a key whose templated value DIFFERS from AWS's default, or a reset
  that wiped everything reads identically and the sibling proves nothing; its
  Listener arm still empties the only value it sets, so the fixture carries
  both shapes at once
- The fixture set grows as #1160 batches ship; enumerate it with
  `grep -rl CDKD_TEST_REMOVAL tests/integration/*/lib/*.ts tests/integration/*/verify.sh`
  rather than trusting a list here. `tests/integration/route53/` is the
  reference for the collection-valued shape
- Full writeup in [docs/testing.md](../../docs/testing.md)

## Rollback Testing (failure injection)

- Environment variable `CDKD_TEST_FAIL=true` injects a deliberately-failing
  resource (an `AWS::SQS::Queue` with an out-of-range `MessageRetentionPeriod`)
  into the `basic` stack
- Verifies against real AWS that already-completed siblings get rolled back
  when one resource fails: `CDKD_TEST_FAIL=true cdkd deploy CdkdBasicExample`
- After rollback, S3 and SSM Document should both be deleted and state file
  should be empty

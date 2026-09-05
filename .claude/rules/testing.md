---
description: cdkd testing strategy (unit / integration / UPDATE / Rollback failure injection)
paths:
  - 'tests/**'
---

# Testing Strategy

## Unit Tests

- `tests/unit/**/*.test.ts`, Vitest.
- **Import test APIs from `'vite-plus/test'`, never `'vitest'`** — a bare `'vitest'`
  specifier resolves locally (pnpm hoisting) but fails CI's `vp run typecheck:test`
  with TS2307 (PR #1226). Copy the import line from a sibling test. Enforced by
  `tests/unit/scripts/test-import-convention.test.ts`.
- **A green run must print nothing.** `tests/setup.ts` buffers raw
  `process.stdout` / `process.stderr` writes made inside a test and replays them
  only when that test FAILS — see
  [.claude/rules/test-stream-fence.md](test-stream-fence.md) before adding a test
  that asserts on one, or when a run goes unexpectedly quiet.
- Mocking: mock the AWS SDK with `vi.mock()`.
- **Mocking `src/utils/aws-clients.js` does NOT isolate a provider that builds its
  OWN client** — `new Route53Client({ region })` inside a provider ignores that
  mock and transacts with the real authenticated account; a SUCCEEDING call
  creates a real, billable resource and still reports green. A network fence in
  `tests/setup.ts` refuses any outbound AWS call from a vitest run and FAILS the
  test from an `afterEach` (a bare `rejects.toThrow()` is satisfied by the
  refusal itself) — issue #2081. It is a RUNTIME control: a file that constructs
  a client and never calls it stays green.
- **When the fence fires, find the CONSTRUCTION SITE before choosing the mock —
  never an opt-out.** Client built inside the provider → mock the SDK PACKAGE
  (`vi.mock('@aws-sdk/client-<svc>', ...)`, the shape in
  `tests/unit/provisioning/route53-provider.test.ts`); reached through
  `getAwsClients()` with nothing self-constructing → mock
  `src/utils/aws-clients.js` (both answers occur in this repo; the three of
  that shape are `tests/unit/analyzer/diff-calculator.test.ts`,
  `tests/unit/deployment/deploy-engine-interrupt-cause.test.ts` and
  `tests/unit/deployment/strict-getatt-output-refusal-cause.test.ts`). Copy the package
  name out of the fence's message rather than spelling it from the host — some
  packages hyphenate where the endpoint host does not, and a mis-named
  `vi.mock` is silently INERT.

### A test that SPAWNS a subprocess must declare its own timeout

Vitest's default 5 s is an IN-PROCESS bound. A case that spawns one of this
repo's own `.ts` entry points pays Node startup plus type-stripping every time,
so it passes locally and fails on a loaded CI runner — the direction that reads
as flakiness rather than an under-declared bound (2026-09-04,
go-to-k/cdkd#2553: five spawns of `scripts/audit-stateful-candidates.ts` ran in
~2 s locally, timed out at 5000 ms in CI). Pass the bound as `it`'s third
argument (`}, 60_000);`), generously — its job is to stop a HANG, not to police
latency. One cheap spawn of an already-BUILT binary is fine under the default;
the trigger is a TS entry point, or several spawns in a case.

### A `*Once` primer must be consumed by the test that primed it (mandatory)

- `vi.clearAllMocks()` clears call RECORDS but does NOT drain the queue seeded by
  `mockResolvedValueOnce` / `mockReturnValueOnce` / `mockRejectedValueOnce` /
  `mockThrowOnce` / `mockImplementationOnce` (`mockReset` does). An over-primed
  test leaks the remainder into the NEXT test in its file, shifting every later
  call — and the shifted test still PASSES via absence assertions, which are
  satisfied both by "the guard declined" and by "the code never got there"
  (issue #1588: the only symptom was one uncalled `logger.warn`).
- Enforced at RUNTIME by `tests/once-leak-detector.ts` + the `once-leak-detect`
  CI job (`vp run test:once-leak`). All five `*Once` spellings funnel through
  `mock.mockImplementationOnce`, so one instrumented method covers them; what is
  flagged is a primed value CONSUMED BY A DIFFERENT TEST than the one that primed
  it — the defect itself.
- Three cheaper-looking proxies were tried and are wrong; do not reintroduce
  them: "queue non-empty when the test ends" (flags the `mockReset()`-in-
  `beforeEach` remediation itself — measured), `calls.length` delta accounting
  (wrong when priming and consumption interleave), and a static lint requiring
  `mockReset()` (checks a symbol, not over-priming; 182 of 265 files lack one
  while the real check implicated three, fixed by issue #1655).
- **The detector has its own canary**:
  `tests/unit/scripts/once-leak-canary.test.ts` leaks deliberately (auto
  allow-listed by the generator), and the CI step `detector canary` re-runs that
  file alone with `CDKD_ONCE_LEAK_IGNORE_ALLOWLIST=1`, requiring a failure that
  carries the detector's OWN wording (`primed by an EARLIER test`). Asserting
  only a non-zero exit is NOT equivalent (a deleted/renamed canary, a syntax
  error, and a failed install each also exit non-zero while the detector is
  dead). Do not "fix" that suite's priming either.
- **OFF unless `CDKD_ONCE_LEAK_DETECT=1`** — nothing is wrapped when off, so the
  default run is byte-for-byte unchanged (what let it land mid-flight).
- **The allow-list grandfathers whole FILES** (per-test entries go stale on any
  rewording). Ratchet direction: fix a file and DROP its entry
  (`vp run gen:once-leak-allowlist`).
  `tests/unit/scripts/once-leak-allowlist.test.ts` fails stale entries and caps
  the list; issue #1655 walked the ratchet to its end — only the canary remains.
- The over-priming is usually a call the path never makes, and the priming's own
  comment is not evidence (issue #1655: all three annotated call sequences were
  wrong). MEASURE consumption first — drain with `mockReset()` in `beforeEach`,
  log `mockSend.mock.calls.length` per test (measuring while the queue still
  leaks is circular) — then pin with `expect(mockSend).toHaveBeenCalledTimes(N)`.
  The pin and the detector cover DIFFERENT regressions: the pin catches a
  call-COUNT change; a SURPLUS primer leaves the count unchanged and is caught
  only by the detector. Fixing the priming is strictly better than draining: a
  drained suite can never be flagged again, re-creating the grandfathering.

## Mutation probes: mutate every site the value reaches, not the first one

- A probe that flips one use of a value proves that ONE use is pinned. PR #2010:
  a banner read `stackUnaddressed` in a guard AND in the interpolated message;
  the guard-flip probe failed the test, swapping the INTERPOLATION did not —
  and the fixture's clean stack never entered the warn arm, so its
  `not.toContain(...)` assertion was unfalsifiable by construction.
- **Enumerate the value's uses before probing** (`grep` the identifier in the
  changed hunk). One probe per use — for a GUARD the uses are its CALL SITES
  and both directions of its message, each needing its OWN negative:
  go-to-k/cdkd#2674 fenced a damage sentence in the out-of direction only, so
  a change confined to the into text went unwatched (2026-09-05).
- **A negative assertion needs a case where the wrong value would actually be
  EMITTED** — e.g. two DIRTY stacks with different counts (1 and 2), asserting
  the total 3 appears in neither banner.
- The same shape hides behind mocks: a `vi.mock`ed module pins what the caller
  PASSES, never what the far side WRITES (hard-coding `'SUCCEEDED'`
  inside `recordRunOutcome` passed all 2261 unit tests). When a value crosses a
  module boundary, one case must exercise the far side unmocked.
- **Do not report a mutation result you did not run — and a probe that changed
  TWO things at once is one you did not run.** A false mutation-table entry
  surfaces only when a reviewer re-executes every claim; nothing else looks.
  PR #2612 is the harder half, where the probe WAS run: a "reds four cases"
  claim rested on a probe that had also edited the rendered line's TEXT, and
  re-measuring one mutation at a time inverted it (each alone green, BOTH reds
  one case — the two mechanisms are mutually redundant). One mutation per
  probe, tree restored byte-exact between them.
- **Give a probe result written into a SOURCE COMMENT the same disposition as a
  count in published prose** — delete it, fence it, or attribute it as a dated
  measurement (`.claude/skills/work-issues/references/verify.md` §8-g). Nothing
  downstream re-checks such a line: PR #2612's wrong claim sat on a branch
  comment beside a destructive confirm prompt, invisible to every test, and
  only review stopped it becoming a fence a later editor would trust. State
  instead the invariant the two mechanisms jointly enforce, which is
  re-derivable and cannot go stale.

## Integration Tests

- `tests/integration/**`, real AWS account.
- Environment variables: `STATE_BUCKET`, `AWS_REGION`.

### `verify.sh` signal traps (mandatory)

A fixture that provisions real AWS resources must arm its `cleanup` trap on the
signal paths too, in the **exiting** form:

```bash
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM
```

`trap cleanup EXIT INT TERM` is NOT equivalent and must never be used: a bash
signal handler returns to the interrupted point, so the script can resume and
`exit 0` — reporting PASS while `cleanup` raced a still-live deploy. Omitting
`INT` / `TERM` leaks the stack on Ctrl-C or a harness timeout. Disarm with
`trap - EXIT INT TERM`.

The `(exit N)` seed is load-bearing: many `cleanup`s open with `rc=$?` and gate
teardown on it, and inside a handler `$?` is the **interrupted command's**
status, so without the seed an interrupted run can see rc=0 and skip teardown
entirely. `(exit N)` sets `$?` to the signal's code, so `rc=$?` and `${1:-$?}`
cleanups both tear down correctly.

Enforced by `tests/unit/scripts/integ-verify-signal-traps.test.ts` (issue
#1097); user-facing writeup in [docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### `verify.sh` gone-probes (mandatory)

A destroy/leak assertion must never be a silenced blind probe:
`if aws <read-probe> ... >/dev/null 2>&1; then FAIL` (and the inverse
`if ! aws ...; then <conclude gone>`) read ANY failure (throttle, auth, network)
as "gone" (issue #1097 pattern 2). Route probes through the canonical helper
block every affected fixture carries verbatim (source of truth:
`scripts/check-integ-probe-not-found.ts`):

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
fallbacks** (`N=$(aws <read-verb> ... 2>/dev/null || echo 0)` / `|| true` — a
throttle reads as "0 remaining"; use a plain strict capture, or branch on
`gone_probe` when not-found is legitimate) and **silenced function wrappers**
(an exit-status wrapper `fn() { aws ... >/dev/null 2>&1; }` or a value wrapper
with a swallow tail). Tail-less silenced captures/wrappers stay legal (`set -e`
fails them loudly; for wrappers ONLY when the probe is the LAST command of the
body), as does the strict stderr-capture idiom
(`$(cmd 2>&1 >/dev/null || true)`).

**Intermediate captures inside a value wrapper need `|| return 1`**: errexit is
CLEARED inside `$( )`, so in a multi-statement wrapper called as `V="$(fn)"` an
intermediate `out="$(aws ...)"` failure does not abort the body and the function
exits 0 via its formatting tail (`local V=$(...)` masks the status entirely —
split declaration from assignment). A `gone_probe`-then-requery site must guard
the requery against the TOCTOU race: canonical not-found on the requery is still
"gone", anything else hard-fails. Best-effort cleanup is exempt via `set +e[u]`
spans (bounded by the enclosing function); mark cleanup helpers with `set +eu` in a SUBSHELL body
(`fn() { ( set +eu; ... ) }`) so calling them from a `set +eu` cleanup trap
never re-arms strict mode mid-sweep. Enforced by
`tests/unit/scripts/integ-verify-probe-not-found.test.ts`; user-facing writeup
in [docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### `verify.sh` CLI flags (mandatory)

Every flag a fixture passes must be declared on the **subcommand it targets**,
not merely somewhere in `src/cli/options.ts` (issue #1097: `cdkd import
--region` died with `unknown option`, so that fixture's import round-trip had
never run once — ~10 sibling commands accept it, so the flag looked right by
analogy). Two hand-audit traps: `--help` omits hidden options, and `--region`
is NOT a no-op on commands that DO accept it (highest-precedence region source
per [cli-internals.md](cli-internals.md)) — do not "clean up" deprecated
`--region` flags.

Enforced by `tests/unit/scripts/integ-cli-flags.test.ts`, which walks the real
Commander tree via `buildProgram()` (`src/cli/program.ts`); a flag counts when
the target command OR any ancestor declares it, matching Commander's lookup. The
check carries coverage floors (totals plus one per supported call shape) so a
parser regression fails loudly instead of passing vacuously — two iterations of
this lint were green while skipping most of the tree. The
`state-destroy-force-gate.sh` hook remains the commit-time guard for the
specific `state destroy --force` case.

### `verify.sh` version literals (mandatory)

Never hardcode a Lambda published-version literal: version counters are
monotonic per function/layer NAME and never reset, so a `"${FN}:1"` probe
passes only on the very first run in the account, and a
`[ "${V}" != "2" ]` assert is the same defect in the classifier's separate
`literal-compare` verdict (issue #1324; third recurrence). Read version N from the live alias
(`--query 'FunctionVersion'`), guard it numeric with a `case` pattern, and
assert rotation as `EXPECTED=$((N + 1))` — see
`codedeploy-lambda-deployment-group/verify.sh` for the reference shape. Alias
qualifiers (`:live`, `:$LATEST`), variable qualifiers, relative compares, and
`length(...)` count queries stay legal; genuinely fixed versions (public
cross-account layer ARNs) take `# allow-version-literal: <reason>`. Enforced by
`tests/unit/scripts/integ-verify-version-literals.test.ts` (classifier:
`scripts/check-integ-version-literals.ts`); user-facing writeup in
[docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### `verify.sh` must not call an `aws` verb the CLI does not have (mandatory)

The AWS CLI **removes** a set of operations from its command table
(`awscli/customizations/removals.py`) that still exist in the API, so the SDKs
and the API reference all offer a verb the CLI rejects. Originating case:
`aws emr list-instance-groups` — its symptom was a misleading `[Errno 22]` /
hang, which is what `cli_auto_prompt` does to ANY invalid-choice error on a
non-terminal stdin; `AWS_CLI_AUTO_PROMPT=off` makes it fail fast and legibly.
The unit of the defect is the (service, verb) pair — the neighbouring verbs are
usually fine, so neither "the family is suspect" nor "any `aws emr` verb is
suspect" is the right generalization.

Enforced by `tests/unit/scripts/integ-aws-commands.test.ts` (classifier:
`scripts/check-integ-aws-commands.ts`) against the captured table
`tests/fixtures/aws-cli-removed-commands.json` (refresh:
`vp run gen:aws-cli-removals`) — a checked-in capture, so the check is offline
and deterministic (a checker that skips when its oracle is missing is a vacuous
pass). Escape hatch: `# allow-unavailable-aws-command: <reason>` on the
invocation's line or the line above.

**Probe before you rely on an unfamiliar verb**:
`AWS_CLI_AUTO_PROMPT=off aws <service> <verb> --help` settles existence in
under a second; running it against a bogus id settles behavior.

**When the verb is unavailable, call the SDK directly** rather than a different
CLI verb that returns less. The repo root already depends on every
`@aws-sdk/client-*` cdkd uses, so a `node --input-type=module -e` one-liner
from `REPO_ROOT` needs no extra install (response keys are the SDK's PascalCase
shape):

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

Two things in that shape are load-bearing: the `|| return 1` propagates a
node/SDK failure to the caller's `set -e` (without it an empty result silently
satisfies a `// empty`-defaulted `jq` assertion — the gone-probe failure mode
one layer up), and the `Marker` loop matches the provider's pagination (a
partial first page is a silent false pass). References:
`tests/integration/emr-cluster/verify.sh` and
`tests/integration/emr-instance-configs/verify.sh`.

A pager invoked non-interactively is a SEPARATE route to a hang, so
`export AWS_PAGER=""` near the top of a fixture is cheap insurance — for NEW
and affected fixtures, not a tree-wide invariant. Enforced since issue #1402;
writeup in
[docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### `verify.sh` upstream-cdk callers must pin AND resolve a fixture-local CLI (mandatory)

A fixture whose `verify.sh` invokes the upstream `cdk` CLI (bare `cdk deploy`,
`npx` / `pnpm exec` / `yarn cdk ...`, or a `CDK_BIN`-style variable) must:

1. pin `aws-cdk` at a real version range — `*` / `latest` re-admit the skew;
2. install the FIXTURE's own deps (the `(cd "${REPO_ROOT}" && pnpm install)`
   most fixtures carry installs the CLI's deps, not the fixture's);
3. if that install is conditional, guard it on the cdk BIN, not on the
   directory — a pre-pin `node_modules` exists but has no `cdk` in it; an
   unconditional install needs no guard; and
4. make every invocation resolve the fixture-local CLI. Canonical shape:

```bash
[ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || (cd "${TEST_DIR}" && npm install)
export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"
```

(an explicit `CDK_BIN="${TEST_DIR}/node_modules/.bin/cdk"` used for every
invocation is equally hermetic and needs no PATH prepend — but an absolute-path
`CDK_BIN` is resolved directly, so a prepended PATH never redeems one pointing
outside the fixture.)

A pin without resolution is dead weight: the run silently takes the global
`cdk`, and when that lags the fixture's `aws-cdk-lib` the synth dies with a
cloud-assembly schema-version mismatch (`import-nested-stack`; issue #1485
closed the class PR #1253 had fixed per-fixture). Enforced by
`tests/unit/scripts/integ-cdk-cli-pins.test.ts` (classifier:
`scripts/check-integ-cdk-cli-pins.ts` — strips heredocs and comments, walks
quote-aware, so no signal is read out of an `echo` argument or `grep` pattern).
User-facing writeup in [docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### `verify.sh` `state destroy` must pass `--state-bucket` (mandatory)

The harness exports `STATE_BUCKET`; the CLI's env fallback is
`CDKD_STATE_BUCKET` — a DIFFERENT name. A cleanup sweep that omits
`--state-bucket` never reads the harness bucket: resolution is CLI flag >
`CDKD_STATE_BUCKET` > `cdk.json` `context.cdkd.stateBucket` > STS default
`cdkd-state-{accountId}` (`resolveStateBucketWithSource`), so
the omission either resolves a fixture `cdk.json`'s placeholder bucket (dies,
swallowed by the call's own `>/dev/null 2>&1` — those cleanups had failed on
EVERY run, invisibly) or falls through to the STS default (working by
coincidence, no-opping the moment `STATE_BUCKET` points elsewhere). Either way
the state record survives and wedges the fixture's next run.

```bash
node "${LOCAL_DIST}" state destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
```

`"${STATE_BUCKET:-}"` not `"${STATE_BUCKET}"`: `cleanup` is trap-installed and
can run BEFORE the script's own unset-variable guard, and a cleanup that only
does `set +e` (not `set +eu`) aborts teardown mid-sweep on the unguarded form.
Empty is safe — `resolveStateBucket()` treats `''` as not-supplied.

**`deploy` / `destroy` deliberately keep the strict `"${STATE_BUCKET}"` form**:
on a deploy an unset bucket is a harness misconfiguration that must fail loudly
rather than silently target the default bucket. Do not "normalize" the deploy
sites to `:-`.

Made a lint by the measured asymmetry (issue #1567: `deploy` passed the flag at
all 335 sites, `destroy` at all 228, `state destroy` at only 96 of 171 —
because nothing enforced it). Enforced by
`tests/unit/scripts/integ-state-bucket.test.ts` (classifier:
`scripts/check-integ-state-bucket.ts`, which strips heredocs, comments and
`echo` arguments). User-facing writeup in
[docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### `verify.sh` list readbacks must be order-insensitive (mandatory)

AWS does not preserve the submitted order of list-valued members on readback.
An assertion that string-compares a joined list against the submitted order is
flaky, and its failure message ACCUSES THE FIX (verified 2026-08-09 on
`lambda-esm-self-managed-kafka`: the readback returned the brokers reordered and
the assertion reported "issue #1384 NOT closed" while the fix worked).

Sort BOTH sides unless the list is genuinely order-significant:

```bash
--query "join(' ', sort(Path.To.List || \`[]\`))"
```

(The `|| \`[]\`` coalesce is the separate null-list guard the gone-probe rule
covers — keep both.) This is the integ-side twin of
`src/analyzer/drift-normalize.ts`; the same judgment call applies — a list that
IS order-significant (DNS resolver lists, preference orders — see
`getDriftUnorderedPaths`) must stay unsorted, because sorting would HIDE a real
regression. NOT mechanically enforced by design: whether a list is
order-significant is a judgment a lint cannot make. User-facing writeup in
[docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### A mode-gated fixture resource DISAPPEARS in every later step that omits the token (mandatory)

Multi-step fixtures drive phases with `CDKD_TEST_UPDATE=<comma,separated,modes>`
and the stack reads `updateMode.includes('x')`. Gating a new resource on a new
token is **wrong whenever a later deploy in the same `verify.sh` uses a mode
list without it** — the resource vanishes from the template and cdkd correctly
issues a DELETE. A per-step conditional in a long fixture is a *step function
over the whole run*, not a flag for your step. (Issue #1512: the later
`ttl,tags` deploys would have removed a live DynamoDB replica — the operation
that arms DynamoDB's 24h source-region delete lock, #1442.)

**Make the token MONOTONIC — carry it forward in a shell suffix**:

```bash
OD_MODE_SUFFIX=""                              # seeded with the other run vars
...
OD_MODE_SUFFIX=",cross-region-ondemand-dropped" # set right after the rounds
...
CDKD_TEST_UPDATE=ttl,tags${OD_MODE_SUFFIX} ${CLI} deploy ...
```

The suffix stays empty when the scenario is not gated on, so the default flow is
byte-for-byte unchanged; only `cdkd destroy` then removes the resource.

**Do NOT instead key presence on a run-scoped env var** — it stops the deletion
but silently changes what the test tests: the resource is declared from step 1,
so it is created WITH its parent and the step you meant to exercise becomes an
UPDATE (how the #1512 fixture briefly stopped covering `addReplica` while its
assertion still passed). Use the env var only for presence no step transitions.

**Before adding a mode-gated resource to a multi-step fixture**: enumerate every
LATER deploy's mode list (grep for the invocation, not a single-line pattern —
wrapped mode lists put the env prefix and `${CLI} deploy` on different lines);
ask what the deletion COSTS (nothing for a queue; the whole point for slow,
locked, or destructive removals); verify by synthesizing the LATER modes
(`cdk synth` under `ttl,tags` showing the resource intact — not your own mode
showing it created); and make sure some assertion would NOTICE the drop
(a post-destroy "gone" check passes vacuously — assert presence at the point
the resource must still exist).

Mechanically enforced since issue #1543:
`scripts/check-integ-mode-gated-resources.ts` reads the ORDERED per-deploy mode
lists (resolving the monotonic-suffix `${VAR}` idiom in source order) and the
condition behind each gated declaration, reporting a declaration present at one
step and absent at a later one. Enforced by
`tests/unit/scripts/integ-mode-gated-resources.test.ts`. Only CREATE-shaped
gates BLOCK (a construct, or an entry in a resource list); a scalar property
gate is reported for visibility only (flipping a property off is an ordinary
in-place update test). A deliberate removal takes
`// allow-mode-gated-drop: <reason>` on the declaration — the reason is
mandatory.

### Fixture stateful L2s need an explicit removalPolicy (mandatory)

Stateful CDK L2 constructs (`kinesis.Stream`, `dynamodb.Table`/`TableV2`,
`s3.Bucket`, `logs.LogGroup`, `kms.Key`, `rds.DatabaseInstance`/`Cluster`,
`efs.FileSystem`, `opensearchservice.Domain`, `ecr.Repository`,
`cognito.UserPool`, `backup.BackupVault`) default to `RemovalPolicy.RETAIN` →
`DeletionPolicy: Retain`, which both CloudFormation and cdkd honor — so a
fixture that omits the policy leaks the resource on EVERY deploy/destroy cycle
while destroy still reports success (issue #1326: a Kinesis Stream leaked 14
billed PROVISIONED streams across a month of benchmark runs).

Every instantiation of those constructs in `tests/integration/*/{lib,bin}` must
do ONE of: pass an explicit `removalPolicy` (RETAIN included — a decision, not
a default), call `applyRemovalPolicy(...)` on the assigned variable/property in
the same file, or carry `// allow-default-removal-policy: <reason>` (count
capped by the test). A props object passed as a same-file variable is resolved;
a spread does NOT count — restate the policy visibly. L1 `Cfn*` constructs are
out of scope (their template default is `Delete`).

Enforced by `tests/unit/scripts/integ-fixture-removal-policy.test.ts`
(classifier: `scripts/check-fixture-removal-policy.ts`); user-facing writeup in
[docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### A `local-*` fixture's Lambdas must declare the HOST architecture (mandatory)

cdk-local pins `docker --platform` to each Lambda's declared `Architectures` —
correct — but a CDK `lambda.Function` with no `architecture` defaults to
`X86_64`, so on an **arm64 host** its container runs `linux/amd64` under CPU
emulation and the Go RIE inside `public.ecr.aws/lambda/*` faults (measured:
qemu segfaults then RIE timeouts; root cause and fix pattern
go-to-k/cdk-local#560 / #567). So a fixture under
`tests/integration/local-*/` declares:

```ts
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;
```

and passes `architecture: HOST_ARCHITECTURE` to every `lambda.Function`.

**Hardcoding either value is wrong in the same way** — the fence pins the
DERIVATION, not the outcome: `ARM_64` moves the emulation onto an amd64 CI
runner, `X86_64` is the default that caused the fault. The base image is
multi-arch, so the host-derived form is native on both; nothing in any
`verify.sh` asserts the architecture, so this costs no coverage.

The regression is silent in exactly the direction that hides it (passes on
amd64 CI, fails only on arm64 dev machines), so CI can never catch it by
running the fixture — the fence is a source-shape test:
`tests/unit/scripts/integ-fixture-host-architecture.test.ts`. Its
`FIXTURE_STACKS` list is literals on purpose (cannot silently widen to fixtures
nobody has run on arm64), and it REFUSES any Lambda constructor spelling other
than `new lambda.Function(` rather than skipping it. Two fixtures are covered
today; the remaining 16 are #2287 — they join one at a time, each after a green
arm64 run (`provided.*` fixtures pin the arch to a prebuilt BINARY and
`DockerImageFunction` takes it from the built image, so neither is mechanical).

### A `PendingDeletion` KMS key is NOT an orphan

A customer-managed KMS key cannot be deleted synchronously — 7 days is the AWS
**minimum** pending window, and `RemovalPolicy.DESTROY` schedules the deletion.
`PendingDeletion` is the terminal state of a *successfully deleted* key: a
fixture needing a CMK may create one per run, set
`pendingWindow: cdk.Duration.days(7)`, and assert `PendingDeletion` (or `GONE`)
after destroy — the shape of `loggroup-kms-associate` and siblings since #958.
(Issues #1523 / #1533 were both filed asserting the opposite as a settled
blocker and proposed account-bootstrap infrastructure to avoid a non-problem —
neither premise survived one `grep` of the fixture tree.)

Two things this rule does NOT say: `/cleanup`'s caution stands for keys it did
not create (schedule deletion only for `KeyManager == CUSTOMER` +
`KeyState == Enabled` keys with a cdkd-shaped description, never one with live
grants or aliases), and a key keeps BILLING through its window — a cost, not an
orphan, and not a reason to skip coverage.

The generalizable half: when an issue states a BLOCKER as settled fact, grep
the tree before building around it — a sibling fixture may already have
disproven it. User-facing writeup in
[docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### `verify.sh` must sweep S3 OBJECT VERSIONS and assert zero (mandatory for secret-seeding fixtures)

`cdkd bootstrap` enables VERSIONING on the state bucket, so `aws s3 rm` writes a
DELETE MARKER and removes nothing — the near-universal
`assert_gone ... s3api head-object` ending asserts only that the CURRENT object
is gone, while every prior version stays readable via `s3:GetObjectVersion`.
For a fixture that puts a KNOWN SECRET PLAINTEXT into state (an
`unsafePlainText` secret, a literal `masterUserPassword`, an IAM
`SecretAccessKey` cached in `attributes`, a seeded pre-GHSA record) that is a
disclosure that outlives the run (issue #2096: measured immediately after GREEN
runs, hundreds of surviving versions carrying live passwords).

**Sweep the PREFIX, never a key list.** `state.json` is not the only thing
under it: `rollback-journal.json` stores
`failedOperations[].attemptedProperties` verbatim (measured carrying a literal
`"MasterUserPassword"`); `lock.json` leaves a CURRENT delete marker per stack
(since issue #2346 site 5 cdkd purges the lock key's noncurrent versions on
release; what survives is that marker plus whatever a crashed run left);
`deployments/**` is not delete-markered by `cdkd destroy` at all.
`s3_stack_prefix` + `s3_purge_prefix_versions` covers all four. Blind spot: a
nested-stack child at `cdkd/<Parent>~<Child>/<region>/` is a SIBLING prefix,
not a descendant — `nested-stack-secret` derives a SECOND prefix from
`"${STACK}~Child"` and sweeps + asserts both; copy that. The shared exports
index `cdkd/_index/<region>/exports.json` is a sibling prefix too and holds
RESOLVED Output values; sweep it KEY-scoped and `noncurrent` only, never `all`
(other stacks share it) — issue #2107.

Use the shared helpers in `tests/integration/s3-versions.sh`; do not open-code
a sweep. Source after the `cd`, purge NONCURRENT from `cleanup` (which also
runs pre-run and from the failure traps, where a live state.json may be the
only record of standing resources), and do the FULL sweep plus the assertion on
the SUCCESS path:

```bash
cd "$(dirname "$0")"
. ../s3-versions.sh
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
...
  s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true   # in cleanup
...
cleanup                                                                               # success path
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "<fixture> state teardown"
```

Three traps make a sweep silently PARTIAL while the run still exits 0 — all
observed live, none visible from reading the script, only from COUNTING what S3
holds afterwards:

1. **Trap-only sweep.** `trap - EXIT INT TERM` on the success path means a
   sweep living only in `cleanup` never runs on the normal path.
2. **`printf '%s' | tr | while read`.** `out=$(aws ...)` strips the trailing
   newline, so `read` returns non-zero on the LAST field and the body skips it
   (verified: 0 of 1, and 346 of 347). Use `printf '%s\n'` AND
   `|| [ -n "${key}" ]`.
3. **`length(...)` under `--output text`.** `--query` is applied PER PAGE, so a
   >1000-entry listing prints one number per page (measured `1000\n189`).
   Count ROWS of a projection. Applies to ANY filtered count, not just a
   version sweep (go-to-k/cdkd#2553 shipped six such captures in a fixture).

Two shapes are decisions, not style: the parentheses in
`([Versions, DeleteMarkers][])[...]` are load-bearing (unparenthesised returns
empty; measured 0 vs 347), and the teardown sweep must NOT be noncurrent-only —
after `aws s3 rm` the DELETE MARKER is the `IsLatest == true` entry, so one
marker per key would survive forever.

EVERY entry point — purge, count AND assertion — refuses a prefix that is not
`cdkd/<stack>/<region>/` with both segments non-empty. On the purge side that
stops an unset `STACK` (`cleanup` runs under `set +eu`) from widening the
prefix and deleting another stack's LIVE state. On the READ side: `cdkd///`
lists nothing, so the count is a truthful `0` about the WRONG key space, and
since a refusing purge cannot abort its caller (wrapped in `|| true` or running
under `set +e`), a mis-derived prefix once printed a refusal to stderr while
the fixture still exited 0 with the plaintext intact — the vacuous pass this
convention exists to remove, reintroduced inside its own assertion. Pinned by
`tests/unit/scripts/integ-s3-versions-helper.test.ts`, which runs the guard
under bash against a fake `aws` that records its own invocation — asserting not
just a non-zero exit but that no AWS call was attempted at all.

Deletes go through `DeleteObjects` in batches of 1000 (the API maximum); a key
carrying a quote or backslash falls back to single-object `delete-object`, its
payload built without `jq` (sourcing the helper must not add that dependency).
Under `Quiet: true` a success returns `{}`, so an `Errors` key is a per-object
failure reported as overall success (confirmed: rc=0 with `Errors` present); it
warns, and the retry loop plus the zero-assertion are the backstop. **Both AWS calls pin `--output`** — `json` on
the delete, `text` on the listing — because the CLI's format is AMBIENT
(`AWS_DEFAULT_OUTPUT`, or `output =` in the profile): un-pinned, the delete's
per-object failure arrives in a shape the `"Errors"` check never matches and
the WARN is swallowed — from `cleanup` that is a silent under-sweep (measured:
un-pinned fires under `json` only, pinned under all three formats). The
listing keeps stderr OUT of the row stream — `2>&1` there makes a benign CLI
warning a phantom surviving version and feeds that text to
`delete-object --key`.

Also scanned by `tests/unit/scripts/integ-verify-bash-compat.test.ts` and by
`scripts/check-integ-aws-commands.ts`, both with per-shape floors so a total
swamped by 247 verify.sh cannot hide the helper going unread. Four other integ
scanners cannot see it; the per-scanner verdict lives in issue #2110 rather
than a blanket extension (at least one — `integ-verify-signal-traps` — would
fail on correct code: a sourced helper installs no traps by design).

It is a FLAT file rather than `lib/s3-versions.sh` on purpose: three
coverage-matrix generators treat every DIRECTORY under `tests/integration/` as
a fixture, so a `lib/` directory would silently become a row in all three
committed matrices (issue #2105).

The convention IS enforced, by
`tests/unit/scripts/integ-secret-fixture-sweep.test.ts`: a fixture whose
`bin/**` / `lib/**` TypeScript declares secret material — `unsafePlainText`, a
hand-supplied `secretStringValue` / `secretObjectValue` / `secretStringBeta1`,
a templated `master(User)?Password`, `generateSecret: true`, an
`iam.AccessKey`, an `appsync.CfnApiKey` or an `addApiKey` — must source the
helper AND call `s3_assert_versions_swept`. Per-pattern FLOORS mean a regex
that silently stopped matching cannot hide behind the others; two
forward-looking patterns (`SecretValue.plainText`, ElastiCache `AuthToken`)
carry a floor of 0, so every pattern also carries a mandatory `sample` it must
match — a control derived from the list, which is what keeps a zero-floor
pattern honest. The seeding set is pinned by NAME (the failure this closes was
a hand audit producing the wrong SET, not the wrong count). Both predicates
read comment-stripped CODE — the first cut matched the explanatory comment
above the `source` line, so its own break-test stayed GREEN.

It exists because the written rule was violated the moment it was written: the
#2096 audit read all 282 `verify.sh` files and still missed FIVE fixtures —
three structural twins of ones it found (the secret is declared in `lib/*.ts`
while the audit read `verify.sh`), and two probed and wrongly CLEARED from a
newest-N sample. **A newest-N sample is the wrong shape for this question**:
the newest versions come from the most recent run, the one most likely to be
already-fixed or to have failed early. Sample across the range, or grep the
whole key. Nor is grepping `src/provisioning/providers/**` a substitute for
measuring: `AWS::ApiGateway::ApiKey` is registered to no provider, so it takes
the generic Cloud Control readback, whose resource model includes `Value` —
the live key, in `attributes`, with no provider code naming it.

**When auditing by hand, read the stack name from `verify.sh`'s `STACK=` line —
never infer it from the directory name** (`cognito-resource-server`'s stack is
`CognitoResourceServerStack`, and probing the convention-derived name returns a
clean-looking `0` for a key that does not exist).

Three blind spots are named in the lint's own header: raw CloudFormation
fixtures (template in a checked-in `.json` / `.yaml`, not scanned); secrets
seeded by the SCRIPT rather than the app (`dynamic-ref-cross-region` writes a
plaintext state record with `aws s3 cp`); and service-generated credentials
with no source marker (Cognito's `ClientSecret`, found by grepping the BUCKET).
The per-fixture zero-assertion plus periodic bucket inspection stay the
backstop. User-facing writeup in [docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### A fixture that greps cdkd's OWN output must fail loudly when the format drifts

A `verify.sh` that measures by grepping the deploy log is a CONSUMER of a
string the same PR may be CHANGING — when the producer's wording moves, a zero
match is indistinguishable from "the condition did not occur" (issue #2018: a
review relabel made the fixture's three greps silently 0, printing a confident,
wrong CAUSE over a broken parse while the run still exited 0). Sibling of "A
checker must prove it sees its input", one layer out. Two rules:

- **Carry a sentinel that distinguishes "absent" from "unparsed".** Pick a
  second, independent marker in the same line, stable across the wording you
  are likely to change, and hard-fail when it is present while the parsed
  marker is not (the #2018 fixture greps `attempt [0-9]*/26` and exits 1 naming
  the drift). A sentinel keyed on the SAME substring you parse is worthless.
- **Re-run the fixture after ANY edit to a string it greps**, including one
  arriving from code review late in the PR — a `verify.sh` edit is in no integ
  gate's digest scope, so the assertions can go blind while the marker is still
  fresh (fixture-facing half of `feedback_integ_after_final_rebase` /
  `feedback_review_fixes_stale_integ_marker`).
- **A reword that makes a string LESS SPECIFIC blunts sentinels in fixtures
  your diff never opens, and re-running finds none of them** — the grep still
  MATCHES, it has just stopped discriminating, so every phase stays green
  (`loggroup-never-expire-guard` grepped `not provably empty` until #2615
  hedged the S3 reason the same way; review caught it, no fence did). Fence
  it: `stateful-guard-message-sync.test.ts` derives the word-grams two
  rendered strings SHARE and refuses a PINNED fixture carrying one outside a
  full sentence. Read its scope note first — a population derived by scanning
  every fixture looked general and was fail-OPEN (go-to-k/cdkd#2643).

### A checker must prove it sees its input

When writing a lint or codegen that SCANS files, "0 violations" and "parsed
nothing at all" produce the identical green result. Assert coverage explicitly:
items parsed, distinct kinds, and **a floor per input SHAPE the parser claims
to handle** — not just a grand total. (The #1097 CLI-flag lint shipped this
twice while green — 36% real coverage; a third variant appeared in the fix
itself, an unanchored shape regex whose total regression would still have
cleared `> 0`.) Practical rules:

- before trusting a new checker, measure — count parsed items per shape and
  explain any gap against a rough independent count;
- encode it as assertions with real numeric floors, anchored so a near-miss
  cannot satisfy them; aggregate floors alone hide one dead shape.

See `tests/unit/scripts/integ-cli-flags.test.ts` for the shape the assertions
take.

### A checker must also prove it FAILS — against real code

Coverage floors prove the checker SEES its input; they do not prove it still
REJECTS a violation. Synthetic unit fixtures cannot close that on their own — a
fixture encodes the author's mental model, so a checker and its tests can share
a blind spot (the `update-wrap-coverage` critic, #1269, shipped with a passing
"flags an unguarded wrap" test that threw LEXICALLY inside the `try`; real
providers throw in the delegated `applyUpdate()`, so the check enforced nothing
on exactly the providers it existed to protect — found by deleting the
pass-through from the real `LogsLogGroupProvider` and observing rc=0).
Practical rules:

- for each CI-blocking verdict, introduce that violation into REAL repo code,
  confirm a non-zero exit naming the right target, then restore — before
  trusting the checker, and record it in the PR;
- a synthetic fixture that passes is necessary but never sufficient — when the
  real-code probe disagrees with it, the FIXTURE is usually wrong;
- once a real-code probe finds a miss, add the shape it exercised as a
  synthetic regression test too, so the specific gap stays closed cheaply.

## UPDATE Testing

- Environment variable `CDKD_TEST_UPDATE=true` enables UPDATE test mode
- Example: `tests/integration/basic/lib/basic-stack.ts`
- Allows testing UPDATE operations without modifying code
- JSON Patch (RFC 6902) verified working for S3, Lambda, IAM resources

## REMOVAL Testing (CDKD_TEST_REMOVAL)

- `CDKD_TEST_REMOVAL=true` makes a fixture synthesize a template that genuinely
  LACKS a property — the only way to exercise the #1160 absent-field removal
  class (`CDKD_TEST_UPDATE` changes a value, and a changed value never takes
  the removal branch)
- Two conventions keep the assertion from being vacuous: the BASELINE phase
  must assert the property is live before the removal phase asserts it is gone
  (otherwise "gone" also passes when it never reached AWS), and a sibling must
  be RETAINED (otherwise a reset that clears everything passes too)
- The retained sibling is REQUIRED for a collection-valued property (a tag
  list, an attribute map) and does not apply when the removal empties the only
  value the fixture sets — `cloudfront-function-url` is that shape. `alb`
  carries both shapes since issue #1609 item 1: its `LoadBalancerAttributes`
  removal retains `routing.http2.enabled` while dropping `idle_timeout` — the
  sibling must be a key whose templated value DIFFERS from AWS's default, or a
  wholesale reset reads identically and the sibling proves nothing — while its
  Listener arm still empties the only value it sets
- The toggle ALSO serves the inverse assertion, where RETENTION is correct —
  `nlb-source-nat` (issue #1619) drops two NLB flags riding on `SetSubnets` /
  `SetSecurityGroups` and asserts AWS kept the live value (the SERVICE's
  omission semantics are under test, not cdkd's reset). Same baseline-live rule
  (and the templated value must be AWS's NON-default), no retained sibling (the
  flags are scalar), plus one more: assert the Set* call actually FIRED by
  changing a companion property in the same deploy — otherwise "the value is
  unchanged" passes when no call was issued at all
- Enumerate the fixture set with
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

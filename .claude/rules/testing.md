---
description: cdkd testing strategy (unit / integration / UPDATE / REMOVAL / rollback injection)
paths:
  - 'tests/**'
---

# Testing Strategy

## Unit tests

- `tests/unit/**/*.test.ts`, Vitest. Mock the AWS SDK with `vi.mock()`.
- **Import test APIs from `'vite-plus/test'`, never `'vitest'`** — a bare
  `'vitest'` resolves locally but fails `vp run typecheck:test` with TS2307.
- **A green run must print nothing**: `tests/setup.ts` buffers raw stdout/stderr
  and replays only on FAILURE — [test-stream-fence.md](test-stream-fence.md).
- **Mocking `src/utils/aws-clients.js` does NOT isolate a provider that builds
  its OWN client.** A network fence in `tests/setup.ts` refuses outbound AWS
  calls and fails the test from an `afterEach` (a bare `rejects.toThrow()` is
  satisfied by the refusal itself). It is a RUNTIME control: a client constructed
  and never called stays green.
- **When the fence fires, find the CONSTRUCTION SITE before choosing the mock —
  never an opt-out.** Built inside the provider → mock the SDK PACKAGE
  (`vi.mock('@aws-sdk/client-<svc>', ...)`, shape in
  `tests/unit/provisioning/route53-provider.test.ts`); reached via
  `getAwsClients()` → mock `src/utils/aws-clients.js`. Copy the package name from
  the fence's message — a mis-named `vi.mock` is silently INERT.
- **A test that SPAWNS a subprocess declares its own timeout** as `it`'s third
  argument (`}, 60_000);`) or on its enclosing `describe`: Vitest's 5 s default
  is an IN-PROCESS bound, and a spawned `.ts` entry point pays Node startup
  plus type-stripping. A case that
  walks or copies the real tree uses `CONTENDED_CASE_TIMEOUT_MS`
  (`tests/contended-case-timeout.ts`), passed to `spawnSync` as well.

### A `*Once` primer must be consumed by the test that primed it (mandatory)

- `vi.clearAllMocks()` clears call RECORDS but does NOT drain the `*Once` queue
  (`mockReset` does). A leaked primer shifts every later call in the file, and
  the shifted test still PASSES via absence assertions.
- Enforced at RUNTIME by `tests/once-leak-detector.ts` + the `once-leak-detect`
  CI job, OFF unless `CDKD_ONCE_LEAK_DETECT=1`. `once-leak-canary.test.ts` leaks
  deliberately and the `detector canary` step requires a failure carrying the
  detector's OWN wording — do not "fix" its priming. The allow-list grandfathers
  whole FILES; fix a file and DROP its entry (`vp run gen:once-leak-allowlist`).
- MEASURE consumption before pinning `toHaveBeenCalledTimes(N)`: the pin catches
  a call-COUNT change, while a SURPLUS primer leaves the count unchanged and only
  the detector sees it. Fixing the priming beats draining.

## Mutation probes

- **Enumerate the value's uses before probing** (`grep` the identifier in the
  changed hunk); one probe per use. A GUARD's uses are its CALL SITES and both
  directions of its message, each needing its OWN negative.
- A probed callee says nothing about its WIRING — delete each argument the call
  site passes and assert THOSE.
- A case reaching the subject through an outer layer inherits that layer's
  NORMALISATION and cannot exhibit what it asserts: enter by a route that
  PRESERVES the property, or call the private method directly.
- **A negative assertion needs a case where the wrong value would be EMITTED**,
  and a `vi.mock`ed module pins what the caller PASSES, never what the far side
  WRITES — one case must exercise the far side unmocked.
- **One mutation per probe, tree restored byte-exact between them**; never report
  a result you did not run. Take the receipt with `git diff --stat HEAD` — plain
  `git diff --stat` cannot see a mutation applied by `git checkout <ref> --
  <paths>`, which STAGES.

## A checker must prove it sees its input, and that it still FAILS

"0 violations" and "parsed nothing at all" are the identical green result, so
assert items parsed and **a floor per input SHAPE the parser claims to handle**
(an aggregate floor hides one dead shape) — see `integ-cli-flags.test.ts`. Floors
still do not prove the checker REJECTS a violation, and a checker and its
synthetic fixtures can share a blind spot: for each CI-blocking verdict,
introduce that violation into REAL repo code, confirm a non-zero exit naming the
right target, restore, and record it in the PR. When the real-code probe
disagrees with a passing synthetic fixture, the FIXTURE is usually wrong.

## Integration tests

`tests/integration/**`, real AWS account. Env: `STATE_BUCKET`, `AWS_REGION`. Every
convention below is written up in full, with examples, in
[docs/integ-fixture-conventions.md](../../docs/integ-fixture-conventions.md).

### `verify.sh` signal traps (mandatory)

```bash
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM
```

`trap cleanup EXIT INT TERM` is NOT equivalent and must never be used: a bash
handler returns to the interrupted point, so the script can resume and `exit 0` —
PASS while `cleanup` raced a live deploy. The `(exit N)` seed is load-bearing:
inside a handler `$?` is the **interrupted command's** status, so a `rc=$?`
cleanup can see rc=0 and skip teardown. Disarm with `trap - EXIT INT TERM`.
(`integ-verify-signal-traps.test.ts`.)

### `verify.sh` gone-probes (mandatory)

A destroy/leak assertion must never be a silenced blind probe — `if aws <read>
>/dev/null 2>&1` reads ANY failure (throttle, auth, network) as "gone":

```bash
assert_gone "<leak description>" aws <service> <read-verb> [args...]
if ! gone_probe aws <service> <read-verb> [args...]; then ...still exists...; fi
```

`gone_probe` accepts ONLY `'not ?found|no ?such|does ?not ?exist|non
?existent|\(404'` and hard-FAILs on anything else. Probe state files with `s3api
head-object`, never `aws s3 ls` (exits 1 with empty output for "no keys"). Also
banned: capture-form fallbacks (`N=$(aws ... 2>/dev/null || echo 0)` — a throttle
reads as "0 remaining") and silenced function wrappers; `$(cmd 2>&1 >/dev/null ||
true)` stays legal, piped to `tail` it is not
([abort-capture.md](abort-capture.md)). **Intermediate captures inside a value
wrapper need `|| return 1`** — errexit is CLEARED inside `$( )`, and `local
V=$(...)` masks the status entirely. Best-effort cleanup is exempt via
`set +e[u]`; write helpers as `fn() { ( set +eu; ... ) }` so calling one from a
`set +eu` trap never re-arms strict mode mid-sweep. Classifier
`scripts/check-integ-probe-not-found.ts`, fenced by
`integ-verify-probe-not-found.test.ts`.

### Mechanically enforced fixture conventions

Each is the shape a fixture must take; the named test blocks a wrong change.

- A flag is declared on the **subcommand it targets**; `--region` is NOT a no-op
  where accepted ([cli-internals.md](cli-internals.md)) and `state destroy` takes
  `--yes`. (`integ-cli-flags.test.ts`.)
- **No Lambda version literals** — counters are monotonic per function/layer NAME
  and never reset; read N from the live alias and assert `$((N + 1))`.
  (`integ-verify-version-literals.test.ts`.)
- **No `aws` verb the CLI lacks** — it REMOVES operations the API still has, per
  (service, verb) pair, with a misleading `[Errno 22]` / hang as the symptom.
  `AWS_CLI_AUTO_PROMPT=off aws <svc> <verb> --help` settles existence; call a
  missing verb through the SDK instead, with `|| return 1` and the provider's own
  pagination. (`integ-aws-commands.test.ts`.)
- **An upstream-`cdk` caller pins AND resolves a fixture-local CLI** — a pin
  without resolution takes the global `cdk` and synth dies on a schema-version
  mismatch. (`integ-cdk-cli-pins.test.ts`.)
- **`state destroy` passes `--state-bucket "${STATE_BUCKET:-}"`** — the CLI's env
  fallback `CDKD_STATE_BUCKET` is a DIFFERENT name, so omitting the flag targets
  another bucket and the surviving record wedges the next run; `:-` because
  `cleanup` can run BEFORE the unset-variable guard. **`deploy` / `destroy` keep
  the strict `"${STATE_BUCKET}"` form**, where an unset bucket must fail loudly.
  (`integ-state-bucket.test.ts`.)
- **Stateful L2s carry an explicit removalPolicy** (`kinesis.Stream`,
  `dynamodb.Table`/`TableV2`, `s3.Bucket`, `logs.LogGroup`, `kms.Key`, `rds.*`,
  `efs.FileSystem`, `opensearchservice.Domain`, `ecr.Repository`,
  `cognito.UserPool`, `backup.BackupVault`): they default to RETAIN, which cdkd
  honors, so omitting it leaks the resource every cycle while destroy reports
  success. RETAIN counts, as a decision; a spread does not.
  (`integ-fixture-removal-policy.test.ts`.)
- **The `/new-integ` scaffold's `aws-cdk-lib` floor >= the LOWEST floor in the
  corpus**, not "all floors equal": dependabot bumps one fixture at a time, so
  the subject is the GENERATOR, and every unreadable input is a REFUSAL rather
  than a skip. (`integ-cdk-lib-floor.test.ts`, which IS the CI enforcement.)
- **A mode-gated resource DISAPPEARS in every later step that omits its token** —
  phases run under `CDKD_TEST_UPDATE=<modes>`, so the resource leaves the
  template at any later deploy whose mode list lacks it and cdkd correctly issues
  a DELETE. Make the token MONOTONIC via a shell suffix
  (`CDKD_TEST_UPDATE=ttl,tags${OD_MODE_SUFFIX}`); keying presence on a run-scoped
  env var instead declares the resource from step 1 and turns the step under test
  into an UPDATE. (`integ-mode-gated-resources.test.ts`.)
- **A `local-*` fixture's Lambdas declare the HOST architecture** (`process.arch
  === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64`) —
  cdk-local pins `docker --platform` to the declared `Architectures`, and the CDK
  default `X86_64` runs under emulation on an arm64 host, faulting the Go RIE.
  Hardcoding either value is wrong the same way: the fence pins the DERIVATION.
  (`integ-fixture-host-architecture.test.ts`.)
- **A secret-seeding fixture sweeps S3 OBJECT VERSIONS and asserts zero** —
  versioning is on, so `aws s3 rm` writes a DELETE MARKER and every prior version
  stays readable, a disclosure outliving the run
  ([#2096](https://github.com/go-to-k/cdkd/issues/2096)). Sweep the PREFIX, never
  a key list (`rollback-journal.json`, `lock.json` and `deployments/**` hold
  copies too), plus the two SIBLING prefixes that are not descendants: a
  nested-stack child at `cdkd/<Parent>~<Child>/<region>/`, and the shared exports
  index `cdkd/_index/<region>/exports.json` — that one KEY-scoped and
  `noncurrent` only, never `all`, because other stacks share it. Use
  `tests/integration/s3-versions.sh`: purge `noncurrent` from `cleanup`, then on
  the SUCCESS path (after `trap - EXIT INT TERM`) purge `all` and call
  `s3_assert_versions_swept` — a sweep living only in `cleanup` never runs on the
  normal path, and a noncurrent-only teardown leaves the delete marker.
  (`integ-secret-fixture-sweep.test.ts`, `integ-s3-versions-helper.test.ts`.)
  Two shell shapes make such a sweep silently PARTIAL while the run still exits
  0, and neither is linted: **`out=$(aws ...)` strips the trailing newline**, so
  a `printf '%s' | tr | while read` loop skips the LAST field — use
  `printf '%s\n'` AND `|| [ -n "${key}" ]`; and **`length(...)` under
  `--output text`** applies `--query` PER PAGE, so a >1000-entry listing prints
  one number per page — count ROWS of a projection instead, for ANY filtered
  count.
- **When auditing a fixture by hand, read the stack name from `verify.sh`'s
  `STACK=` line, never from the directory name** — `cognito-resource-server`'s
  stack is `CognitoResourceServerStack`, and probing the convention-derived name
  returns a clean-looking `0` for a key that does not exist.

### Conventions no lint can enforce

- **List readbacks must be order-insensitive** — AWS does not preserve submitted
  order, and a joined-string compare fails in a way that ACCUSES THE FIX. Sort
  both sides, keeping the null-list coalesce:
  ``--query "join(' ', sort(Path.To.List || \`[]\`))"``. A genuinely
  order-significant list (`getDriftUnorderedPaths`) stays unsorted, since sorting
  HIDES a regression — which is why this is a judgment, not a lint.
- **A destructive prefix sweep must refuse a widened scope.** A teardown that
  LISTS under a variable prefix and DELETES what it gets back widens to the whole
  ACCOUNT when that variable is empty, and `cleanup` runs under `set +eu`. The
  guard must DOMINATE the sweep (inside a non-catch-all arm, or after an `esac`
  whose catch-all leaves via `exit` / `return`; accepting arm FIRST), and its
  pattern must be unable to match empty — the shortest literal prefix YOUR scope
  has plus `?*`, since a guard that never matches leaks silently. **The refusal
  warns on stderr with the words `teardown sweep refused`**
  ([#2690](https://github.com/go-to-k/cdkd/issues/2690) keys on that phrase).
- **A fixture that greps cdkd's OWN output must fail loudly when the wording
  drifts** — a zero match is otherwise indistinguishable from "the condition did
  not occur". Carry a sentinel: a second, independent marker on the same line,
  hard-failing when it is present while the parsed marker is not (one keyed on
  the SAME substring you parse is worthless). Re-run the fixture after ANY edit
  to a string it greps, review fixes included; a reword making a string LESS
  SPECIFIC blunts sentinels in fixtures your diff never opens
  (`stateful-guard-message-sync.test.ts`).
- **A `PendingDeletion` KMS key is NOT an orphan** — 7 days is the AWS minimum
  pending window, so it is the terminal state of a *successfully deleted* key; a
  fixture may create one per run with `pendingWindow: cdk.Duration.days(7)` and
  assert it after destroy.

## UPDATE / REMOVAL / rollback modes

- `CDKD_TEST_UPDATE=true` enables UPDATE test mode (example
  `tests/integration/basic/lib/basic-stack.ts`), making UPDATE operations
  testable without modifying code.
- `CDKD_TEST_REMOVAL=true` makes a fixture synthesize a template that genuinely
  LACKS a property — the only way to exercise the absent-field removal class,
  since a changed value never takes the removal branch. Two conventions keep the
  assertion from being vacuous: the BASELINE phase asserts the property is live
  before the removal phase asserts it gone, and a sibling is RETAINED (required
  for a collection-valued property, its templated value DIFFERING from AWS's
  default; inapplicable when the removal empties the only value set). The same
  toggle serves the inverse assertion, where RETENTION is correct — there the
  templated value must be AWS's NON-default and you must prove the `Set*` call
  FIRED, by changing a companion property in the same deploy. Enumerate the
  fixtures with `grep -rl CDKD_TEST_REMOVAL tests/integration/*/lib/*.ts
  tests/integration/*/verify.sh`; `tests/integration/route53/` is the reference.
  Full writeup: [docs/testing.md](../../docs/testing.md).
- `CDKD_TEST_FAIL=true` injects a deliberately-failing resource (an
  `AWS::SQS::Queue` with an out-of-range `MessageRetentionPeriod`) into the
  `basic` stack, verifying against real AWS that already-completed siblings roll
  back when one resource fails. After rollback, S3 and the SSM Document should
  both be deleted and the state file should be empty.

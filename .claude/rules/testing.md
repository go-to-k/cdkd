---
description: cdkd testing strategy (unit / integration / UPDATE / Rollback failure injection)
paths:
  - 'tests/**'
---

# Testing Strategy

## Unit Tests

- `tests/unit/**/*.test.ts`
- Uses Vitest
- Mocking: Mock AWS SDK with vi.mock()

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
fails them loudly), as does the strict stderr-capture idiom
(`$(cmd 2>&1 >/dev/null || true)`). Best-effort cleanup is exempt via
`set +e[u]` spans (bounded by the enclosing function) — mark cleanup helpers
with `set +eu` instead of silencing probes. Enforced by
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

## UPDATE Testing

- Environment variable `CDKD_TEST_UPDATE=true` enables UPDATE test mode
- Example: `tests/integration/basic/lib/basic-stack.ts`
- Allows testing UPDATE operations without modifying code
- JSON Patch (RFC 6902) verified working for S3, Lambda, IAM resources

## Rollback Testing (failure injection)

- Environment variable `CDKD_TEST_FAIL=true` injects a deliberately-failing
  resource (an `AWS::SQS::Queue` with an out-of-range `MessageRetentionPeriod`)
  into the `basic` stack
- Verifies against real AWS that already-completed siblings get rolled back
  when one resource fails: `CDKD_TEST_FAIL=true cdkd deploy CdkdBasicExample`
- After rollback, S3 and SSM Document should both be deleted and state file
  should be empty

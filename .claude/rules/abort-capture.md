---
description: The one silenced-capture shape a verify.sh may not use under pipefail — `V=$(cmd 2>/dev/null | tail -1)` aborts the script at the assignment with no diagnostic — and the byte-identical `capture` helper that replaces it
paths:
  - 'tests/integration/*/verify.sh'
---

# Abort-shaped captures in `verify.sh` (issue #3126)

Pointed at from [testing.md](testing.md)'s gone-probe section. Its own
satellite because `testing.md` sits within a few dozen bytes of the per-path
rule budget on `main`, and this rule is needed only while a `verify.sh` is
open.

## The shape, and what it loses

```bash
RESULT_1=$(${CDKD} local invoke <Fn> --no-pull 2>/dev/null | tail -1)   # banned
TEMPLATE=$(ls cdk.out/*.template.json 2>/dev/null | head -1)              # same shape, head
```

Every fixture runs under `set -euo pipefail`. When the CLI exits non-zero the
pipeline fails (pipefail), the substitution fails, the assignment fails, and
`set -e` kills the script AT THE ASSIGNMENT — before the assertion that would
print `FAIL: ... got: ${RESULT_1}`, with the CLI's stderr already discarded by
`2>/dev/null`. The log ends at the previous `==> [2/4] ...` banner with no
error text at all; that is how a transient during issue #3106's verification
read as an unexplained abort and cost the lane a re-run. Measured before
the sweep (2026-09-14): eight `local-*` fixtures carried it at 35 sites,
plus three retry loops that lost every attempt's stderr the same way, two
`grep`-piped captures and two sites outside `local-*`.

It is NOT a swallow: the script still fails, so nothing false-passes (issue
#1120's capture-form lint classifies a silenced capture with no fallback as
legal for that reason). What it loses is the DIAGNOSTIC.

## The correct form

`capture`, carried byte-for-byte by every fixture that uses it — copy
`CANONICAL_CAPTURE_BLOCK` from `scripts/check-integ-capture-shape.ts`, never
retype it (the fence compares each copy to the constant):

```bash
RESULT_1=$(capture ${CDKD} local invoke <Fn> --no-pull)
RESULT_6=$(AWS_REGION=US-EAST-1 capture ${CDKD} local invoke <Fn> --no-pull)  # env prefix reaches the CLI
```

It takes the exit status explicitly. On a non-zero exit it prints the
status, the last stdout line and the tail of the captured stderr, and emits
NOTHING on stdout — the assertion still runs and FAILS with its own text, and
a response that happened to look right never passes a failed invoke (the old
shape's one merit, kept). On success it emits the last stdout line. Its
stderr file is per call and removed inside the helper, so the fixture's EXIT
trap chain needs no entry for it.

Where the last stdout line is not what you want — a retry loop, or a `grep`
for the JSON line — keep stderr in a file and print its tail on the failure
path instead of running the command again to see it:

```bash
if out=$(${CLI} local invoke "${args[@]}" 2>"${err}" | tail -1) && ...; then
```

Legal and unchanged: `$(cmd 2>&1 | tail -1)` (stderr reaches the capture),
`$(cmd 2>"${file}" | tail -1)`, and `$(ls ... 2>/dev/null | head -1 || true)`
(the fallback hands the caller an explicit empty value to check — #1120's
class). Enforced by `tests/unit/scripts/integ-verify-capture-shape.test.ts`,
which also proves the convention under bash: the banned shape dies with no
diagnostic, `capture` reaches the assertion with one.

---
description: The silenced-capture shape verify.sh may not use, and `capture`
paths:
  - 'tests/integration/*/verify.sh'
---

# Abort-shaped captures in verify.sh

Issue [#3126](https://github.com/go-to-k/cdkd/issues/3126). Banned:
`V=$(cmd 2>/dev/null | tail -1)` and its `head -1` variant.

Every fixture runs under `set -euo pipefail`, so on a non-zero CLI exit the
pipeline, substitution and assignment all fail and `set -e` kills the script AT
THE ASSIGNMENT — before the assertion that would print the value, with stderr
already discarded. Not a SWALLOW (the script still fails); what it loses is the
DIAGNOSTIC.

Use `capture` instead — `V=$(capture ${CMD} ...)` — copying
`CANONICAL_CAPTURE_BLOCK` from `scripts/check-integ-capture-shape.ts`
byte-for-byte, since the fence compares each copy to that constant.
On a non-zero exit it prints the status, the last stdout line and the tail of
captured stderr, and emits NOTHING on stdout — the assertion still runs and
FAILS with its own text, so a response that looked right never passes a failed
invoke. On success it emits the last stdout line.

Where the last stdout line is not what you want (a retry loop, a `grep`) keep
stderr in a FILE and print its tail on the failure path. Legal and unchanged:
`$(cmd 2>&1 | tail -1)`, `$(cmd 2>"${file}" | tail -1)` and
`$(ls ... 2>/dev/null | head -1 || true)`, whose fallback hands the caller an
explicit empty value. Fenced by
`tests/unit/scripts/integ-verify-capture-shape.test.ts`.

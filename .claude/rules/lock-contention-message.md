---
description: The one lock-contention refusal and its `cdkd force-unlock` hint
paths:
  - 'src/state/lock-contention-message.ts'
  - 'src/state/lock-manager.ts'
  - 'src/cli/commands/force-unlock.ts'
---

# The lock-contention message and its recovery command

`src/state/lock-contention-message.ts` is the ONLY place a fail-fast
lock-contention refusal is worded (issue
[#2161](https://github.com/go-to-k/cdkd/issues/2161)). Every refusing site uses
it, `acquireLockWithRetry`'s exhaustion arm and `destroy-runner.ts`'s FORCE-QUIT
hint included.

- `acquireLock` reaps an EXPIRED foreign lock and retries, so `false` means the
  lock is LIVE. `buildLockContentionMessage` reads `getLockInfo` best-effort and
  names owner / operation / time-to-expiry; on null or a throw it degrades to
  the evidence-free wording — never replace contention with an S3 error.
- `cdkd force-unlock` re-resolves the state bucket from the AMBIENT profile, so
  a hint with only `--stack-region` can unlock a same-named stack in another
  account. `buildForceUnlockCommand` emits whichever of
  `LockRecoveryContext`'s `profile` / `stateBucket` / `statePrefix` were set.
- `DEFAULT_STATE_PREFIX` comes from `src/state/state-prefix.ts`; importing it
  from `src/cli/commands/` inverts the layering.

## Rules a later edit must not undo

- Every value reaching the terminal is sanitized THEN shell-quoted, in the PROSE
  as well as the command — `stackName` and `region` come from S3 key segments,
  so both are plantable, and quoting does nothing about an ESC. The unsafe class
  is wider than C0+DEL: U+0085, C1, U+2028/9 and the bidi overrides. Fragments
  take the DENYLIST while stack and region take `asciiOnly`, since a profile
  name legitimately is not ASCII (issue
  [#3377](https://github.com/go-to-k/cdkd/issues/3377)).
- The command is emitted LAST and UNWRAPPED, and that is a SECURITY rule: pasted
  inside a `'...'` wrapper, a `shellQuote`d value turns inside out and
  `--state-bucket 'b; printf X; #'` RUNS `printf X` (measured on `cdkd orphan`'s
  properties refusal, go-to-k/cdkd#3363). A `Parent~Child` name also becomes
  unpastable that way; `~` is deliberately NOT in the unquoted class. A message
  that must show several commands prints them on trailing labelled lines.
- **The rule reaches a shell-quoted VALUE in PROSE, and a PLACEHOLDER in prose,
  not only a command in a wrapper.** No wrapper is needed: an English apostrophe
  supplies the parity flip, so `... under this stack's name in state bucket
  'evil; touch OWNED; #'.` pasted into bash created the file — the `'` in
  `stack's` opened a quote that closed at the bucket's own. Deleting the
  apostrophe is NOT the fix: one anywhere before the value is enough, so that
  repairs a sentence and leaves the class open for the next one written. A value
  goes on a labelled trailing line instead, and a placeholder in prose is QUOTED
  like `commandHole`'s — a bare `<prefix>` in a SENTENCE reads stdin from a file
  named `prefix` and truncated one named `where` (go-to-k/cdkd#3440).
- **A fence for this pastes SENTENCES and CLAUSES, never lines alone, and plants
  DECOYS.** The line carrying the measured bug also carries `record(s)`, whose
  `(` is a syntax error that stops bash before the payload, so a line-level
  harness reported zero against an exploitable build (line 0, sentence 2, clause
  2). An execution sentinel alone is blind to REDIRECTION — compare the whole
  directory against decoys named for every placeholder. Exempt only what the
  SPLITTER makes out of one value in isolation: both "contained in a value" and
  "contained but not equal" measured green on a real regression, the second
  because `displaySafe` TRIMS, so the spelling printed is a proper substring of
  the one injected.
- A value sanitizing to EMPTY suppresses the WHOLE command; `--stack-region ''`
  reads as "not supplied" and widens to every region holding the name. An empty
  `--state-prefix` is the exception and IS emitted as `--state-prefix ''`, since
  it keys a real key space. The flag rule lives in the exported
  `recoveryCommandFlags`, shared with `cdkd orphan`'s properties refusal, which
  prints an inexact fragment as a `<profile>` / `<bucket>` / `<prefix>` hole
  where this function suppresses. Anything that can suppress must ALSO be named
  in `UNREPRODUCIBLE_LOCK_CLAUSE` and in the no-command sentence.
- `formatLockExpiry(expiresAt)` is the ONE rendering of a lock deadline. It
  takes the RAW `expiresAt` and tests it with `Number.isFinite`, the same test
  `isLockExpired` makes. Fenced by
  `tests/unit/state/lock-expiry-renderer-sync.test.ts`.

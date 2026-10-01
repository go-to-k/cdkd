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
it, `acquireLockWithRetry`'s exhaustion arm and the destroy FORCE-QUIT hint
(`src/cli/commands/stack-lock-guard.ts`, both `destroy-runner.ts` lock sites'
one SIGINT + lock guard) included.

- `acquireLock` reaps an EXPIRED foreign lock and retries, so `false` means the
  lock is LIVE. `buildLockContentionMessage` reads `getLockInfo` best-effort and
  names owner / operation / time-to-expiry; on null or a throw it degrades to
  the evidence-free wording — never replace contention with an S3 error.
- `cdkd force-unlock` re-resolves the state bucket from the AMBIENT profile, so
  a hint with only `--stack-region` can unlock a same-named stack in another
  account. `buildForceUnlockCommand` emits whichever of
  `LockRecoveryContext`'s `profile` / `stateBucket` / `statePrefix` were set,
  and builds through the shared `pasteableCommand` gate, SUPPRESSING the whole
  command on any withheld value — so a leading `-` (`--state-bucket=attacker`
  parses as the FLAG once the shell strips the quotes) and a name past the
  stack-ref cap suppress beside an altered or empty one (go-to-k/cdkd#3436),
  and so does any value, the three recovery flags included, that is not inert
  with its quotes stripped (go-to-k/cdkd#4205), or a name or region
  `isPasteableIdent` refuses (`plainIdent`): the head displays the name, and a
  block displaying an untrusted value carries no pasteable command
  (go-to-k/cdkd#3950).
- `DEFAULT_STATE_PREFIX` comes from `src/state/state-prefix.ts`; importing it
  from `src/cli/commands/` inverts the layering.

## Rules a later edit must not undo

- Every value reaching the terminal is sanitized first — `stackName` and
  `region` come from S3 key segments, so both are plantable, and quoting does
  nothing about an ESC — then shell-quoted in the COMMAND, while the PROSE
  renders the stack name in `displayStackName`'s identifier boundary and never
  inside cdkd's own quotes (a hand-quoted name ran when pasted with its
  sentence, go-to-k/cdkd#3436). The unsafe class
  is wider than C0+DEL: U+0085, C1, U+2028/9 and the bidi overrides. Fragments
  take the DENYLIST while stack and region take `asciiOnly`, since a profile
  name legitimately is not ASCII (issue
  [#3377](https://github.com/go-to-k/cdkd/issues/3377)).
- The command is emitted LAST and UNWRAPPED: pasted
  inside a `'...'` wrapper, a `shellQuote`d value turns inside out and
  `--state-bucket 'b; printf X; #'` RUNS `printf X`. A `Parent~Child` name also becomes
  unpastable that way; `~` is deliberately NOT in the unquoted class. A message
  that must show several commands prints them on trailing labelled lines.
- The paste hazard above is out of scope (SECURITY.md): keep the current
  behavior, and do not extend it to new prose or build fences for it.
- A value sanitizing to EMPTY suppresses the WHOLE command; `--stack-region ''`
  reads as "not supplied" and widens to every region holding the name. An empty
  `--state-prefix` is the exception and IS emitted as `--state-prefix ''`, since
  it keys a real key space. The flag rule lives in the exported
  `recoveryCommandFlags`; the malformed-record refusals qualify through their
  own stricter `accountArgs` instead (go-to-k/cdkd#3909). Anything that can suppress must ALSO be named
  in `UNREPRODUCIBLE_LOCK_CLAUSE` and in the no-command sentence.
- `formatLockExpiry(expiresAt)` is the ONE rendering of a lock deadline. It
  takes the RAW `expiresAt` and tests it with `Number.isFinite`, the same test
  `isLockExpired` makes. Fenced by
  `tests/unit/state/lock-expiry-renderer-sync.test.ts`.

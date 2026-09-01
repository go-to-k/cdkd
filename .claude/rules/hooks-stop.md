---
description: cdkd Stop hooks (stop-warn.sh / stop-unmerged-lane-warn.sh) - output channels, the nudge cadence rule, and the block cap they spend
paths:
  - '.claude/hooks/stop-warn.sh'
  - '.claude/hooks/stop-warn.test.sh'
  - '.claude/hooks/stop-unmerged-lane-warn.sh'
  - '.claude/hooks/stop-unmerged-lane-warn.test.sh'
---

# Stop hooks

Split out of [hooks.md](hooks.md) when that file crossed the 120,000 B per-file
payload cap again (the go-to-k/cdkd#2236 precedent). Its `paths:` glob is the
four files the detail is about, so a session not touching a Stop hook does not
pay for it.

Two hooks fire on `Stop` rather than on a tool call, and they split the same
question -- "is there work here that is not finished?" -- along the axis of
whether it has been committed.

Both had the same defect and both are fixed the same way, so read the channel
table and the cadence rule below as belonging to the pair rather than to either
one.

| channel | who reads it | the turn |
| --- | --- | --- |
| `hookSpecificOutput.additionalContext` | the MODEL | CONTINUES -- it gets another turn to act |
| `systemMessage` | the USER only | ends normally |
| stdout / stderr at exit 0 | nobody (both are discarded on `Stop`) | ends normally |

There is no fourth option that reaches the model WITHOUT continuing the turn,
which is why each hook has to choose rather than simply emit.

**A continuation is not free, and it is not merely slow.** Read from the
installed Claude Code (2.1.251) rather than the published docs: a Stop hook's
`additionalContext` travels in the SAME `blockingErrors` return value as a
`decision: "block"`, and the main loop re-queries on either. Both therefore count
against one budget -- `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, default **8**
consecutive blocks -- after which the harness overrides the hook, ends the turn
and prints "A hook blocked the turn from ending N consecutive times". So a hook
that nudges on every turn-end does not just cost a turn each time: it spends a
budget shared with every other Stop hook, and the one that spends it is not
necessarily the one with something urgent to say.

**The cadence rule, shared by both hooks (issue #2391 / issue #2396).**
`stop_hook_active` -- a required boolean on the Stop payload, set once the
harness has already resumed this turn on a hook's account -- stops a nudge from
SPINNING inside one turn, and that is all it does. Across turns the condition
persists, so an unconditional `additionalContext` fires at every turn-end for as
long as it holds. Each hook therefore nudges the model **at most once per
distinct SUBJECT**, and a repeat of the same subject falls back to
`systemMessage`: the user still sees it, the turn ends.

The subject is chosen per hook so that ORDINARY WORK does not change it --
otherwise the rule bounds nothing:

| hook | subject | re-arms when |
| --- | --- | --- |
| `stop-warn` | is a commit POSSIBLE (`check` marker fresh) | a DIFFERENT `session_id`, a record that is absent or MALFORMED, or `blocked -> commitable` |
| `stop-unmerged-lane-warn` | `<own branch>:<pushed\|unpushed>` | a DIFFERENT `session_id`, a record that is absent or MALFORMED, a DIFFERENT branch, or `unpushed -> pushed` |

The **session id** is an arming condition in its own right and this column used
to omit it, which made the table read as if only the subject transitions
mattered. It is the first clause of both predicates: a second session in the
same worktree sees a record it did not write, arms, and overwrites it. So does a
MALFORMED record -- one whose subject is not a value this hook writes -- which
is deliberate and is the safe direction (see below).

Two of those choices are load-bearing and each was arrived at by rejecting the
obvious alternative:

- `stop-warn` keys on a DIRECTED transition rather than on the marker's value.
  Editing anything in the `check` gate's scope invalidates the marker, so
  `commitable -> blocked` is what ordinary work looks like; re-arming on it hands
  back the every-turn cadence the rule exists to bound.
- The lane predicate is DIRECTED too: `unpushed -> pushed` re-arms, `pushed ->
  unpushed` never. The undirected `prev_subject != subject` spelling is a bug --
  `pushed -> unpushed` is an ordinary COMMIT, costing two forced continuations
  per commit/push cycle forever.
- Both compare against the last subject OBSERVED, not the last NUDGED, so the
  record is written on the quiet path too. Recording only on the arm froze
  `stop-warn` at `fresh -> ctx, stale -> sys, fresh -> sys` (the table promises
  `ctx`).
- `stop-unmerged-lane-warn` does NOT key on the commit COUNT, which changes every
  time the model commits, and does not use PUSH STATE as the CHANNEL
  discriminator -- the shape issue #2391 proposed. That discriminator goes quiet
  on a branch pushed with NO PR, which is a real failure and one of the two the
  hook exists for. Push state earns its keep in the subject (so the transition
  re-arms exactly once) and in the TEXT, which has THREE arms: no upstream, an
  upstream with N commits not on it, and fully pushed. The middle one is where a
  lane spends most of its life and had no case until 2026-08-31.

The record is one file in the PER-WORKTREE git dir (`stop-nudge-warn` /
`stop-nudge-lane`), holding `<session id>TAB<subject>TAB<epoch>`, written
tmp-then-`mv`. Per-worktree because that is where markgate keeps its markers too,
and because removing a worktree then takes its record with it. ONE file rather
than one per session, because a per-session file would accumulate in the git dir
with nobody to clean it up; a concurrent session in the same worktree can
therefore clobber it, and the cost is in the SAFE direction -- extra nudges,
never a missed one. "An EXTRA nudge", singular, understated it: the two sessions
alternate, so each turn finds the other's session id in the record and arms
again, and the extra cost is one nudge PER TURN for as long as both sessions run
in that worktree. It stays the accepted trade because it is bounded by the
condition itself (it stops when either session's lane clears) and because the
alternative -- a file per session -- accumulates with nobody to delete it.

BOTH hooks DELETE the record when the condition clears: `stop-warn` on the
clean-tree exit, and `stop-unmerged-lane-warn` when no worktree in the repo is
ahead of `origin/main` (it clears EVERY worktree's record there, since "no lane
is ahead" is a repo-global fact). Without that the record outlives the condition
and the next genuine first sighting of the same subject is DOWNGRADED -- a
MISSED nudge, reachable through the `git switch --detach origin/main` remedy the
lane hook itself prints. Only `stop-warn` did it until 2026-09-01.
Per-worktree-ness is pinned by a case arming from a linked worktree on the same
session id and subject.

Corrections from 2026-08-31 and 2026-09-01, each pinned by a mutation-proved
case. Where one applies to only ONE of the two hooks it now says so: an earlier
version of this list said "in BOTH hooks" of all four, and the last one had
landed in `stop-warn` alone -- which is the one shape where only the hook that
already HAS the fix can detect its own regression:

- **A RESUMED pass writes no record.** It reaches the user only, so recording
  there turns "suppress this pass" into "suppress this subject for good" -- and
  that subject is routinely NEW, having first become true DURING the
  continuation. The case asserts channel, record untouched AND next turn arming;
  any two also pass against a hook that never records.
- **The downgrade changes the TEXT, not only the channel.** Both messages are
  INSTRUCTIONS, so `systemMessage` addressed a human as the agent -- issue
  #2389's defect, widened from one path to three. Each hook keeps a `model_msg`
  and a `user_msg`; the lane hook's push wording splits into a FACT (both
  channels) and a TODO (model only).
- **The session id is normalised ONCE, from both sources.** The
  `CLAUDE_CODE_SESSION_ID` fallback ran raw, in shell, AFTER the Python fold, so
  a TAB or NEWLINE added a record field, shifted the read-back and re-armed every
  turn. No coverage before: every payload named a session.
- **BOTH hooks parse the record by parameter expansion, not `IFS=<TAB> read`.**
  A TAB is IFS WHITESPACE, so `read` folds a run into one separator and an EMPTY
  subject field handed `prev_subject` the NEXT field, taking the QUIET arm: a
  malformed record SILENCING the nudge. `stop-warn` was corrected on 2026-08-31
  and the lane hook on 2026-09-01; until then the lane suite had no
  malformed-record case at all.
- **A MALFORMED subject is normalised to ABSENT, not merely an empty one.**
  `stop-warn`'s predicate tested only the empty spelling, so a record whose
  field 2 held non-empty garbage still bought silence (`<sid>TABGARBAGETAB111`
  -> `sys` where the table promises `ctx`). `subject` has a closed value set, so
  anything else is now cleared before the predicate.
- **`mv -f <tmp> <record>` is not proof the record was written.** `mv -f` onto a
  DIRECTORY returns 0 and moves the tmp inside it, so `persisted` was set, the
  readback found nothing, and every later turn re-armed -- unbounded
  `additionalContext` against `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, arriving
  through the success check, plus one orphan tmp per turn. Both hooks now
  confirm the destination is a regular FILE and sweep the stray tmp.
- **The user text's closing clause is per DOWNGRADE PATH.** "The agent has
  already been told" is true on the repeat-subject path only. On a RESUMED pass
  this may be the first turn the condition holds at all, and on the
  UNPERSISTABLE-RECORD path `arm` is forced 0 every turn so the agent is never
  told. One string across all three re-committed issue #2389's defect in the
  user's own voice.

- **`.claude/hooks/stop-warn.sh`** covers the UNCOMMITTED half. It fires when the
  working tree is dirty and says whether a commit is currently allowed (the
  markgate `check` marker fresh) or blocked. Every word of it is addressed to the
  AGENT ("run /check to allow commit"), and until issue #2396 all of it left as
  `systemMessage` -- the USER-only channel, the same defect issue #2389 reported
  for the lane hook next door, and the reason a `stop-warn says: WARNING ...`
  line kept appearing in the terminal after issue #2392 fixed that one. Two
  Stop hooks were registered; only the other was revisited. Smoke test at
  `.claude/hooks/stop-warn.test.sh` (65 cases; 12 fail against the pre-2026-08-31
  hook, each also mutation-proved). Three fixture traps are pinned there, each
  having made a case pass for the wrong reason: this git does NOT create
  `.git/info/` on `init`, so the exclude file was never written and the
  clean-tree case ran against a permanently dirty tree; the no-python3 case
  emptied `PATH`, where `bash` and `dirname` vanish too, so the hook died at the
  `cd ""` ABOVE its `command -v python3` guard and deleting that guard left the
  suite green (the stub now omits only `python3`, and the case asserts exit 0);
  and every `ctx` assertion depended on its POSITION until a
  `clear_nudge_records` reset was added.

  **bash 3.2 is exercised on the HOOK, not just the suite.** `/bin/bash <suite>`
  leaves the hook on `#!/usr/bin/env bash`, which PATH resolves to the 5.x.
  `HOOK_BASH=<path>` puts a `bash` shim first on PATH; six suites honour it and
  `run-tests.sh` sets it per shell. Verified with a bash-4-only PARSE error
  (`;;&` in a `case`) per hook: red with the shim, green without.
- **`.claude/hooks/stop-unmerged-lane-warn.sh`** covers the quieter half: a
  linked worktree whose branch is COMMITTED but still ahead of `origin/main` --
  a lane that is finished as far as the editor is concerned and unfinished as
  far as the repo is. It names each such branch, its commit count and its
  worktree -- but WHICH CHANNEL it leaves by depends on whose lane it is, per the
  table above:

  - **this session's own worktree is a lane** -> `additionalContext`, subject to
    the cadence rule. This is the failure the hook exists for.
  - **only OTHER worktrees are lanes** -> `systemMessage`. The model cannot act
    on another session's lane, so a continuation buys one extra reply that can
    only say "not mine".
  - **`stop_hook_active` set** (the harness already continued once this turn) ->
    `systemMessage`, so one nudge never becomes a spin. NOT silent, as it used to
    be: the lane can be COMMITTED during the continuation.

  Ownership is decided from `cwd` in the Stop payload, resolved to its worktree
  root, falling back to this hook copy's own checkout -- in a linked worktree
  BASH_SOURCE IS the lane. Note the POLARITY against the #2279 defect below: the
  same path that was wrong as a SKIP is right as an IDENTIFIER.

  **The channel was wrong for months** (go-to-k/cdkd#2389): everything went out
  as `systemMessage`, so a message written AT THE AGENT ("you are not done",
  "the honest label is STOPPED, not WAITING") reached only the party that cannot
  act on it, while the user got the same wall of text every single turn. Fixing
  it to `additionalContext` unconditionally was measured first and rejected:
  four forced continuations in one session over ONE lane belonging to another
  session, each producing a reply that could only say "not mine". Because this
  repo SQUASH-merges, a merged branch reads as ahead forever, so a single
  un-removed worktree would have made that permanent.

  Why a hook rather than another sentence: `CLAUDE.md` already says a
  NOT-CLOSEABLE verdict is a to-do list and not a stopping point, and already
  says that a turn with no signal that will re-invoke you is STOPPED and not
  WAITING. Both were violated repeatedly in one session on 2026-08-26 -- turns
  ended with `Mode: WAITING` next to `Waiting on: none`, and with
  `Verdict: NOT CLOSEABLE` in the same report as the stop. Per the escalation
  rule, a rule already in the text that gets violated anyway is not made
  load-bearing by a third spelling of it, so this computes the verdict from the
  REPO instead of from the agent's own self-report -- which is the part that was
  wrong. Deliberately does NOT call `gh` and does NOT fetch: it runs every turn,
  and a stale `origin/main` can only OVER-report -- a branch whose work already
  merged keeps reading as ahead -- which is the safe direction, since the
  failure that matters is MISSING a real lane and staleness cannot cause that.
  (This sentence said UNDER-report until #2389; the hook's own comment had
  already been corrected and this copy had not.)

  **It shipped INERT for its own primary case** (go-to-k/cdkd#2279, fixed in the
  follow-up). It derived its root from `BASH_SOURCE` and skipped the worktree
  that matched -- intended to skip the main tree, but in a linked worktree
  `BASH_SOURCE` IS the lane, so the session ending inside its own unmerged lane
  got nothing. Measured in the sibling cdk-local from a lane five commits ahead:
  EMPTY. The main tree is identified by BRANCH (`main` / `master`), which the
  loop already checks, so the path skip was redundant AND the entire defect. All
  seven original cases ran the hook from the sandbox's MAIN tree, which is why
  none of them could see it.

  Smoke test at `.claude/hooks/stop-unmerged-lane-warn.test.sh` (77 cases; 11
  fail against the pre-2026-08-31 hook, each also mutation-proved).
  Its suite carries one trap worth knowing before editing it. On macOS
  `mktemp -d` returns a `/var/folders/...` path whose real location is
  `/private/var/...`; the hook canonicalises its own root with `cd && pwd` while
  git records a worktree under the path it was CREATED with, so the two
  spellings never compare equal and any case whose subject IS that equality
  passes no matter what the hook does. The self-lane case was measured VACUOUS
  on its first attempt for exactly that reason. The sandbox root is therefore
  `cd "$(mktemp -d)" && pwd -P`.

  One false positive is expected and is named in the warning text itself: this
  repo squash-merges, so a merged branch never becomes an ancestor of
  `origin/main` and keeps reading as ahead until its worktree is removed. The
  remedy there is `git worktree remove` plus `git branch -D`, not another PR.


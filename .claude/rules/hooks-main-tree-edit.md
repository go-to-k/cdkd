---
description: cdkd main-tree edit gate (main-tree-edit-gate.sh) and its dirty-detector backstop - detection model, Bash arm, suites
paths:
  - '.claude/hooks/main-tree-edit-gate.sh'
  - '.claude/hooks/main-tree-edit-gate.test.sh'
  - '.claude/hooks/main-tree-dirty-detector.sh'
  - '.claude/hooks/main-tree-dirty-detector.test.sh'
---

# main-tree-edit-gate and main-tree-dirty-detector

Moved out of [hooks.md](hooks.md), then updated for go-to-k/cdkd#2614, when its entry took
that file past its 80,000 B per-file payload cap — the same split as
[hooks-cwd-detector.md](hooks-cwd-detector.md),
[hooks-branch-gate.md](hooks-branch-gate.md) and
[hooks-main-tree-branch.md](hooks-main-tree-branch.md). hooks.md keeps a
one-line pointer; this file's `paths:` glob is narrow, so the detail is a token
toll only on a session actually touching these two hooks.

- **`.claude/hooks/main-tree-edit-gate.sh`** — blocks *mutating a
  git-tracked file* in a worktree currently on `main` / `master` (matcher
  `Edit|Write|Bash`) — the gap `branch-gate.sh` (commit/push only) and
  `main-tree-branch-gate.sh` (switch/checkout only) both leave open. The
  2026-06-21 incident: a `/run-integ` campaign rewrote the committed ledger
  `docs/_generated/integ-last-run.tsv` in the main tree on `main`, blocking
  the user's `git pull --ff-only`. Fires only when the target's branch is
  `main`/`master` AND the file is tracked (or is a NEW file under `src/` /
  `tests/` / `docs/` / `scripts/` / `.claude/`, excluding
  `.claude/worktrees/*`). Edit/Write read `tool_input.file_path` (reliable);
  Bash best-effort-scans for LITERAL write targets (`> f`, `>> f`,
  `tee [-a] f`, `sed -i ... f`). **Known gap**: a variable-indirected target
  (`mv "$tmp" "$LEDGER"`) cannot be resolved statically — the next bullet,
  `main-tree-dirty-detector`, is the backstop for it.
  Feature worktrees always pass. macOS-safe (`cd && pwd -P`).
  **The `cd` BEFORE the write comes from the SHARED matcher since go-to-k/cdkd#2614**:
  the local regex it replaced read the verb `cd` as literal text while
  unquoting its VALUE, so `"cd" <main-tree> && echo x > <tracked>` (and `'cd'`
  / `\cd`) exited 0 where the literal spelling exited 2. Load fails CLOSED.
  **The scan is bounded to the prefix before the earliest write, with
  subshell / substitution spans removed** — `cmd_last_cd_target` follows EVERY
  `cd` in command position, and handing it the whole command re-opened this
  gate's founding incident: `echo hi > <tracked> && cd /tmp` went rc=2 -> 0,
  as did the `; cd`, `tee`, `(cd …)` and `$(cd … && pwd)` spellings, the last
  being an ordinary path-resolution idiom this repo's hooks carry in ~20
  files. The same walk false-blocked the standing post-merge
  `echo hi > f && cd <main> && git pull` from a feature worktree (rc=0 -> 2).
  **KNOWN FALSE REFUSAL, and it is the price of that bound**: a `>` or `tee`
  inside a QUOTED argument truncates the prefix and drops a real `cd` after it,
  so `echo "a > b" && cd <feature-wt> && echo x > <tracked>` from a main-tree
  cwd BLOCKS. Distinguishing a quoted `>` needs a stripper whose offsets do not
  map back to the original, and running the whole scan on stripped text would
  delete the quoted `"cd"` go-to-k/cdkd#2614 exists to see. Loud direction, the
  same answer the pre-#2614 regex gave, and pinned as case 31 rather than left
  to be rediscovered.
  Smoke test: `main-tree-edit-gate.test.sh` (31 cases). The three quoted-`cd`
  spellings carry a literal control from the SAME foreign cwd so the trio
  cannot pass vacuously — and the control PASSES against the pre-#2614 hook,
  which is what makes it a control; that hook fails 4 of the 31. The eight
  trailing-/subshell-/substitution-`cd` cases and their three false-block twins
  come from the review of #2614's own first revision, which handed the WHOLE
  command to `cmd_last_cd_target`: it follows every `cd` in command position,
  so a `cd` AFTER the write moved the base and re-opened this gate's founding
  incident. That revision fails 11 of the 31. The
  block names file + worktree + branch and prints the `git worktree add`
  recipe (incl. the /run-integ ledger note). See memory
  `feedback_main_tree_tracked_edit_gate.md`.

- **`.claude/hooks/main-tree-dirty-detector.sh`** — PostToolUse (`Bash`),
  REACTIVE, **non-blocking** backstop for exactly the variable-indirected gap
  above: after a command, when the MAIN worktree is on `main`/`master` and
  now has dirty TRACKED files (`git status --porcelain` minus `??`), it emits
  a loud `additionalContext` warning naming the files + the worktree recipe.
  Noise control: runs the git check only when the command contains a
  write-ish token (`>` / `>>` / `tee` / `mv` / `cp` / `sed -i` / `dd` /
  `truncate`); always exit 0 (PostToolUse cannot block). Smoke test:
  `main-tree-dirty-detector.test.sh` (8 cases, incl. 1 non-opted-in quiet
  case).


---
description: cdkd main-tree edit gate (main-tree-edit-gate.sh) and its dirty-detector backstop - detection model, Bash arm, suites
paths:
  - '.claude/hooks/main-tree-edit-gate.sh'
  - '.claude/hooks/main-tree-edit-gate.test.sh'
  - '.claude/hooks/main-tree-dirty-detector.sh'
  - '.claude/hooks/main-tree-dirty-detector.test.sh'
---

# main-tree-edit-gate and main-tree-dirty-detector

Moved verbatim out of [hooks.md](hooks.md) when go-to-k/cdkd#2614's entry took
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
  **The leading `cd` comes from the SHARED matcher since go-to-k/cdkd#2614**:
  the local regex it replaced read the verb `cd` as literal text while
  unquoting its VALUE, so `"cd" <main-tree> && echo x > <tracked>` (and `'cd'`
  / `\cd`) exited 0 where the literal spelling exited 2. Load fails CLOSED.
  Smoke test: `main-tree-edit-gate.test.sh` (15 cases, incl. 2 non-opted-in
  passes and the three quoted-`cd` spellings with a literal control from the
  SAME foreign cwd, so the trio cannot pass vacuously; all four fail against
  the pre-#2614 hook). The
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


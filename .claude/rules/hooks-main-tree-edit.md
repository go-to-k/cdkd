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
  **The `cd` match is a local ANCHORED regex, with only the VERB and the PATH unquoted through the shared library (go-to-k/cdkd#2614)**:
  the local regex it replaced read the verb `cd` as literal text while
  unquoting its VALUE, so `"cd" <main-tree> && echo x > <tracked>` (and `'cd'`
  / `\cd`) exited 0 where the literal spelling exited 2. Load fails CLOSED.
  **The scan stays ANCHORED at the start of the command**, and three widenings
  were built and reverted to keep it that way — each fixed its predecessor and
  shipped a SILENT failure where the anchored form has only loud ones. Passing
  the whole command to `cmd_last_cd_target` let a `cd` AFTER the write move the
  base (`echo hi > <tracked> && cd /tmp`, rc=2 → 0 — this gate's founding
  incident, ten characters, no quoting trick). Truncating at the earliest write
  with a hand-rolled `$( )` / backtick / `( )` stripper leaked a `cd` through a
  nested or quoted `)`, and dropped a real `cd` when a `>` sat inside a QUOTED
  argument — a BYPASS, not a refusal, whenever the payload cwd is a feature
  worktree. An ordered `gate_segments` walk closed both of those and still
  leaked a `cd` inside a plain subshell, which the segmenter emits in place.
  Every one of them was a hook-local shell parser written inside the change
  whose purpose was deleting a hook-local shell parser.
  **The anchored form's cost has BOTH polarities, and both are pinned** — a
  command whose first segment is a substitution or a subshell has its real `cd`
  ignored, so the base stays the payload cwd. From a main-tree cwd that is a
  false refusal (cases 29-31, loud, one rephrase away); from a FEATURE-worktree
  cwd with the `cd` pointing at the main tree it is the same miss with the sign
  flipped and the gate exits 0 while the write lands on `main` (cases 32-34).
  An earlier round shipped that shape while claiming the cost was refusals
  only, which is why the claim is now pinned in both directions instead of
  asserted in one. Inherited from origin/main, not introduced here. The three
  measurement tables and the remaining option — teaching `gate_segments` to
  mark subshell-derived segments, which helps every consumer — are in
  go-to-k/cdkd#2650.
  Smoke test: `main-tree-edit-gate.test.sh` (42 cases). The three quoted-`cd`
  spellings carry a literal control from the SAME foreign cwd so the trio
  cannot pass vacuously — and the control PASSES against the pre-#2614 hook,
  which is what makes it a control; origin/main's hook fails 7 of the 42. The eight
  trailing-/subshell-/substitution-`cd` cases and their three false-block twins
  come from the review of #2614's own first revision, which handed the WHOLE
  command to `cmd_last_cd_target`: it follows every `cd` in command position,
  so a `cd` AFTER the write moved the base and re-opened this gate's founding
  incident. The first revision fails 18 of the 42. The
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


---
description: cdkd main-tree edit gate (main-tree-edit-gate.sh) and its dirty-detector backstop - detection model, Bash arm, suites
paths:
  - '.claude/hooks/main-tree-edit-gate.sh'
  - '.claude/hooks/main-tree-edit-gate.test.sh'
  - '.claude/hooks/main-tree-dirty-detector.sh'
  - '.claude/hooks/main-tree-dirty-detector.test.sh'
  - '.claude/hooks/main-tree-edit-oracle.test.sh'
  # This file asserts behaviour of the SHARED matcher (`_gate_struct_next`'s
  # escaped-whitespace refusal, `gate_dequote_structural` ahead of the verb
  # walk), so it has to load when that file changes. Without this path the
  # claims below would rot with nothing watching them, which is the failure
  # this corpus exists to prevent. The MECHANISM belongs to
  # hooks-class-fences.md; what lives here is this gate's incident.
  - '.claude/hooks/lib/command-match.sh'
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
  **The `cd` comes from an ORDERED WALK over `gate_segments_marked`**: each
  segment either updates the running base — when it is a `cd` that is NOT
  subshell-derived — or has its write targets resolved against the base as it
  stands at that point. The VERB is unquoted and then unescaped the way bash
  does (go-to-k/cdkd#2614): a token that WAS quoted keeps its content verbatim,
  only an UNQUOTED one is unescaped. A brute force over 137,256 tokens once
  reported six spellings reaching `cd`, but it measured the VERB UNESCAPE
  alone, and `gate_segments` rewrites the command word ahead of this walk — so
  **the "reads a `cd` bash does not run" direction was never empty.**
  go-to-k/cdkd#2650 found `cd\ /tmp`: ONE shell word, answered by bash with
  `cd /tmp: No such file or directory`, split on whitespace into `cd` +
  `/tmp`. Closed in the segmenter at `_gate_struct_next`, by refusing to split
  after an ODD trailing backslash. The blast radius is every gate that
  resolves a target, not this hook — `origin/main`'s LIBRARY resolves it to
  `/tmp` for the target observables, though its anchored-regex HOOK still
  answers 2, so the rc=0 once published here as shipped behaviour was this
  branch's regression and not main's.

  **The count of affected observables is deliberately absent.** It was
  published as eleven, then fourteen, then twenty-eight, and a reviewer
  re-measuring got fourteen against a different comparand: four attempts, no
  two agreeing. Apply the `odd-trailing-bs` mutant and read the differential's
  own undeclared-cell list.

  **Load fails CLOSED for `Bash` ONLY, and the asymmetry is the point**
  (go-to-k/cdkd#2717). Every other gate on the shared matcher refuses outright
  when the library will not load; this one matches `Edit|Write|Bash`, so
  refusing at LOAD time took away the three tools the library is repaired with.
  It happened four times in one session (go-to-k/cdkd#2650), three of them from
  a single apostrophe inside a comment in the library's awk program, and each
  time the maintainer ran the repair from their own shell. A safety mechanism
  must not be able to remove the operator's means of repair.

  What makes the split sound rather than a relaxation: the
  `Edit|Write|MultiEdit` arm reads `tool_input.file_path` through `jq` and calls
  no library function — the path arrives already expanded, so there is no shell
  text to parse. Only the `Bash` arm needs the matcher. Everything between the
  load and the dispatch is assignments and function definitions, so nothing runs
  against the missing symbols in between. Inside the `Bash` arm the refusal is
  UNCONDITIONAL — a write to `/tmp` is refused too, because deciding it is safe
  is the parse the hook just failed to do.

  **The surviving arms still ENFORCE**, which is the half a fail-open would also
  satisfy: with the library broken, an `Edit` or `Write` of a protected
  main-tree file is still refused, by the gate's OWN message rather than the
  load refusal. Measured against `origin/main`'s hook under the same broken
  library and the same payloads: `Edit` 2 → 0, `Write` 2 → 0, `Bash` 2 → 2, with
  a working-library copy giving 0 on the old hook as the control.

  **There is ONE enforcement control per tool label, and the reason is a
  measured survivor, not symmetry.** With only the `Edit` control, injecting
  `[ "$tool" = Write ] && [ "$__lib_loaded" != 1 ] && exit 0` into the dispatch
  survived the whole suite: an expect-0 lockout case asserts a bare exit code,
  so a fail-open in that arm is indistinguishable from the arm working. The same
  shape sank the worktree-repair case, which named a path under a directory the
  fixture never created — `__norm_candidate` returns 1 on an absent parent
  directory, so it exited before the branch lookup and its MAIN-tree twin
  answered 0 as well. **Every expect-0 case here is paired with a case that must
  answer 2 for the same tool**, and the pairs differ only in the thing under
  test.

  The refusal TEXT is a case too, one needle per SENTENCE. It has to say that
  Edit and Write survive **and where** — `FROM A FEATURE WORKTREE`; in the main
  tree on `main` the gate refuses that edit as well, for its own separate
  reason, and there the repair is the operator's. The first revision said only
  the first half, which is the same overstatement in the other direction as the
  text it replaced: a refusal that misstates what is available is what sends an
  agent looking for a way around the gate.

  **An unclassifiable `tool_name` now exits 0 where the load-time refusal caught
  it** — a malformed payload, or `jq` missing as well, falls through the `case`
  to `*)`. Accepted, not overlooked: refusing there puts Edit and Write back
  inside the refusal the moment `jq` breaks too, which is the lockout arriving
  by a second route, and the registered matcher is `Edit|Write|Bash`, so `*)` is
  unreachable for any tool this hook is invoked on.

  **This is the fifth resolution strategy the gate has carried, and the first
  that is neither anchored nor hand-rolled.** The four before it each fixed
  their predecessor and shipped a SILENT failure — a local `^cd` regex that
  read the verb as literal text; `cmd_last_cd_target` over the whole command,
  which follows a `cd` AFTER the write and re-opened this gate's founding
  incident; truncation plus a hand-rolled span stripper, which leaked a `cd`
  through a nested or quoted `)` and dropped a real one when a `>` sat inside a
  quoted argument; and the anchored regex, which has no fail-open of its own
  but ignores every `cd` that is not first. go-to-k/cdkd#2650 keeps all four
  measurement tables. The ordered walk was tried and rejected once because
  `gate_segments` FLATTENS a subshell: `( cd /tmp ) ; echo hi > <tracked>`
  moved the base although the real shell would not. `gate_segments_marked` is
  the missing piece, and it is a SEPARATE entry point, so no consumer of
  `gate_segments` has to opt in. That is not the same as leaving
  `gate_segments` alone, and an earlier draft claimed it was: `gate_segments`
  differs from `origin/main` on 28 of the differential's 239 inputs (11.7%), mostly
  from the per-line drain, which changes segment ORDER. The fence prices every
  difference — that is the property; the size of the set is not restated here,
  because "differs on 9" stood until a reviewer re-ran it and got 28.

  **Marking reads the segment through `strip_noncommand_spans` first**, so a
  `(` inside a quoted argument is gone before any paren is counted:
  `echo "a (b" && cd <wt> && echo x > f` keeps its real `cd`. That shape and
  its control (a REAL subshell `cd`, still ignored) are both pinned, so the
  pair cannot regress into each other.

  **TWO BOUNDS, and each must be checked in BOTH polarities.** Past
  `GATE_MARK_MAXSEG` segments the marking marks everything subshell-derived;
  past `GATE_EDIT_MAXBYTES` of command text the walk is skipped and targets are
  read off the raw command. Both exist because this hook runs on every Bash,
  Edit and Write call in any repo on any branch, BEFORE the on-`main` test, and
  the walk measured 16 s for 2000 segments against a 10 s PreToolUse timeout —
  a killed hook cannot emit exit 2, so the gate vanishes at the size where
  someone would want it.

  Discarding the `cd` walk is conservative from the MAIN tree and PERMISSIVE
  from a feature worktree, where the `cd <main tree>` that brings a write INTO
  the protected tree is the one being discarded — padding past either bound
  switched the refusal off. **Both bounded paths therefore UNION IN every `cd`
  target found in the raw text** as an extra base for every candidate, which
  over-approximates in the refusing direction. A write outside the repo must
  still pass, or the cheap path becomes a blanket refusal of large commands
  everywhere; that is pinned as a case. The first revision of this paragraph
  claimed only the flattering polarity, which is how the hole survived a round.
  **The suites are two, and the second is the load-bearing one.**
  `main-tree-edit-oracle.test.sh` EXECUTES its corpus in a sandbox and asks
  whether the protected file was really written, comparing that with the
  gate's verdict. It exists because successive hand-picked fixes to the
  segmenter each introduced a new fail-open while every existing suite stayed
  green: hand-picked cases encode the same misunderstanding the code has.
  Tolerances are 0. `GATE_HOOK=<path>` points it at another revision, which is
  how "inherited or introduced?" gets settled rather than argued — that is how
  `origin/main` was measured at 38 fail-opens against this branch's 0. Its
  header carries the grid's dimensions and the two traps that made an earlier
  revision of it vacuous; no figure from it is restated here. **Both suites
  honour `HOOK_BASH`** — they did not until 2026-09-07, and that is how a
  bash-3.2-only fail-open in `gate_strip_prefix` stayed invisible to every
  local run of them.

  Smoke test: `main-tree-edit-gate.test.sh`, whose CASE_FLOOR is the count —
  read it there rather than here. The three quoted-`cd`
  spellings carry a literal control from the SAME foreign cwd so the trio
  cannot pass vacuously — and the control PASSES against the pre-#2614 hook,
  which is what makes it a control; origin/main's hook failed 7 of the 42 cases the file held AT THAT MEASUREMENT (go-to-k/cdkd#2614) -- a historical figure, not a running tally, and it is written that way because the count above it has drifted three times. The eight
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


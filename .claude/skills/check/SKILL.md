---
name: check
description: Run local quality checks (typecheck, lint, build, tests). Quick check during development.
---

# Local Quality Check

Run all local quality checks. Use during development to verify the current state quickly.

## Steps

Run these sequentially and report results:

0. **Worktree pre-flight**: confirm root `node_modules/` exists in the cwd:
   ```bash
   [ -d node_modules ] || pnpm install --frozen-lockfile
   ```
   `git worktree add` does NOT copy `node_modules`, and in a fresh worktree
   `vp check` fails with an UNNAMED `typescript(tsconfig-error): Invalid
   tsconfig — Cannot find type definition file for 'node'` (no file path in
   the message), which reads like a broken fixture tsconfig and sends you
   hunting in the wrong place. `/verify-pr` step 0 has the same pre-flight;
   this copy exists because `/check` is usually the FIRST skill run in a
   fresh worktree.

1. `vp check --fix` — typecheck + lint + Prettier formatting, with auto-fix. Then `vp run check` — the EXACT command CI's `check-build-test` job runs. The two are NOT equivalent: `vp check --fix` has passed 0-errors while `vp run check` failed with a TS7053 error on the same tree (observed 2026-08-09 on PR #1372 — an implicit-any union index the --fix invocation never surfaced, plus a `no-base-to-string` that --fix reported as a warning but CI failed as an error). Run both; CI parity comes from the second. **Use this, not `vp run lint:fix`**: the CI workflow runs `vp check` (which includes Prettier), and `lint:fix` does NOT touch Prettier formatting — so a `lint:fix`-only run passes locally but CI fails with `Formatting issues found` on the same branch. See memory rule `feedback_vp_check_vs_lint_fix.md` for the underlying gotcha and PR #363 for a concrete trap.
2. `vp run typecheck:test` — type-checks `tsconfig.test.json` (the `tests/**` project). **`vp check` above only type-checks `tsconfig.json` (src/** + types/**), which excludes `**/*.test.ts`** — so a wrong `import type` or a stale mock shape in a test file would pass `vp check` AND `vp test` (whose "Type Errors" line only covers `*.test-d.ts`). This step is what makes test-file type errors fail locally the same way CI now fails them (issue #1133).
3. `vp run build`
4. `vp test run` — the whole unit suite. **Prefer this over `vp run test`**, even though that is the spelling CI uses and the `test` task delegates to exactly this command: nothing sits between the caller and the verdict. Measured on this repo 2026-08-31, both spellings on the same 17,497 tests: `vp test run` prints **15 lines / 617 bytes**, `vp run test` **17 lines / 651 bytes**.
   The gap used to be 260x, and closing it is what the `cache: false` change bought. While the `test` task still cached, `vp run test` gave the child a TTY, so vitest switched to its per-file reporter with console interception on: **1,981 lines / 171 KB** for a green run. It could also exit 0 having run NOTHING, when the cache encoder overflowed while serialising the task's inputs (`Cache lookup failed: Encoded sequence length exceeded preallocation limit`, no `Test Files` line, rc=0). Both are gone with the cache; `vp test run` never had either.
   Read the summary line, not just the exit code: a run that reports no `Test Files` count did not run.

   **And check WHICH PROJECT the summary belongs to — the summary line cannot
   tell you.** Measured 2026-09-02 with several sessions running suites at once:
   three consecutive `vp test run` invocations from cdkd's worktree printed
   `Test Files 246 passed (246) / Tests 4410 passed (4410) / Type Errors no
   errors` — the suite of a **cdk-local worktree**
   (`/Users/goto/pc/github/cdk-local/.claude/worktrees/...`, which has exactly
   246 test files), not cdkd's 856. `cd`-ing to the right worktree did not help
   and neither did `--config vite.config.ts`; the shell's `pwd` was correct
   throughout. The tells are the `RUN <root>` header — 3 lines above the
   summary on a clean cdkd run, but ~1,600 lines above it here (probably
   because the foreign project's output is not stream-fenced the way
   cdkd's `tests/setup.ts` fences its own; inferred, not confirmed) — and a
   stray `vp run: cdk-local#test ...` line at the end.

   **The MECHANISM is unconfirmed; do not repeat a guess as fact.** Ruled out
   in this tree: `node_modules/cdk-local` is a pnpm REGISTRY install (store
   symlink, v0.147.7), `pnpm-workspace.yaml` declares no `packages:`, and
   `vite.config.ts` references no sibling project — so it is not a workspace
   link. **Also ruled out — and this is the second wrong guess, so stop
   guessing:** the `vp` on PATH is not an unpinned toolchain. `type -a vp`
   resolves function -> `~/.vite-plus/bin/vp` -> the mise shim, and while that
   launcher self-reports `vp v0.1.12`, it prints `Local vite-plus: v0.2.5`,
   matching both `package.json` and `.mise.toml`'s `http:vp` pin. No version
   mismatch. What remains observable is only that PATH prefers the
   `~/.vite-plus` launcher over the mise shim; whether that matters here is
   unknown. Treat the cause as OPEN and reproduce it before acting on any
   theory.

   Whatever the cause, acting on the summary sets the `check` marker (and
   through `requires`, the `verify-pr` one) over a suite that never ran. So
   assert the root in the same command that produces the verdict, and read the
   suite's own exit code rather than the trailing `grep`'s:

   ```bash
   # Subshell so the `exit`s are safe to paste into an interactive shell and
   # still give the caller a non-zero status.
   (
     log=$(mktemp)                     # NOT a fixed path: the documented
                                       # trigger is concurrent lanes, and a
                                       # shared /tmp/t.log lets one lane read
                                       # another's summary as its own.
     echo "log: $log"                  # print it BEFORE the exits below, or a
                                       # failing run's output is unrecoverable
                                       # (each agent Bash call is a new shell).
     vp test run > "$log" 2>&1; rc=$?
     # Exactly ONE header. Two projects interleaved into one log would let
     # `-m1` bind cdkd's header while the summary grep prints both suites';
     # zero headers means the suite never started. Report the count, since
     # the two directions have different causes.
     runs=$(grep -c 'RUN  v' "$log")
     [ "$runs" = 1 ] || { echo "expected 1 RUN header, found $runs -- attests to nothing; log: $log"; exit 1; }
     run_root=$(grep -m1 -oE "RUN  v[0-9.]+ .*" "$log" | sed 's/^RUN  v[0-9.]* //')
     [ "$run_root" = "$(pwd -P)" ] || { echo "WRONG PROJECT ($run_root) -- attests to nothing; log: $log"; exit 1; }
     grep -E "Test Files|      Tests |Type Errors" "$log"
     [ "$rc" = 0 ] || { echo "SUITE FAILED rc=$rc; log: $log"; exit 1; }
   )
   ```

   It is contention-dependent, not sticky — re-running usually lands on the
   right project. A single-FILE run (`vp test run tests/unit/<x>.test.ts`)
   reported the right project every time in the same window, so it is a useful
   way to confirm which project you are addressing while other lanes are busy —
   **but it does NOT substitute for this step.** The marker still requires a
   full-suite run that passed AND was rooted here; if the full suite cannot be
   obtained, say so rather than setting the marker on a narrower run.

## Output

Report as a table:

| Check | Result |
|-------|--------|
| typecheck + lint + format (`vp check --fix`) | pass/fail |
| test-project typecheck (`vp run typecheck:test`) | pass/fail |
| build | pass/fail |
| tests (N files, M tests) (`vp test run`) | pass/fail |

If all pass, confirm "All checks passed."
If any fail, show the error output and STOP — do not write the commit-gate marker.

## Commit-gate marker (on success only)

After all four checks pass, record a marker so the PreToolUse `check-gate` hook (see `.claude/hooks/check-gate.sh`) allows the next `git commit`. The marker is managed by [markgate](https://github.com/go-to-k/markgate) and captures the current working tree state; any subsequent edits invalidate it and require re-running `/check`.

**Merely CREATING a file inside a gate's scope stales that gate — no edit to an existing file, and no commit.** An untracked file counts: the digest covers the scope's file SET, so a new path appearing in it changes the digest the moment the file exists. Measured 2026-08-20 in a feature worktree, markers otherwise fresh: creating an untracked `tests/_probe.ts` flipped `markgate verify check` from rc=0 to rc=1, and deleting it flipped it back to rc=0. `git commit` is **not** the trigger — the staleness is already there before you commit.

It is scope-dependent, which is what makes it confusing rather than merely surprising: in the same measurement `docs` stayed rc=0 throughout, because `tests/**` is not in its scope. So the same action stales one gate, both, or neither depending only on where the file landed — a new file under `tests/**` stales `check` alone, one under `.github/workflows/release.yml` or `CONTRIBUTING.md` stales neither. The measurement's third case is now stale rather than wrong: it recorded three untracked files under `.claude/hooks/` leaving BOTH gates at rc=0, and `.claude/hooks/**` joined the `check` scope in issue #2381, so that path now stales `check`. (Derived from the include list, not re-measured.)

This is correct behaviour, not a defect — a new test file genuinely means the recorded run no longer covers the tree. But the symptom is a `check-gate` refusal that reads as "my markers randomly expired", so it gets debugged instead of re-run. **Re-run the skill; do not investigate.** `/verify-pr` re-sets both markers in one shot.

Run this from the repo root (cdkd pins markgate via mise, so use `mise exec` to avoid PATH issues when shims aren't active):

```bash
mise exec -- markgate set check
```

Skip this step if any check failed — a stale or missing marker correctly forces the user (or Claude) to re-run `/check` after fixing the failure.

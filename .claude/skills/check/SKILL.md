---
name: check
description: Run local quality checks (typecheck, lint, build, tests). Quick check during development.
---

# Local Quality Check

Run all local quality checks. Use during development to verify the current
state quickly.

## First: self-review on four axes

Walk these BEFORE the commands below and before committing. A green suite says
the tests pass, not that the work is *good*, and none of these four is
something a runner reports.

1. **Implementation gaps** — the parallel change forgotten in a sibling command;
   a test or a doc not added.
2. **Oddities** — dead code, leftover names, a half-applied refactor.
3. **Polish opportunities** — small in-scope improvements; **default to
   including them** when they touch the same files and carry no
   behavior-break risk.
4. **Regression risk** — the full suite, and the call sites of anything renamed
   or removed.

Say out loud what you found, then fix it before running the checks.

## Steps

Run these sequentially and report results.

0. **Worktree pre-flight**: `[ -d node_modules ] || pnpm install --frozen-lockfile`.
   `git worktree add` does not copy `node_modules`, and without it `vp check`
   fails with an unnamed `typescript(tsconfig-error): Invalid tsconfig — Cannot
   find type definition file for 'node'`, reading like a broken fixture
   tsconfig.

1. `vp check --fix` (typecheck + lint + Prettier, auto-fix), then `vp run check`
   — the exact command CI's `check-build-test` job runs. They are NOT equivalent:
   `vp check --fix` has passed with 0 errors on a tree `vp run check` failed. Do
   not substitute `vp run lint:fix`, which does not touch Prettier, so a
   `lint:fix`-only run passes locally while CI fails `Formatting issues found`.
   Run both; CI parity comes from the second.

2. `vp run typecheck:test` — type-checks `tsconfig.test.json` (`tests/**`).
   `vp check` only type-checks `tsconfig.json` (src + types), which excludes
   `**/*.test.ts`, and `vp test`'s `Type Errors` line covers only `*.test-d.ts`.
   A wrong `import type` or stale mock shape in a test file is invisible without
   this step.

3. `vp run build`.

   Then regenerate the generated artifacts, unconditionally:
   `vp run gen:all-matrices && vp run audit:coverage:check && vp run format`.
   The suite carries a byte-for-byte guard per generated matrix, and the trigger
   set is wider than any condition you would write — renaming a private provider
   method stales `handled-property-wiring.json`, and a `verify.sh` edit with no
   src change stales `cli-flag-coverage`.

4. `vp test run` — the whole unit suite. Prefer this over `vp run test`: nothing
   sits between the caller and the verdict.

   Read the summary's NUMBERS, not its colour, and read the `Errors` line, which
   is NOT `Type Errors`. `Test Files N passed (N)` is self-consistent over a
   suite that LOST files before they ran, so it cannot report its own shortfall:
   a loaded host produces `[vitest-pool]: Failed to start forks worker` beside an
   otherwise green summary. `vp test run --maxWorkers=4` is the remedy for the
   whole `[vitest-pool]` / `[vitest-pool-runner]` family.

   Also check WHICH PROJECT the summary belongs to — the summary line cannot
   tell you, and a run launched from this worktree has been observed printing a
   sibling project's suite. Assert the root in the same command that produces the
   verdict, and read the suite's own rc, not the trailing grep's:

   ```bash
   # Subshell so the `exit`s are safe to paste into an interactive shell.
   (
     log=$(mktemp)                     # NOT a fixed path: concurrent lanes share /tmp.
     echo "log: $log"                  # print BEFORE the exits, or a failing run is unrecoverable.
     vp test run > "$log" 2>&1; rc=$?
     runs=$(grep -c 'RUN  v' "$log")
     [ "$runs" = 1 ] || { echo "expected 1 RUN header, found $runs -- attests to nothing; log: $log"; exit 1; }
     run_root=$(grep -m1 -oE "RUN  v[0-9.]+ .*" "$log" | sed 's/^RUN  v[0-9.]* //')
     [ "$run_root" = "$(pwd -P)" ] || { echo "WRONG PROJECT ($run_root) -- attests to nothing; log: $log"; exit 1; }
     # The alternatives are chosen against the COLOURED bytes: vitest pads the
     # label inside the dim escape, so `      Tests ` survives colouring and
     # `Tests +[0-9]` does not. Do not tighten either one.
     grep -E "Test Files|      Tests |Type Errors|Errors.*[0-9]+ error" "$log"
     if [ "$rc" != 0 ]; then
       echo "SUITE FAILED rc=$rc; log: $log"
       grep -qE '\[vitest-pool(-runner)?\]: ' "$log" \
         && echo "  the pool lost workers before their files ran, so the passing counts above cover only what survived -- re-run with --maxWorkers=4"
       exit 1
     fi
     # A run that exited 0 can still have COLLECTED fewer files than the tree
     # holds (a stray filter, a narrowed include). Unanchored `(N)`: the
     # coloured summary ends in an escape, not in `)`.
     collected=$(grep 'Test Files' "$log" | grep -oE '\([0-9]+\)' | tail -1 | tr -d '()')
     # `:(glob)` on every pathspec: git's bare `**` demands an intervening `/`
     # while vitest's does not.
     ondisk=$(git ls-files ':(glob)tests/**/*.test.ts' ':(glob)src/**/*.test.ts' \
       ':(glob)tests/**/*.test-d.ts' ':(glob)src/**/*.test-d.ts' | wc -l | tr -d ' ')
     # `-ge`, not `=`: an untracked new test file is collected but not listed.
     [ "${collected:-0}" -ge "$ondisk" ] || { echo "COLLECTED ${collected:-none} of $ondisk tracked test files over a run that exited 0 -- attests to nothing; log: $log"; exit 1; }
   )
   ```

   The wrong-project symptom is contention-dependent, not sticky — re-running
   usually lands right.

## Output

Report as a table:

| Check | Result |
|-------|--------|
| typecheck + lint + format (`vp check --fix`) | pass/fail |
| test-project typecheck (`vp run typecheck:test`) | pass/fail |
| build | pass/fail |
| tests (N files, M tests) (`vp test run`) | pass/fail |

If all pass, confirm "All checks passed." If any fail, show the error output and
STOP — fix the failures and re-run before committing.

These checks attest to the working-tree state at the time of the run, so re-run
after any further edit.

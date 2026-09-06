---
name: check
description: Run local quality checks (typecheck, lint, build, tests). Quick check during development.
---

# Local Quality Check

Run all local quality checks. Use during development to verify the current
state quickly.

## Steps

Run these sequentially and report results:

0. **Worktree pre-flight**: `git fetch -q origin || echo 'FETCH FAILED --
   budget verdicts below are LOCAL-only'` first, then
   `[ -d node_modules ] || pnpm install --frozen-lockfile`. The fetch is
   BEST-EFFORT and must not fail the step (offline, or no `origin`, exits
   128), but its failure is not free either: say so in the report, because
   the cumulative-budget verdict in step 4 then attests to your local ref
   rather than to the merge.

   **The fetch is what makes step 4's CUMULATIVE-BUDGET check mean anything.**
   `rule-file-payload.test.ts` projects this branch's delta onto the LOCAL
   `origin/main` ref (`skill-file-payload.test.ts` does NOT project — it
   measures the working tree, so its per-file caps carry this risk with no
   projection at all). A ref predating a peer's merge projects a merge that
   cannot happen. **A CI run carries the same staleness, because its base is
   frozen when the run STARTS**: measured 2026-09-06, go-to-k/cdkd#2695's run
   started 08:20:59Z, go-to-k/cdkd#2700 merged 08:22:04Z — 65 s later — and
   the run went green at 08:31:43Z having never seen it. Nothing re-ran it,
   and #2695 merged at 08:34:08Z, putting `main` 172 B over the rules-corpus
   ceiling with both PRs' CI green. So a green check attests to the base at
   its START, not at your merge: fetch and re-run before the LAST `/check` of
   a lane, and treat a summed-budget verdict as stale the moment a peer
   merges.

   `git worktree add` does NOT copy `node_modules`, and in a fresh worktree
   `vp check` fails with an UNNAMED `typescript(tsconfig-error): Invalid
   tsconfig — Cannot find type definition file for 'node'`, which reads like a
   broken fixture tsconfig. (`/verify-pr` step 0 has the same pre-flight; this
   copy exists because `/check` is usually the FIRST skill run in a fresh
   worktree.)

1. `vp check --fix` — typecheck + lint + Prettier, with auto-fix. Then
   `vp run check` — the EXACT command CI's `check-build-test` job runs. The
   two are NOT equivalent: `vp check --fix` has passed 0-errors while
   `vp run check` failed with a TS7053 on the same tree (PR #1372). **Use
   this, not `vp run lint:fix`** — `lint:fix` does not touch Prettier, so a
   `lint:fix`-only run passes locally while CI fails `Formatting issues
   found` (PR #363). Run both; CI parity comes from the second.

2. `vp run typecheck:test` — type-checks `tsconfig.test.json` (`tests/**`).
   **`vp check` only type-checks `tsconfig.json` (src + types), which
   excludes `**/*.test.ts`** — a wrong `import type` or stale mock shape in a
   test file passes `vp check` AND `vp test` (whose "Type Errors" line covers
   only `*.test-d.ts`). This step matches how CI fails them (issue #1133).

3. `vp run build`

   **Before step 4, regenerate the generated artifacts — UNCONDITIONALLY,
   offline, seconds**:
   `vp run gen:all-matrices && vp run audit:coverage:check && vp run format`.
   The suite carries a byte-for-byte guard per generated matrix, and the
   trigger set is wider than any condition you would write — renaming a
   PRIVATE provider method stales `handled-property-wiring.json` (issue
   #1417's class); a `verify.sh` edit with no src change stales
   `cli-flag-coverage` (measured 2026-09-03: one private helper, two red
   cases, green after regeneration).

4. `vp test run` — the whole unit suite. **Prefer this over `vp run test`**:
   nothing sits between the caller and the verdict (the cached `vp run test`
   historically replayed without executing and could exit 0 having run
   NOTHING; both gone since `cache: false`, but the direct spelling stays the
   rule). Read the summary line, not just the exit code — a run reporting no
   `Test Files` count did not run.

   **And check WHICH PROJECT the summary belongs to — the summary line cannot
   tell you.** Measured 2026-09-02 with several sessions running suites at
   once: three consecutive `vp test run` invocations from cdkd's worktree
   printed a **cdk-local worktree's** suite (246 files, not cdkd's 856), with
   `pwd` correct throughout. The tells: the `RUN <root>` header far above the
   summary, and a stray `vp run: cdk-local#test` line at the end. **The
   MECHANISM is unconfirmed — do not repeat a guess as fact** (ruled out:
   workspace links, an unpinned `vp`). Acting on the wrong summary sets the
   `check` marker (and through `requires`, `verify-pr`) over a suite that
   never ran — so assert the root in the same command that produces the
   verdict, and read the suite's own rc, not the trailing grep's:

   ```bash
   # Subshell so the `exit`s are safe to paste into an interactive shell.
   (
     log=$(mktemp)                     # NOT a fixed path: concurrent lanes
                                       # share /tmp, and a shared log lets one
                                       # lane read another's summary as its own.
     echo "log: $log"                  # print BEFORE the exits, or a failing
                                       # run's output is unrecoverable.
     vp test run > "$log" 2>&1; rc=$?
     # Exactly ONE header: two projects interleaved would let -m1 bind cdkd's
     # header while the summary grep prints both; zero means it never started.
     runs=$(grep -c 'RUN  v' "$log")
     [ "$runs" = 1 ] || { echo "expected 1 RUN header, found $runs -- attests to nothing; log: $log"; exit 1; }
     run_root=$(grep -m1 -oE "RUN  v[0-9.]+ .*" "$log" | sed 's/^RUN  v[0-9.]* //')
     [ "$run_root" = "$(pwd -P)" ] || { echo "WRONG PROJECT ($run_root) -- attests to nothing; log: $log"; exit 1; }
     grep -E "Test Files|      Tests |Type Errors" "$log"
     [ "$rc" = 0 ] || { echo "SUITE FAILED rc=$rc; log: $log"; exit 1; }
   )
   ```

   It is contention-dependent, not sticky — re-running usually lands right. A
   single-FILE run reported the right project every time in the same window,
   so it can confirm which project you are addressing — **but it does NOT
   substitute for this step**: the marker requires a full-suite run that
   passed AND was rooted here.

## Output

Report as a table:

| Check | Result |
|-------|--------|
| typecheck + lint + format (`vp check --fix`) | pass/fail |
| test-project typecheck (`vp run typecheck:test`) | pass/fail |
| build | pass/fail |
| tests (N files, M tests) (`vp test run`) | pass/fail |

If all pass, confirm "All checks passed." If any fail, show the error output
and STOP — do not write the commit-gate marker.

## Commit-gate marker (on success only)

After all four checks pass, record the marker so the `check-gate` hook allows
the next `git commit`. The marker captures the working-tree state; subsequent
edits invalidate it.

**Merely CREATING a file inside a gate's scope stales that gate** — an
untracked file counts (the digest covers the scope's file SET; measured:
creating `tests/_probe.ts` flipped `markgate verify check` rc 0→1, deleting
it flipped it back; `docs` stayed 0 throughout because `tests/**` is not in
its scope). Correct behaviour, but the symptom is a `check-gate` refusal that
reads as "my markers randomly expired" — **re-run the skill; do not
investigate**. `/verify-pr` re-sets both markers in one shot.

Run from the repo root (`mise exec` because cdkd pins markgate via mise):

```bash
mise exec -- markgate set check
```

Skip this step if any check failed.

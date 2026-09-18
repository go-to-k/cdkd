# Step 1 — read the diff and the touched files' history

Read at step 1. Almost all of this is shell, and the history probe is the one
step-3 signal that cannot be read off `paths`.

**Size no longer selects anything.** The reviewer count is flat (one by
default), so LOC and file count are context for the reviewer prompts, not
inputs to a threshold — do not re-derive a tier from them. What this step is
still for is the `paths` list, which drives every step-3 trigger, and the
history probe.

Orchestrator: [../SKILL.md](../SKILL.md).

1. **Read the PR**:

   ```bash
   gh pr view <N> --json additions,deletions,changedFiles,title,headRefName,files \
     -q '{a: .additions, d: .deletions, fc: .changedFiles, title: .title, branch: .headRefName, paths: [.files[].path]}'
   ```

   `paths` is the load-bearing field. Report `a`/`d`/`fc` in the
   recommendation so a reader knows the diff's size, and remember that
   `docs/_generated/**` and lockfiles inflate it without adding reviewer
   surface (reviewers audit the SCRIPT that produced them, not the output).

   **Then gather each touched `src/` file's recent HISTORY in the same pass**
   — the recent-defect signal in step 3 is the one that cannot be read off
   `paths`, so a step that does not fetch it leaves the signal to be
   remembered rather than evaluated. Measured on go-to-k/cdkd#2612: the loop
   below scores its two `src/` files 2 and 3, and the decision was still made
   from standing memory rather than from a query.

   ```bash
   BASE=$(gh pr view <N> --json baseRefOid -q .baseRefOid)   # NOT plain HEAD --
   # run on the PR branch, an unanchored log counts the PR's OWN fix-back
   # commits and a 2-fix-back PR self-trips the signal.
   git fetch -q origin
   # The `if` is the point, not the `echo`. baseRefOid can be missing locally
   # (shallow clone; a base that exists only on the remote), and then `git log`
   # dies, `|| true` swallows it, and every file prints 0 -- a VOID probe whose
   # output is character-identical to a clean one. Warning BESIDE the loop does
   # not fix that; the loop must not run at all.
   if git rev-parse --verify -q "$BASE^{commit}" >/dev/null; then
     for f in $(gh pr view <N> --json files -q '.files[].path' | grep -E '^src/'); do
       # `|| true` because `grep -c` exits 1 when the count is zero.
       n=$(git log --oneline -3 "$BASE" -- "$f" | grep -cE '^[a-f0-9]+ fix(\(|:)' || true)
       printf '%s\t%s\n' "$f" "$n"
     done   # n >= 2 of the last 3 on a file = evaluate the step-3 signal
   else
     echo "base $BASE is not local -- history probe VOID, not zero"
   fi
   ```

   **That loop is `^src/`-filtered, and for `.claude/**` no prefix count works
   at all — which is where the stakes are highest.** A `feat:` / `fix:` title
   with no `src/**` file is refused (in CI since go-to-k/cdkd#2717), so an
   agent-instruction change lands as `chore:` (or `docs:` / `test:`) and scores
   zero however many times the file has been corrected: measured on SKILL.md,
   whose last five commits carry no `fix:` while the go-to-k/cdkd#2595 run's
   retro was correcting a gap in text go-to-k/cdkd#2596 had added to it one run
   earlier. A nonzero is no better, because a commit staging `src/**` AND a
   `.claude/**` file may carry `fix:` and score the instruction file for a
   defect that was never in it (`git log --oneline -5 origin/main --
   .claude/rules/testing.md` returns go-to-k/cdkd#2450, a `fix(state):`).

   So for a `.claude/**` path, read the SUBJECTS rather than a count
   (`git log --oneline -5 "$BASE" -- "$f"`) and treat consecutive retro /
   correction commits on the same file as the recency signal.

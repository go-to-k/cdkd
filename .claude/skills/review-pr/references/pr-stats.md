# Step 1 — read the diff and the touched files' history

Read at step 1. Orchestrator: [../SKILL.md](../SKILL.md).

**Only the `src/**` size selects anything** (the step-3 size trigger: 3-axis
above 400 lines or 8 files). Whole-diff LOC and file count are context for the
reviewer prompts. What this step is also for is the `paths` list, which drives
the other step-3 triggers, and the history probe.

```bash
gh pr view <N> --json additions,deletions,changedFiles,title,headRefName,files \
  -q '{a: .additions, d: .deletions, fc: .changedFiles, title: .title, branch: .headRefName, paths: [.files[].path]}'
gh pr view <N> --json files \
  -q '[.files[] | select(.path | startswith("src/"))] | {src_fc: length, src_loc: (map(.additions + .deletions) | add // 0)}'
```

`paths` is the load-bearing field. Report `a`/`d`/`fc` and `src_loc`/`src_fc`
so a reader knows the diff's size, and remember that `docs/_generated/**` and
lockfiles inflate the whole-diff numbers without adding reviewer surface
(reviewers audit the SCRIPT that produced them, not the output).

**Then gather each touched `src/` file's recent HISTORY in the same pass** — the
recent-defect signal in step 3 is the one that cannot be read off `paths`, so a
step that does not fetch it leaves the signal to be remembered rather than
evaluated.

```bash
BASE=$(gh pr view <N> --json baseRefOid -q .baseRefOid)   # NOT plain HEAD --
# run on the PR branch, an unanchored log counts the PR's OWN fix-back
# commits and a 2-fix-back PR self-trips the signal.
git fetch -q origin
# The `if` is the point, not the `echo`. baseRefOid can be missing locally
# (shallow clone; a base that exists only on the remote), and then `git log`
# dies, `|| true` swallows it, and every file prints 0 -- a VOID probe whose
# output is character-identical to a clean one.
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

**That loop is `^src/`-filtered, and for `.claude/**` no prefix count works at
all — which is where the stakes are highest.** A `feat:` / `fix:` title with no
`src/**` file is refused in CI, so an agent-instruction change lands as `chore:`
and scores zero however many times the file has been corrected; and a commit
staging `src/**` alongside a `.claude/**` file may carry `fix:` and score the
instruction file for a defect that was never in it. So for a `.claude/**` path,
read the SUBJECTS rather than a count (`git log --oneline -5 "$BASE" -- "$f"`)
and treat consecutive retro / correction commits on the same file as the recency
signal.

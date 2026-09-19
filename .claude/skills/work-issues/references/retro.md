<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

After the last §9 lane is merged and every worktree THIS RUN added is removed,
BEFORE the wrap report. Scope is the WHOLE run; APPLY the fix.

### 10-0. Measure the run's net effect on the backlog

**Take the closed and filed sets from the RUN's own record — its posted claims
and lane reports — never from a date or wording scan**: concurrent sessions
file into the same window in the same vocabulary. Then run the PROMOTION check
on every `next` this run filed:

```bash
git diff --name-only "<sha main was at at run start>..origin/main" | sort -u > /tmp/t.$$
# Does a still-open `next`'s body name a file this run touched? BASENAMES too;
# escape `.`, or `x.test.ts` also matches `x-test.ts`.
gh issue view <n> --json body -q .body \
  | grep -oE '\.?[A-Za-z0-9_][A-Za-z0-9_./-]*\.[a-z]+' | sort -u \
  | while read -r f; do e=$(printf '%s' "$f" | sed 's/[][\\.*^$+?(){}|/]/\\&/g')
      grep -E "(^|/)$e\$" /tmp/t.$$; done
```

The diff is a LOWER bound: a `next` is `now` if ANY file its fix touches or
must read was read this run. Empty output is not "nothing to promote" — bodies
name subjects by SYMBOL as often as by path. A hit prompts judgement, not a
verdict. Then split the filed count by what §5-f did with each:

```bash
# Folded INTO an existing issue rather than filed as new. `updatedAt` alone
# cannot answer this — §4's claim comments touch every taken issue — so count
# the issues whose BODY gained a checklist row.
# The label exclusions matter MORE here than in triage: this counts issues whose
# body gained a `- [ ]` row, and a coverage-map sync rewrites the umbrella's
# generated block with a body region that is nothing but such rows — up to 44 of
# them in one edit. `backfill-umbrella` is the one that fires today; the legacy
# `backfill-type` slices carried the same hazard one issue each, and a reopened
# one still would. Without both, a run that touched neither reports dozens of
# findings folded.
gh issue list --state open --limit 200 --json number,title,updatedAt,labels \
  --jq '.[] | select(.updatedAt > "<this run start ISO>")
        | select([.labels[].name] | index("backfill-type") | not)
        | select([.labels[].name] | index("backfill-umbrella") | not) | .number' \
| while read -r n; do
    gh issue view "$n" --json body -q '.body' \
      | grep -qE '^[[:space:]]*- \[ \]' && echo "$n"
  done
```

Report `closed N / filed M (new K / folded J)`; when weighing whether to file a
finding, file it.

### 10-a. Evidence: only what this run actually produced

Collect, each with its instance: user corrections (two on one theme is a defect
in this text); text WRONG as written; steps you had to invent; right
instruction, wrong place. Which shape RECURRED is a COUNT. No evidence, no edit.

### 10-b. Where the fix belongs — pick ONE

- **A row in `docs/tooling-backlog.md`** — the DEFAULT for tooling (hook, rule,
  skill, CI fence, integ harness), and where an already-stated rule violated
  anyway goes on its FIRST occurrence.
- **A hook, or a `tests/unit/**` test for a committed file** — only on the
  SECOND occurrence, only when mechanically detectable, BLOCKING only under
  `.claude/rules/hooks.md`'s third-party-harm rule.
- Otherwise the stage file where the lesson fires (never SKILL.md unless the
  stage list changed), `CLAUDE.md` / `.claude/rules/**`, or Memory.


### 10-c. How to edit: amend, do not append

- Put the fix in the step where it fires (gotchas is for traps spanning steps),
  amending the wrong sentence rather than adding a sibling, evidence as ONE
  line, paid for by cutting a stale one.
- A FLOW lesson is mirrored into the same-named `work-issues` skill in
  `../cdk-local` and `../cdk-real-drift`, one `chore:` PR per repo batching the
  run's lessons; the session that FINDS it lands all three.

  **Resolve it against the target repo's CURRENT state — merged FILE, then open
  PRs, then open issues — and file only what none of the three carries**,
  commenting instead on a hit. Match the CONCEPT, judge a PR by BODY and DIFF:

  ```bash
  T=/Users/goto/github/<target>; git -C "$T" fetch -q origin   # stale clone lies
  git -C "$T" grep -n -i -e '<concept-keyword>' origin/main -- .claude/skills/work-issues/
  gh -R go-to-k/<target> pr list --state open --search '<keyword>' --json number,title
  gh -R go-to-k/<target> issue list --state open --search '<keyword>' --json number,title
  ```

### 10-d. Ship it like any other change

Back on `main` after §9, `main-tree-edit-gate` blocks editing a tracked file,
so the retro gets a worktree. MAIN-CHECKOUT (SKILL.md "Launch mode") runs:

```bash
# UTC MINUTE, not day: post-merge-orphan-push-gate refuses a merged name.
B=chore/work-issues-retro-$(date -u +%Y%m%d-%H%M)
git worktree add ".claude/worktrees/${B##*/}" -b "$B" origin/main
cd ".claude/worktrees/${B##*/}" && mise trust && mise install && pnpm install
```

IN-PLACE runs THIS block INSTEAD, never both — `git worktree add` here NESTS a
worktree:

```bash
B=chore/work-issues-retro-$(date -u +%Y%m%d-%H%M)
git fetch origin && git switch -c "$B" origin/main
```

- `chore:` prefix — CI refuses a `fix:` / `feat:` PR TITLE with no `src/**`
  change (go-to-k/cdkd#2717). Run `/check`, `/check-docs`, `/verify-pr` and
  `/review-pr`'s reviewer set, unenforced though they now are; a
  `.claude/hooks/**` change runs `bash .claude/hooks/run-tests.sh`, read by
  TALLY rather than rc.
- **Merge it before the wrap report, then remove the worktree**
  (`git worktree remove .claude/worktrees/<name> && git worktree prune`). An
  IN-PLACE run added none and runs §9's cleanup arm HERE instead, last of the
  whole run: `git switch --no-guess <LAUNCH_BRANCH> && git branch -D` every
  branch this run created, the retro included, AS-IS — no pull, no rebase.

Report it in one wrap line: what changed where, or "no skill change".

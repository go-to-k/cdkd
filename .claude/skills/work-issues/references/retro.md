<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

Trigger: after the last §9 lane is merged and every worktree THIS RUN added is
removed (an IN-PLACE run added none, so for it the trigger is the last merge),
BEFORE the wrap report. Not optional — the evidence exists only in this
session. `/verify-pr` step 10 ran a retrospective per LANE; this step differs:
subject is **the flow itself** (this skill's docs and the skills it drives);
scope is the WHOLE run (cross-lane patterns are invisible from inside one
lane); and it **applies** the fix instead of proposing it — a routine call
(`AskUserQuestion` only when the edit changes what the flow PROMISES: dropping
a gate, lowering a verification tier, loosening §0).

### 10-0. Measure the run's net effect on the backlog

Count what the run did to the issue list, for the wrap report:

```bash
# closed BY this run (the lanes you merged, plus anything a sweep folded in)
gh issue list --state closed --limit 100 --json number,closedAt,title \
  --jq '.[] | select(.closedAt > "<this run start ISO>") | "\(.number)\t\(.title)"'
# filed BY this run
gh issue list --state all --limit 100 --json number,createdAt,title \
  --jq '.[] | select(.createdAt > "<this run start ISO>") | "\(.number)\t\(.title)"'
```

**Then run the PROMOTION check on every `next` this run filed** — a deferral is
judged against the run that has now happened, and nobody re-opens a decision
they remember making deliberately, so make it a QUERY:

```bash
# For each issue this run filed and left OPEN with `Session-fit: next`: does
# the run's OWN merged diff touch a file the body names?
RANGE="<the sha main was at when this run started>..origin/main"
git diff --name-only "$RANGE" | sort -u > /tmp/run-touched.$$
for n in <the numbers this run filed that are still open>; do
  b=$(gh issue view "$n" --json body -q .body)
  printf '%s' "$b" | grep -q 'Session-fit: *next' || continue
  printf '%s' "$b" \
    | grep -oE '\.?[A-Za-z0-9_][A-Za-z0-9_./-]*\.[a-z]+' | sort -u \
    | while read -r f; do
        # Suffix match, not equality: bodies name files by BASENAME far more
        # often than by full path.
        grep -E "(^|/)$(printf '%s' "$f" | sed 's/[.[\*^$]/\\&/g')\$" \
          /tmp/run-touched.$$ | while read -r hit; do
            echo "PROMOTE #$n -- this run touched $hit"
          done
      done
done | sort -u
rm -f /tmp/run-touched.$$
```

- **An EMPTY result is not "nothing to promote" — check the extraction saw a
  FILE at all.** A body names its subject by SYMBOL as often as by path
  (go-to-k/cdkd#2442), and a DOTFILE needs the `\.?` prefix above
  (go-to-k/cdkd#2455); both reported nothing while the criterion fired. Print
  what the extraction found; resolve by hand (`git grep -l '<the symbol>'`)
  whenever no token is path-shaped or the diff is mostly dotfiles.
- **A hit is a prompt for judgement, not a verdict** — it cannot tell a
  citation from a target, and the output does not help: go-to-k/cdkd#2621
  cites a SIBLING fixture this run touched, by FULL path, and a retro shipped
  that hit as a sourced incident. Open the body and read the SENTENCE around
  the token before believing any hit (printing it automatically is
  go-to-k/cdkd#2655, withdrawn from this recipe with two measured defects).
  Do the item, or re-classify it in the issue with the reason the criterion no
  longer applies. When the run's own
  PRs ARE the follow-ups' subject — one lane, or several sharing a subsystem — expect
  EVERY one to hit, and read the issue's REASON instead (go-to-k/cdkd#2514 10
  of 10; go-to-k/cdkd#2558's two lanes; all but three across
  go-to-k/cdkd#2554's five) — a run-wide hit rate is a property of the run's
  SHAPE, not of the deferrals.
- **Re-read the REASON, not just the files — and when a hit CONTRADICTS it,
  the BODY is the stale side.** A reason anchored to the filing session's own
  state goes false while the decision it justified still stands.
  `.claude/rules/session-report.md` → Session-fit carries the shape, its
  boundary against the PR-shaped reason that is refused outright rather than
  merely expiring, and the incident. Correct the issue when this catches one —
  and when LANES REMAIN, route a hit whose file a later lane will open into
  that lane's brief instead of noting it (go-to-k/cdkd#2604: a mid-run retro
  logged the cleared blocker as "not that run's lane"; the next lane opened
  that file anyway, and a third retro paid for what was twice free).

Then split the filed count by what the §5-f window did with each finding:

```bash
# Folded INTO an existing issue rather than filed as new. `updatedAt` alone
# cannot answer this — §4's claim comments touch every taken issue — so count
# the issues whose BODY gained a checklist row.
gh issue list --state open --limit 200 --json number,title,updatedAt \
  --jq '.[] | select(.updatedAt > "<this run start ISO>") | .number' \
| while read -r n; do
    gh issue view "$n" --json body -q '.body' \
      | grep -qE '^[[:space:]]*- \[ \]' && echo "$n"
  done
```

Report one line — `closed N / filed M (new K / folded J)` — and when M > N,
give the reason in one more line. `J = 0` over several findings in one area
means the §5-f window was searched by this instance's spelling, not the
concept. Three usual reasons; only the first is healthy: the code really has
that many independent defects (say which area, so the next `/hunt-bugs` aims
there); one root cause split into many issues (fold what is still open into an
umbrella NOW); discoveries deferred that had session-only evidence (the next
session re-derives the repro). **M ≤ N is NOT a target** — an unfiled finding
removes the defect from the record while leaving it in the product. If you
find yourself weighing whether to file, file.

### 10-a. Evidence: only what this run actually produced

Walk the session and collect, with the concrete instance attached: (1)
corrections the user made — two on one theme is a defect in this text, not a
preference; (2) text that was WRONG as written — a command that failed, a
probe that reported clear while a lane was live, a stale flag/path/gate name;
(3) steps you had to invent because the skill is silent; (4) right
instruction, wrong place — done, but a step too late; (5) followed it and
still paid — obeyed text, retry anyway.

**No evidence, no edit.** A clean run's correct output is one wrap line
("retrospective: no skill change — §2 / §4 / §8 held"). A skill grown from
"this would be nice" stops being read to the bottom.

### 10-b. Where the fix belongs — pick ONE

- **A hook** (`.claude/hooks/`) — or a test under `tests/unit/**` when the
  subject is a committed file — whenever the failure is mechanically
  detectable. Strongest, and the RIGHT answer whenever the rule was ALREADY in
  the text and got violated anyway: that proves the sentence is not
  load-bearing, and another sentence will not make it so. Escalate rather than
  restate.
- **This skill's stage files** when the lesson is about running THIS flow. The
  edit target is the `references/<stage>.md` where the lesson fires — never
  the SKILL.md orchestrator, unless the stage list itself changed; its own
  byte cap is 10-c's, and for the same reason.
- **Another skill**, but only one this run actually exercised. ALL skills sit
  in the `check` gate's scope (`.claude/skills/**` since go-to-k/cdkd#2364),
  so editing any one invalidates the `check` marker.
- **`CLAUDE.md` / `.claude/rules/**`** when it applies to any work in this
  repo, not just this flow (both in the `docs` gate's scope and in `check` —
  read by the unit suite as INPUT).
- **Memory** when the lesson is judgmental and cross-repo. Weakest enforcement
  — the landing spot when nothing above can hold the rule, not the default.

### 10-c. How to edit: amend, do not append

Every run appending one more bullet is exactly how a long skill becomes an
unread one.

- Put the fix **in the step where it fires**; gotchas is for traps that span
  steps, not a run log.
- **Amend the sentence that was wrong** rather than adding a sibling — two
  near-duplicate bullets blunt each other.
- **Carry the evidence inline** (date, issue/PR number, what happened) — but
  as ONE line: the rule plus a citation, not the narrative. A rule with no
  incident behind it cannot be re-judged or retired; a rule buried in its own
  incident report is not read.
- **Pay for what you add**: cut a line this run proved stale, subsumed, or
  wrong. **A retro NEVER buys room by raising a byte cap or a corpus
  bound** — the caps in `tests/unit/scripts/skill-file-payload.test.ts` are
  the mechanical stop on this skill's growth loop, and a retro that raises one
  converts the stop into a ratchet (the 2026-09-02 retro raised the corpus
  floor to fit its additions; the 2026-09-04 pass reversed it and re-derived
  every bound DOWNWARD). A lesson compression cannot pay for splits the stage
  instead; the floor moves DOWN only.
- Do not restate a rule living in `CLAUDE.md` or another step — point at it.
  `CLAUDE.md` is injected into every context, so a stage-file paragraph
  re-explaining a gate it documents is paid for twice in every lane.
- A FLOW lesson (vs a cdkd one) gets mirrored into the same-named
  `work-issues` skill in `../cdk-local` and `../cdk-real-drift` — wording
  adapted per repo, one `chore:` PR per repo under that repo's own flow.
  Without the rules below this bullet is a duplicate GENERATOR (thirteen open
  issues across the repos were one change; go-to-k/cdkd#2011 and
  go-to-k/cdkd#2016 were three lessons filed twice, twenty minutes apart):
  - **The session that FINDS the lesson lands all three** — the default; the
    narrow exception (cannot pay the remaining gate cycles) is justified in
    the wrap. Land the mirror BEFORE the original's review rounds finish: the
    mirror's own reviewers read the same design with none of the original's
    momentum (measured 2026-09-02: the cdk-local port's reviewers found two
    defects in code cdkd had already merged past a three-axis panel, and
    cdkd's found one the port had inherited — the mirror is a second review
    pass that happens to also be the deliverable — and it reviews the SOURCE
    too: re-deriving each claim against the target's gates re-opens the
    original's, returning two defects in cdkd's own hooks on 2026-09-05,
    go-to-k/cdkd#2630 / go-to-k/cdkd#2638).
  - **Filing a mirror issue covers the WHOLE remainder, in one turn** — file
    into every repo still missing it at once, each issue naming the others.
  - **A lane WORKING a mirror issue does not mirror onward** — the
    originating session owns all three landings; only lessons from the
    adaptation itself are new findings.
  - **Batch a run's lessons into ONE PR per repo**, not per lesson — the gate
    cycle is the per-PR cost.

  **Before filing into a target repo, resolve the lesson against that repo's
  CURRENT state — merged FILE, then open PRs, then open issues — and file only
  what none of the three already carries.** A lesson MOVES between the windows
  while worked. Per hit: in the file — do not file; open PR — comment on the
  PR; open issue — comment with what this hop adds. Match on the CONCEPT, not
  a phrase (each hop rewords per repo), and judge a candidate PR by its BODY
  and DIFF, never its title:

  ```bash
  T=/Users/goto/github/<target>
  git -C "$T" fetch -q origin   # a stale clone false-negatives the one window
                                # no later check can recover
  git -C "$T" grep -n -i -e '<concept-keyword-1>' -e '<concept-keyword-2>' \
    origin/main -- .claude/skills/work-issues/
  gh -R go-to-k/<target> pr list --state open --search '<keyword>' --json number,title
  gh -R go-to-k/<target> pr view <hit> --json body -q .body
  gh -R go-to-k/<target> pr diff <hit>
  gh -R go-to-k/<target> issue list --state open --search '<keyword>' --json number,title
  ```

  (No single window suffices: three issues for two lessons in 70 minutes, the
  lesson in a DIFFERENT window at each look — go-to-k/cdkd#1973 /
  go-to-k/cdkd#1980 / go-to-k/cdkd#1986.)

  **Verify the copy against the TARGET repo, claim by claim, before shipping —
  and every briefed lesson against the SOURCE run's own diff.** Gates/hooks/ship
  steps differ, so a sentence true here is false there; and a brief written from
  memory names lessons the run never produced (2026-09-05: one was in no commit
  of the source PR). "Not applicable here" is a legitimate per-lesson outcome
  when MEASURED — two of the lessons briefed to cdk-real-drift were ruled out
  that way: it has no `/review-pr` skill and no sentinel-bound live gate.
  Dispatch a read-only reviewer per target repo to check each gate name, hook
  behavior, skill name, path and cross-reference against that repo's own files
  (caught four false claims on the first mirror). Here rather than in memory,
  which is per-project-path and would not load in the targets.
  **Read the BODY of every incident the copy cites** — a resolving number
  makes a wrong mechanism claim look sourced; name the mechanism the issue
  actually describes or drop it. **Fully qualify every issue/PR reference**
  (`go-to-k/<repo>#N`) — this file is the mirror SOURCE and a bare `#N`
  renders against whichever repo reads it; enforced per repo by a test
  (cdkd's: `tests/unit/scripts/work-issues-skill-refs.test.ts`).

### 10-d. Ship it like any other change

Every worktree THIS run added is gone by §9 and you are back on `main`, where
`main-tree-edit-gate` blocks editing a tracked file — so the retro gets its
own worktree:

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
# Suffix the branch to UTC MINUTE, not day: post-merge-orphan-push-gate
# refuses a merged branch's name, and a date-suffixed one has already
# collided with a PR merged the same morning.
B=chore/work-issues-retro-$(date -u +%Y%m%d-%H%M)
git worktree add ".claude/worktrees/${B##*/}" -b "$B" origin/main
cd ".claude/worktrees/${B##*/}"
mise trust && mise install    # see section 5 -- same trap, same one-line fix
pnpm install                  # worktrees have no node_modules
```

IN-PLACE — run THIS block INSTEAD of the one above, never both: there is no
worktree to add, and `git worktree add` from inside this tree NESTS the very
worktree this mode exists to prevent. The lane's tree is still here with its
deps installed, and you are not on `main`, so take the retro branch in it
(`B` re-assigned — a separate fenced block is a separate shell; the merged
lane branch cannot be reused):

```bash
B=chore/work-issues-retro-$(date -u +%Y%m%d-%H%M)
git fetch origin && git switch -c "$B" origin/main
```

- `chore:` prefix — `.claude/**` is not `src/**`; `commit-prefix-scope-gate`
  blocks `fix:` / `feat:` here.
- English only in every committed line.
- Scope does not exempt you from the markers (CLAUDE.md, "Before every
  commit") — a fresh worktree starts with none, and `/verify-pr` sets all
  three in one pass; run it before the commit. A
  tooling-only PR gets §8's live-test exemption — the prose arm for a
  SKILL.md / rule edit, the command arm as soon as it lands in
  `.claude/hooks/**`. **There, run the WHOLE harness — `bash
  .claude/hooks/run-tests.sh`, not just your own hook's suite — and read the
  TALLY, not the rc**: a hooks edit re-triggers the path-filtered `hooks.yml`,
  so a fence a PEER left inert surfaces as YOUR red CI (2026-08-29: a
  settings-only PR had broken a `main` suite sitting outside that path filter).
- Agent-instruction files are deliberately NOT down-biased in `/review-pr`'s
  tier heuristic — a wrong rule here propagates into every future session —
  so take the tier the heuristic gives and do not argue it down.
- **Merge it before the wrap report, then remove the worktree**
  (`git worktree remove .claude/worktrees/<name> && git worktree prune` —
  §9's closing check is "every worktree THIS run added is gone", and §10 must
  not undo that). An IN-PLACE run added none, so instead this is where it runs
  §9's IN-PLACE cleanup arm — **the LAST step of the whole run**: `git switch
  --no-guess <LAUNCH_BRANCH> && git branch -D` every branch this run created,
  the retro branch included. AS-IS: no pull, no rebase, no fast-forward — the
  branch is the outer tool's artifact. CHAINED, because an unchained delete
  after a failed switch still removes every branch that is not checked out;
  and `--no-guess` because a plain `switch` would re-create the branch from
  `origin` instead of failing through to the fallback. §9 deliberately does
  NOT do it per-lane, because THIS section branches in the same tree and would
  undo it. Restoring what the outer tool created is the quiet end state — it
  silences the unmerged-lane Stop hook without the surprise of a detached HEAD
  in that tool's UI. All of it is `Session-fit: now`: the evidence dies with
  the session, and an open PR is NOT CLOSEABLE.

Then report the outcome in one line of the wrap: what changed, in which step,
and the run evidence behind it — or "no skill change" plus what held.

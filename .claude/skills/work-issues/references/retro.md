<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

Trigger: after the last §9 lane is merged and every worktree THIS RUN added is
removed — an IN-PLACE run added none, so for it the trigger is the last merge —
BEFORE the wrap report. Not optional — the evidence (what you had to re-read, which
correction the user made twice) exists only in this session.

`/verify-pr` step 10 ran a retrospective per LANE; this step differs:

- subject: **the flow itself** — this skill's docs (SKILL.md + references/) and
  the skills it drives, not the code the lane changed;
- scope: the WHOLE run — cross-lane patterns (the same correction on two lanes)
  are invisible from inside one lane;
- it **applies** the fix instead of proposing it — a routine call (`CLAUDE.md`
  → "Decide routine calls yourself"); `AskUserQuestion` only when the edit
  changes what the flow PROMISES (dropping a gate, lowering a verification
  tier, loosening §0), never for wording, ordering, or a new trap.

### 10-0. Measure the run's net effect on the backlog

First, count what the run did to the issue list, for the wrap report:

```bash
# closed BY this run (the lanes you merged, plus anything a sweep folded in)
gh issue list --state closed --limit 100 --json number,closedAt,title \
  --jq '.[] | select(.closedAt > "<this run start ISO>") | "\(.number)\t\(.title)"'
# filed BY this run
gh issue list --state all --limit 100 --json number,createdAt,title \
  --jq '.[] | select(.createdAt > "<this run start ISO>") | "\(.number)\t\(.title)"'
```

**Then run the PROMOTION check on every `next` this run filed: a deferral is
judged against the run that has now happened, not the run predicted when it was
written.** `CLAUDE.md`'s promote-when-touched rule and the "AND none of the
`now` criteria fire" conjunct both get skipped — nobody re-opens a decision
they remember making deliberately — so make it a QUERY:

```bash
# For each issue this run filed, does the run's OWN merged diff touch a file
# that issue names? A hit means the reverse move in CLAUDE.md fires.
RANGE="<the sha main was at when this run started>..origin/main"
git diff --name-only "$RANGE" | sort -u > /tmp/run-touched.$$
# The population is the issues this run FILED and left OPEN -- not the folded
# list above, and not the ones it filed and then fixed in the same lane, which
# section 3-a makes routine.
for n in <the numbers this run filed that are still open>; do
  b=$(gh issue view "$n" --json body -q .body)
  # The prose says every `next`; without this the loop also reports items
  # already classified `now`, which are not deferrals at all. `Session-fit`
  # carries no GitHub label, so it has to be grepped out of the body.
  printf '%s' "$b" | grep -q 'Session-fit: *next' || continue
  printf '%s' "$b" \
    | grep -oE '[A-Za-z0-9_][A-Za-z0-9_./-]*\.[a-z]+' | sort -u \
    | while read -r f; do
        # Suffix match, not equality: an issue body names a file by BASENAME far
        # more often than by full path (`destroy-runner.ts`, not
        # `src/cli/commands/destroy-runner.ts`), and an exact-line compare misses
        # every one of those. Measured: the exact form fired on 1 of this run's 2
        # deferrals and missed the one whose body used the basename.
        grep -E "(^|/)$(printf '%s' "$f" | sed 's/[.[\*^$]/\\&/g')\$" \
          /tmp/run-touched.$$ | while read -r hit; do
            echo "PROMOTE #$n -- this run touched $hit"
          done
      done
done
rm -f /tmp/run-touched.$$
```

Pipe the whole loop through `sort -u` — a body naming the same file twice
otherwise prints two findings.

**An EMPTY result is not "nothing to promote" — check that the extraction saw a
FILE at all.** A body names its subject by SYMBOL at least as often as by path,
and the regex then yields a plausible-looking non-file that suffix-matches
nothing, so the loop prints no candidates rather than admitting it could not see
the subject — the same VOID-versus-result confusion `references/implement.md`
fences for mutation probes. Measured 2026-09-02: go-to-k/cdkd#2442's subject is
`EFSProvider.createOrAdoptAccessPoint`, the extraction stopped at the capital
and produced `EFSProvider.create` (plus `i.e`), and the run's merged diff DID
touch `src/provisioning/providers/efs-provider.ts` — the criterion fired while
the loop reported nothing. **A DOTFILE path is invisible the same way, and in
this repo that is most of the tooling surface.** The extraction's first
character class is `[A-Za-z0-9_]`, which cannot start on `.`, so
`.claude/hooks/x.test.sh` in a body yields `claude/hooks/x.test.sh`; the match
is then anchored `(^|/)`, and the character before `claude` in the diff line is
`.` rather than `/` or start-of-line. Measured 2026-09-02 on this section's own
run: go-to-k/cdkd#2455 named a file the retro PR ADDED and the loop reported
nothing. Print what the extraction found, and resolve by hand whenever no token
is path-shaped OR the diff is mostly dotfiles:

```bash
# Self-contained: a separate fenced block is a separate shell (section 10-d
# spells the same trap out for `B`), so `$b` from the loop above is empty here.
gh issue view <n> --json body -q .body \
  | grep -oE '\.?[A-Za-z0-9_][A-Za-z0-9_./-]*\.[a-z]+' | sort -u   # leading dot KEPT
git grep -l '<the symbol the body names>' -- src tests   # when none is a path
```

The `\.?` is the one-character fix for the dotfile half; the symbol half has no
regex fix, which is why the instruction above is to LOOK rather than to trust an
empty result.

**A hit is a prompt for judgement, not a verdict** — the check cannot tell a
citation from a target (measured: one deferral hit its fix's single file, the
other hit FOUR, three cited as precedent). Do not skim past a hit: do the item,
or re-classify it in the issue with the reason the criterion no longer applies.

**And re-read the REASON, not just the files — a deferral reason can name a
state that has since resolved.** Classify-once freezes the DECISION, not the
PREMISE: "the PR carrying it is still open" / "that lane is mid-flight" go
FALSE when the state resolves (2026-08-26: a fifth-review-round deferral reason
survived into the wrap after that PR merged). Keeping a `next` alive on an
expired reason is not protected by classify-once.

**When a hit CONTRADICTS the body's own reason, the BODY is the stale side, not
the check.** A reason asserting NO FILE OVERLAP is a claim about a MOVING
target — the lane keeps editing after the reason is written, and nothing
re-reads it. Measured 2026-09-02: go-to-k/cdkd#2440 was deferred on
"`src/local/docker-runner.ts` has no overlap with this session's lanes
(go-to-k/cdkd#2410 changed no line of it)", and go-to-k/cdkd#2410's merged PR
changed that file `+9/-2`. So prefer a reason the lane cannot falsify by
carrying on (what the work NEEDS: a new fixture, an upstream release, a
maintainer call), correct the issue when this check catches one, and judge the
item on whatever survives.

Then split the filed count by what the section 5 window did with each finding —
the aggregate cannot tell the two apart and they mean opposite things:

```bash
# Folded INTO an existing issue rather than filed as a new one. `updatedAt`
# alone does NOT answer this: §4 makes every lane post a CLAIM comment on the
# issue it takes, so a bare updatedAt sweep counts this run's own claims and
# can never read 0. Count the issues whose BODY gained a checklist row instead.
gh issue list --state open --limit 200 --json number,title,updatedAt \
  --jq '.[] | select(.updatedAt > "<this run start ISO>") | .number' \
| while read -r n; do
    gh issue view "$n" --json body -q '.body' \
      | grep -qE '^[[:space:]]*- \[ \]' && echo "$n"
  done
```

Report one line — `closed N / filed M (new K / folded J)` — and **when M > N,
give the reason in one more line**. `J = 0` over several findings in one area
means the §5-f window was searched by this instance's spelling, not the concept.
Three usual reasons; only the first is healthy:

- **the code really does have that many independent defects** — an untested
  area; say which, so the next `/hunt-bugs` aims there.
- **one root cause was split into many issues** — §5-f's sweep rule should have
  folded them; fold what is still open into an umbrella now, not next time.
- **discoveries were deferred that had session-only evidence** — per
  `CLAUDE.md`'s `now` criteria not a residual; deferring means the next session
  re-derives the repro.

**M ≤ N is NOT a target, and must never become one.** An unfiled finding is
strictly worse than a filed one — it removes the defect from the record while
leaving it in the product. The count makes growth VISIBLE — never a reason to
not file, soften a finding, or merge two independent defects into one vague
issue. If you find yourself weighing whether to file, file.

### 10-a. Evidence: only what this run actually produced

Walk the session and collect, with the concrete instance attached to each:

1. **Corrections the user made.** Two on one theme — different lanes, different
   wording — is a defect in this text, not a preference; the second occurrence
   is the signal.
2. **Text that was WRONG as written**: a command that failed, a probe that
   reported a clear field while a lane was live, a flag / path / gate name that
   no longer exists.
3. **Steps you had to invent** because the skill is silent, and the next run
   would have to invent again.
4. **Right instruction, wrong place** — done, but a step too late (the claim
   posted after the triage, the rebase discovered after the phantom diff).
5. **Followed it and still paid** — the text was obeyed and a retry happened anyway.

**No evidence, no edit.** A clean run's correct output is one wrap line
("retrospective: no skill change — §2 / §4 / §8 held"). A skill grown from
"this would be nice" stops being read to the bottom — where §9 and §10 live.

### 10-b. Where the fix belongs — pick ONE

- **A hook** (`.claude/hooks/`) — or a test under `tests/unit/**` when the
  subject is a committed file rather than a command — whenever the failure is
  mechanically detectable. Strongest, and the RIGHT answer whenever the rule
  was ALREADY in the text and got violated anyway: that proves the sentence is
  not load-bearing, and another sentence will not make it so. Escalate rather
  than restate. A hook fires on the action, a test in CI; pick by what the rule
  is about.
- **This skill's stage files** when the lesson is about running THIS flow
  (triage, claiming, fan-out, ship order). The edit target is the
  `references/<stage>.md` where the lesson fires — never the SKILL.md
  orchestrator, unless the stage list itself changed. SKILL.md's byte size is
  capped by `tests/unit/scripts/skill-file-payload.test.ts`, the mechanical
  stop on the growth loop that produced the 231 KB single-file predecessor.
- **Another skill**, but only one this run actually exercised (`/run-integ`,
  `/verify-pr`, `/review-pr`, `/pick-integ`, `/check`, `/check-docs`,
  `/cleanup`). ALL of them sit in the `check` gate's scope — its include names
  `.claude/skills/**` since go-to-k/cdkd#2364, not an enumeration of four — so
  editing any one invalidates the `check` marker and forces a `/check` re-run.
- **`CLAUDE.md` / `.claude/rules/**`** when it applies to any work in this repo,
  not just this flow (both in the `docs` gate's scope, alongside `src/**`,
  `docs/**` and `README.md` — and both in `check` as well, as are those three:
  every one of them is read by the unit suite as INPUT).
- **Memory** (`~/.claude/projects/.../memory/`) when the lesson is judgmental
  and cross-repo. Weakest enforcement — the landing spot when nothing above can
  hold the rule, not the default one.

### 10-c. How to edit: amend, do not append

Every run appending one more bullet is exactly how a long skill becomes an unread one.

- Put the fix **in the step where it fires** — a claiming lesson belongs in §4,
  not a tail section; gotchas is for traps that span steps, not a run log.
- **Amend the sentence that was wrong** rather than adding a sibling — two
  near-duplicate bullets blunt each other.
- **Carry the evidence inline** (date, issue / PR number, what happened) — a
  rule with no incident behind it cannot be re-judged or retired.
- **Pay for what you add**: cut a line this run proved stale, subsumed, or
  wrong. Net growth is fine for a new lesson; unbounded growth is not.
- Do not restate a rule living in `CLAUDE.md` or another step — point at it.
- A FLOW lesson (vs a cdkd one) gets mirrored into the same-named `work-issues`
  skill in `../cdk-local` and `../cdk-real-drift` — wording adapted per repo
  (their gates and ship steps differ), one PR per repo under that repo's own
  worktree + `chore:` + gate flow. Landing it in one repo only is how the three
  drift apart; without the four rules below this bullet is a duplicate
  GENERATOR (2026-08-19: thirteen open issues across the repos were one change,
  and go-to-k/cdkd#2011 / go-to-k/cdkd#2016 were the SAME three cdk-local
  lessons filed twenty minutes apart by two hops):
  - **The session that FINDS the lesson lands all three** — the default, not
    the ambitious option; the narrow exception (cannot pay the remaining gate
    cycles) is justified in the wrap. Land the mirror BEFORE the original's
    review rounds are finished, not after: the mirror gets its own reviewers,
    and they read the same design with none of the original's momentum behind
    it. Measured 2026-09-02 — the cdk-local port's reviewers found an unchained
    `git branch -D` that deletes on a FAILED switch, and a quote-parsing bug,
    BOTH in code cdkd had already merged past a three-axis panel; cdkd's found
    a `git switch` DWIM the port had inherited. Neither repo alone would have
    caught both, so the mirror is a second review pass that happens to also be
    the deliverable.
  - **Filing a mirror issue covers the WHOLE remainder, in one turn** — file
    into EVERY repo still missing it at once, each issue naming the other
    filings plus the repo already landed; partial filing produced the pairs above.
  - **A lane WORKING a mirror issue does not mirror onward** — the originating
    session owns all three landings; only lessons from the ADAPTATION itself (a
    gate behaving differently, a claim false in this repo) are new findings, to
    which the first rule applies.
  - **Batch a run's lessons into ONE PR per repo**, not per lesson — the gate
    cycle is the per-PR cost: five lessons, still three PRs.

  **Before filing into a target repo, resolve the lesson against that repo's
  CURRENT state — merged FILE, then open PRs, then open issues — and file only
  what none of the three already carries.** A lesson MOVES between the windows
  while worked (an hour after a rival hop files, its issue is closed and its PR
  merged, leaving the file as the only evidence). Per hit: in the file — do not
  file; open PR — comment on the PR; open issue — comment with what this hop
  adds. **Match on the CONCEPT, not on a phrase** (each hop rewords per repo,
  so your literal phrase misses the sibling's rewrite), and **judge a candidate
  PR by its BODY and DIFF, never its title** (a mirror lesson often rides in a
  PR named for another; "landed in N of them" in a body signals other hops).

  ```bash
  T=/Users/goto/github/<target>
  # the landed window — fetch first: a stale clone false-negatives the one window
  # that no later check can recover
  git -C "$T" fetch -q origin
  git -C "$T" grep -n -i -e '<concept-keyword-1>' -e '<concept-keyword-2>' \
    origin/main -- .claude/skills/work-issues/
  # the in-flight window — then read each hit, since the title alone decides nothing
  gh -R go-to-k/<target> pr list --state open --search '<keyword>' --json number,title
  gh -R go-to-k/<target> pr view <hit> --json body -q .body
  gh -R go-to-k/<target> pr diff <hit>
  # the not-started window
  gh -R go-to-k/<target> issue list --state open --search '<keyword>' --json number,title
  ```

  Measured 2026-08-19: three cdkd issues filed for two lessons in 70 minutes
  (go-to-k/cdkd#1973 / go-to-k/cdkd#1980 / go-to-k/cdkd#1986), the lesson
  sitting in a DIFFERENT window at each look — last in PR go-to-k/cdkd#1984's
  body and diff under an unrelated title, then only the FILE after the merges.
  No single window suffices.
  **Verify the copy against the TARGET repo, claim by claim, before shipping
  it** — gates/hooks/ship steps differ, so a sentence true here is false there,
  and nothing lints instruction prose. Dispatch a read-only reviewer per target
  repo to check each gate name, hook behavior, skill name, path convention and
  cross-reference against that repo's own files (caught four false claims in
  the 2026-08-18 first mirror). This rule lives HERE, not in agent memory —
  memory is per-project-path and per-machine, so it would not load in the
  target repos.
  **Read the BODY of every incident the copy cites, not just the number** — a
  resolving number makes a wrong mechanism claim look sourced. Name the
  mechanism the issue actually describes or drop it (2026-08-19: an rc flap
  blamed on a "tsgolint budget cascade" citing go-to-k/cdk-real-drift#1761,
  which actually documents a Vite+ stdout EAGAIN panic, rc=134, 0 errors).
  **Fully qualify every issue / PR reference in this file** (`go-to-k/<repo>#N`)
  — this file is the mirror SOURCE, and a bare `#N` renders against whichever
  repo READS it, where the number almost always exists and is unrelated
  (go-to-k/cdkd#1973's one bare ref would have resolved to go-to-k/cdkd#1761,
  an EC2 export attribute). Violated 13 times here despite being stated, so per
  §10-b each repo enforces it with a TEST — cdkd's is
  `tests/unit/scripts/work-issues-skill-refs.test.ts`; a mirror lane WRITES the
  sibling's own rather than citing this path. It fails any plain-prose
  reference not `go-to-k/<repo>#N`, exempting frontmatter, fenced blocks and
  inline code spans (a bare ref may appear as a counter-example).

### 10-d. Ship it like any other change

Every worktree THIS run added is gone by §9 and you are back on `main`, where
`main-tree-edit-gate` blocks editing a tracked file — so the retro gets its own
worktree:

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
# Suffix the branch to UTC MINUTE, not day. A merged branch is deleted, and
# re-pushing that name is refused by post-merge-orphan-push-gate — which a bare
# date suffix does not avoid, because more than one run lands per day. Measured
# 2026-08-21: this step's own `$(date +%Y%m%d)` name collided with PR
# go-to-k/cdkd#2139, merged 02:35Z the same morning, and the push was blocked
# after the retro was already written and committed.
B=chore/work-issues-retro-$(date -u +%Y%m%d-%H%M)
git worktree add ".claude/worktrees/${B##*/}" -b "$B" origin/main
cd ".claude/worktrees/${B##*/}"
mise trust && mise install    # see section 5 -- same trap, same one-line fix
pnpm install                  # worktrees have no node_modules
```

IN-PLACE — run THIS block INSTEAD of the one above, never both: there is no
worktree to add, and `git worktree add` from inside this tree NESTS the very
worktree this mode exists to prevent. The lane's own tree is
still here with its deps installed, and you are not on `main`, so take the
retro branch in it. `B` is re-assigned because a separate fenced block is a
separate shell (§9's `$MAIN` trap), and the merged lane branch cannot be reused
(post-merge-orphan-push). `main-tree-branch-gate` backs this switch up
against a cwd reset, and since go-to-k/cdkd#2406 landed (on `main` 2026-09-02)
it covers the chained `git fetch origin && git switch -c ...` form below as well
as the bare one — §5 has the measurement of both copies and the content probe
that settles which is deployed.

```bash
B=chore/work-issues-retro-$(date -u +%Y%m%d-%H%M)
git fetch origin && git switch -c "$B" origin/main
```

- `chore:` prefix — `.claude/**` is not `src/**`; `commit-prefix-scope-gate`
  blocks `fix:` / `feat:` here (a `feat(work-issues)` commit ships a misleading
  minor release; PR go-to-k/cdkd#346).
- English only in every committed line.
- Scope does not exempt you from the markers: `check-gate` verifies BOTH
  `check` and `docs` on every commit without computing scope, and a fresh
  worktree starts with none — a `work-issues`-only edit still needs them.
  `/verify-pr` sets all three in one pass (`gh pr create` is gated on the
  third); run it before the commit. A tooling-only PR with no `src/**` change
  gets §8's live-test exemption — the prose arm for a SKILL.md / rule edit, the
  command arm (run the suite, drive the failure direction, add the test case)
  as soon as it lands in `.claude/hooks/**` (per §10-b the RIGHT place for a
  violated written rule). **Run the WHOLE harness there — `bash
  .claude/hooks/run-tests.sh`, not just your own hook's suite — and read the
  TALLY, not the exit code of whatever you piped it into.** A hooks edit is
  what re-triggers the path-filtered `hooks.yml`, so a fence a PEER left inert
  surfaces as YOUR red CI. Measured 2026-08-29 while shipping this very
  section: go-to-k/cdkd#2380 had respelled every registration in
  `.claude/settings.json` as `${CLAUDE_PROJECT_DIR:-.}/...`,
  `unresolved-target-class.test.sh`'s start-anchored enumeration then matched
  nothing, so its population guard fired and the suite has failed on `main`
  since — while the workflow that would have said so never ran, a settings-only
  PR being outside its `.claude/hooks/**` path filter. Both halves (the
  enumeration and the filter) were repaired in the retro PR.
- Agent-instruction files are deliberately NOT down-biased in `/review-pr`'s
  tier heuristic — a wrong rule here propagates into every future session — so
  take the tier the heuristic gives and do not argue it down.
- **Merge it before the wrap report, then remove the worktree** (`git worktree
  remove .claude/worktrees/<name> && git worktree prune` — §9's closing check
  is "every worktree THIS run added is gone", and §10 must not undo that). An
  IN-PLACE run added none, so instead this is where it runs §9's IN-PLACE
  cleanup arm — **the LAST step of the whole run**: `git switch
  --no-guess <LAUNCH_BRANCH> && git branch -D` every branch this run created,
  the retro branch included. AS-IS: no pull, no rebase, no fast-forward — the
  branch is the outer tool's artifact. CHAINED, because an unchained delete
  after a failed switch still removes every branch that is not checked out; and
  `--no-guess` because a plain `switch` would re-create the branch from
  `origin` instead of failing through to the fallback. §9 deliberately
  does NOT do it per-lane, because THIS section branches in the same tree and
  would undo it. Leaving the tree on the retro branch — the previous
  instruction here — makes the unmerged-lane Stop hook warn every turn (the
  appendix has the wording), and detaching instead is visible-surprising in the
  outer tool's UI; restoring what the tool created is quiet on both counts.
  This
  is `Session-fit: now`: deferring leaves main self-inconsistent (the skill
  keeps telling the next run to do what this run proved wrong), the evidence
  dies with this session, and an open PR is NOT CLOSEABLE besides.

Then report the outcome in one line of the wrap: what changed, in which step,
and the run evidence behind it — or "no skill change" plus what held.

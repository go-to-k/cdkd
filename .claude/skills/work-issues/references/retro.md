<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

Trigger: after the last lane in §9 is merged and its worktree removed, BEFORE
the wrap report. This is part of the run, not an optional extra — the evidence for
it (what you had to re-read, what the text sent you into, which correction the user
had to make twice) exists only while this session's context is alive, and none of it
survives into the next `/work-issues`.

`/verify-pr` step 10 already ran a retrospective per LANE. This step has a different
subject and a wider scope, and neither is covered by that one:

- its subject is **the flow itself** — this skill's docs (SKILL.md + references/) and the skills it drives — not
  the code the lane changed;
- it spans the WHOLE run, so it can see the cross-lane pattern (the same probe
  missing twice, the same correction on lane A and again on lane C) that is
  invisible from inside a single lane;
- it **applies** the fix instead of proposing it. Editing this repo's own agent
  tooling is a routine call you make yourself (`CLAUDE.md` → "Decide routine calls
  yourself"). Escalate through `AskUserQuestion` only when the edit would change
  what the flow PROMISES — dropping a gate, lowering a verification tier, loosening
  §0 — never for wording, ordering, or a newly-learned trap.

### 10-0. Measure the run's net effect on the backlog

Before anything else in this step, count what the run did to the issue list and
put the two numbers in the wrap report:

```bash
# closed BY this run (the lanes you merged, plus anything a sweep folded in)
gh issue list --state closed --limit 100 --json number,closedAt,title \
  --jq '.[] | select(.closedAt > "<this run start ISO>") | "\(.number)\t\(.title)"'
# filed BY this run
gh issue list --state all --limit 100 --json number,createdAt,title \
  --jq '.[] | select(.createdAt > "<this run start ISO>") | "\(.number)\t\(.title)"'
```

**Then run the PROMOTION check on every `next` this run filed, because a
deferral is judged against the run that has now happened, not the run that was
predicted when it was written.** `CLAUDE.md` already requires promoting a `next`
to `now` when the session ends up touching those files anyway, and the `next`
criterion "an independent subsystem with no file overlap" already carries the
conjunct "AND none of the `now` criteria fire". Both are correctly written and
both get skipped, because at wrap time nobody re-opens a decision they remember
making deliberately. So make it a QUERY rather than a thing to remember:

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

Pipe the whole loop through `sort -u`: a body naming the same file twice prints
twice, and the duplicate reads as two findings.

**A hit is a prompt for judgement, not a verdict** -- measured on this run's own
two deferrals, one hit on the single file its fix touches and the other hit on
FOUR, three of which its body cited as precedent rather than as files to change.
The check cannot tell a citation from a target, and should not try: its job is to
put the issue back in front of you at the moment the answer has changed.

A hit is still not something to skim past. Either do the item, or re-classify it in the issue
with the reason the criterion no longer applies.

**And re-read the REASON, not just the files, because a deferral reason can
name a state that has since resolved.** The classify-once rule exists to stop
the post-merge moment being re-litigated, and it is right — but it freezes the
DECISION, not the PREMISE. A reason phrased in terms of the run's own transient
state ("taking this at review round four is how a fifth round happens", "the PR
carrying it is still open", "the lane holding that file is mid-flight") is true
when written and FALSE the moment that state resolves. On 2026-08-26 exactly
that shipped: an issue was deferred because its fix would have been a fifth
round on a PR still in review, and the reason survived unchanged into the wrap
report after that PR merged, where it read as a considered judgement. Re-reading
a premise that has expired is not re-litigation; keeping a `next` alive on a
reason that has stopped being true is.

Then split the filed count by what the section 5 window did with each finding,
because the aggregate cannot tell the two apart and they mean opposite things:

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

Report it as one line — `closed N / filed M (new K / folded J)` — and **when
M > N, give the reason in one more line**. `J` is the number the section 5
window exists to move, and it is the only one of the three that can be improved
without either missing a defect or leaving one unfixed; a run reporting `J = 0`
over several findings in one area is the signal that the window was searched by
this instance's spelling rather than by the concept. The reason is almost always
one of three, and only the first is healthy:

- **the code really does have that many independent defects** — the run walked
  into an untested area. Fine; say which area, so the next `/hunt-bugs` aims there.
- **one root cause was split into many issues** — §5's sweep rule should have
  folded them. This is the failure mode to catch; if it happened, fold what is
  still open into an umbrella now rather than next time.
- **discoveries were deferred that had session-only evidence** — re-read the
  `now` criteria in `CLAUDE.md`; a discovery whose repro dies with this session
  is not a residual, and deferring it means the next session re-derives it.

**M ≤ N is NOT a target, and must never become one.** The purpose of the system
is a correct codebase, not a short list: an unfiled finding is strictly worse
than a filed one, because it removes the defect from the record while leaving it
in the product. So this count exists to make growth VISIBLE and to route it to
the right cause — never to justify not writing a finding down, softening one, or
merging two genuinely independent defects into a single vague issue to make the
number smaller. If you ever find yourself weighing whether to file, file.

### 10-a. Evidence: only what this run actually produced

Walk the session and collect, with the concrete instance attached to each:

1. **Corrections the user made.** Two on one theme — different lanes, different
   wording, same theme — is not a preference, it is a defect in this text. The
   second occurrence is the signal; the first one alone may be a one-off.
2. **Text that was WRONG as written**: a command that failed, a probe that reported
   a clear field while a lane was live, a flag / path / gate name that no longer
   exists.
3. **Steps you had to invent** because the skill is silent about them, and that the
   next run would have to invent again from scratch.
4. **Right instruction, wrong place** — you did the thing, but a step too late (the
   claim posted after the triage, the rebase discovered only after the phantom diff).
5. **Followed it and still paid** — the text was obeyed and a retry happened anyway.

**No evidence, no edit.** If the run was clean, the correct output is one line in the
wrap report ("retrospective: no skill change — §2 / §4 / §8 held"). A skill
that grows from "this would be nice" stops being read to the bottom, and the bottom
is where §9 and §10 live.

### 10-b. Where the fix belongs — pick ONE

- **A hook** (`.claude/hooks/`) — or a test under `tests/unit/**` when the subject
  is a committed file rather than a command — whenever the failure is mechanically
  detectable. Strongest, and the RIGHT answer whenever the rule was ALREADY in the
  text and got violated anyway: that proves the sentence is not load-bearing, and
  another sentence will not make it so. Escalate rather than restate. A hook fires
  on the action, a test fires in CI; pick by what the rule is about.
- **This skill's stage files** when the lesson is about running THIS flow (triage,
  claiming, fan-out, ship order). The edit target is the `references/<stage>.md`
  where the lesson fires — never the SKILL.md orchestrator, unless the stage
  list itself changed. SKILL.md's byte size is capped by
  `tests/unit/scripts/skill-file-payload.test.ts`, which is the mechanical stop
  on the growth loop that produced the 231 KB single-file predecessor of this
  layout.
- **Another skill**, but only one this run actually exercised (`/run-integ`,
  `/verify-pr`, `/review-pr`, `/pick-integ`, `/check`, `/check-docs`, `/cleanup`).
  The first four sit in the `check` gate's scope, so editing one invalidates the
  `check` marker and forces a `/check` re-run.
- **`CLAUDE.md` / `.claude/rules/**`** when it applies to any work in this repo, not
  just this flow (both are in the `docs` gate's scope, alongside `src/**`,
  `docs/**` and `README.md`; `CLAUDE.md` is in `check` as well).
- **Memory** (`~/.claude/projects/.../memory/`) when the lesson is judgmental and
  cross-repo. Weakest enforcement — the landing spot when nothing above can hold the
  rule, not the default one.

### 10-c. How to edit: amend, do not append

Every run appending one more bullet is exactly how a long skill becomes an unread one.

- Put the fix **in the step where it fires** — a claiming lesson belongs in §4, not
  in a tail section. Gotchas is for traps that span steps, not a run log.
- **Amend the sentence that was wrong** rather than adding a sibling beside it. Two
  bullets saying nearly the same thing blunt each other.
- **Carry the evidence inline**, in this file's existing style: date, issue / PR
  number, what actually happened ("On 2026-08-11 ... pushed four minutes earlier").
  A rule with no incident behind it cannot be re-judged or retired later.
- **Pay for what you add**: look for a line this run proved stale, subsumed, or
  wrong, and cut it. Net growth is fine when the lesson is genuinely new; unbounded
  growth is not.
- Do not restate a rule that already lives in `CLAUDE.md` or in another step — point
  at it instead.
- If the lesson is about the FLOW rather than about cdkd, mirror it into the
  same-named `work-issues` skill in the sibling repos (`../cdk-local`,
  `../cdk-real-drift`). They run this flow with different gates and different ship
  steps, so adapt the wording per repo rather than copying the section verbatim, and
  it is one PR per repo under that repo's own worktree + `chore:` + gate flow. What
  is not an option is landing the fix in only one of the three — that is how the
  three drift apart. Four rules govern who does that landing, and they exist
  because this bullet is otherwise a duplicate GENERATOR: on 2026-08-19 thirteen
  open issues across the three repos were one change, and two of them
  (go-to-k/cdkd#2011 and go-to-k/cdkd#2016) were the SAME three cdk-local lessons
  filed twenty minutes apart by two hops, neither able to see the other.
  - **The session that FINDS the lesson lands all three.** Three worktrees, three
    PRs, three gate cycles, in this session — that is the default, not the ambitious
    option. The narrow exception is a session that genuinely cannot pay for the
    remaining gate cycles, and it is an exception you justify in the wrap, not a
    preference between two equal routes.
  - **Filing a mirror issue covers the WHOLE remainder, in one turn.** When the
    exception applies, file into EVERY repo still missing the lesson at once, and
    have each issue name the other filings plus the repo the lesson already landed
    in. A reader can then see the set is complete instead of re-deriving it — and
    partial filing is precisely what produced the duplicate pairs above, because
    the second hop re-derives a set the first hop already covered.
  - **A lane WORKING a mirror issue does not mirror onward.** This is the clause
    that actually stops the generator: the originating session already owns all
    three landings, so re-filing the received lesson into the siblings creates a
    second and third copy of work already accounted for. Only the lessons this
    lane learns from the ADAPTATION itself are new — a gate that behaves differently
    here, a claim that turned out false in this repo — and those are new findings,
    so the first rule applies to them in turn.
  - **Batch a run's lessons into ONE PR per repo**, not one PR per lesson. The gate
    cycle is the per-PR cost, so a run that learned five things ships three PRs
    total. The PR that landed these four clauses is the shape: seven issues, one
    skill file plus the test that mechanizes one of them, one gate round.

  **Before filing into a target repo, resolve the lesson against that repo's
  CURRENT state — the merged FILE, then open PRs, then open issues — and file only
  what none of the three already carries.** The clauses above are what STOPPED
  this rule generating duplicates -- one session owning all three landings leaves
  no second hop to collide with -- but the check still earns its place, because a
  lesson can already be carried by work you did not do: a sibling repo may have
  found it first, or an earlier run may have landed it. All three windows are
  needed because a lesson MOVES between them while it
  is being worked — an hour after a rival hop files, its issue is closed and its PR
  is merged, and the file is the only place left that shows the work was done. Each
  hit takes a different action: already in the file, do not file at all; in an open
  PR, comment on the PR; in an open issue, comment there with what this hop adds.
  Two ways these searches miss what is really there: **match on the CONCEPT, not on
  a phrase** — the bullet above tells each hop to adapt the wording per repo, so a
  literal phrase lifted from your own copy will not find the sibling's rewrite — and
  **judge a candidate PR by its BODY and DIFF, never its title**, since a mirror
  lesson often rides along in a PR named for a different one. A mirror body saying
  "landed in N of them" is the signal that other hops exist.

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

  On 2026-08-19 this chain filed THREE issues into cdkd for two lessons inside 70
  minutes, and the SAME lesson was reachable through a different window at each
  moment someone looked. go-to-k/cdkd#1973 (03:14Z) and go-to-k/cdkd#1980 (03:50Z)
  duplicate each other on the same §8 change: at 03:50Z the open-ISSUE check reaches
  it, go-to-k/cdkd#1973 being still open. go-to-k/cdkd#1986 (04:23Z) then asked for
  a §10-c sentence that by then sat in TWO open places — go-to-k/cdkd#1980's body,
  and go-to-k/cdkd#1984, open since 04:18:12Z carrying the sentence in both its body
  and its diff while its title named only the §8 lesson. Ten minutes later every one
  of those had evaporated: go-to-k/cdkd#1984 merged at 04:27:29Z, go-to-k/cdkd#1980
  closed at 04:28:51Z, and at 04:33Z triage neither an issue nor a PR search still
  surfaced a rival holding the lesson, while the FILE now carried it outright (§3).
  No single window was sufficient across that hour; which one pays depends only on
  when you look.
  **Verify the copy against the TARGET repo, claim by claim, before shipping it.**
  Their gates, hooks and ship steps differ, so a sentence that is true here reads as
  authoritative there while being false, and nothing lints instruction prose — the
  next agent simply acts on it. On 2026-08-18 the first mirror of this section
  carried four such claims: a `verify-pr` gate that exempts a non-`src/**` diff, a
  review heuristic that still down-biases `.claude/**`, a `CLAUDE.md` rule the
  sibling does not carry, and a hook it does not ship. A read-only reviewer per
  target repo — its only job being to check each gate name, hook behavior, skill
  name, path convention and cross-reference against that repo's own files — is what
  caught them. Checking in the rule here rather than in agent memory is deliberate:
  memory is per-project-path and per-machine, so it would not load in the very repos
  this bullet sends you to.
  **Read the BODY of every incident the copy cites, not just the number.** A
  mechanism claim is the one that survives a careless check, because the issue
  number resolves and the sentence therefore looks sourced. On 2026-08-19 the
  section mirrored here blamed an rc flap on a "tsgolint budget cascade" citing
  go-to-k/cdk-real-drift#1761; that issue documents `vp run check` aborting rc=134
  from a Vite+ stdout EAGAIN panic on a long warning write, with 0 errors. The
  phrase appears in neither repo's issues. A mirrored diagnosis sends the next agent
  hunting the wrong failure, so name the mechanism the cited issue actually
  describes, or drop it.
  **Fully qualify every issue / PR reference in this file** — not only the ones a
  copy brings in, since the whole file is the mirror SOURCE and every bare `#N` in
  it breaks the moment the section travels: it renders against whichever repo is
  READING it, where that number almost always exists and is unrelated. Mirroring
  go-to-k/cdkd#1973 verbatim on 2026-08-19 would have pointed its one bare ref at
  go-to-k/cdkd#1761 — an EC2 export attribute — as the evidence for a toolchain
  incident, a working link to the wrong thing. The rule was stated here and
  violated 13 times in this same file, so per §10-b each repo now enforces it with
  a TEST rather than a sentence — in cdkd,
  `tests/unit/scripts/work-issues-skill-refs.test.ts`; the siblings carry their own
  under their own layouts, so a mirror lane WRITES one rather than citing this
  path. It fails on any reference in this file's plain prose that is not
  `go-to-k/<repo>#N`, exempting the frontmatter, fenced blocks and inline code
  spans so a paragraph can still show a bare one as a counter-example.

### 10-d. Ship it like any other change

Every worktree THIS run added is gone by §9 and you are back on `main`, where
`main-tree-edit-gate` blocks editing a tracked file. So the retro gets its own
worktree:

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

- `chore:` prefix — `.claude/**` is not `src/**`, and `commit-prefix-scope-gate`
  blocks `fix:` / `feat:` here (a `feat(work-issues)` commit ships a misleading
  minor release; PR go-to-k/cdkd#346).
- English only in every committed line.
- Scope does not exempt you from the markers: `check-gate` verifies BOTH `check`
  and `docs` on every commit without computing scope, and a fresh worktree starts
  with none, so a `work-issues`-only edit still needs them. `/verify-pr` sets all
  three in one pass (and `gh pr create` is gated on the third), so run it before the
  commit. It is a tooling-only PR with no `src/**` change, so §8's live-test
  exemption applies — take the arm matching what the retro actually changed: the
  prose arm for a SKILL.md / rule edit, the command arm (run the suite, drive the
  failure direction, add the test case) as soon as it lands in `.claude/hooks/**`,
  which §10-b says is the RIGHT place whenever a rule was already written and got
  violated anyway.
- Agent-instruction files are deliberately NOT down-biased in `/review-pr`'s tier
  heuristic — a wrong rule here propagates into every future session — so take the
  tier the heuristic gives and do not argue it down.
- **Merge it before the wrap report, then remove the worktree** (`git worktree
  remove .claude/worktrees/<name> && git worktree prune` — §9's closing check is
  "every worktree THIS run added is gone", and §10 must not undo that). This is
  `Session-fit: now` on the criterion that deferring leaves main self-inconsistent:
  the skill would keep telling the next run to do the thing this run just proved it
  gets wrong. Its evidence also dies with this session's context, and leaving the PR
  open is an open PR (NOT CLOSEABLE) besides.

Then report the outcome in one line of the wrap: what changed, in which step, and
the run evidence behind it — or "no skill change" plus what held.


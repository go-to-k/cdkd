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

Count what the run did to the issue list, for the wrap report. **Take the
closed and filed sets from the RUN's own record — its posted claims and lane
reports — never from a scan of the issue list by date or wording**: concurrent
sessions file into the same window in the same vocabulary, and on 2026-09-06 a
sweep for `lane` / `this run` returned seven issues of which only THREE were
this run's — the other four came from two concurrent sessions
(go-to-k/cdkd#2679 among them), separable only by reading each body's own
account of the session that found it, usually its `Session-fit` reason. The
queries below DATE the window; they do not attribute it.

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
# ere() only ever gets a token from the extraction charset below, so `.` is
# the one metacharacter it meets -- and escaping it is LOAD-BEARING, not
# defensive: unescaped, `x.test.ts` is a wildcard that matches a touched
# `x-test.ts`, promoting a file the run never touched under that name. The
# rest of the class guards a future widening of that charset. None of it
# protects a touched PATH holding `+` or `(` -- that path is the HAYSTACK, and
# a body naming it yields a metacharacter-free token anyway
# (`tests/a+b/verify.sh` -> `b/verify.sh`, which still suffix-matches).
ere() { printf '%s' "$1" | sed 's/[][\\.*^$+?(){}|/]/\\&/g'; }
# Centered context windows, one per OCCURRENCE. awk's index() is a LITERAL
# substring search: no regex engine, so no complexity limit and no escaping.
# The needle travels through the ENVIRONMENT, not `-v`, because `-v` processes
# escape sequences -- a path containing a backslash would not arrive literally.
# The empty-needle guard is not decoration: index(s, "") is 1, so the advance
# below never moves and the loop does not terminate.
ctx() { [ -n "$1" ] || return 0
  CTX_NEEDLE="$1" awk '
    BEGIN { n = ENVIRON["CTX_NEEDLE"] }
    { line = $0; off = 0
      while ((p = index(substr(line, off + 1), n)) > 0) {
        abs = off + p; s = abs - 50; if (s < 1) s = 1
        print substr(line, s, (abs - s) + length(n) + 50)
        off = abs + length(n) - 1
      } }'; }
for n in <the numbers this run filed that are still open>; do
  b=$(gh issue view "$n" --json body -q .body)
  printf '%s' "$b" | grep -q 'Session-fit: *next' || continue
  # Dedupe on the HIT, never on the printed line: the extraction yields both a
  # full path and its bare basename, so one touched file matches twice, and a
  # trailing `sort -u` over the output would also separate each context line
  # from the row it belongs to.
  hits=$(printf '%s' "$b" \
    | grep -oE '\.?[A-Za-z0-9_][A-Za-z0-9_./-]*\.[a-z]+' | sort -u \
    | while read -r f; do
        # Suffix match, not equality: bodies name files by BASENAME far more
        # often than by full path.
        grep -E "(^|/)$(ere "$f")\$" /tmp/run-touched.$$
      done | sort -u)
  [ -n "$hits" ] || continue
  printf '%s\n' "$hits" | while read -r hit; do
    echo "PROMOTE #$n -- this run touched $hit"
    # Context is derived from the HIT and printed for EVERY occurrence.
    c=$(printf '%s' "$b" | ctx "$hit")
    if [ -n "$c" ]; then
      printf '%s\n' "$c" | sed 's/^/    ctx: /'
    else
      base=$(basename "$hit")
      echo "    AMBIGUOUS -- the body never names $hit, only \`$base\`:"
      printf '%s' "$b" | ctx "$base" | sed 's/^/    ctx: /'
    fi
  done
done
rm -f /tmp/run-touched.$$
```

Three properties of that block are the fix rather than style, each a defect a
previous attempt shipped (go-to-k/cdkd#2655):

- **The context is grepped for `$hit`, not for the extracted token `$f`.** A
  bare basename token pairs with EVERY touched path sharing it, so a `verify.sh`
  token printed a sentence about a SIBLING fixture beside a hit naming this one
  — reproducing, inside the mechanism, the citation-read-as-target error the
  mechanism exists to stop. When the body names only the basename the row says
  `AMBIGUOUS` and prints every occurrence, because there is genuinely no
  sentence that belongs to this path.
- **Every occurrence prints, not the first.** `grep -m1` binds a token that
  appears in both a comparison sentence and a subject sentence to whichever
  came first — and which one that is carries no information.
- **The window is CENTERED on the match** (50 BYTES each side), never a head
  cut. `cut -c1-110` truncated the token out of its own context line on
  go-to-k/cdkd#2636, printing 110 characters that did not contain the thing
  being explained.

**`ctx` is `awk`, and the obvious `grep -oE ".{0,50}<tok>.{0,50}"` is a
DEFECT rather than a stylistic alternative.** `grep` IN THE AGENT'S OWN BASH
TOOL is ugrep, which REFUSES a bounded repeat around a short needle —
`retro.md`, `ship.md` and `foo.md` all exit rc=2 with
`exceeds complexity limits`, while `verify.sh` and `triage.md` pass (the
boundary is exactly 9 characters), so the failure is invisible to any probe
whose needle happens to be long enough — both probes written for
go-to-k/cdkd#2655 were. An rc=2 leaves `c` EMPTY, which takes the `else` arm
and prints `AMBIGUOUS`, the row this block defines as the STRONGEST citation
signal. A tool failure rendered as a positive finding is worse than no context
line at all.

**And a probe cannot settle it, which is the transferable part.** Measured
2026-09-15: `grep` is a shell FUNCTION injected by Claude Code's shell
snapshot, so the agent's Bash tool gets ugrep while `zsh -l -i`, `zsh -l` and
`bash -c` every one resolve `/usr/bin/grep`, which accepts the same pattern.
The login shell is NOT where the divergence lives — the session pasting this
block is — and a harness built on `bash -c` therefore reports clean on the
exact input that fails in use. The remedy is not a better probe but a helper
depending on no `grep` at all, which is what the fence asserts.

**This block is EXECUTED by `tests/unit/scripts/work-issues-promotion-context.test.ts`,
and that is the instrument change rather than a belt-and-braces addition.**
The recipe shipped three defects as prose (basename pairing, head-cut window,
the ugrep refusal) and its rewrite three more (an empty-needle non-terminating
loop, `awk -v` escape processing, a byte-vs-character window). Six defects
across three hand-verified rounds is this skill's own "three spellings in
three rounds is the signal to change instrument" (`references/implement.md`
5-f'), and the fence follows the precedent one file over: the launch-mode
probe in `references/launch-mode.md` is extracted and run by
`work-issues-launch-mode.test.ts` for the same reason. Edit the block and the
suite runs it.

Two bounds, stated so a silent row is not read as an absence. `awk` here is
LINE-based, so a token wrapped across two lines of a body gets no context and
prints `AMBIGUOUS`. And the scan is non-overlapping — each occurrence gets its
own window, which `grep -o` did not give, but a needle overlapping ITSELF
(`aaa` in `aaaaa`) still reports once; no repo path has that shape.

- **The diff is a LOWER bound on what this run loaded — run the context test
  on every `next` as well.** The query above sees files the run EDITED; the
  run also READ its reviewers' diffs, the modules its lanes traced and every
  sibling site a review named, none of which is in `run-touched`. For each
  `next` still open, list the files its fix touches or must read and ask
  whether any was read this run — if one was, it is `now` (`.claude/rules/session-report.md`
  → Session-fit: the default is `now`, and the maintainer's wrap-time
  challenge on exactly this has promoted every time it was asked).
- **An EMPTY result is not "nothing to promote" — check the extraction saw a
  FILE at all.** A body names its subject by SYMBOL as often as by path
  (go-to-k/cdkd#2442), and a DOTFILE needs the `\.?` prefix above
  (go-to-k/cdkd#2455); both reported nothing while the criterion fired. Print
  what the extraction found; resolve by hand (`git grep -l '<the symbol>'`)
  whenever no token is path-shaped or the diff is mostly dotfiles.
- **Count the (b)s.** `.claude/rules/session-report.md`'s reason (b) — cold
  AND heavy — must stay rare; more than one (b) among this run's filings
  means re-classify all but the strongest as `now`.
- **A hit is a prompt for judgement, not a verdict** — it cannot tell a
  citation from a target: a retro wrote go-to-k/cdkd#2621's citation of a
  SIBLING fixture into a rule as a sourced incident, unpicked only by review.
  The `ctx:` lines the query now prints are what that judgement reads; an
  `AMBIGUOUS` row means the body never names this path at all, which is the
  strongest citation signal the query can give. Read the SENTENCE, not the
  row. Do the item, or re-classify it in the issue with the
  reason the criterion no longer applies. When the run's own PRs ARE the
  follow-ups' subject — one lane, or several sharing a subsystem — expect
  EVERY one to hit, and read the issue's REASON instead (go-to-k/cdkd#2514,
  10 of 10; two more runs since) — a run-wide hit rate is a property of the
  run's SHAPE, not of the deferrals.
- **Re-read the REASON, not just the files — and when a hit CONTRADICTS it,
  the BODY is the stale side.** A reason anchored to the filing session's own
  state goes false while the decision it justified still stands.
  `.claude/rules/session-report.md` → Session-fit carries the shape and the
  incident. **A reason naming an EXTERNAL blocker is checked by RUNNING the
  query §4 makes it name** — the file criterion above never fires for a
  stand-down whose file this run never touched (2026-09-10:
  go-to-k/cdkd#2847 / go-to-k/cdkd#2885 stood down on open go-to-k/cdkd#2911,
  which merged 20 minutes later). Correct the issue when this catches one —
  and when LANES REMAIN, route a hit whose file a later lane will open into
  that lane's brief instead of noting it (go-to-k/cdkd#2604: a mid-run retro
  logged the cleared blocker as "not that run's lane"; the next lane opened
  that file anyway, and a third retro paid for what was twice free).

Then split the filed count by what the §5-f window did with each finding:

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

**Which shape RECURRED is a COUNT, not a recollection** — the tally decides
which lesson is worth a stage file's remaining bytes, and a retro's own brief
is prose, so §8-g applies to it (2026-09-10: a brief named one pattern "the
single most repeated defect across both PRs" and the commit bodies did not bear
it out). Take the tally BEFORE §9 flattens the lane branches — a merged PR shows
far fewer commits than it had rounds, a subagent-reviewed run carries no GitHub
review comment at all, and `--delete-branch` leaves those commit bodies
reachable from no LOCAL ref (GitHub keeps `refs/pull/<N>/head`), so cite the
PR, never the sha.

**No evidence, no edit.** A clean run's correct output is one wrap line
("retrospective: no skill change — §2 / §4 / §8 held"). A skill grown from
"this would be nice" stops being read to the bottom.

### 10-b. Where the fix belongs — pick ONE

- **A row in `docs/tooling-backlog.md`** — the DEFAULT for anything about the
  tooling itself (a hook, a markgate gate, a rule, a skill, a CI fence, the
  integ harness). It is not a GitHub issue: the tracker is for cdkd behaviour a
  user can hit, and a row graduates to an issue only when someone starts
  working it. **A rule that was ALREADY in the text and got violated anyway
  goes here on its FIRST occurrence** — the observation is recorded, and
  nothing is built on it.
- **A hook** (`.claude/hooks/`) — or a test under `tests/unit/**` when the
  subject is a committed file — on the SECOND occurrence of that same failure,
  and only when it is mechanically detectable. The escalation rule is intact:
  a sentence violated despite being stated is not load-bearing and another
  sentence will not make it so — it is now BOUNDED by the second-occurrence
  bar, because a mechanism built for a one-off costs every future run more
  than the failure did. Two things that never reach this rung: a hook failing
  OPEN on an exotic shell shape (quoting, heredocs, `$( )`, `bash -c`, `eval`,
  case arms, redirections), which is accepted as-is; and anything that would
  BLOCK where the harm does not complete at the moment of the action and land
  on a third party's artifact (`docs/tooling-backlog.md` carries the
  criterion). "Cost is not a tiebreaker" governs verifying PRODUCT changes and
  does not reach here.
- **This skill's stage files** when the lesson is about running THIS flow. The
  edit target is the `references/<stage>.md` where the lesson fires — never
  the SKILL.md orchestrator, unless the stage list itself changed; its own
  byte cap is 10-c's, and for the same reason.
- **Another skill**, but only one this run actually exercised.
- **`CLAUDE.md` / `.claude/rules/**`** when it applies to any work in this
  repo, not just this flow.
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
  wrong. **A retro NEVER buys room by raising a CAP** — the per-file caps in
  `tests/unit/scripts/skill-file-payload.test.ts` are the mechanical stop on
  this skill's growth loop, and raising one converts the stop into a ratchet (a
  2026-09-02 retro raised a bound to fit its additions; 2026-09-04 reversed
  it). A lesson compression cannot pay for splits the stage instead.
  **`MIN_REFERENCE_CORPUS_BYTES` is the one exception, and only RE-DERIVED**:
  it must stay above `corpus - runnerUp`, so ANY growth lapses it and "moves
  DOWN only" would make it unmaintainable (go-to-k/cdkd#2720 /
  go-to-k/cdkd#1837 / go-to-k/cdkd#2779 each re-derived it upward). It buys no
  room — the same assertion pins it from BELOW, so restoring a prior value
  under a grown corpus goes RED (measured 2026-09-11). Recompute from the
  tree, never pick.
- Do not restate a rule living in `CLAUDE.md` or another step — point at it.
  `CLAUDE.md` is injected into every context, so a stage-file paragraph
  re-explaining a gate it documents is paid for twice in every lane.
- A FLOW lesson (vs a cdkd one) gets mirrored into the same-named
  `work-issues` skill in `../cdk-local` and `../cdk-real-drift` — wording
  adapted per repo, one `chore:` PR per repo under that repo's own flow.
  Without the rules below this bullet is a duplicate GENERATOR (thirteen open
  issues across the repos were one change; go-to-k/cdkd#2011 /
  go-to-k/cdkd#2016 filed three lessons twice):
  - **The session that FINDS the lesson lands all three** — the default, and
    session budget is not a `next` reason (`.claude/rules/session-report.md`);
    the only exception is external input, justified in the wrap. Land the
    mirror BEFORE the original's review rounds finish: the
    mirror's own reviewers read the same design with none of the original's
    momentum (measured 2026-09-02: the cdk-local port's reviewers found two
    defects in code cdkd had already merged past a three-axis panel). It
    reviews the SOURCE too — re-deriving each claim against the target's gates
    re-opens the original's, returning two defects in cdkd's own hooks on
    2026-09-05, go-to-k/cdkd#2630 / go-to-k/cdkd#2638.
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
  (caught four false claims on the first mirror).
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

- `chore:` prefix — `.claude/**` is not `src/**`; CI refuses a `fix:` / `feat:`
  PR TITLE here (go-to-k/cdkd#2717).
- Scope does not exempt you from the checks — run `/check`, `/check-docs` and
  `/verify-pr` before the commit exactly as a `src/**` lane does; nothing
  blocks this PR if you skip them, which is the only difference. A
  tooling-only PR gets §8's live-test exemption — the prose arm for a
  SKILL.md / rule edit, the command arm as soon as it lands in
  `.claude/hooks/**`. **There, run the WHOLE harness — `bash
  .claude/hooks/run-tests.sh`, not just your own hook's suite — and read the
  TALLY, not the rc**: a hooks edit re-triggers the path-filtered `hooks.yml`,
  so a fence a PEER left inert surfaces as YOUR red CI (2026-08-29: a
  settings-only PR had broken a `main` suite sitting outside that path filter).
- Take the reviewer set `/review-pr` gives (one reviewer by default; the
  security reviewer on a secret / credential / redaction / process-launch
  surface; all three axes for a schema bump or a security fix) and do not argue
  it down — a wrong rule in an agent-instruction file propagates to every
  future session (CLAUDE.md).
- **Merge it before the wrap report, then remove the worktree**
  (`git worktree remove .claude/worktrees/<name> && git worktree prune` —
  §9's closing check is "every worktree THIS run added is gone", and §10 must
  not undo that). An IN-PLACE run added none; it runs §9's IN-PLACE cleanup
  arm HERE instead, as **the LAST step of the whole run**: `git switch
  --no-guess <LAUNCH_BRANCH> && git branch -D` every branch this run created,
  the retro branch included, AS-IS — no pull, no rebase, no fast-forward. §9
  owns WHY (`--no-guess`, the chaining, the three end states) and defers the
  step to here rather than per-lane, because THIS section branches in the same
  tree and would undo it. All of it is `Session-fit: now`: the evidence dies
  with the session, and an open PR is NOT CLOSEABLE.

Then report the outcome in one line of the wrap: what changed, in which step,
and the run evidence behind it — or "no skill change" plus what held.

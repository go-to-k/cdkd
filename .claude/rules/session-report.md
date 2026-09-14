---
description: Session-wrap report field reference (the four TODO classification fields, State line, Session-close verdict, report templates) — the detail behind CLAUDE.md's wrap-report contract
paths:
  - 'CLAUDE.md'
---

# Session-wrap report: the full field reference

CLAUDE.md's "Every session-wrap / task-complete report" rule states the
contract; this file carries the complete field semantics, scales, and
templates. Read it when writing a wrap report or filing a deferral.

## The four TODO classification fields

Decide them WHEN THE ITEM ARISES — the moment you defer something and file
its issue — never at wrap time, when the evidence (which files were open,
which verification cycle was paid) is gone. Record them **in the
issue body** so they survive the session. The issue body and the report use
the SAME four lines:

```text
Session-fit: now (do it in this session) | next (not this session) — <context test, then the reason>
Severity: medium — <what stays broken while it is undone>
Effort: large (L) — <which verification cycle it drags>
Estimate: ~3 h+ — <what eats the time>
```

A report adds a fifth line, **`Notes`**, for session-specific context
(`none` when empty). The issue body carries no `Notes` but does carry
**`Dup-check:`**, written at filing time (`/work-issues` §5-f); on a dup-check
HIT there is no issue to classify — the finding becomes a checklist row in
the covering issue.

The four answer four different questions, and none is a spelling of
another (the one sanctioned link: `Severity: high` forces `now` unless
external input blocks it):

| Field | Question it answers | Kind |
| --- | --- | --- |
| `Session-fit` | do I finish it in THIS session? | decision |
| `Severity` | how much does leaving it undone hurt? | value |
| `Effort` | which verification cycle does it drag? | kind of cost |
| `Estimate` | how many hours? | amount of cost |

**Do not collapse `Severity` into `Session-fit`** — a `high` can still be
`next` (external input) and a `low` is usually `now` (it lands in an open
file); `Severity` says what a USER suffers, `Session-fit` what THIS session
does, and one field is wasted the moment they merely track each other. **`Effort` is
not `Estimate`**: "one integ run" is a kind of cost; the hours depend on the
fixture.

### Spelling rules (mechanical, not taste)

- Keys are English, one spelling, everywhere: `Session-fit` / `Severity` /
  `Effort` / `Estimate` / `Notes`. Never localized or renamed per context —
  one token means the same string is greppable in the issue and the report.
- **No bare tokens — every value readable without knowing the internal
  scale**: `Session-fit: next (not this session)`, never a lone `next`;
  `Effort: large (L)`, never a lone `L`; `Severity` as a word, **never an
  initial** (`L` collides between severity *low* and effort *large*).
- **Always write both `Effort` AND `Estimate`** — dropping the duration and
  keeping the letter is the failure the split exists to end. This has gone
  wrong three ways (`M` for a duration, `now`/`next` bare, "Handoff" as a
  label), always because a short token is cheap to emit and its expansion is
  not.
- One field per line; never two keys on one line.

### Session-fit — the deferral decision

**`now` is the DEFAULT; `next` needs one of two reasons.** At the wrap of
nearly every recent session the maintainer has had to ask whether the
leftover would not be cheaper to finish HERE, with the context already
loaded — and every time the answer was yes: the item was re-classified `now`
and done in that session (go-to-k/cdkd#3083 is the latest, ~25 min because
every file it touched was already read). This rule pre-answers the question.

**Write the CONTEXT TEST before the decision**: list the files the fix
touches or must read to be made correctly (tests and docs included), and
say, per file, whether this session already READ it — read, edited, or
reviewed in a diff; a reviewer's read set counts exactly like an author's.
ONE loaded file makes the item `now`: a fresh session pays the launch probe,
install, build, the module read and the evidence re-derivation BEFORE its
first edit, while this session pays the edit alone. Precedence: `next` reason (a) below asks whether the work
CAN finish here and is decided first; (b) is what the test gates — it
decides whether (b) is available, not that it fires.

- **`now`** — any of: a file the fix touches is loaded (above); skipping it
  leaves main self-inconsistent (docs contradicting shipped code, a stale
  rationale comment, a fixture that no longer discriminates); it blocks
  another lane; **it rides an EXISTING integ fixture** (calibration below);
  **its evidence exists only in this session** (a live repro, a real-AWS
  observation, a measurement — understanding survives in an issue body,
  evidence does not); or **the user cannot use the result yet** (unreleased /
  undeployed — "merged" is not done; this criterion alone is decided by
  whether the request's purpose is met); or **leaving it loose compounds** —
  an integ fixture not yet written for a subsystem this session holds, a
  pattern landed at some sites and not others, a guard with a known hole:
  the cost of undone grows FOR THE REPO with every session that passes, and
  the fixture case is the clearest — deferred, it is the piece that never
  lands; or **`Severity: high`** — a wrong result, data loss, or a security
  surface, rated on the scale below and never on the decision it forces —
  is `now` unless (a) blocks it.
  **Residuals of a just-merged lane** — polish, nits, parity gaps, sibling
  sites a review named — are the hottest context there is and are `now` by
  the test above; "only a residual" names no cost. Writing a NEW integ
  fixture is `Effort: large`, a cost to record, never a reason to defer.
- **`next`** — ONLY one of: (a) external input (a quota, an upstream fix,
  credentials this host lacks, a file held by another lane's OPEN PR, a
  maintainer decision already asked through `AskUserQuestion` and unanswered
  — a routine call is yours to make); or (b) the work is COLD AND HEAVY —
  nothing the fix touches or must read was read this session, no `now`
  criterion fires, AND doing it here is clearly WORSE than fresh, not merely
  as costly: the reason names the modules to load and says why loading them
  beside THIS session's context degrades the work (a security surface read
  through an unrelated subsystem's assumptions). That is the one claim about
  the session that counts. Cold alone is not (b) — a small cold fix is
  `now`. (b) is legitimate and never to be forced through — but it must stay
  RARE: a (b) fired twice in one run is the reflex, not the reason, and
  `/work-issues` §10-0 counts them. **Nothing
  about the SESSION is a reason**: its length, the context left, "it has done
  enough", a wrap report already drafted, the PR already merged. The wrap reflex (file → classify → close)
  fires when the context is richest — which is why it produced `next`.

**No `next` criterion is about the PR.** Two used to be — "must not share a
PR", "bundling makes the PR unreviewable" — PR-SPLITTING guidance under a
SESSION-deferral heading, and load-bearing: three items deferred on it in one
session were all re-classified `now` and finished that session (2026-09-04,
go-to-k/cdkd#2587 / #2588 / #2590). A rule that offers two answers is not a
rule; the reader takes the cheaper one. Splitting work across PRs is normal —
decide it on review surface, and `Session-fit` on the criteria above. **The
PR's REVIEW HISTORY is the spelling that survives both tells** — "PR #N took
eight rounds; folding this in is how the next instance gets written" is still
a claim about the PULL REQUEST (2026-09-09: six of ten `next` filings,
go-to-k/cdkd#2846 / #2847 / #2850 / #2852 / #2854 / #2872, each already
carrying a work-owned reason; the retro DELETED the PR-shaped clause). Ask
which of the two a clause is ABOUT, never whether it MENTIONS a PR — strike
every clause about the PR and see whether a reason is left.

**The neighbouring failure: a reason about the FILING SESSION's own STATE
expires when that session does.** Not the rule above (a claim about the PULL
REQUEST); this is a claim about the SESSION that filed it — "PR 2519's scope
was frozen at its final review round" (go-to-k/cdkd#2554), "the file is held
by another open PR's diff" (go-to-k/cdkd#2604), "no integ run budgeted"
(go-to-k/cdkd#2539). A PR can be named on either side, so ask which of the
two the sentence is ABOUT. Only #2604's survives, as reason (a) ending at that
merge — "unblocked the moment that PR merges" is the model: a session-state
clause is legal only when it names its expiry event on the same line, since
classify-once freezes the DECISION, not the PREMISE. The COLD half of (b) is
such a claim about a MOVING target — the lane keeps reading after the reason
is written (go-to-k/cdkd#2440: deferred on "no file overlap", then the lane's
own PR changed that file `+9/-2`); `/work-issues` `references/retro.md` §10-0
re-checks every `next` at end of run (promoted go-to-k/cdkd#2544, #2595). No
vocabulary gate closes it — `issue-deferral-criteria-gate` refused three
spellings and the fourth walked through; go-to-k/cdkd#2717 retired it. The
criteria above are the control.

**Before writing `next`, NAME the next session's verification** — the
concrete command a FRESH session will run, and that it will be able to run
it. Not "run the integ": the fixture name. If naming it is hard, that is the
finding: the verifier may be host-bound (CPU arch, toolchain, Docker state),
account/region-bound, not yet existing (write it NOW while the subsystem is
loaded — an unwritten fixture is the loose end that compounds; `next` only
under (a) or (b)), or unnameable (an unbounded deferral). Measured: go-to-k/cdk-local#560 was deferred on the
work's CATEGORY while the real verification was "run on an arm64 host" —
which nothing guaranteed. Put the named command in the issue body beside
`Session-fit`.

**Calibration: RUNNING an existing integ is never a deferral reason.**
Measured over the 268-row ledger (2026-08-20): median run 85 s, mean 4.6 min,
p90 8.8 min. A fix riding a fixture the session already runs costs zero.
What is genuinely expensive: WRITING a new fixture, and an integ that FAILS.
Both are `Effort` / `Estimate` lines, not reasons: the fixture is written
cheapest while the subsystem is loaded, and unbounded here is unbounded next
session too.

**Classify by PURPOSE, never by MEANS.** Misfires: "the release PR is
tagpr's, so out of scope" (the purpose was a usable release); "toolchain fix
is developer-facing" (it rode loaded files). Do not hold your own regressions
to a higher reporting bar — noticing one right after shipping is a reason to
raise it.

**A newly DISCOVERED bug is `now` even in a cold subsystem**: its expensive
part is the evidence (repro, observed AWS behavior, measured numbers), which
an issue body cannot carry cheaply — unless that evidence is already
PERSISTED in the repo (a committed fixture or corpus case), when (b) applies
as usual. If deferred anyway on (a) or (b), the issue body carries the
EVIDENCE, not just the diagnosis.

**`next` is not on the menu inside a scope the user framed as "do this across
the repos in one session".** The framing IS the deferral decision; three
tells force `now`: filing the SAME issue body in more than one repo; a
mechanical fix whose evidence is live now; the user already said "finish it
here" (2026-08-20). Same session is the bar; same PR only when reviewable
together.

### Severity — what a USER experiences while it is undone

- **`high`** — wrong result, data loss, a security surface, or hit in normal
  operation.
- **`medium`** — a capability missing with a workaround, or
  condition-specific.
- **`low`** — internal tidiness; wrong text that does not execute (docs
  contradicting shipped code) lands here.

Never rate "why this session should do it" — "main left self-inconsistent"
is a `Session-fit: now` trigger, not a Severity level — rating it `high`
smuggles a Session-fit trigger through the wrong field, and a misrated `high`
now forces `now` by itself. Add the one line saying
what is broken; a bare value still forces the reader to open the issue.

### Effort — which verification cycle it drags

- **`small` (S)** — edit + unit tests, riding verification already paid.
- **`medium` (M)** — one re-review round, or an EXISTING integ fixture this
  session was not otherwise running.
- **`large` (L)** — a NEW integ fixture must be written, or an own-PR
  behavior change / schema bump. A cost, not a `Session-fit` input.

Review and fixture authoring dominate, not integ runtime (calibration above).

### Estimate — hours, plus what eats them

`Estimate: ~1-3 h — the export fixture deploys a NAT gateway, so the integ is
~25 min of the total`. Name what consumes the time — restating the Effort
level is the collapse the split forbids. If unbounded, say what would settle
it.

### Labels

`Severity` / `Effort` are ALSO labels (`severity:high|medium|low`,
`effort:small|medium|large`) — set at filing and at a claim that rewrites an
old packed body; the label is APPLIED in CI from the body (go-to-k/cdkd#2717
retired the refusing hook); the PR inherits them via
`pr-inherit-issue-labels.yml` (label the ISSUE, never the PR by hand). Only these two: `Session-fit` is re-decided at claim (a stale
label is worse than none) and `Estimate` is free-form.

A label can also be **DERIVED** (a 2026-09-06 maintainer-directed sweep
labelled every open cdkd issue from its body). A derived label is a ranking
INPUT, never a measurement — where label and body disagree the BODY wins, and
the lane that learns better corrects both. It still satisfies `/work-issues`
§3-a rule 3's precondition. A lane labels what it touches; a BULK sweep is the
maintainer's call.

## State — WAITING or STOPPED, stated every turn end

- **WAITING (on: ...)** — you resume WITHOUT user input when the condition is
  met and carry the work to its goal. Name three things, one line each: what
  you wait on, how you learn it finished (a completion notification,
  `gh pr checks --watch`, a `Monitor`, a poll loop), what you do next. No
  concrete signal that will re-invoke you means you are STOPPED. List only
  what THIS session will still do — a `Session-fit: next` TODO never appears
  here.
- **STOPPED** — nothing pending; legitimate only when the work is finished.
  Stopping with work undone: say in one line why it is not yours to do.
- **A user decision is NOT a state — it is an `AskUserQuestion` call.**
  "Waiting on the user's answer" never appears on this line.
- **When WAITING, the thing awaited IS the Session-close blocker** — the
  two lines must name the same thing, not diverge.

**A NOT-CLOSEABLE verdict is a TO-DO LIST, not a stopping point** — keep
working until CLOSEABLE or the only blockers are genuinely not yours (CI in
flight, a running reviewer, a maintainer decision). Open PRs, worktrees,
unfiled issues, un-run verification are yours to finish; low context is not
a blocker (bank the work and keep going).

## Report templates

```text
## Remaining work
- TODO #<N> — <what it is>
  - Session-fit: now (do it in this session) | next (not this session) — <one line>
  - Severity: high | medium | low — <what stays broken while it is undone>
  - Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
  - Estimate: <duration> — <what eats the time>
  - Notes: <session-specific context | none>
- Won't-do — <what>
  - Why: <one line>
  - Recorded: <PR body | in-code comment | issue>
(or the single line: Nothing remaining)

## State
- Mode: WAITING | STOPPED
- Waiting on: <what>           (WAITING only)
- Signal: <how you learn it finished>
- Then: <what you do next>

## Session close
- Verdict: CLOSEABLE | NOT CLOSEABLE
- Blocker: <name>              (NOT CLOSEABLE only)
- Tree: <clean, on main | ...>
- Open PRs (this session): <none | #N ...>
- Background tasks: <none | ...>
- AWS leftovers: <none | ...>
- TODOs filed + classified: <yes | ...>
- Open `now` TODOs: <0 | N>

## Not this session          (only when `next` TODOs exist)
- Start with: <literal command>
- Together: <items one fresh session can take at once>
- Separately: <items that must be serialized, and why>
```

Scale the CONTENT to the task, never the SHAPE: same labels, same order, a
field with nothing to say gets `none` / `n/a` (a missing line and a "none"
line mean different things). In the TODO record the four classification lines
are `Key: value — <one-line why>`; no other block owes a why; two keys never
share a line.

### The not-this-session line

Lead with the decision, then the literal start command:

```text
Not this session — start a fresh session with: fix issue <N> (Estimate: ~1-3 h)
```

Never label it "Handoff" / "Next steps" (mechanism, not decision); never
condition it on this session's pending work ("after lane C merges" reads as
this session continuing); never let a `next` item appear on the State line.
Group `next` items by whether one fresh session can take them together
(file-disjoint) or must serialize, and say which.

### When a `now` item exists

All three sections change together: Remaining work lists the four fields plus
`Notes: doing this next`; State is never STOPPED (either WAITING with the
`now` item queued behind a named signal, or keep working without ending the
turn); Session close is NOT CLOSEABLE naming it. A genuinely final report
therefore contains only `next` items and won't-dos — if you reach the end and
find a `now`, DO it, or re-classify with the reason stated. Promoting a
`next` to `now` mid-session is allowed but must be stated as an explicit
re-classification, never by drift. **Before the final report, re-run the
context test on every `next` it lists** — the report is the last moment the
loaded context can still be spent, and the maintainer's question is what this
pass answers in advance.

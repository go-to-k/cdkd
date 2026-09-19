---
description: Session-wrap report field reference (the four TODO fields, the State line, the Session-close verdict, report templates)
paths:
  - 'CLAUDE.md'
---

# Session-wrap report: the full field reference

CLAUDE.md's "Every session-wrap / task-complete report" rule states the
contract; this file carries the field semantics, scales and templates. Read it
when writing a wrap report or filing a deferral.

## The four TODO classification fields

Decide them WHEN THE ITEM ARISES — the moment you defer something and file its
issue — never at wrap time, when the evidence (which files were open, which
verification cycle was paid) is gone. Record them **in the issue body** so they
survive the session. The issue body and the report use the SAME four lines:

```text
Session-fit: now (do it in this session) | next (not this session) — <context test, then the reason>
Severity: medium — <what stays broken while it is undone>
Effort: large (L) — <which verification cycle it drags>
Estimate: ~3 h+ — <what eats the time>
```

A report adds a fifth line, **`Notes`** (`none` when empty); the issue body
carries no `Notes`. The duplicate SEARCH still happens before filing, and on a
HIT there is no issue to classify — the finding becomes a checklist row in the
covering issue.

The four answer four different questions, and none is a spelling of another (the
one sanctioned link: `Severity: high` forces `now` unless external input blocks
it):

| Field | Question it answers | Kind |
| --- | --- | --- |
| `Session-fit` | do I finish it in THIS session? | decision |
| `Severity` | how much does leaving it undone hurt? | value |
| `Effort` | which verification cycle does it drag? | kind of cost |
| `Estimate` | how many hours? | amount of cost |

**Do not collapse `Severity` into `Session-fit`** — a `high` can still be `next`
(external input) and a `low` is usually `now`. **`Effort` is not `Estimate`**:
"one integ run" is a kind of cost; the hours depend on the fixture.

### Spelling rules (mechanical, not taste)

- Keys are English, one spelling, everywhere: `Session-fit` / `Severity` /
  `Effort` / `Estimate` / `Notes`.
- **No bare tokens**: `Session-fit: next (not this session)`, never a lone
  `next`; `Effort: large (L)`, never a lone `L`; `Severity` as a word, **never an
  initial** (`L` collides between severity *low* and effort *large*).
- **Always write both `Effort` AND `Estimate`.**
- One field per line; never two keys on one line.

### Session-fit — the deferral decision

**`now` is the DEFAULT; `next` needs one of two reasons.**

**Write the CONTEXT TEST before the decision**: list the files the fix touches or
must read to be made correctly (tests and docs included), and say, per file,
whether this session already READ it — read, edited, or reviewed in a diff; a
reviewer's read set counts exactly like an author's. ONE loaded file makes the
item `now`: a fresh session pays the launch probe, install, build, the module
read and the evidence re-derivation BEFORE its first edit, while this session
pays the edit alone.

- **`now`** — any of: a file the fix touches is loaded; skipping it leaves main
  self-inconsistent (docs contradicting shipped code, a stale rationale comment,
  a fixture that no longer discriminates); it blocks another lane; it rides an
  EXISTING integ fixture; its evidence exists only in this session (a live repro,
  a real-AWS observation, a measurement — understanding survives in an issue
  body, evidence does not); the user cannot use the result yet (unreleased /
  undeployed — "merged" is not done); leaving it loose COMPOUNDS (an integ
  fixture not yet written for a subsystem this session holds, a pattern landed at
  some sites and not others, a guard with a known hole); or `Severity: high`.
  **Residuals of a just-merged lane** — polish, nits, parity gaps, sibling sites
  a review named — are the hottest context there is and are `now`. Writing a NEW
  integ fixture is `Effort: large`, a cost to record, never a reason to defer.
- **`next`** — ONLY one of: (a) external input (a quota, an upstream fix,
  credentials this host lacks, a file held by another lane's OPEN PR, a
  maintainer decision already asked through `AskUserQuestion` and unanswered); or
  (b) the work is COLD AND HEAVY — nothing the fix touches or must read was read
  this session, no `now` criterion fires, AND doing it here is clearly WORSE than
  fresh, not merely as costly. Cold alone is not (b) — a small cold fix is `now`.
  (b) must stay RARE. **Nothing about the SESSION is a reason**: its length, the
  context left, "it has done enough", a wrap report already drafted, the PR
  already merged.

**No `next` criterion is about the PR.** Splitting work across PRs is normal —
decide that on review surface, and `Session-fit` on the criteria above. The PR's
REVIEW HISTORY ("PR #N took eight rounds, so folding this in is risky") is still
a claim about the PULL REQUEST. Ask which of the two a clause is ABOUT, never
whether it MENTIONS a PR.

**A reason about the FILING SESSION's own STATE expires when that session does**
("scope was frozen at the final review round", "no integ run budgeted"). Such a
clause is legal only when it names its EXPIRY EVENT on the same line
("unblocked the moment that PR merges"), since classify-once freezes the
DECISION, not the PREMISE.

**Before writing `next`, NAME the next session's verification** — the concrete
command a FRESH session will run, and that it will be able to run it. Not "run
the integ": the fixture name. If naming it is hard, that is the finding: the
verifier may be host-bound, account/region-bound, not yet existing (write it NOW
while the subsystem is loaded), or unnameable. Put the named command in the issue
body beside `Session-fit`.

**Calibration: RUNNING an existing integ is never a deferral reason** (median run
under two minutes). What is genuinely expensive is WRITING a new fixture and an
integ that FAILS — both `Effort` / `Estimate` lines, not reasons.

**Classify by PURPOSE, never by MEANS**, and do not hold your own regressions to
a higher reporting bar. **A newly DISCOVERED bug is `now` even in a cold
subsystem**: its expensive part is the evidence, which an issue body cannot carry
cheaply — unless that evidence is already PERSISTED in the repo. If deferred
anyway, the issue body carries the EVIDENCE, not just the diagnosis.

**`next` is not on the menu inside a scope the user framed as "do this across the
repos in one session".** The framing IS the deferral decision.

### Severity — what a USER experiences while it is undone

- **`high`** — wrong result, data loss, a security surface, or hit in normal
  operation.
- **`medium`** — a capability missing with a workaround, or condition-specific.
- **`low`** — internal tidiness; wrong text that does not execute (docs
  contradicting shipped code) lands here.

Never rate "why this session should do it" — "main left self-inconsistent" is a
`Session-fit: now` trigger, not a Severity level. Add the one line saying what is
broken.

### Effort — which verification cycle it drags

- **`small` (S)** — edit + unit tests, riding verification already paid.
- **`medium` (M)** — one re-review round, or an EXISTING integ fixture this
  session was not otherwise running.
- **`large` (L)** — a NEW integ fixture must be written, or an own-PR behavior
  change / schema bump. A cost, not a `Session-fit` input.

### Estimate — hours, plus what eats them

`Estimate: ~1-3 h — the export fixture deploys a NAT gateway, so the integ is
~25 min of the total`. Name what consumes the time. If unbounded, say what would
settle it.

### Labels

`Severity` / `Effort` are ALSO labels (`severity:high|medium|low`,
`effort:small|medium|large`), applied in CI from the issue BODY; the PR inherits
them via `pr-inherit-issue-labels.yml` — label the ISSUE, never the PR by hand.
Only these two: `Session-fit` is re-decided at claim, `Estimate` is free-form.
A DERIVED label is a ranking INPUT, never a measurement — where label and body
disagree the BODY wins.

## State — WAITING or STOPPED, stated every turn end

- **WAITING (on: ...)** — you resume WITHOUT user input when the condition is met
  and carry the work to its goal. Name three things, one line each: what you wait
  on, how you learn it finished (a completion notification,
  `gh pr checks --watch`, a `Monitor`, a poll loop), what you do next. No
  concrete signal that will re-invoke you means you are STOPPED. A
  `Session-fit: next` TODO never appears here.
- **STOPPED** — nothing pending; legitimate only when the work is finished.
  Stopping with work undone: say in one line why it is not yours to do.
- **A user decision is NOT a state — it is an `AskUserQuestion` call.**
- **When WAITING, the thing awaited IS the Session-close blocker** — the two
  lines must name the same thing.

**A NOT-CLOSEABLE verdict is a TO-DO LIST, not a stopping point** — keep working
until CLOSEABLE or the only blockers are genuinely not yours (CI in flight, a
running reviewer, a maintainer decision). Low context is not a blocker.

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

Scale the CONTENT to the task, never the SHAPE: same labels, same order, a field
with nothing to say gets `none` / `n/a`.

### The not-this-session line

Lead with the decision, then the literal start command:

```text
Not this session — start a fresh session with: fix issue <N> (Estimate: ~1-3 h)
```

Never label it "Handoff" / "Next steps"; never condition it on this session's
pending work; never let a `next` item appear on the State line. Group `next`
items by whether one fresh session can take them together (file-disjoint) or must
serialize.

### When a `now` item exists

All three sections change together: Remaining work lists the four fields plus
`Notes: doing this next`; State is never STOPPED; Session close is NOT CLOSEABLE
naming it. A genuinely final report contains only `next` items and won't-dos — if
you reach the end and find a `now`, DO it, or re-classify with the reason stated.
**Before the final report, re-run the context test on every `next` it lists** —
the report is the last moment the loaded context can still be spent.

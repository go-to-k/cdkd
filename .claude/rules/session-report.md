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

Decide them WHEN THE ITEM ARISES — at the moment you defer something and file
its issue — never at wrap time, when the evidence (which files were open,
which verification cycle was already paid) is gone. Record them **in the
issue body** so they survive the session. The issue body and the report use
the SAME four lines:

```text
Session-fit: next (not this session) — <one-line reason>
Severity: medium — <what stays broken while it is undone>
Effort: large (L) — <which verification cycle it drags>
Estimate: ~3 h+ — <what eats the time>
```

A report adds a fifth line, **`Notes`**, for session-specific context (write
`none` when empty). The issue body carries no `Notes` but does carry
**`Dup-check:`**, written at filing time (see `/work-issues` §5-f); on a
dup-check HIT there is no issue to classify — the finding becomes a checklist
row in the covering issue.

The four answer four different questions, and none derives from another:

| Field | Question it answers | Kind |
| --- | --- | --- |
| `Session-fit` | do I finish it in THIS session? | decision |
| `Severity` | how much does leaving it undone hurt? | value |
| `Effort` | which verification cycle does it drag? | kind of cost |
| `Estimate` | how many hours? | amount of cost |

**Do not collapse `Severity` into `Session-fit`** — a `high` can be `next` (a
new fixture must be written) and a `low` can be `now` (it lands in an open
file); the moment the two track each other one field is wasted. **`Effort` is
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
  wrong three separate ways (`M` for a duration, `now`/`next` bare, "Handoff"
  as a label), always because a short token is cheap to emit and its
  expansion is not.
- One field per line; never two keys on one line.

### Session-fit — the deferral decision

- **`now`** — finish in this session. Any of: it lands in files this session
  already has open (re-acquiring context costs more than the work); skipping
  it leaves main self-inconsistent (docs contradicting shipped code, a stale
  rationale comment, a fixture that no longer discriminates); it blocks
  another lane; **it rides an EXISTING integ fixture** (calibration below);
  **its evidence exists only in this session** (a live repro, a real-AWS
  observation, a measurement — understanding survives in an issue body,
  evidence does not); or **the user cannot use the result yet** (unreleased /
  undeployed — "merged" is not done; this criterion alone is decided by
  whether the request's purpose is met).
- **`next`** — hand off. Any of: a NEW integ fixture must be WRITTEN; a
  schema bump / behavior change that must not share a PR; bundling makes the
  PR unreviewable; external input (a quota, a maintainer decision, an
  upstream fix); an independent subsystem with no file overlap AND no `now`
  criterion firing.

**Before writing `next`, NAME the next session's verification** — the
concrete command a FRESH session will run, and that it will be able to run
it. Not "run the integ": the fixture name. If naming it is hard, that is the
finding: the verifier may be host-bound (CPU arch, toolchain, Docker state),
account/region-bound, not yet existing (the one case where `next` is
genuinely right), or unnameable (an unbounded deferral). Measured:
go-to-k/cdk-local#560 was deferred on the work's CATEGORY while the real
verification was "run on an arm64 host" — which nothing guaranteed. Put the
named command in the issue body beside `Session-fit`.

**Calibration: RUNNING an existing integ is never a deferral reason.**
Measured over the 268-row ledger (2026-08-20): median run 85 s, mean 4.6 min,
p90 8.8 min. A fix riding a fixture the session already runs costs zero.
What is genuinely expensive: WRITING a new fixture, an integ that FAILS
(unbounded, and paid next session too), and above all REVIEW of a larger
diff, which grows superlinearly. Defer on those.

**Classify by PURPOSE, never by MEANS.** Misfires to avoid: "the release PR
is tagpr's, so out of scope" (the purpose was a usable release); "toolchain
fix is developer-facing" (it rode open files and the current cycle);
"only two occurrences so far" (2 of 2 opportunities with the mechanism
known). Do not hold your own regressions to a higher reporting bar — noticing
one right after shipping is a reason to raise it, not to wait.

**Right after a merge, `next` is the default for RESIDUALS** (deferred
polish, nits, parity gaps) — what stays hot is the merged lane's own files.
**A newly DISCOVERED bug flips the default**: its expensive part is the
evidence (repro, observed AWS behavior, measured numbers), which an issue
body cannot carry cheaply — `now` unless a `next` criterion genuinely fires,
and if deferred anyway, the issue body carries the EVIDENCE, not just the
diagnosis.

**`next` is not on the menu inside a scope the user framed as "do this across
the repos in one session".** The framing IS the deferral decision. Three
tells force `now`: filing the SAME issue body in more than one repo; a
mechanical fix whose evidence is live now; the user already said "finish it
here" (measured 2026-08-20: a three-repo consolidation filed the residual as
three per-repo issues and had to carry them in-session after the user
objected). Same session is the bar; same PR only when reviewable together.

### Severity — what a USER experiences while it is undone

- **`high`** — wrong result, data loss, a security surface, or hit in normal
  operation.
- **`medium`** — a capability missing with a workaround, or
  condition-specific.
- **`low`** — internal tidiness; wrong text that does not execute (docs
  contradicting shipped code) lands here.

Never rate "why this session should do it" — "main left self-inconsistent"
is a `Session-fit: now` trigger, not a Severity level (copying it here makes
that flavour of `high` permanently un-`next`-able). Add the one line saying
what is broken; a bare value still forces the reader to open the issue.

### Effort — which verification cycle it drags

- **`small` (S)** — edit + unit tests, riding verification already paid.
- **`medium` (M)** — one re-review round, or an EXISTING integ fixture this
  session was not otherwise running.
- **`large` (L)** — a NEW integ fixture must be written, or an own-PR
  behavior change / schema bump.

Review and fixture authoring dominate, not integ runtime (calibration above).

### Estimate — hours, plus what eats them

`Estimate: ~1-3 h — the export fixture deploys a NAT gateway, so the integ is
~25 min of the total`. Name what actually consumes the time — restating the
Effort level is the collapse the split forbids. If genuinely unbounded, say
what would settle it.

### Labels

`Severity` / `Effort` are ALSO labels (`severity:high|medium|low`,
`effort:small|medium|large`) — set at filing and at a claim that rewrites an
old packed body; enforced by `issue-classification-label-gate.sh`; the PR
inherits them via `pr-inherit-issue-labels.yml` (label the ISSUE, never the
PR by hand). Only these two: `Session-fit` is re-decided at claim (a stale
label is worse than none) and `Estimate` is free-form.

## State — WAITING or STOPPED, stated every turn end

- **WAITING (on: ...)** — you resume WITHOUT user input when the condition is
  met and carry the work to its goal. Name three things, one line each: what
  you wait on, how you learn it finished (a completion notification,
  `gh pr checks --watch`, a `Monitor`, a poll loop), what you do next. If you
  cannot name a concrete signal that will re-invoke you, you are STOPPED.
  List only what THIS session will still do — a `Session-fit: next` TODO
  never appears here.
- **STOPPED** — nothing pending; legitimate only when the work is finished.
  If stopping with work undone, say in one line why it is not yours to do.
- **Needing a user decision is NOT a state — it is an `AskUserQuestion`
  call.** "Waiting on the user's answer" never appears on this line.
- **When the state is WAITING, the thing being awaited IS the Session-close
  blocker** — the two lines must name the same thing, not diverge.

**A NOT-CLOSEABLE verdict is a TO-DO LIST, not a stopping point** — keep
working until CLOSEABLE or the only blockers are genuinely not yours (CI in
flight, a running reviewer, a maintainer decision). Open PRs, unremoved
worktrees, unfiled issues, un-run verification are all yours to finish; low
context is not a blocker (bank the work and keep going).

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
Not this session — start a fresh session with: /work-issues
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
re-classification, never by drift.

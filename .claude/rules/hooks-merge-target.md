---
description: cdkd merge-time live-query gates (ci-green-gate, pr-review-gate) - what "the target PR" means, and the repo-slug forwarding that decides it
paths:
  - '.claude/hooks/ci-green-gate.sh'
  - '.claude/hooks/ci-green-gate.test.sh'
  - '.claude/hooks/pr-review-gate.sh'
  - '.claude/hooks/pr-review-gate.test.sh'
---

# Which pull request the merge-time gates judge

Split out of [hooks.md](hooks.md) by go-to-k/cdkd#3273, when the entry it grew
took the `lib/command-match.sh` payload past its 120,000 B cap — the same
precedent as [hooks-cwd-detector.md](hooks-cwd-detector.md) and
[hooks-branch-gate.md](hooks-branch-gate.md). hooks.md keeps a one-line pointer
in its "CI-green merge gate" section; this file's `paths:` glob is narrow, so
the detail is a token toll only on a session touching these two gates.

## A PR NUMBER DOES NOT NAME A PULL REQUEST

go-to-k/cdkd#3273. `42` exists in every repository, so recovering the number
from the command and querying with no `-R` judged whatever repo the SHELL was
in. Measured through the shipped hooks from a cdkd worktree, with an
argv-recording `gh` — the argv is the measurement, and gh resolving a
`-R`-less command against the CWD's repo is what makes it the wrong PR:

```
gh pr merge 42 -R go-to-k/cdk-local --squash
  ci-green-gate   ->  gh pr checks 42          # so: CDKD's PR 42's CI state
  pr-review-gate  ->  gh pr view 42 --json …   # so: CDKD's PR 42's size, headRefOid
```

A wrong ANSWER rather than a silent pass, and wrong in BOTH directions — a
green local 42 clears a red foreign one, and a red local 42 refuses a green
one. The first direction is the dangerous one, and the cross-repo merge flow it
needs is the one [hooks.md](hooks.md)'s "Working on a sibling repo from a cdkd
session" section describes as routine.

For `pr-review-gate` the blast radius is wider than the tier: the sentinel is
compared against the `headRefOid` that lookup returned, so a marker bound to the
real PR reads as stale and one bound to the other repo's HEAD reads as fresh.
Its fix-back heuristic needed no separate change — it takes `owner` / `repo`
from the PR's own `url`, which now comes from the right PR.

Both gates resolve the slug with the shared `gate_gh_repo_slug` (either flag
slot, and after the verb too) and forward `-R <slug>`. `verify-pr-gate` was
never affected: it REFUSES to relax when a command names another repo rather
than reading which one.

## Two ways the FIX reproduced the defect, caught in review

Both are worth reading before editing `gate_gh_repo_slug`, because each looked
correct and each re-opened the exact hole go-to-k/cdkd#3273 is about.

- **`gh` takes the LAST `-R`; the first walk took the FIRST.** Measured on
  gh 2.92.0 in three slot orders — `-R a -R b` and `gh -R a pr view … -R b`
  both answer **b**. So `gh pr merge 42 -R <this repo> -R <other repo>`
  forwarded `-R <this repo>`, and a green local 42 cleared a merge in the other
  one: the defect, reproduced by its fix. **The walk now runs to the end of the
  segment and REFUSES two DISTINCT slugs** rather than mirroring gh's
  precedence. That choice is deliberate: mirroring encodes a MEASUREMENT of
  cobra's precedence into a gate whose whole job is to be right about which
  repo gh acts on, so if that precedence ever differs — by slot, by spelling,
  by gh version — the gate silently judges the wrong repo again. Refusing
  cannot be wrong that way, it is `gate_target_dir_strict`'s posture, and it
  costs nothing real: gh acts on ONE repo, so no legitimate command names two.
  Two IDENTICAL slugs are not ambiguous and behave like one — pinned in both
  gates, in both directions.
- **A trailing comment was read as a repository.** The walk tokenised the raw
  segment, so the apostrophe in `gh pr merge 42 --squash # don't wait` opened a
  quote, the split truncated, and the truncation was reported as rc 2 — a
  refusal whose message says the command "names a repository with `-R`" when it
  names none. `gate_strip_comment` runs first now; the library's own doc for
  that helper had recorded the identical bug for `gate_argv`.

## The call is BOUNDED, and that became load-bearing here

`pr-review-gate` has wrapped its `gh` calls in `gate_bounded` since
go-to-k/cdkd#2638; `ci-green-gate` did not, and go-to-k/cdkd#3273 is what made
that matter. A hook killed by its registered timeout emits NO exit 2, which
propagates as a non-blocking error — a SILENT PASS on a merge gate. That was
tolerable while nothing in the COMMAND TEXT could choose what `gh` talks to.
Forwarding a slug ends it: measured, `gh pr checks <n> -R <unroutable host>/o/r`
takes 30 s against that hook's registered 20 s.

`gate_bounded` therefore MOVED from `pr-review-gate.sh` into
`lib/command-match.sh` — one shared mechanism rather than 70 lines of perl
copied — with one addition: it discards the wrapped command's stderr by design
(so the wrapper can still speak), and `ci-green-gate` PARSES that stderr, since
"no checks reported" arrives there and is the only discriminator between "no CI
yet" and "a check failed" (both rc=1). `GATE_BOUNDED_KEEP_STDERR=1` is the
opt-in; it defaults OFF, so `pr-review-gate`'s behaviour is byte-for-byte
unchanged. A timeout with a slug named REFUSES; with none it keeps today's
infra fail-open.

## Three consequences, before touching either gate

- **An unreadable slug REFUSES** — `-R "$VAR"`, a substitution, a trailing `-R`
  with no value. Falling back to the cwd there is the defect with an extra
  step, so this is `gate_target_dir_strict`'s posture applied to the REPO
  rather than to the directory. A hook receives command TEXT, so the
  worktree-style `-R "$SLUG"` arrives unexpanded and guessing is what produced
  the bug.
- **The infra fail-open does not survive an explicit `-R`.** It is unchanged
  for the ordinary cwd-relative merge — an unrelated GitHub outage must not
  block those. With a slug named, an unreadable answer BLOCKS: "that repo is
  unreachable from here" and "GitHub is down" are the same answer, and the gate
  then knows nothing at all about the PR it would be clearing. In
  `ci-green-gate` that is TWO shapes, because rc alone does not cover it —
  rc > 1 (transport), and **rc=1 with no tab-separated rows**, which is what
  `gh pr checks <n> -R <unreachable>` returns and what the `not_green` awk would
  otherwise read as "nothing is red". Both branches are narrow by construction:
  neither can fire for a command that names no repo.
- **A short-flag CLUSTER carrying `R` (`-cR <slug>`, `-sR<slug>`) is a DECLARED
  residue**, not a closed case. `gh` honours it (measured 2026-09-16 on 2.92.0,
  recorded in `verify-pr-gate.sh`), and the caller then judges the cwd repo
  exactly as it did before. It is left because the cluster is not decidable
  from the text: only a per-flag ARITY table separates `-sR <slug>`
  (`--squash --repo <slug>`) from `-tRelease` (`--subject Release`), and that is
  the enumeration [hooks-class-fences.md](hooks-class-fences.md) refuses.
  Over-refusing it was considered and rejected — on a MERGE gate a wrong
  refusal is not cheap. Filed as go-to-k/cdkd#3301. A repo arriving through
  `GH_REPO`, a URL selector or an `upstream` remote is the same kind of
  residue and is go-to-k/cdkd#3235's subject.

## Three more residues, all PRE-EXISTING and all in the refusing direction

Confirmed by the delta security round to predate the slug forwarding. None is a
bypass; each is recorded so the next reader does not re-derive it.

- **`-R=o/r`** is accepted by gh but read here as the value `=o/r`, so the gate
  forwards a slug gh then rejects, and the slug-present arm BLOCKS. An
  over-refusal, which is the direction this whole guard errs in.
- **`--subject "-Rx/y"`** reads `x/y` — the flag-ARITY residue, the same family
  as the cluster above and go-to-k/cdkd#3301's subject. Nothing here knows
  `--subject` takes a value.
- **Two spellings of the SAME repo** (`o/r` vs `O/R` vs a URL vs `-R=o/r`)
  refuse as "distinct", because the comparison is textual. Harmless: no
  legitimate command names one repository twice in two spellings, and the
  outcome is a refusal rather than a wrong answer.

The bounding property they share is the one to keep: **every shape this parser
gets wrong lands on a REFUSAL, never on a verdict about the wrong repo.** That
is what makes the residue list a cost rather than a hole.

## The perl-absent arm is part of the gate, not a detail

`gate_bounded` degrades to running the command unbounded when perl is missing
from PATH, and that arm hardcoded `"$@" 2>/dev/null`. `ci-green-gate` reads
"no checks reported" off gh's STDERR, so with perl absent the discriminator
vanished: stdout empty, rc=1, `not_green` empty — **PASS**. A fail-open caused
by a missing INTERPRETER, introduced by the go-to-k/cdkd#3273 delta itself and
caught in its security round. The arm honours `GATE_BOUNDED_KEEP_STDERR` now.

Reachability on macOS is effectively nil (`/usr/bin/perl` ships), which is why
it was not a blocker — but a gate that fails open because a binary is absent is
exactly the shape [hooks.md](hooks.md) refuses, and the fence is three cases in
`ci-green-gate.test.sh` running the hook against a PATH with no perl: a
no-checks answer and a red check must still BLOCK, and an all-green one must
still pass, so the degraded arm is not a blanket refusal either. The fixture
asserts its own premise first — a PATH that still resolved perl would make all
three vacuous. Restoring the hardcoded redirect reds exactly the no-checks
case, rc 2 → 0, which is the fail-open itself.

## The suites: an exit code cannot say WHICH

**The argv-recording blocks are the load-bearing part of both suites.** A
wrong-repo answer is byte-identical to a correct one from outside — same exit
codes, same messages, same cwd — so every case that does not read the trace is
satisfied by the defect. That is exactly how #3273 survived a gate whose own
suite was green.

- `ci-green-gate.test.sh` — the `argv-bin` shim records `$*`; `want_pr_number`
  reads the NUMBER out of it and `want_pr_repo` the `-R`. They are independent
  facts about the same question and neither implies the other.
- `pr-review-gate.test.sh` — records `pr view` argv for the same reason its
  graphql half has since go-to-k/cdkd#2638. The NUMBER-LESS arm
  (`gh pr merge --auto -R <slug>`) is a separate `gh pr view` invocation in the
  hook, so it carries its own case: a fix applied to one arm and not the other
  is the sibling-site miss `/work-issues` warns about.
- The unreadable-slug cases assert **exit 2 AND an empty argv trace**. Exit 2
  alone is also what a stale marker produces, so the empty trace is what says
  the gate refused rather than queried the wrong repo and happened to find it
  red.
- Each block carries the CONTROL that keeps the change narrow: a command naming
  no repo still asks cwd-relative, and the same `gh` failure with no `-R` still
  fails OPEN and still says so.

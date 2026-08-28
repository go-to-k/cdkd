<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## Gotchas (learned the hard way)

- **Claim before editing, always** — the whole point. An unclaimed lane races a
  parallel agent onto the same cross-cutting file.
- **Claiming is not winning.** Posting the comment does not end the race — read
  it back and yield to an earlier `createdAt` (§4). Claiming late, after the
  triage, is what makes the race winnable in the first place.
- **A pushed branch with no PR is a live lane.** `gh pr list` goes blind during the
  window between a lane's first push and its `gh pr create` — which is when it is
  writing hardest — and `git worktree list` shows the lane without saying it is
  alive. `git for-each-ref --sort=-committerdate refs/remotes/origin` after a
  `git fetch` is what sees the push (§2). Issue comments are NOT blind here: §4
  posts the claim before the first edit, so it already exists by the time anything
  is pushed. The window that IS the claim comment's alone is the mirror of this one
  — a lane with a worktree and nothing pushed at all (§3, §9).
- **A fresh issue is someone's deferral, not free backlog** (§3-0). The author field
  proves nothing about which session filed it, so the 60-minute window is the whole
  defence — and §4 is its other half: claim what you FILE, not only what you take.
- **The filer may already have classified the issue.** A body carrying
  `Session-fit: next` names the cycle the issue needs; take it only if this run
  can pay for that, and say why in the claim (§3). On 2026-08-13 go-to-k/cdkd#1791
  passed every §2 / §3 gate — `fix(export)`, unclaimed, disjoint from all eight live
  lanes — was claimed, and had to be retracted after the deep read showed the
  legacy-state fixture arm plus export integ its body had already named. The line
  was in the body the whole time; nothing but a grep stood between the run and it.
- **A cross-repo framing spends the deferral budget up front.** When the user
  says "do this across the repos in one session", `Session-fit: next` is no
  longer available for anything discovered inside that scope — the decision was
  made when the scope was set, and a discovery inside it inherits it. Three
  tells make it unarguable: you are about to file the SAME issue body in more
  than one repo (that split is what the framing exists to end, so filing it is
  the failure, not triage); the fix is mechanical and its evidence is live right
  now (repro built, files open, a gate cycle already turning); or the user
  already said "finish it here" about the surrounding task. Remember what the
  four fields are for: they make a deferral HONEST, they do not make one
  available. An `Effort` / `Estimate` pair that reads defensibly for work the
  run is already positioned to do is the tell that the classification is being
  written as an excuse. On 2026-08-20 a run consolidating one `/work-issues`
  lesson across cdkd, cdk-local and cdk-real-drift discovered the siblings'
  PreToolUse gates were inert, fixed them, and then filed the remaining
  script-level gap as three separate issues — the exact per-repo split the user
  had asked it to end. It was carried in the same session as a follow-up PR per
  repo once the user objected: **same session is the bar; same PR only when the
  work is small enough to review together.**
- **A mirror issue may already be carried elsewhere.** Historically §10-c's
  hop-by-hop mirroring filed one lesson into one repo twice; the same-session
  three-repo clauses removed that source, but a lesson can still already sit in a
  target repo because a sibling found it first. Resolve it against the file, open
  PRs and open issues before filing one (§10-c) or claiming one (§3). Which of the
  three finds it depends only on how long ago the other work landed.
- **One lane per cross-cutting file.** The files §2 lists as contested absorb most
  non-trivial fixes; you cannot parallelize two issues that both land there.
  Per-provider fixes ARE disjoint — parallelize those freely. §2 holds the list;
  this bullet does not restate it, for the reason go-to-k/cdkd#2076 records.
- **Never merge a PR whose destroy path is unverified.** A green CI does not
  exercise real-AWS destroy. If the fix touches any `delete()` / DAG-destroy-order /
  state-cleanup path, the `integ-destroy` (+ `integ-broad`) gate blocks the merge
  until `/run-integ` completes the destroy step with zero orphans.
- **Never bypass `/run-integ`** with a raw `cdkd deploy` / `cdkd destroy` — the
  skill is what guarantees the destroy + orphan sweep + ledger write happen together.
- **Unique stack names on a real account** — it may hold PROD stacks; a shared
  fixed name risks clobbering one.
- **`vp run build` before any live test**, and re-`build` after every source edit —
  the user runs `node dist/cli.js`, so an unbuilt change is invisible.
- **Stale-base phantom diff** (§7) — never "restore" the peer's lines a stale
  `git diff main` appears to have removed; rebase instead.
- **`bash cwd silent reset`** — a persistent Bash cwd can drift back to the main
  tree between calls; use `git -C .claude/worktrees/<branch>` for git ops and
  re-`cd` before relative-path commands. **Its worst form is not a misplaced
  edit but a FALSE GREEN on a verification command**, because a gate run from
  the main tree verifies unmodified `main` and passes: on 2026-08-20 a lane
  reported `vp run typecheck:test` RC=0 twice while its own worktree held 20
  type errors, and the same command with an explicit `cd` returned RC=1. The
  tell was a COUNT, not an error — 123 tests without the `cd` against 143 with
  it — so a run that only reads rc cannot detect it. Prefix every verification
  command with `cd <worktree> &&`, and when a result is surprisingly clean,
  check `pwd` before believing it. **A BACKGROUNDED call gets this wrong even
  when you know the rule**, because the `cd` you were relying on came from an
  earlier tool call and the backgrounded command starts from the session cwd,
  which may have drifted. Measured twice on 2026-08-26: an orchestrator launched
  a full `/check` that began in the MAIN tree (killed before it could report a
  false green), and a lane agent's cwd silently moved into a DIFFERENT lane's
  worktree mid-round. Make every long-running call print its own `pwd` as its
  first line and read that line before the results — the receipt costs nothing
  and is the only thing separating "green" from "green somewhere else".
  **When it has already happened, the two
  obvious repairs are both refused**: `git checkout -- <path>` trips
  `dirty-path-restore-gate` (the stray edit IS uncommitted work, and the gate
  cannot know you have a copy elsewhere) and writing the file back trips
  `main-tree-edit-gate`. Re-apply the edit in the worktree with an ABSOLUTE
  path first, then `git -C <main> stash push -m <label> -- <path>` — that clears
  the main tree without discarding anything, so neither gate has cause to
  object. Drop the stash only after confirming `stash@{0}`'s message is yours;
  parallel lanes stash too, and the indices shift (2026-08-19). A blocked call
  runs NOTHING, preamble included — §6 has the rule and what it costs.

## Important existing rules this skill leans on

- **All changes via PR; never commit to `main`.** Feature work lives in its OWN
  worktree under `.claude/worktrees/<branch>/`; the orchestrator integrates.
  (`CLAUDE.md` → Workflow Rules.)
- **Always add unit tests** for a fix — do not wait to be asked. (`CLAUDE.md` →
  Workflow Rules.)
- **Merge with `--squash --delete-branch` only** — the repo's sole merge method.
- **English-only** for all committed/public artifacts (source, docs, PR/commit
  messages, issue comments on this repo).
- **`Severity` / `Effort` go on the issue as LABELS too** — same two values, body
  text unchanged (`CLAUDE.md` → the four TODO classification fields). Set at
  filing (§5) and at the claim that rewrites an old packed body (§4). The lane's
  PR inherits them from the issue it closes, so never hand-add them to a PR.
- **Never download/run/install untrusted third-party content** (§0).
- **Drive each lane to MERGED, not to "pushed".** Section 9 is the finish line for
  a LANE — merge, pull, confirm the release bump, rebuild, remove the worktree —
  and section 10 is the finish line for the RUN. A lane left as an open PR is
  unfinished work, and a NOT-CLOSEABLE session verdict is a to-do list rather
  than a stopping point — keep going
  until every lane is merged and every worktree removed, or until the only
  blockers left are ones you cannot act on (CI in flight, a running reviewer, a
  maintainer decision). Low context is not such a blocker: commit, push, file
  the issue, and continue. If you stop, say per blocker WHY it is not yours to
  finish.
- **Wrap with a Remaining-work section + State line + Session-close verdict,
  scoped to the issues this run actually worked.** This skill is the easiest
  place to get that scope wrong: the backlog issues you triaged but did NOT pick
  up are not follow-ups and do not belong in the report. List only residuals of
  the lanes you shipped (gaps, deferred polish, issues filed because of this
  work). (`CLAUDE.md` → Workflow Rules.)
- **Classify every deferral `now` / `next` the moment you defer it — this flow
  is where that decision is hardest and most often re-litigated.** Each merge in
  section 9 lands on the same question: keep going here, or hand off to a fresh
  session / another agent? Answer it when the item is created — write the four
  classification lines into the issue body, one field per line, per
  `CLAUDE.md` → "The four TODO fields" — not after the merge when the
  context that justified it is gone:

  ```text
  Session-fit: now (do it in this session) | next (not this session) — <reason>
  Severity: high | medium | low — <what stays broken while it is undone>
  Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
  Estimate: <duration, e.g. ~1-3 h -- never a bare letter> — <what eats the time>
  ```

  The report repeats those same four lines and adds a `Notes` line for
  session-specific context; the issue body carries no `Notes`. It does carry a `Dup-check:` line (section 5), which is a filing-time record rather than a classification field. **After a lane merges, `next` is the
  default**: what stays hot is that lane's files and the integ you already ran,
  and nothing else — so a residual landing in those files is `now`, and a
  residual anywhere else is `next` even when it looks small.
  A fan-out run makes this sharper than usual in two directions: a residual that
  lands in a lane you are STILL holding a worktree for is almost always `now`
  (the worktree, the deps and the markers are already paid for, and removing it
  and re-creating it later is most of the cost), while a residual in a lane you
  just merged and cleaned up has lost exactly those things and is `next`.

  **The trap is that the filing happens mid-lane, and the wrong question is the
  loud one there.** Mid-review the question in your head is "can this ride THIS
  PR?" — a reviewability question, whose answer is usually no — while the one the
  rule asks is "is that lane's worktree still open?", which is quiet and usually
  yes. Measured 2026-08-27: a three-lane run filed go-to-k/cdkd#2321 and
  go-to-k/cdkd#2322 as `next` while the lanes owning `import.ts` and
  `s3-bucket-provider.ts` were both still open; §10-0's promotion check then hit on
  both at wrap, by which point the worktrees were gone, the markers were spent, and
  `next` had become the correct answer to a question that had a different answer an
  hour earlier. Both are ~30-60 min items that would have ridden an integ their
  lane was running anyway, at a marginal cost of zero. So ask the worktree question
  explicitly at FILING time, not the PR-size one: a separate PR from the same open
  worktree is cheap, and is not what `next` is for.

  Close
  the run with the **not-this-session line** — the decision first, then the
  literal command (`Not this session — start a fresh session with: /work-issues`)
  — and say which `next` items are file-disjoint enough for one fresh run to
  take together. Do NOT label it "Handoff" or "Next steps": those name how the
  work moves, not whether this run will do it, which is the one thing the reader
  needs.
  **This flow is where that line is most likely to be written ambiguously**,
  because lanes merge at different times: while one lane is still in flight the
  report is simultaneously "waiting on lane C" and "handing off three issues",
  and a line phrased as "next session, after lane C merges" collapses the two
  into "this run continues into them once C lands". Write the start command with
  NO condition attached, and keep the `next` items off the State line entirely —
  that line is only for lanes this run is still driving to merge.
  Conversely, a `now` item found mid-run (a residual landing in a lane whose
  worktree is still open) is a commitment this run finishes it: it goes in
  Remaining work WITH what you are about to do about it, the State line is never
  STOPPED while it is open, and the verdict is NOT CLOSEABLE naming it. A final
  report can therefore only ever list `next` items and won't-dos.
- **This flow parks a LOT, so the State line carries most of its weight.** A
  fan-out run spends most of its wall-clock parked on something: a lane subagent
  still implementing, `gh pr checks --watch` on a lane's CI, a `/run-integ`
  against real AWS, the `chore(release)` bump after a merge. Every one of those
  is **WAITING**, not STOPPED — you resume with no user input and drive the lane
  to merged. Name the lane and the signal per line, e.g.
  `WAITING — lane A (go-to-k/cdkd#1752) subagent: background completion notification -> review tier, live-test evidence, then merge`.
  Report **STOPPED** only when every lane is merged, every worktree removed and
  nothing is pending; a run that ends STOPPED with an open PR is the failure the
  "Drive each lane to MERGED" rule above exists to prevent.

  **ARM the signal BEFORE you write the line, not after — a named signal is not
  an armed one.** The rule above says to name what will re-invoke you, and naming
  it is the part that feels like compliance; the poll, the `Monitor` or the
  backgrounded `until` loop is the part that actually resumes the run. Write the
  report only once the thing that will wake you is RUNNING, so the line describes
  a mechanism rather than an intention. Measured 2026-08-28: a run with two PRs
  in CI wrote `WAITING — waiting on: CI on both PRs / Signal: gh pr checks` and
  armed nothing, so it simply ended; the maintainer had to ask why it had
  stopped. Every other field of that report was accurate, which is what makes the
  failure invisible from inside — the only thing missing was a running process.
- **A lane needing a user decision goes through `AskUserQuestion`, never prose.**
  Scope calls this skill legitimately escalates (an issue whose fix direction
  only the maintainer can pick; whether to engage an untrusted comment per §0)
  are asked with the tool, so the run continues from the answer. Do NOT end the
  turn with the question in prose — that reads as STOPPED and loses the other
  lanes' momentum. Everything else (which integ to run, how many reviewers, how
  deep to verify) you decide yourself and report as a decision.

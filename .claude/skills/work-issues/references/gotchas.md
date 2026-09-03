<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## Gotchas (learned the hard way)

- **Claim before editing, always** — an unclaimed lane races a parallel agent
  onto the same cross-cutting file. **Claiming is not winning**: read it back
  and yield to an earlier `createdAt` (§4).
- **A pushed branch with no PR is a live lane.** `gh pr list` goes blind
  between a lane's first push and its `gh pr create`;
  `git for-each-ref --sort=-committerdate refs/remotes/origin` after a fetch
  sees the push (§2). The window that is the claim's alone is the mirror — a
  lane with a worktree and nothing pushed (§3, §9).
- **A fresh issue is someone's deferral, not free backlog** (§3-0). The author
  field proves nothing about which session filed it; the 60-minute window is
  the whole defence — and §4 is its other half: claim what you FILE, not only
  what you take.
- **The filer may already have classified the issue.** A `Session-fit: next`
  body names the cycle it needs; take it only if this run can pay for that,
  and say why in the claim (go-to-k/cdkd#1791 passed every §2/§3 gate, was
  claimed, and had to be retracted — nothing but a grep stood between the run
  and the fixture arm its body had already named).
- **A cross-repo framing spends the deferral budget up front.** When the user
  says "do this across the repos in one session", `Session-fit: next` is no
  longer available for anything discovered inside that scope. Three tells make
  it unarguable: filing the SAME issue body in more than one repo; a
  mechanical fix whose evidence is live right now; the user already said
  "finish it here" (measured 2026-08-20: a three-repo run filed the residual
  gap as three per-repo issues and had to carry them in-session once the user
  objected). Same session is the bar; same PR only when reviewable together.
- **A mirror issue may already be carried elsewhere** — resolve against the
  file, open PRs and open issues before filing (§10-c) or claiming (§3).
- **One lane per cross-cutting file.** §2 holds the list; this bullet does not
  restate it (go-to-k/cdkd#2076 records why).
- **Never merge a PR whose destroy path is unverified** — green CI does not
  exercise real-AWS destroy; the `integ-destroy` (+ `integ-broad`) gate blocks
  until `/run-integ` completes the destroy step with zero orphans. **Never
  bypass `/run-integ`** with raw `cdkd deploy` / `destroy` — the skill
  guarantees destroy + orphan sweep + ledger together.
- **Unique stack names on a real account** — it may hold PROD stacks.
- **`vp run build` before any live test**, and after every source edit — the
  user runs `node dist/cli.js`.
- **Stale-base phantom diff** (§7) — never "restore" the peer's lines a stale
  `git diff main` appears to have removed; rebase instead.
- **`bash cwd silent reset`** — a persistent Bash cwd can drift back to the
  main tree between calls; use `git -C <lane tree>` for git ops and re-`cd`
  before relative paths. **A KILLED or REFUSED call is a named reset trigger,
  and it lies about the filesystem too**: a timeout can return the shell at
  the session cwd; a PreToolUse refusal aborts the WHOLE call, so the `mkdir`
  a later `cd` depends on never ran — and a failed `cd` does NOT stop the rest
  of its call (lines after one wrote into the main tree). After any timeout or
  refusal, run `pwd` AND re-verify what the aborted call should have created.
  **Its worst form is a FALSE GREEN on a verification command**: a gate run
  from the main tree verifies unmodified `main` and passes (measured:
  `vp run typecheck:test` RC=0 twice while the lane held 20 type errors; the
  tell was a COUNT — 123 tests vs 143). Prefix every verification command with
  `cd <worktree> &&`; when a result is surprisingly clean, check `pwd`. **A
  BACKGROUNDED call starts from the session cwd**, not the `cd` of an earlier
  call — make every long-running call print its own `pwd` first. **When a
  stray main-tree edit has already happened, both obvious repairs are
  refused** (`git checkout -- <path>` trips `dirty-path-restore-gate`; writing
  the file back trips `main-tree-edit-gate`): re-apply the edit in the
  worktree with an ABSOLUTE path, then
  `git -C <main> stash push -m <label> -- <path>`; drop the stash only after
  confirming `stash@{0}`'s message is yours — parallel lanes stash too. A
  blocked call runs NOTHING, preamble included — §6 has the rule.
- **An IN-PLACE run ends with the Stop hook still calling its lane unmerged,
  and the remedy it names is one this mode forbids.**
  `stop-unmerged-lane-warn.sh` enumerates worktrees ahead of `origin/main`,
  and a squash-merged branch reads as ahead forever; the warning's "remove its
  worktree" half is forbidden here (SKILL.md "Launch mode"). Expected, not a
  defect: confirm the PR is MERGED and say so in the wrap. The tree is only
  clearable from inside by LEAVING the lane branch, which is what §9's
  IN-PLACE arm does as the run's last step: `git switch
  --no-guess <LAUNCH_BRANCH> && git branch -D` the lane branch — the branch
  the probe recorded, restored as-is, with `--no-guess` so a branch surviving
  only on `origin` fails here instead of being re-created from the remote.
  That silences the hook — provided `LAUNCH_BRANCH` carries no commits of its
  own (§9 has the `git rev-list --count` check) — without removing a tree this
  run does not own. Detach silences it too but leaves the outer tool
  displaying a detached workspace; it is the fallback for a run launched
  detached, not the default (go-to-k/cdkd#2417).
- **A usage-limit interruption does not have to end the run: leave a one-shot
  checkpoint at the reset time**, scheduled when the limit is ANNOUNCED, not
  when it bites (the 2026-09-02 run resumed itself at the reset instant from
  an in-session one-shot cron and finished its lane — the alternative is not
  "resume later" but "re-derive later"; go-to-k/cdkd#2417).

## Important existing rules this skill leans on

- **All changes via PR; never commit to `main`.** Feature work lives in its
  OWN worktree — or, launched inside one, in that one (SKILL.md "Launch
  mode"); the orchestrator integrates. (`CLAUDE.md` → Workflow Rules.)
- **Always add unit tests** for a fix — do not wait to be asked.
- **Merge with `--squash --delete-branch` only.**
- **English-only** for all committed/public artifacts.
- **`Severity` / `Effort` go on the issue as LABELS too** — set at filing
  (§5-f) and at the claim that rewrites an old packed body (§4); the lane's PR
  inherits them from the issue it closes, so never hand-add them to a PR.
- **Never download/run/install untrusted third-party content** (§0).
- **Drive each lane to MERGED, not to "pushed".** §9 is the finish line for a
  LANE (merge, pull, confirm the release PR picked it up, rebuild, remove the
  worktree) and §10 for the RUN. An open PR is unfinished work; a
  NOT-CLOSEABLE verdict is a to-do
  list, not a stopping point — keep going until every lane is merged and every
  worktree removed, or the only blockers left are ones you cannot act on (CI
  in flight, a running reviewer, a maintainer decision). Low context is not
  such a blocker: commit, push, file, continue. The removal half is "every
  worktree THIS RUN added is gone" — an IN-PLACE run added none and leaves its
  tree standing.
- **Wrap with Remaining-work + State + Session-close, scoped to the issues
  this run actually worked** — backlog issues you triaged but did not pick up
  are not follow-ups. (`CLAUDE.md` → Workflow Rules.)
- **Classify every deferral `now` / `next` the moment you defer it** — write
  the four classification lines into the issue body, one field per line, per
  `CLAUDE.md` → "The four TODO fields":

  ```text
  Session-fit: now (do it in this session) | next (not this session) — <reason>
  Severity: high | medium | low — <what stays broken while it is undone>
  Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
  Estimate: <duration, e.g. ~1-3 h -- never a bare letter> — <what eats the time>
  ```

  The report repeats those four and adds `Notes`; the issue body carries
  `Dup-check:` (§5-f) instead. **After a lane merges, `next` is the default**
  — what stays hot is that lane's files and the integ already run; a residual
  in a worktree you are STILL holding is almost always `now` (worktree, deps,
  markers paid for), one in a lane already cleaned up is `next`. **The trap:
  the filing happens mid-lane, where the loud question is "can this ride THIS
  PR?" (usually no) while the rule asks "is that lane's worktree still open?"
  (quiet, usually yes)** — two ~30-60 min items were filed `next` while the
  lanes owning their files were still open, and by wrap the classification had
  become right for the wrong reason (go-to-k/cdkd#2321 / go-to-k/cdkd#2322).
  Ask the worktree question at FILING time; a separate PR from the same open
  worktree is cheap, and is not what `next` is for.

  Close the run with the **not-this-session line** — decision first, then the
  literal command (`Not this session — start a fresh session with:
  /work-issues`), no condition attached ("after lane C merges" collapses
  waiting and handing-off), and keep `next` items off the State line. A `now`
  found mid-run is a commitment: Remaining work says what you are about to do,
  the State line is never STOPPED while it is open, the verdict is NOT
  CLOSEABLE naming it. A final report can only list `next` items and
  won't-dos.
- **This flow parks a LOT, so the State line carries most of its weight.** A
  fan-out run spends most wall-clock parked (lane subagents, `gh pr checks
  --watch`, `/run-integ`) — every one is **WAITING**, not
  STOPPED: name the lane and the signal per line. Report **STOPPED** only when
  every lane is merged and nothing is pending. **ARM the signal BEFORE you
  write the line** — a named signal is not an armed one; the poll, `Monitor`
  or backgrounded `until` loop is what actually resumes the run (measured: a
  run wrote `WAITING — Signal: gh pr checks`, armed nothing, and simply
  ended).
- **A lane needing a user decision goes through `AskUserQuestion`, never
  prose** — a prose question ends the turn as STOPPED and loses the other
  lanes' momentum. Everything else (which integ, how many reviewers, how deep
  to verify) you decide yourself and report as a decision.

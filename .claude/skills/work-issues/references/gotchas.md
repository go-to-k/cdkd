<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## Gotchas (learned the hard way)

- **Claim before editing, always** — an unclaimed lane races a parallel agent
  onto the same cross-cutting file. **Claiming is not winning**: read it back
  and yield to an earlier `createdAt` (§4).
- **A pushed branch with no PR is a live lane**, and its mirror — a worktree
  holding commits it has not pushed — is the window only the claim covers. §2
  owns both probes; this bullet does not restate them (§3, §9).
- **A fresh issue is someone's deferral, not free backlog** (§3-0). The author
  field proves nothing about which session filed it; the 60-minute window is
  the whole defence — and §4 is its other half: claim what you FILE, not only
  what you take.
- **The filer may already have classified the issue.** A `Session-fit: next`
  body names the cycle it needs; take it only if this run can pay for that,
  and say why in the claim (go-to-k/cdkd#1791 passed every §2/§3 gate, was
  claimed, and had to be retracted — nothing but a grep stood between the run
  and the fixture arm its body had already named).
- **A cross-repo framing spends the deferral budget up front.** Inside a "do
  this across the repos in one session" scope, `Session-fit: next` is off the
  menu for anything discovered there; `.claude/rules/session-report.md` →
  Session-fit carries the three tells and the 2026-08-20 measurement.
- **A mirror issue may already be carried elsewhere** — resolve against the
  file, open PRs and open issues before filing (§10-c) or claiming (§3).
- **One lane per cross-cutting file.** §2 holds the list; this bullet does not
  restate it (go-to-k/cdkd#2076 records why).
- **Never merge a PR whose destroy path is unverified, and never bypass
  `/run-integ`** — CLAUDE.md owns both rules; §8-c owns what COUNTS as a
  bypass.
- **`vp run build` after every source edit, before any live test** (CLAUDE.md);
  §8-i owns the unique-stack-name rule that goes with it.
- **Stale-base phantom diff** (§7) — never "restore" the peer's lines a stale
  `git diff main` appears to have removed; rebase instead.
- **`bash cwd silent reset`** — a persistent Bash cwd can drift back to the
  main tree between calls; prefix every verification command with
  `cd <worktree> &&` and `git -C <lane tree>` every git op (the addressing
  rule for READS, and the contradicting-answer test, are in
  `references/launch-mode.md`). **A KILLED or REFUSED call is a named
  reset trigger, and it lies about the filesystem too**: a timeout can return
  the shell at the session cwd; a PreToolUse refusal aborts the WHOLE call, so
  the `mkdir` a later `cd` depends on never ran — and a failed `cd` does NOT
  stop the rest of its call. After any timeout or refusal, run `pwd` AND
  re-verify what the aborted call should have created. **Its worst form is a
  FALSE GREEN on a verification command**: a gate run from the main tree
  verifies unmodified `main` and passes (measured: `vp run typecheck:test`
  RC=0 twice while the lane held 20 type errors; the tell was a COUNT — 123
  tests vs 143) — an unexpectedly clean or short result is a `pwd` check, not
  a pass. **A BACKGROUNDED call starts from the session cwd**, not the
  `cd` of an earlier call — make every long-running call print its own `pwd`
  first. **When a stray main-tree edit has already happened, both obvious
  repairs are refused** (`git checkout -- <path>` trips
  `dirty-path-restore-gate`; writing the file back trips
  `main-tree-edit-gate`): re-apply the edit in the worktree with an ABSOLUTE
  path, then `git -C <main> stash push -m <label> -- <path>`; drop the stash
  only after confirming `stash@{0}`'s message is yours — parallel lanes stash
  too. A blocked call runs NOTHING, preamble included — §6 has the rule.
- **An IN-PLACE run ends with the Stop hook still calling its lane unmerged,
  and the remedy it names is one this mode forbids.**
  `stop-unmerged-lane-warn.sh` enumerates worktrees ahead of `origin/main`,
  and a squash-merged branch reads as ahead forever; the warning's "remove its
  worktree" half is forbidden here (SKILL.md "Launch mode"). Expected, not a
  defect: confirm the PR is MERGED and say so in the wrap. The tree is only
  clearable from inside by LEAVING the lane branch, which is exactly §9's
  IN-PLACE arm — its recipe, its `--no-guess`, and its
  `LAUNCH_BRANCH`-carries-no-commits check all live there, and it silences the
  hook without removing a tree this run does not own. Detach silences it too
  but leaves the outer tool displaying a detached workspace; it is the fallback
  for a run launched detached, not the default (go-to-k/cdkd#2417).
- **A usage-limit interruption does not have to end the run: leave a one-shot
  checkpoint at the reset time**, scheduled when the limit is ANNOUNCED, not
  when it bites (the 2026-09-02 run resumed itself at the reset instant from
  an in-session one-shot cron and finished its lane — the alternative is not
  "resume later" but "re-derive later"; go-to-k/cdkd#2417).

## Important existing rules this skill leans on

- **CLAUDE.md's standing rules apply unchanged**: every change via PR and none
  onto `main` — feature work in its OWN worktree, or, launched inside one, in
  that one (SKILL.md "Launch mode"), with the orchestrator integrating — unit
  tests with every fix, `--squash --delete-branch` merges, English-only in
  every published artifact, and never running untrusted content (§0).
- **`Severity` / `Effort` go on the issue as LABELS too** — §5-f at filing, §4
  at the claim that rewrites an old packed body; never on the PR (CLAUDE.md).
- **Drive each lane to MERGED, not to "pushed".** §9 is the finish line for a
  LANE (merge, pull, confirm the release PR picked it up, rebuild, remove the
  worktree) and §10 for the RUN. An open PR is unfinished work, and
  CLAUDE.md's NOT-CLOSEABLE rule applies unchanged — low context is not one of
  the blockers it excuses: commit, push, file, continue. The removal half is
  "every worktree THIS RUN added is gone" — an IN-PLACE run added none and
  leaves its tree standing.
- **Wrap with Remaining-work + State + Session-close** (`CLAUDE.md`), scoped to
  the issues this run actually WORKED — triaged-but-not-picked is not one.
- **Classify every deferral `now` / `next` the moment you defer it** — the four
  classification lines go in the issue body, one field per line, per
  `CLAUDE.md` → "The four TODO fields". The report repeats those four and adds
  `Notes`; the body carries `Dup-check:` instead, and §5-f owns the
  open-worktree test that decides `now` vs `next`.
- **This flow parks a LOT, so the State line carries most of its weight.** A
  fan-out run spends most wall-clock parked (lane subagents, `gh pr checks
  --watch`, `/run-integ`) — every one is **WAITING**, not STOPPED: one line
  per lane, naming the lane and its signal. STOPPED only when every lane is
  merged. CLAUDE.md owns the arm-it-BEFORE-you-write-it rule.
- **A lane needing a user decision goes through `AskUserQuestion`, never
  prose** — a prose question ends the turn as STOPPED and loses the other
  lanes' momentum. That prompt is CHAT, not a published artifact, so it goes
  in the USER's language — CLAUDE.md's English-only rule already draws that
  line and was over-applied anyway (the go-to-k/cdkd#2522 decision,
  2026-09-05). Everything else (which integ, how many reviewers, how deep
  to verify) you decide yourself and report as a decision.

<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## Gotchas

- **Claim before editing, always** — an unclaimed lane races a parallel agent
  onto the same file, and **claiming is not winning**: read it back, yield to an
  earlier `createdAt` (§4).
- **A pushed branch with no PR is a live lane**, as is a worktree holding
  unpushed commits — the window only the claim covers (§2 owns the probes).
- **A fresh issue is someone's deferral, not free backlog** (§3-0); §4 is its
  other half: claim what you FILE.
- **The filer may already have classified the issue**: a `Session-fit: next` body
  names the cycle it needs, so take it only if this run can pay, saying why in
  the claim (go-to-k/cdkd#1791).
- **A cross-repo framing spends the deferral budget up front**: inside a
  "do this across the repos in one session" scope, `next` is off the menu.
- **One lane per cross-cutting file** — §2 holds the list.
- **Never merge a PR whose destroy path is unverified, and never bypass
  `/run-integ`** (§8-c owns what COUNTS as one).
- **Stale-base phantom diff** (§7) — rebase; never "restore" peer lines a stale
  `git diff main` shows removed.
- **A Bash cwd silently drifts back to the main tree between calls**: prefix every
  verification command with `cd <worktree> &&` and use `git -C <lane tree>`
  (addressing rules: `references/launch-mode.md`).
  - **A KILLED or REFUSED call is a reset trigger that also lies about the
    filesystem**: a refusal aborts the WHOLE call, so the `mkdir` a later `cd`
    needs never ran — run `pwd` and re-verify. A BACKGROUNDED call likewise
    starts from the session cwd, and the drift runs FORWARD, so use absolute
    paths for every EDIT.
  - **Its worst form is a FALSE GREEN**: a check run from the main tree verifies
    unmodified `main` and passes, so an unexpectedly clean or short result (the
    tell is the test COUNT) calls for a `pwd`, not a pass.
  - **After a stray main-tree edit the obvious repair is refused** (`git
    checkout` trips `dirty-path-restore-gate`): re-apply the edit in the
    worktree by ABSOLUTE path, then
    `git -C <main> stash push -m <label> -- <path>`, dropping that stash only
    once `stash@{0}` is yours.
- **An IN-PLACE run ends with its lane branch still reading as unmerged**, since a
  squash-merged branch stays ahead of `origin/main`. Removing that worktree is
  forbidden (SKILL.md "Launch mode"): confirm the PR is MERGED and clear the tree
  only by LEAVING the lane branch (§9's IN-PLACE arm).
- **A usage-limit interruption need not end the run: leave a one-shot checkpoint
  at the reset time**, scheduled when the limit is ANNOUNCED.
- **Qualify every published issue/PR reference as `owner/repo#N`** — a bare `#N`
  renders against whichever repo reads it.
- **An agent KILLED by a usage limit or a 429 keeps its context — `SendMessage`
  it, never re-dispatch**, and tell it its OWN reviewer subagents died too: only
  it can resume them. A HOST RESTART may kill it outright (`SendMessage` first,
  re-dispatch on its tree only if it cannot answer) and wipes the scratchpad:
  rebuild any helper kept there (a relaunch exiting 127 is the symptom).
  **Read the TREE and the DIFF first** (an unpushed commit survives): the agent
  may already have committed, pushed and opened the PR, and **uncommitted changes
  there may be the round's real fix, not an abandoned probe**; §5-g covers one
  that finished quietly. One killed MID-INTEG also owes, before the resume: no
  `pgrep -fl verify.sh` hit whose cwd (`lsof -a -p <pid> -d cwd`) is inside its
  tree, a clean `/run-integ` step 4 scan for its fixtures, and its tree's HEAD
  against the pushed branch.

## Important existing rules this skill leans on

- **AGENTS.md's standing rules apply unchanged** — PR-only changes, worktree
  placement, unit tests with every fix, squash merges, English-only published
  artifacts, untrusted content (§0).
- **Drive each lane to MERGED, not to "pushed"** — §9 is the finish line for a
  LANE, §10 for the RUN; low context is no NOT-CLOSEABLE excuse.
- **Wrap with Remaining-work + State + Session-close** (`AGENTS.md`; its scope
  rule excludes triaged-but-not-picked issues).
- **Classify every deferral `now` / `next` the moment you defer it** — four
  fields in the issue body, one per line; the report repeats them and adds
  `Notes` (§5-f owns the deciding test).
- **This flow parks a LOT, so the State line carries its weight**: lane
  subagents, `gh pr checks --watch` and `/run-integ` are all **WAITING**, one
  line each naming its signal; STOPPED only when every lane is merged.
- **A user decision (a lane's or a triaged issue's) goes through
  `AskUserQuestion`, never prose**, which ends the turn as STOPPED. It is CHAT,
  so in the USER's language, and it states the problem and each option's fix in
  plain words plus what CloudFormation / the AWS CDK CLI does for the same
  shape, where one applies; without those the maintainer asks back instead of choosing (#2868).
  Everything else you decide.

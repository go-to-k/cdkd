---
description: How verify-pr-gate decides WHICH repository a gh command will act on - the target checkout's remotes, not only the command text
paths:
  - '.claude/hooks/verify-pr-gate.sh'
  - '.claude/hooks/verify-pr-gate.test.sh'
---

# What repository will this `gh` command act on?

`verify-pr-gate`'s foreign-target relaxation (go-to-k/cdkd#3209) lets a cdkd
session open or merge a PR in a SIBLING repo on that repo's own `verify-pr`
marker, skipping cdkd's `.markgate-verify-pr-sha` binding, which a sibling has
no way to write. The relaxation is sound only while the repo gh acts on is the
repo whose marker is being checked — and answering that takes TWO independent
instruments, because a repository reaches gh through two different channels.

## Channel 1 — the command text

`__vpg_names_no_other_repo` is an ALLOWLIST: relax only when the command
PROVABLY names no other repo, and treat every shape it cannot read as naming
one. Its history is in the hook's own block comment and is not repeated here;
what matters is that a denylist of spellings was tried first and one review
round produced five more that gh honours and it did not see.

## Channel 2 — the target checkout's remotes (go-to-k/cdkd#3235)

gh picks a base repo from the target checkout's git config, and that channel
leaves NOTHING in the command for channel 1 to read. Measured on gh 2.92.0: a
checkout whose `origin` is `go-to-k/cdk-local` and which also carries
`upstream = go-to-k/cdkd` answers **go-to-k/cdkd** for a plain
`gh pr merge 42 --squash`, so cdk-local's own fresh marker cleared the merge of
a CDKD pull request. `git remote add upstream <other repo>` is an ordinary
operation and the standard fork setup; `gh repo set-default` does it
deliberately.

`__vpg_target_repo_is_its_own` resolves what gh would resolve and requires it to
equal that checkout's own `origin`.

- **`git config` reads only.** No `gh` invocation — that is a network round trip
  inside a PreToolUse hook — and nothing executed FROM the target:
  [hooks.md](hooks.md) records why delegation was abandoned in PR 1970.
  Measured: `git remote` and `git remote get-url` fire neither `core.fsmonitor`
  nor `core.pager`.
- **A COMPARISON, not a presence test.** Refusing any checkout carrying a
  `gh-resolved` key would refuse a sibling that ran `gh repo set-default` on
  ITSELF, which is exactly what gh tells a multi-remote checkout to do, and that
  re-breaks the flow go-to-k/cdkd#3209 exists to enable.
- **Fails closed**, matching the identity test beside it. The ONE wave-through
  is a checkout with NO remotes at all, decided by asking git whether any remote
  exists rather than by the parser returning nothing — gh answers
  `no git remotes found` there too, so the command can act on no repository.
- **The refusal carries the matching remedy** (`__vpg_retract_kind`): a
  remote-config retraction prints the remote fix, since the command-shape advice
  would clear nothing.

### gh's order, measured rather than read off its source

`upstream` > `github` > `origin` > the rest **alphabetically**, with a
`gh-resolved` key on the first remote that HAS one winning outright. The cells
that decided the implementation, each a row in the suite's matrix:

- `zzz` added before `aaa`, no `origin` → **aaa's** repo. The tail tie-break is
  alphabetical, not config order; a first cut took git's config order and this
  refuted it. That cell REFUTES an implementation but does not FENCE one: with
  no `origin` the checkout has no unambiguous identity, so it blocks through
  that arm whichever remote wins, and reversing only the tie-break left the
  suite green. `tail_tiebreak_decides` is the row that fences it — the order
  decides which of two `gh-resolved` keys is read, and reversing it flips the
  verdict.
- `gh-resolved` on BOTH `origin` (`base`) and `upstream` (a slug) →
  **upstream's**. The key does not win by being first in the config.
- `gh-resolved` holding a full URL is accepted; holding junk makes **gh itself
  error**, so refusing agrees with gh rather than guessing.
- `origin` spelled `GO-TO-K/CDK-Local` → gh answers `go-to-k/cdk-local`. gh
  normalises case through the API and this hook cannot, so the compare is
  case-insensitive.

### Two properties that are correctness, not detail

Both were live fail-opens found in review, and both have the same shape — a
remote gh SEES that the gate did not, leaving the remaining remotes to compare
equal and RELAX:

- **The URL comes from `git remote get-url`, never from
  `git config remote.<n>.url`.** gh reads it with `url.<base>.insteadOf`
  applied. Measured: with `url.https://github.com/.insteadOf = gh:` and
  `upstream = gh:go-to-k/cdkd.git`, the raw config says `gh:go-to-k/cdkd.git`
  (unreadable → dropped) while `get-url` and gh both say the github.com URL.
  `insteadOf` lives in a user's global gitconfig routinely.
  Because `get-url` feeds BOTH sides of the comparison, an `insteadOf` that
  rewrites one readable github.com URL to another readable one is INERT rather
  than a hole: `origin` genuinely is the rewritten repo for every git operation,
  gh acts on it, and the gate agrees. A review round expected a refusal there;
  the row `insteadof_parseable_to_parseable` pins the relax, because refusing
  would mean calling a correctly-configured checkout wrong. What no
  remote-derived comparison can see is a tree whose FILES came from one repo
  while its remotes now name another — that is a broken checkout, not something
  this test can decide.
- **A remote the parser cannot classify REFUSES; it is never dropped.** ONLY an
  exact `github.com` is classifiable — every other HOST refuses, and only a
  hostless remote (a local path, `file://`) is dropped.

  An earlier revision accepted `*.github.com` as well, arguing that being more
  generous than gh could only ever over-refuse. **That argument is wrong**, and
  the counter-example is measured: over-accepting a remote gh DROPS makes the
  comparison come out EQUAL when that remote outranks gh's real choice and its
  slug coincides with `origin`. With `origin` = cdk-local, `github` = cdkd and
  `upstream` = `https://ssh.github.com/go-to-k/cdk-local.git`, gh drops the
  upstream and answers **cdkd**, while the gate ranked it first, read
  cdk-local, matched `origin`, and RELAXED. The accepted slug feeds the
  EQUALITY, not just the refusal, so over-acceptance is not a one-way error.
  `over_accepted_outranks` is that row.

  Two other hosts refuse for the same reason: a DOTLESS host in scp / `ssh://`
  form is an ssh `Host` alias as often as a real name and **gh expands it** —
  measured, gh shells out to `ssh -G <host>` (an `ssh` wrapper on PATH logged
  `-G github-work`) while `git remote get-url` returns the alias verbatim — and
  an authenticated GitHub ENTERPRISE host is one gh keeps and this cannot
  recognise, the auth config not being readable from here.

  **The cost is real and is accepted**: a checkout whose only GitHub remote is
  spelled `git@ssh.github.com:...`, or that carries any non-`github.com` remote
  at all (a GitLab mirror, a GHES upstream), is refused rather than judged. That
  is an over-refusal falling back to the binding, never below `origin/main`, and
  the prescribed sibling checkouts carry github.com remotes only.

### It retires the second-clone bound

A second CLONE of cdkd has a different git common dir, so the identity test
answers FOREIGN and the relaxed path dropped the go-to-k/cdkd#2686 binding in a
checkout that IS cdkd. The common dir was only ever a proxy for repo identity;
two checkouts whose own `origin` is the same repository are now the same
repository. That direction only ever ADDS the binding requirement, so it cannot
open a path.

### Known bound

A genuine FORK checkout (`origin` = `<you>/cdk-local`,
`upstream` = `go-to-k/cdk-local`) compares unequal and is refused, though the
files really are cdk-local's. That is the guard's declared failure direction —
an over-refusal falls back to the binding, never below `origin/main` — and it
does not touch the prescribed flow, whose sibling checkouts point `origin`
straight at `go-to-k/<repo>`.

## The matrix is the fence

`verify-pr-gate.test.sh` carries every configuration above as a row whose
column 4 is **gh's own measured answer**, which is what makes the table
re-checkable rather than a restatement of the code:
`VPG_REMEASURE_GH=1 bash .claude/hooks/verify-pr-gate.test.sh` rebuilds each row
and diffs live gh against it. That mode needs network and `gh auth`, so the
OFFLINE run is the enforcement — a check that skips when its oracle is
unreachable is a vacuous pass ([testing.md](testing.md)). A row-count floor sits
beside it so a mangled heredoc cannot report green over an empty table.

Run the suite under BOTH bashes. `HOOK_BASH` must be used as a COMMAND WORD and
never interpolated into a shebang: `run-tests.sh` iterates
`for candidate in bash /bin/bash` and keeps the CANDIDATE, so the first value is
the bare word `bash`, and `#!bash` is not an absolute path — every case dies
with 126. A first cut rewrote the installed copy's shebang, passed locally
because the runs were hand-given absolute paths, and failed all 137 cases in CI,
the only place the bare word appears.

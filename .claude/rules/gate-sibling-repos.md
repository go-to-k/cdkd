---
description: cdkd cross-repo gate aliasing - how the integ-destroy gate resolves which marker to verify when the target repo is a sibling that spells the gate differently
paths:
  - '.claude/hooks/integ-destroy-gate.sh'
  - '.claude/hooks/integ-destroy-gate.test.sh'
---

# Cross-repo gate aliasing (go-to-k/cdkd#2236)

Split out of `hooks.md`, which crossed the 120,000 B per-file cap in
`tests/unit/scripts/rule-file-payload.test.ts`. It stays reachable from
`hooks.md`'s "Working on a sibling repo from a cdkd session" section, which
carries a pointer to it.

The class was found across four `integ-*` gates. Three of them
(`integ-local`, `integ-broad`, `integ-schema-migration`) were retired with the
rest of the marker layer, so `integ-destroy` is the only gate this now governs —
but the MECHANISM is kept, because the class returns the moment a second
markgate gate is added. Sentences below that name a retired gate record a
MEASUREMENT taken through it and are left as the record.

`paths:` deliberately does NOT list `.claude/hooks/lib/command-match.sh`, even
though `gate_resolve_marker_gate` and its helpers live there. That path already
loads `hooks.md` + `hooks-class-fences.md`, and adding this file too would leave
its payload budget too thin to survive the next ordinary edit. Someone editing
the resolver still gets `hooks.md`'s pointer to this file.

## A gate whose NAME the target repo does not have

"Retry after completing the target repo's checklist" presumes the retry CAN
succeed. For the `integ-*` gates it could not. Each `cd`s to the resolved
target tree and asks markgate about a gate named for cdkd, and a sibling that
spells the same gate differently fails that verify NO MATTER WHAT. Hit live
merging go-to-k/cdk-local#558 (a secret-plaintext redaction under `src/local/`)
from a cdk-local worktree: cdk-local names its Docker local-execution gate
`integ`, `markgate verify integ` returned **0** there, and cdkd's hook demanded
`integ-local`, which cdk-local does not declare. The merge was unsatisfiable by
any legitimate action -- the only ways past were the two the rules forbid
(merging from outside the worktree, which silently bypasses the target repo's
OWN gates, or setting a marker by hand). This is the fail-CLOSED-with-no-exit
shape, not the sanctioned sibling-repo block.

**The existing PR-diff scope guard does not cover it.** That guard asks "does
the DIFF touch this gate's scope?", and cdk-local's entire runtime lives under
`src/local/`, so it answers yes and hands the merge to the blocking path. The
question nobody was asking is "does the TARGET repo DECLARE this gate?".

**No PER-GATE markgate query answers that question, measured rather than
assumed** (0.4.1, 2026-08-26): `verify <undeclared>` exits 1 with no output, and
`status <undeclared>` exits 1 printing `state: no marker` -- byte-identical to a
declared-but-unset gate. That is the decisive fact, because a gate hook asks
about ONE named gate.

Be precise about the scope of that claim: markgate is **not** blind to
definedness in general. **Bare `markgate status` lists every gate and tags the
declared ones `(configured)`**, exiting rc=1 in about 2 s on this repo. It is
not used here for two reasons -- it is a whole extra subprocess on every gated
merge inside a PreToolUse hook, and it needs markgate resolvable in the TARGET
repo before the definedness question can even be asked, whereas reading the
config does not. Do not restate this as "markgate cannot answer definedness":
a future author who finds `markgate status` would reasonably conclude the whole
rationale was sloppy. `gate_markgate_declares` in `lib/command-match.sh` reads
the target's own `.markgate.yml`.

**The mapping is DECLARED, keyed on the repo as well as the gate, not
discovered.** Discovery needs a property separating "the gate that means the
same thing" from the repo's other gates, and none exists: cdk-local's `integ`
include is `src/**` + `tests/integration/**`, a strict SUPERSET of its `check`
gate's `src/**`, so any scope-overlap heuristic matches both. `ttl:` plus
`hash: diff` is not a discriminator either -- cdk-real-drift's `integ` carries
both and is a READ-ONLY AWS gate with no Docker in it. Every heuristic's failure
mode is a false ACCEPT: merging on the strength of a marker that attests to
something else, which is exactly what `markgate-gate-name-class.test.sh` exists
to refuse. `GATE_MARKER_ALIASES` is therefore one reviewable row per
(repo, cdkd gate, that repo's gate, command that refreshes it).

**The table is EMPTY today**, since its only row mapped cdk-local's `integ` onto
cdkd's retired `integ-local`. An empty table is a valid state:
`gate_resolve_marker_gate` then answers `canonical` or `none` and never `alias`.

`gate_resolve_marker_gate <target-dir> <cdkd-gate>` returns one of three modes:

- **canonical** -- the target declares the cdkd gate, OR definedness could not be
  determined. Behaviour is then byte-identical to before, which is why the cdkd
  path is untouched: this repo declares its own gate.
- **alias** -- the target declares an equivalent under its own name. The gate
  verifies THAT marker, and a stale one is refused by
  `gate_refuse_stale_alias_marker`, which names the target's gate and the
  command that refreshes it there. The refusal is satisfiable. Unreachable while
  the table is empty; the branch stays because the table is meant to grow.
- **none** -- nothing equivalent is declared. A REFUSAL by default, exit 2, and
  `gate_refuse_no_equivalent_marker` names the mapping row to add rather than a
  gate that cannot exist. Passing UNCONDITIONALLY was never an option: it would
  silently drop the policy cdkd deliberately applies to sibling-repo commands.

  One retired gate carved out of this, and the carve-out did NOT generalise
  (go-to-k/cdkd#3351): `integ-schema-migration` exited 0 at `none` when the
  target was PROVABLY a different repository -- `gate_target_is_foreign`, which
  settles identity on the repo SLUG across every remote and refuses to relax
  when the command can name another repo. **`integ-destroy` does NOT inherit
  it**, and neither does a new gate. What justified it there was that the
  schema contract is about a document CDKD persists, so `none` genuinely meant
  "this policy does not apply here" rather than "this repo has not proved it
  yet". A destroy path is not like that: a sibling whose `integ` never exercised
  a delete has proved nothing about deletion, so the refusal is correct.

**Fail closed on UNDETERMINABLE.** Only a positively parsed `gates:` block with
the name absent counts as "not declared"; a `.markgate.yml` that exists but
yields no parsable block keeps the cdkd gate name, so a config this parser does
not understand can never route a merge onto some other repo's marker. An absent
`.markgate.yml` does count as "declares nothing" -- that is already how every
other hook here decides a checkout is not a markgate repo.

**`integ-destroy`'s reachability in a sibling**: not today -- neither sibling
has `src/provisioning/**`, `src/deployment/**` or `src/analyzer/**`, so the
PR-diff scope guard returns before the marker is consulted. And it has no alias
row on purpose: neither sibling has a destroy path, so their `integ` never
exercised a delete. "Not reachable today" is a property of the siblings' current
file layout, not of the gate, so it is not a reason to remove the resolution.

**Read "not affected" as scoped to the gate NAME, which is the only question
this file answers.** The retired `verify-pr-gate` asked about a name both
siblings declare AND additionally compared `<target top>/.markgate-verify-pr-sha`,
a cdkd-only sentinel neither sibling ever wrote -- so it carried an unclearable
sibling refusal of its own until go-to-k/cdkd#3209, by a different mechanism
than aliasing and with a different fix (require the binding only in the repo
that defines it). The lesson generalises past the name: **when a gate refuses a
sibling target, ask what ELSE it compares.**

## Three defects from review round 1, all in the alias path

- **Exit 2 is not staleness, and the alias is where that bites.** markgate exits
  2 for "could not EVALUATE" (`hash: diff` with an unresolvable base, or no
  delta against the merge base) and `markgate set` fails on the same condition,
  so the "go run the integ" remedy burns a real AWS run and leaves the merge
  blocked. The gate branches on `status -eq 2` into the shared
  `gate_refuse_unevaluable_marker`.
- **That branch must sit ABOVE the alias refusal.** In `integ-destroy-gate` it
  originally sat below, which was latent only because no `integ-destroy` alias
  row exists -- adding one later would have silently disabled the exit-2
  message. Ordering is: rc 0 -> pass, rc 2 -> unevaluable, alias -> alias
  refusal, else canonical. **Fenced STATICALLY** in
  `markgate-gate-name-class.test.sh` fence 4, which asserts the gate handles
  markgate rc-2 at an earlier line than its alias refusal. It has to be static:
  with the alias table empty no behavioural test can reach that branch, and the
  trap springs exactly when someone adds the first alias row, which is the
  moment nobody re-reads the ordering. A fence for a case that does not exist
  yet can only be static.
- **A key-format change is a DOC hazard class of its own.** A table row written
  in an older two-segment form matches nothing, and it fails SILENTLY: no error,
  no refusal, just an alias that is never found and a gate quietly back to
  refusing every sibling merge. A doc cell showing the old shape is not merely
  stale -- it is the **template the next author copies from**, so its staleness
  propagates into CODE. When a key format changes, grep the docs for the old
  shape as part of the same change, not as a follow-up.

**The slug carries the HOST.** `gate_repo_slug` returned `<owner>/<name>`, so
`https://gitlab.com/go-to-k/cdk-local` and a local clone at
`/x/go-to-k/cdk-local` both matched cdk-local's row -- an unrelated repo
inheriting the alias, which is precisely the guessing this table exists to
prevent. It now returns `<host>/<full/path>` and refuses to key a remote with
no host at all. The path is kept WHOLE rather than reduced to its last two
segments, because that reduction is the same conflation one level up: it keys
`github.com/o/r/sub/deep` as `github.com/sub/deep` and makes the GitLab
subgroups `gitlab.com/a/x/repo` and `gitlab.com/b/x/repo` identical. The
"at least two segments" test is structural for the same reason a spelling of
`[ "$owner" != "$name" ]` was wrong: it refused `github.com/prettier/prettier`
outright and then reported "origin remote missing or not host-qualified",
which was false for that remote -- fail-closed, but a wrong diagnosis.

**Two normalisations qualify "verbatim", and both were live defects**
(go-to-k/cdkd#3385). gh ALIASES two of its own hosts, so `ssh.github.com`
(GitHub's SSH-over-443 host) and `www.github.com` are folded to `github.com` --
without it the same repository keyed two ways, and a checkout naming THIS repo
through an alias read as FOREIGN. ONLY those two: `nope.github.com` and
`gist.github.com` resolve nowhere in gh (measured), so leaving them unaliased
agrees with gh. And the `.git` suffix is stripped CASE-INSENSITIVELY, because
the case-fold happens after it and an upper-case `.GIT` otherwise survived
into the slug -- a latent bug whose own test case is GREEN IN CI (which checks
out a suffix-less URL) and RED in a local clone, so the direct
`gate_slug_from_url` cases are what hold it.

Over-normalising is safe in a consumer that asks "does this remote name *THIS*
repo": a spurious match makes a checkout read as this repo, which ADDS a
requirement. **`gate_resolve_marker_gate` is NOT of that shape** -- it keys the
alias table on the slug, so a spurious match REMOVES a refusal, selecting a
sibling's gate where the unfolded slug answered `none`. That is vacuously true
while the table is empty and stops being safe the moment a row is added, so
widen the alias host list and this consumer together. It is also NOT safe in a
design that ranks remotes and compares a winner -- there an over-accepted remote
outranking gh's real choice makes the comparison EQUAL and RELAXES (measured,
go-to-k/cdkd#3372). Do not carry the argument to such a caller.

## A probe is only evidence for the mutation you actually claim to fence

The first attempt at the ordering control DELETED the rc-2 block instead of
moving it. That changes behaviour -- the destroy suite's `error`-verdict case
sees a different message -- so the control came back RED, which reads as "the
per-gate suite already covers this" and would have retired fence 4 as redundant.
Re-run with the MOVE, the per-gate suite reports NOT FENCED and the class fence
reports RED, which is the actual justification. Delete-vs-move is a behaviour
change versus a pure reordering; do not substitute one for the other.

The ACCEPT direction is the one that matters for this whole guard, since the
defect is an over-tightening and something fenced only on "refuses what it must"
cannot see one. **Two accept-direction cases were VACUOUS when first written**,
and only a pre-fix comparison found it -- mutation probes did not. Three
separate causes, all fixed: a markgate shim returning `fresh` for ANY gate name,
so exit 0 alone could not discriminate; an argv needle that was a strict
SUBSTRING of the string it existed to reject; and a remedy phrase that appears
in the pre-fix message too. **Re-run the pre-fix swap after touching any of
these cases** -- it is the only check that catches this class.

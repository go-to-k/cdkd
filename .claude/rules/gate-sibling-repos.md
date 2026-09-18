---
description: cdkd cross-repo gate aliasing - how the four integ-* gates resolve which marker to verify when the target repo is a sibling that spells the gate differently
paths:
  - '.claude/hooks/integ-local-gate.sh'
  - '.claude/hooks/integ-destroy-gate.sh'
  - '.claude/hooks/integ-broad-gate.sh'
  - '.claude/hooks/integ-schema-migration-gate.sh'
  - '.claude/hooks/integ-local-gate.test.sh'
  - '.claude/hooks/integ-destroy-gate.test.sh'
  - '.claude/hooks/integ-broad-gate.test.sh'
  - '.claude/hooks/integ-schema-migration-gate.test.sh'
---

# Cross-repo gate aliasing (go-to-k/cdkd#2236)

Split out of `hooks.md`, which crossed the 120,000 B per-file cap in
`tests/unit/scripts/rule-file-payload.test.ts`. The text below is UNCHANGED --
only its heading level, since it is now the file's own subject rather than a
subsection of the sibling-repo notes. It stays reachable from
`hooks.md`'s "Working on a sibling repo from a cdkd session" section, which
carries a pointer to it.

`paths:` deliberately does NOT list `.claude/hooks/lib/command-match.sh`, even
though `gate_resolve_marker_gate` and its helpers live there. That path already
loads `hooks.md` + `hooks-class-fences.md`, and adding this file too would leave
its payload budget about 1 KB under its 140,000 B cap -- too thin to survive the
next ordinary edit, and a cap that has to move when it fires is not a cap.
Someone editing the resolver still gets `hooks.md`'s pointer to this file.

## A gate whose NAME the target repo does not have (go-to-k/cdkd#2236)

"Retry after completing the target repo's checklist" presumes the retry CAN
succeed. For the four `integ-*` gates it could not. Each `cd`s to the resolved
target tree and asks markgate about a gate named for cdkd -- `integ-local`,
`integ-destroy`, `integ-broad`, `integ-schema-migration` -- and a sibling that
spells the same gate differently fails that verify NO MATTER WHAT. Hit live
merging go-to-k/cdk-local#558 (a secret-plaintext redaction under `src/local/`)
from a cdk-local worktree: cdk-local names its Docker local-execution gate
`integ`, `markgate verify integ` returned **0** there, and cdkd's hook demanded
`integ-local`, which cdk-local does not declare. The merge was unsatisfiable by
any legitimate action -- the only ways past were the two the rules forbid
(merging from outside the worktree, which silently bypasses the target repo's
OWN gates, or setting a marker by hand). This is the fail-CLOSED-with-no-exit
shape, not the sanctioned sibling-repo block above.

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
declared ones `(configured)`**, exiting rc=1 in about 2 s on this repo. (An
older memory rule saying bare `status` hangs for minutes is stale for 0.4.1.)
It is not used here for two reasons -- it is a whole extra subprocess on every
gated merge inside a PreToolUse hook, and it needs markgate resolvable in the
TARGET repo before the definedness question can even be asked, whereas reading
the config does not. Do not restate this as "markgate cannot answer definedness":
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

`gate_resolve_marker_gate <target-dir> <cdkd-gate>` returns one of three modes:

- **canonical** -- the target declares the cdkd gate, OR definedness could not be
  determined. Behaviour is then byte-identical to before, which is why the cdkd
  path is untouched: this repo declares all four.
- **alias** -- the target declares an equivalent under its own name. The gate
  verifies THAT marker, and a stale one is refused by
  `gate_refuse_stale_alias_marker`, which names the target's gate and the
  command that refreshes it there. The refusal is satisfiable.
- **none** -- nothing equivalent is declared. A REFUSAL by default, exit 2, and
  `gate_refuse_no_equivalent_marker` names the mapping row to add rather than a
  gate that cannot exist. Passing UNCONDITIONALLY was never an option: it would
  silently drop the policy cdkd deliberately applies to sibling-repo commands.

  **One gate carves out of this, and the carve-out is per-gate rather than
  general** (go-to-k/cdkd#3351). `integ-schema-migration` exits 0 at `none` when
  the target is PROVABLY a different repository -- `gate_target_is_foreign`,
  which settles identity on the repo SLUG across every remote and refuses to
  relax when the command can name another repo. The other three `integ-*` gates
  keep refusing, and a new gate does NOT inherit this.

  What justifies it there and not elsewhere: the schema contract is about a
  document CDKD persists, and cdk-local's own schema is its own business to
  gate, so `none` genuinely means "this policy does not apply here" rather than
  "this repo has not proved it yet". Read the carve-out as narrower than
  go-to-k/cdkd#3209's, not wider: #3209 drops only cdkd's MECHANISM (the
  sentinel) and still requires `markgate verify verify-pr`, while this is a
  bare `exit 0` with markgate never consulted -- which is sound only because at
  `none` there is no marker to ask for. A gate that HAS an answerable marker in
  the target must not copy this shape.

**Fail closed on UNDETERMINABLE.** Only a positively parsed `gates:` block with
the name absent counts as "not declared"; a `.markgate.yml` that exists but
yields no parsable block keeps the cdkd gate name, so a config this parser does
not understand can never route a merge onto some other repo's marker. An absent
`.markgate.yml` does count as "declares nothing" -- that is already how every
other hook here decides a checkout is not a markgate repo.

**Per-gate audit.** All four share the defect structurally -- same resolve,
same `cd`, same cdkd-only gate name -- so all four were fixed. They differ only
in REACHABILITY and in whether an alias exists:

| gate | reachable in a sibling today | alias row |
| --- | --- | --- |
| `integ-local` | YES -- cdk-local's whole runtime is `src/local/**` / `src/cli/commands/local-*.ts`; demonstrated live | `github.com/go-to-k/cdk-local` -> `integ` (the key is HOST-qualified -- copy this shape) |
| `integ-destroy` | not today -- neither sibling has `src/provisioning/**`, `src/deployment/**` or `src/analyzer/**` | none: neither sibling has a destroy path, so their `integ` never exercised a delete |
| `integ-broad` | not today -- same paths | none: the marker is bound to a broad-set real-AWS sentinel with no sibling counterpart |
| `integ-schema-migration` | **YES since go-to-k/cdkd#3351** -- cdk-local has the same file at the same path with byte-identical spelling; only the gate's broken regexes were keeping it out | none, and one is no longer needed: a FOREIGN target resolving to `none` now PASSES (see below) |

**The `integ-schema-migration` row earned a correction, and the correction is
the interesting part.** An earlier revision of this table said "neither sibling
has `src/types/state.ts`". That is FALSE: cdk-local ships that same path, and it
carries `STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = 7`.
The gate's FILE-path scope check therefore matches cdk-local exactly. What KEPT
it inert, until go-to-k/cdkd#3351 corrected them, was only the second half of
its activation test -- the diff-content regexes -- which scored 0 against that
file for incidental spelling reasons. Both are HISTORY now; they are written out
because the reasoning below turns on them:

- `version:\s*\d+(\s*\|\s*\d+)+` missed because the union is spelled
  `export type StateSchemaVersion = 1 | 2 | ...` (an `=`, not a `version:` key),
  and the record field is `version: StateSchemaVersion`, a type name rather than
  numeric literals.
- `STATE_SCHEMA_VERSION\s*=\s*\d+` missed because the constants are
  `STATE_SCHEMA_VERSION_CURRENT` / `_LEGACY`, so `_CURRENT` intervenes before
  the `=`.

Neither shape has ever existed in cdkd's `src/types/state.ts` either, which is
the part the paragraph below turns on: the patterns were not describing
cdk-local badly, they were describing `CLAUDE.md` instead of any source file.

**That conclusion has since FLIPPED, and the instruction one line up -- re-measure
rather than trust the paragraph -- is what flipped it** (go-to-k/cdkd#3351). The
"weaker guarantee" was the whole story: both regexes were describing
`CLAUDE.md`'s flattened `interface StackState` snippet rather than the file they
grep, so they matched nothing in EITHER repo, and the row read "not reachable"
for cdk-local only because the gate was equally inert for cdkd. Correcting them
made the sibling path live on the first try.

The remedy is NOT an alias row. There is nothing in cdk-local for one to point
at -- its `integ` gate is Docker local-execution and attests to no state round
trip -- so a row could only have recorded "no equivalent", which is what `none`
already means. Instead the gate takes the go-to-k/cdkd#3209 precedent: a
requirement only cdkd DEFINES is required only where it is defined, so a target
that is provably a different repository AND resolves to `none` now exits 0.
cdk-local's schema is cdk-local's own contract to gate.

Two properties keep that from being a bypass, and both are fenced:
`gate_target_is_foreign` answers "not foreign" for an UNRESOLVABLE identity, so
an unreadable target keeps the refusal; and its allowlist half withdraws the
relaxation when the command can name another repo, because
`gh pr merge <N> --repo go-to-k/cdkd` from a sibling checkout resolves a CDKD
pull request while the target directory is still the sibling. The residue is
deliberate and fail-closed: a foreign repo whose `.markgate.yml` exists but does
not PARSE resolves to `canonical`, not `none`, and still takes the unclearable
refusal -- an unparsable config cannot say what it declares.

"Not reachable today" is in every case a property of the siblings' current file
layout, not of the gate, so it is not a reason to leave the shape in place.

**The other four markgate gates are NOT affected, and that is a measurement
rather than an assumption.** Comparing the three `gates:` blocks: cdkd declares
`check`, `docs`, `verify-pr`, `pr-review` and the four `integ-*` above;
cdk-local declares `check`, `docs`, `verify-pr`, `pr-review`, `integ`,
`cdkd-parity`, `create-integ`, `merge-pr`; cdk-real-drift declares `check`,
`docs`, `verify-pr`, `pr-review`, `integ`. So `check-gate` (`check` + `docs`),
`verify-pr-gate` and `pr-review-gate` ask about names BOTH siblings declare, and
the cdkd-only names are exactly the four fixed here. Re-run that comparison
before assuming it still holds -- a gate renamed in any of the three repos puts
its hook back into this class.

**Read "NOT affected" as scoped to the gate NAME, which is the only question
this file answers.** `verify-pr-gate` asks about a name both siblings declare
AND additionally compared `<target top>/.markgate-verify-pr-sha`, a cdkd-only
sentinel neither sibling writes -- so it carried an unclearable sibling refusal
of its own until go-to-k/cdkd#3209, by a different mechanism than aliasing and
with a different fix (require the binding only in the repo that defines it;
`hooks.md`'s sibling-repo section has it). The lesson generalises past the name:
when a gate refuses a sibling target, ask what ELSE it compares.

**Three further defects came out of review round 1, all in the alias path.**

- **Exit 2 is not staleness, and the alias is where that bites.** markgate exits
  2 for "could not EVALUATE" (`hash: diff` with an unresolvable base, or no
  delta against the merge base) and `markgate set` fails on the same condition,
  so the "go run the integ" remedy burns a real Docker / AWS run and leaves the
  merge blocked. The one alias that exists points at cdk-local's `integ`, a
  `hash: diff` gate, so exit 2 is its NORMAL verdict from that repo's base tree
  (measured: `no delta against merge-base(origin/main, HEAD)`). All four gates
  now branch on `status -eq 2` into the shared `gate_refuse_unevaluable_marker`.
- **That branch must sit ABOVE the alias refusal.** In `integ-destroy-gate` it
  originally sat below, which was latent only because no `integ-destroy` alias
  row exists -- adding one later would have silently disabled the exit-2
  message. Ordering is now identical in all four: rc 0 -> pass, rc 2 ->
  unevaluable, alias -> alias refusal, else canonical.
A doc cell like that one is worth calling out as its own hazard class. It is
not merely stale -- it is the **template the next author copies from**, so its
staleness propagates into CODE rather than sitting inert on the page. A row
written in the old two-segment form matches nothing, and it fails SILENTLY:
no error, no refusal, just an alias that is never found and a gate quietly back
to refusing every sibling merge. When a key format changes, grep the docs for
the old shape as part of the same change, not as a follow-up.

- **The slug carries the HOST.** `gate_repo_slug` returned `<owner>/<name>`, so
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
  (GitHub's SSH-over-443 host) and `www.github.com` are folded to `github.com`
  -- without it the same repository keyed two ways, and a checkout naming THIS
  repo through an alias read as FOREIGN, dropping the go-to-k/cdkd#2686 binding
  in a checkout that is cdkd. ONLY those two: `nope.github.com` and
  `gist.github.com` resolve nowhere in gh (measured), so leaving them unaliased
  agrees with gh. And the `.git` suffix is stripped CASE-INSENSITIVELY, because
  the case-fold happens after it and an upper-case `.GIT` otherwise survived
  into the slug -- a latent bug whose own test case is GREEN IN CI (which checks
  out a suffix-less URL) and RED in a local clone, so the direct
  `gate_slug_from_url` cases are what hold it.

  Over-normalising is safe in a consumer that asks "does this remote name
  *THIS* repo": a spurious match makes a checkout read as this repo, which ADDS
  a requirement. **`gate_resolve_marker_gate` is NOT of that shape** -- it keys
  the alias table below on the slug, so a spurious match REMOVES a refusal,
  selecting a sibling's gate where the unfolded slug answered `none`. That is
  correct today only because just a genuine cdk-local checkout can fold into
  cdk-local's row; it stops being correct if the alias list widens past gh's own
  two hosts, so widen the list and this consumer together. The unqualified
  version of this sentence was measured FALSE for that consumer, which is why
  the qualifier is here.

  It is also NOT safe in a design that ranks remotes and compares a winner --
  there an over-accepted remote outranking gh's real choice makes the comparison
  EQUAL and RELAXES (measured, go-to-k/cdkd#3372). Do not carry the argument to
  such a caller.

**The ordering trap above is fenced STATICALLY, in `markgate-gate-name-class.test.sh`
fence 4**, which asserts that each of the four gates handles markgate rc-2 at an
earlier line than its alias refusal. It has to be static, and the measurement
says so: moving the rc-2 block below the alias block in `integ-destroy-gate.sh`
-- behaviour-PRESERVING for an alias-less gate, since `__mode` is never `alias`
there -- left the destroy suite at 24/24 AND the local suite at 46/46, while
fence 4 went red. Only `integ-local` has an alias row, so only its suite can
reach that branch at all; the other three carry a live trap no behavioural test
can see, and it springs exactly when someone adds their first alias row, which
is the moment nobody re-reads the ordering. A fence for a case that does not
exist yet can only be static.

**A probe is only evidence for the mutation you actually claim to fence.** The
first attempt at the control DELETED the rc-2 block instead of moving it. That
changes behaviour -- the destroy suite's `error`-verdict case sees a different
message -- so the control came back RED, which reads as "the per-gate suite
already covers this" and would have retired fence 4 as redundant. Re-run with
the MOVE, the two per-gate suites report NOT FENCED and the class fence reports
RED, which is the actual justification. Delete-vs-move is a behaviour change
versus a pure reordering; do not substitute one for the other.

Driven in BOTH directions by `.claude/hooks/integ-local-gate.test.sh` (23 added
cases) and four cases each in the three sibling suites. The ACCEPT direction is
the one that matters, since the defect is an over-tightening and a guard fenced
only on "refuses what it must" cannot see one. The sibling suites drive their
"a repo declaring only its own `integ` is NOT accepted on it" case with a FRESH
verdict, so a hook that guessed an alias by name would exit 0 and fail the case.
Twenty-two mutation probes were taken and every one went RED, alongside three
controls that must NOT fence and did not: a comment-only edit, and the rc-2 MOVE
seen through each of the two per-gate suites.

**Two of the accept-direction cases were VACUOUS when first written**, and only
a pre-fix comparison found it -- the probes did not. Measured by swapping in the
origin/main hook + lib: the "sibling with fresh equivalent gate ACCEPTS" case
and the "names the command to run there" case both PASSED against the pre-fix
hook, so they fenced nothing. Three separate causes, all now fixed: the markgate
shim returns `fresh` for ANY gate name, so exit 0 alone cannot discriminate; the
argv needle `verify integ` is a strict SUBSTRING of `verify integ-local`, the
very string it exists to reject (this one also silently hollowed out the argv
half of a THIRD case, which still failed on its stderr assertions and so looked
healthy); and `/run-integ local-` appears in the pre-fix message too. The needles are now anchored on the argv joiner (`verify integ|`) and on
alias-only text (`/run-integ local-<test>`). **Re-run the pre-fix swap after
touching any of these cases** -- it is the only check that catches this class,
and this is the same substring-confluence failure that hit three other lanes in
the same session. The two cases that legitimately still pass pre-fix are the
FAIL-CLOSED regression guards, whose whole assertion is that behaviour did not
change; probes P3/P4 fence those instead.


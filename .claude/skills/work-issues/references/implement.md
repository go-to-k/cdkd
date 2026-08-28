<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One worktree per lane, then implement

Never edit in the main checkout — the `main-tree-branch-gate` hook blocks branching
there anyway. Per lane:

```bash
git worktree add .claude/worktrees/<branch> -b <branch> origin/main
cd .claude/worktrees/<branch>
mise trust && mise install   # untrusted .mise.toml: vp / markgate will not resolve
pnpm install                 # worktrees have no node_modules
vp run build                 # ...and no dist/ — see below
```

**`mise trust` is not optional here, and skipping it fails in the direction that
costs most.** A fresh worktree's `.mise.toml` is untrusted, so `mise exec --
markgate set` errors instead of writing — and if you read the rc of a pipeline
rather than of `markgate` itself, it looks like it worked. Measured 2026-08-28:
`markgate set check` printed `mise ERROR` twice and `markgate status` still said
`no marker` for every gate. Verify with `markgate status` rather than an exit
code, which this file already tells you to do for a different reason.

**Build BEFORE the first test run, and read a fresh worktree's failures with that
in mind.** A worktree starts with no `dist/`, and any test that spawns the built
CLI then fails on the missing binary rather than on its subject — with an
assertion message about the SUBJECT, which is what makes it costly. Measured in
go-to-k/cdk-real-drift on 2026-08-27: a docs-only lane in a fresh worktree saw 13
failures in a CLI exit-code suite (`expected 1 to be 2`), reproduced them with its
own edit stashed, and had begun writing them up as "a peer merge broke main" — the
same file passed in the main checkout, which HAS a `dist/`, so every comparison
pointed at main. One `vp run build` in the worktree turned it green with no other
change. **A fresh worktree failing where the main checkout passes is evidence about
the WORKTREE first**, and a build costs seconds against a false broken-main report.

**Before fixing, ask whether the defect has SIBLING SITES — and if it does,
sweep them in THIS lane rather than filing them.** Most defects here are a
CLASS, not an instance: one provider mishandling an empty sub-object, one
resolver arm missing an intrinsic, one caller of a shared helper assuming the
old contract. So once the root cause is named, grep for the same shape across
the repo before writing the fix:

```bash
# The shape depends on the defect; the DISCIPLINE is that you run one.
grep -rn "<the mishandled call / property / assumption>" src/ | grep -v test
grep -rln "implements ResourceProvider" src/provisioning/providers/   # per-implementer audits
```

**Query for the PRECONDITION minus the REMEDY, never for the remedy alone.** When the
defect is a MISSING thing, the obvious grep searches for the thing that is missing —
and it can only ever return the sites that already HAVE it. The absent sites are
invisible to it by construction, so the sweep reports itself complete while covering
only the half that was never broken. Ask instead: what makes a site ELIGIBLE for this
defect, and which eligible sites lack the fix?

```bash
# WRONG -- finds only the providers that already validate.
grep -rln "validateDesiredProperties" src/provisioning/providers/
# RIGHT -- eligibility minus remedy.
for f in $(grep -rln "implements ResourceProvider" src/provisioning/providers/); do
  grep -q "validateDesiredProperties" "$f" || echo "NO VALIDATION: $f"
done
```

Measured in go-to-k/cdk-local on 2026-08-27, whose root cause was "a fixture leaks the
Docker image it builds". The sweep was bounded by a grep for the REMEDY
(`docker rmi|docker image rm|docker image prune`); it returned five sites, every one of
them a fixture that already had cleanup, and the lane closed all five and declared the
class done. Eligibility minus remedy returns six more, plus a seventh that neither query
finds — so the remedy-shaped query had seen 5 of 12 eligible sites.

This repo is the one most exposed to it, because so many of its defects ARE missing
entries: an absent `handledProperties` row, a provider with no validation arm, a type
with no comparator. Every one of those is invisible to a grep for the thing it lacks.

**The same run then repeated the mistake one level up, which is why this is a rule and
not a footnote.** An agent that had just diagnosed the flaw in the orchestrator's query
sized the residue from the ONE instance it had tripped over — "one site, ~30 min" —
rather than asking which query would find the class. It was seven. **A count derived
from the instance you happened to hit is not a count**, and sizing a deferral is exactly
where that bites, because `Effort` and `Estimate` are what a future session budgets from.

**This applies to a FIX ROUND at least as much as to the original find, and
that is where it actually gets skipped.** The rule above reads as advice for
discovering a defect; the recurring failure is the fix landing on ONE call site
while a sibling keeps the defect, usually shipping a comment that asserts
completeness. Measured across one run on 2026-08-27, FIVE times on two lanes,
and the last two were in edits made while fixing the previous instance:

| Fix | Sibling that kept the defect |
| --- | --- |
| the 2-arg `Fn::Sub` binding check | the bare-string arm, one line over |
| adding a region-header read | never bounded WHICH errors carry the region |
| redacting the update/delete warn | the create path, and its own `catch`'s sibling arm |
| adding a site to one enumeration | the second enumeration in the same file |
| completing that second enumeration | a third list on the same LINE |

Every one was found by ENUMERATING readers or call sites with grep. None was
found by re-reading the diff, and three had review rounds that read the diff
first and missed it. So after writing a fix, before believing it:

```bash
# Derive the population from the CODE, not from the files your diff touched.
grep -rn "<the field / helper / message you just changed>" src/ | grep -v test
```

and check the count against what you changed. If your fix touched two of three
readers, you have not fixed it -- and if you then write "all N sites now do X",
you have made it durable, because an overstated invariant is what stops the next
reader looking. Three of the five above shipped exactly that sentence.

The cheap tell: a fix whose diff touches ONE site while its message says
"every", "all", "never" or "only". Either derive the population or drop the
quantifier.

**Grep for the SHAPE, not for a NAME — a name finds only the copies you already
knew about.** This is the sweep's own version of the defect it exists to
prevent, and it is easy to miss because the grep looks thorough and returns
hits. On 2026-08-23, go-to-k/cdkd#2176 asked for exactly this sweep over a
duplicated secret-masking walk. The sweep grepped `maskDeep` and
`MASK_WALK_MAX_DEPTH` — the identifiers the known copies used — found four, and
shipped a PR whose comments, docs and follow-up issue all said "four". There
were SIX: two more copies spelled the function `maskLeaf` / `maskLeafValue` and
declared no named constant to grep for. Three independent reviewers caught it,
in the PR written to close the issue that warns about precisely this ("a
per-provider fix that misses siblings just moves the hole"). Grep for a
structural line the copies must share whatever they are called — here
`typeof value === 'string'` beside an `Object.fromEntries`, or simply
`Object.entries(.*).map` — and only then confirm by name:

```bash
# Structural first (finds a renamed copy), name second (confirms what you found).
grep -rn "<a line the shape cannot omit>" src/ | grep -v test
```

**And count the population BEFORE you fix, then assert the count afterwards.**
A sweep that reports a NUMBER in its commit message, its docs and its follow-up
issue has committed to that number in three places; re-deriving it from the
post-fix tree cannot detect a copy the sweep never saw, because the fix removed
the very thing you would grep for.

**Paste the command with the number, and re-run it before you ship.** A count
that appears in a commit message, a changelog entry and a PR body has been
asserted three times, and a reader can only re-derive it if the query is there.
On 2026-08-26 the go-to-k/cdkd#2227 sweep claimed "88 hits across 13 files";
the reviewer's `grep -rn "AlreadyExists\|AlreadyOwned" src/provisioning
--include=*.ts | wc -l` returned 47, and no single grep reproduced 88 -- the
number had come from a different, wider invocation than the one the prose
implied. The CONCLUSION held, which is exactly why this is easy to ship: a
right conclusion with an unreproducible measurement reads as evidence and is
not.

**Any CLAIM relayed from a subagent's report is unearned in the same way — not
just a count — and it is the harder half, because there is no command to paste:
you never ran one.** A count is only the easiest instance to catch; the shape
covers any assertion about what the work DOES. Measured 2026-08-26: an agent
reported that its hermeticity pins were "each probed adversarially", the
orchestrator relayed that to the maintainer as evidence of verification depth,
and a reviewer then measured it — the PATH decoy was created and never placed on
PATH, and deleting six of the pins left the suite 65/65 green. Only `PATH` and
`TMPDIR` were load-bearing. Nothing about that claim was numeric, so a
count-shaped rule does not reach it.
The rule above assumes the number came from a sweep you performed. The numbers
that actually get published usually do not: they arrive inside a fan-out agent's
summary or a reviewer's finding, already phrased as fact, and get copied onward
without anyone re-deriving them. On 2026-08-26 one run of this skill published
FOUR such counts, every one wrong and every one relayed: "all nine sibling
`clearOnUpdateRemoval` sites" (grep: **78** call sites across 14 provider files
— wrong by ~9x, and it under-scoped the deferred work it was justifying), "nine
mutation probes" (fourteen), "ten unit shapes" (thirteen), and "if a third copy
ever appears" for a predicate that already had **nine**. Two of them went into
GitHub artifacts — an umbrella-issue comment and a PR body — where they outlive
the session that got them wrong, and one of those was the load-bearing argument
for deferring the work to the umbrella at all.

The tell is grammatical rather than technical: a number arriving as a WORD
("nine sites", "a third copy") has almost always been counted by a person or an
agent, while one arriving as output has been counted by a machine. So before a
relayed count is published anywhere durable, run the query yourself and put it
in the text. It is one command, and the reviewers on that run spent three
separate rounds catching these instead of catching code. Two forms of the same
discipline are what finally worked there: the implementing agent derived its
next count with `awk` over the test file's `it(` titles and CAUGHT ITS OWN
correction mid-flight (its first fix said fifteen by double-counting one entry),
and it declined to relay a path from the orchestrator's own message after
grepping and finding the file did not exist.

**Before deriving a fix, grep the repo for the SYMPTOM -- something may already
have solved it.** This is a different search from the sibling-site sweep above:
that one looks for the same BUG elsewhere and greps the defect's shape, while
this one looks for a place that already answered the same QUESTION and greps
the error string, the API name, or the surprising behaviour. On 2026-08-26
`src/utils/aws-region-resolver.ts` already carried the mechanism the
go-to-k/cdkd#2227 lane spent a real-AWS round trip rediscovering, verbatim:
"AWS SDK v3's region-redirect middleware does not handle the empty-body HEAD
response on a 301 ... produces a synthetic `name: 'Unknown', message:
'UnknownError'`". Neither the implementation nor its tests had consulted it. A
grep for `UnknownError` or `followRegionRedirects` would have found it in
seconds, and the helper next to that comment also documented the fail-OPEN trap
that the eventual fix had to avoid.

**N sites of one root cause is ONE issue and ONE PR, never N issues.** This is
the single largest source of unbounded backlog growth: split into N, each site
pays the full fixed cost — triage, claim, worktree, review tier, integ run,
merge, release — for a fix that is the same edit N times. Swept together, that
cost is paid once, and the reviewer sees the whole class instead of one instance
whose generality is invisible. It also removes the failure mode where sites 2..N
sit open long enough for the fix at site 1 to drift away from them.

Two boundaries, so this does not become a licence for unbounded lanes:

- **A sweep that would make the PR unreviewable is a genuine `next`** — file it
  as an explicit umbrella naming every site (§3 already sorts umbrellas last),
  and say in the umbrella which sites this lane DID close, so the residue is
  unambiguous rather than "the rest, somewhere".
- **Sweep the same ROOT CAUSE, not the same AREA.** Two unrelated bugs in one
  provider are two issues; one wrong assumption at five call sites is one. The
  test is whether a single sentence describes the fix at every site.

**And whatever you do file, resolve it against the issues ALREADY OPEN first.**
The sweep above looks for sibling sites in the CODE. This looks for a sibling
ISSUE, and it is a different search with a different answer: the umbrella that
covers your finding was written from a DIFFERENT site, by a different lane, and
names a different provider. Section 10-c already runs a rigorous version of this
check -- the merged file, then open PRs, then open issues -- but its subject is a
mirrored skill LESSON. The path that files a defect follow-up mid-lane, which is
where the volume comes from, ran no such check at all.

Measured 2026-08-25. The backlog is NOT rotting: 115 open, median
time-to-close 0.17 d, p90 0.96 d, and exactly two open issues older than a
month. What does not converge is the COUNT.

Where it fails to converge is visible in which issues stay open. By §3's OWN
umbrella predicate -- title or body says `umbrella`, `audit:`, `Backfill`, or
`N entries` -- 13 of the 115 open issues are umbrella-shaped, and **all four of
the oldest are**: go-to-k/cdkd#609 (90 d), go-to-k/cdkd#1160 (33 d),
go-to-k/cdkd#1225 (30 d), go-to-k/cdkd#1393 (16 d). In a repo that closes a
median issue in four hours, the ones that do not close are the ones naming N
sites, because no single lane can close one. Meanwhile 94 of the 115 open
issues carry `Session-fit: next` and `Session-fit: now` appears 3 times in the
last 400, so the deferral classifier has one outcome in practice.

That is the shape: the unit drifted from one ROOT CAUSE to one affected SITE,
and this codebase's site space is types x properties wide, so an umbrella
either sits open for months or is split into forty issues that each pay the
full fixed cost.

```bash
# Search the CONCEPT, not this instance's spelling -- the same reason the code
# sweep above greps for a SHAPE rather than a name.
gh issue list --state open --limit 200 --search '<root-cause concept>' \
  --json number,title
# Then the body window, which the search index misses: an umbrella names its
# sites in the body, not the title.
gh issue list --state open --limit 200 --json number,title,body \
  --jq '.[] | select((.body // "") | test("<shared symbol / call / assumption>";"i"))
        | "\(.number)\t\(.title)"'
# `(.body // "")`, not `.body`: an issue filed with no body makes `test` abort
# the whole jq program with "null (null) cannot be matched", so one body-less
# issue silently costs you the entire window.
```

On a HIT, the finding becomes a CHECKLIST ROW in that issue rather than a new
issue number:

```bash
U=$(mktemp)   # NOT a fixed /tmp path -- parallel lanes share the scratchpad
gh issue view <hit> --json body -q .body > "$U" \
  && [ -s "$U" ] \
  && printf -- '- [ ] <site>: <one line, plus where the evidence is>\n' >> "$U" \
  && gh issue edit <hit> --body-file "$U"
```

**The chaining and the `-s` test are load-bearing, not style.** The redirect
truncates `$U` before `gh` runs, so an unchained recipe whose `view` fails --
wrong number, a non-repo cwd, a transient error -- leaves an empty file that
the `printf` fills with the single new row, and the `edit` then replaces the
umbrella's WHOLE body with it. Every previously folded finding would be
destroyed by the very procedure that exists to preserve them, which is the one
outcome §10-0 says must never happen. `mktemp` rather than a fixed path for the
same reason at a different scale: parallel lanes share the scratchpad, and a
read-modify-write with no concurrency control loses a row when two folds
overlap -- so do not run two folds against the same issue concurrently.

On a MISS -- the expected outcome for a genuinely new root cause -- file it, and
record the search in the body so the next lane can see the window was checked:

```text
Dup-check: searched open issues for <terms> -- none covers this root cause
```

**File it with its `Severity` / `Effort` values ALSO as labels** — the body lines
stay exactly as written, and the same two values ride the command as
`--label severity:<high|medium|low> --label effort:<small|medium|large>`:

```bash
gh issue create -t 'fix(provider): ...' --body-file "$B" \
  --label severity:high --label effort:large
```

Prose is invisible to `gh issue list`, so applying §3's ranking rule 3 at all
used to cost one `gh issue view` per candidate. Making it a listing-time filter
is what let that rule move ABOVE the title-prefix heuristic: a prefix is a proxy
for how much a defect costs while it sits, and `Severity` is that same thing
measured. It stays gated on BOTH candidates carrying the value, because a
label-only query under-counts — most of the backlog predates the labels — so the
body remains the authority. Only these two get labels:
`Session-fit` is re-decided when the issue is claimed and a stale label would be
worse than none, and `Estimate` is a free-form duration with no closed value set.
The same applies at §4's CLAIM, which is where an old packed body is rewritten
into the four-line shape and therefore where `Severity` first exists for most of
the backlog — carry `--add-label` on that `gh issue edit`. Enforced by
`.claude/hooks/issue-classification-label-gate.sh`, which refuses a
`gh issue create` / `gh issue edit` whose body states a value the labels do not
carry; `gh issue comment` is not gated. A folded checklist row (the HIT path
above) still carries no classification of its own — write the severity into the
row's text, as this section already says.

**This is not a filing threshold, and it must never be used as one.** Section
10-0 below is explicit that `filed <= closed` is not a target and that an
unfiled finding is strictly worse than a filed one. Nothing here changes WHETHER
a defect gets written down; it changes only WHERE. An open issue then counts one
unresolved root cause instead of one unfixed site -- and root causes are bounded
by the codebase while sites are bounded by types x properties, so that is the
number that can actually converge.

Enforced by `.claude/hooks/issue-dup-check-gate.sh`, which refuses
`gh issue create` without the `Dup-check:` line, and the same refusal covers
`gh api repos/<o>/<r>/issues`, which mints an issue through the REST verb.
`gh issue edit` and `gh issue comment` are deliberately NOT gated BY THAT GATE --
folding into an existing issue is the outcome it steers toward, so taxing the
cheap path would defeat it. The classification-label gate above makes the
opposite call about `edit` for the opposite reason, and the two are independent.

Be precise about what that buys, because the obvious claim is false: folding is
not CHEAPER than minting. After the same search, minting is one command and
folding is three (`view`, `printf`, `edit`). What the gate does is make minting
non-free while leaving folding untaxed -- it removes minting's advantage rather
than creating one for folding. Two consequences worth stating rather than
discovering: a folded row carries no `Session-fit` / `Severity`, so §3's
ranking cannot see it (write the severity into the row's text), and `gh issue
edit` passes through the `#N` item-number gate that `gh issue create` bodies
get, so keep bare `#N` out of a folded row yourself. The gate exists because this
section's own rule -- "N sites of one root cause is ONE issue and ONE PR, never
N issues", already written and already correct -- produced the numbers above.
Registration is not execution.

Do the fix in the worktree (match the existing provider/pattern exactly; ESM
relative imports need the `.js` extension — even in TypeScript). After every source
change, `vp run build` — the CLI runs from `dist/`, so an unbuilt change has no
effect. **Always add a unit test that fails without the fix and passes with it**
(under `tests/unit/**`, AWS SDK mocked via `vi.mock()`) — do not wait to be asked.
**Check first whether the artifact already has a test harness** — `.claude/hooks/`
carries per-hook `*.test.sh` suites run by `run-tests.sh` under its own
`hooks.yml` workflow, which is not where you would look from `tests/unit/**`.

**Run such a harness from BESIDE its subject, never from a scratch copy.** Every
suite resolves the hook under test from its own script path, so a copy runs
against a sibling that is not there and every case fails with exit 127 —
reporting a regression your change did not cause. Measured here 2026-08-19:
`branch-gate.test.sh` scores `Pass: 27  Fail: 0` from `.claude/hooks/`, and from a
scratch directory exits 1 with `branch-gate.sh: No such file or directory`. Say
`$0` / `${BASH_SOURCE[0]}`-relative rather than naming one spelling — 27 of the 33
suites use `${BASH_SOURCE[0]}` and 6 use `$0`, so a rule naming only one is false
for most of them. Two things here double the damage: `pr-review-gate.test.sh`
derives the REPO ROOT the same way, so a copy misresolves twice; and
`run-tests.sh` is itself `${BASH_SOURCE[0]}`-relative before it globs the suite
directory, so a copied RUNNER cds to the wrong repo entirely.

The trap is invited by the before/after comparison a hook change wants: to check
the OLD suite against the NEW hook, the obvious move is
`git show origin/main:<suite> > /tmp/x.sh && bash /tmp/x.sh`. Write the old copy
next to the real one under a temporary name (`.claude/hooks/_old-<name>.test.sh`)
and delete it after — otherwise the probe measures its own path resolution rather
than the hook. This is the one place the scratch-copy idiom §8 recommends does NOT
transfer: it is right for a data file and wrong for a runnable harness.

**When the issue reports a stale ENTRY in an enumerated list, audit the whole
list, in both directions, before fixing the named entry.** The defect class is
"this list drifted from the repo", and drift almost never produces exactly the
one instance someone happened to notice. Check both that every entry still
resolves to something real AND that every real thing that belongs is present —
the second half is the one that gets skipped, because the issue only names the
first. On 2026-08-19 go-to-k/cdkd#1972 reported one dead path in the
security-surface list; the audit found a second dead path
(`src/local-invoke/docker-runner.ts`, stale since a PR go-to-k/cdkd#228 rename) and
four live authn / credential / exec surfaces that had never been added, so the list
under-protected far more than it over-claimed. Then ask what makes the recurrence
mechanical: if the issue says a list must stay in sync with the repo, that is a
test, not a sentence asking the next reader to remember.

**When the audit is a MEASUREMENT, the shape of the sample is the finding — a
clean result from the wrong shape is indistinguishable from a clean subject.**
Auditing go-to-k/cdkd#2096 on 2026-08-20 produced SIX confident wrong answers,
each from a different plausible sampling shape, and each one hid a real secret:

- **Newest-N.** `appsync` was cleared by reading its 6 NEWEST state versions,
  which are clean; versions 12-45 held an AppSync API key in 17 of 33. The newest
  versions come from the most recent run, i.e. the one most likely already fixed.
  Sample across the range, or grep the whole key.
- **One global needle.** A single `cdkd-known-*` grep reported `secrets-array-nested`
  clean while 5 of its 7 versions carried `cdkd-array-nested-pw-789`. Each fixture
  spells its OWN literal, so derive the needle per subject — or better, assert on a
  needle-INDEPENDENT observable (here, surviving version count == 0).
- **A name derived from convention.** `cognito-resource-server`'s stack is
  `CognitoResourceServerStack`, not the `Cdkd…Example` the directory implies;
  probing the convention returned `0 of 1` and nearly retired a real finding as
  unreproducible. Read the identifier from the subject (`verify.sh`'s `STACK=`),
  never infer it.
- **A silent parse failure inside a pipe.** `aws s3api get-object … /dev/stdout`
  emits metadata alongside the body, so a `json.load` in the pipeline died and the
  loop counted `0 of 16`; a text match found 4. A parse that can fail must report
  failing, not fall through to a count.
- **A per-page aggregate.** `--query 'length(Versions)'` is applied PER PAGE and
  concatenated, so a 1189-entry prefix prints `1000\n189` — and `[ "$n" -ne 0 ]`
  on that is a bash error, not a count. Count ROWS of a projection instead.
- **Grepping the layer the subject does not use.** `AWS::ApiGateway::ApiKey` is
  registered to NO provider, so it takes the generic Cloud Control readback whose
  model includes `Value`. Searching `src/provisioning/providers/**` for credential
  handling — the obvious cross-check — cannot see it.

The through-line: every one FAILED CLEAN. So when a measurement says "nothing
here", treat that as the claim needing evidence, not the one that needs none —
run the shape against a case you KNOW is dirty first, and only then trust a zero.
The same run had a merged repo-wide scanner fail clean for the seventh time in
this family: its `stripComments` stripped block comments before line ones, so a
`//` comment containing the glob `src/provisioning/**` opened a block comment and
swallowed 235 lines of `deploy-engine.ts`, dropping 2 writers and 2 helper calls
into silence.

**Adding a HANDLER to a slot that already has one REPLACES it.** Bash `trap`
does not chain: a second `trap ... EXIT` anywhere in a script silently disarms
the first, and in an integ fixture the first is the AWS teardown. Nearly shipped
2026-08-25 on the go-to-k/cdkd#2213 lane, acting on a correct reviewer nit -- a
`mktemp` scratch file leaked on five `exit 1` paths, and the obvious fix
(`trap 'rm -f "${OUT}"' EXIT`) would have traded that temp file for a live SQS
queue, an anomaly detector and a state record left behind on every failure path.
The happy path still passes, so a green run proves nothing. Put the extra work
inside the EXISTING handler (unset-guarded -- it can run before the variable is
assigned, under `set +eu`), or re-install a handler that still CALLS the
original, which is the form 16 fixtures already use. Fenced by
`tests/unit/scripts/integ-single-exit-trap.test.ts`. The general shape is worth
carrying past `trap`: before adding to any single-slot registration -- a signal
handler, a callback field, an `EXIT` hook -- count what is already there.

**A mutation probe proves a test discriminates only if it changes the value the
test READS.** Four vacuous tests shipped across three lanes on 2026-08-19, and
every one had the same shape: the assertion targeted an observable that the
BROKEN code also produces — a confluence point of the fixed and the broken path,
not a discriminator. Two "released the allowance" cases asserted a poll count
that a second `delete()` never reached, so `.at(-1)` re-read the FIRST call's
value and the test passed with the release deleted. A "canonicalizes case" test
asserted "the ambient client was reused", which is also what the reject-unsafe
arm produces, so deleting the canonicalization left it green. A fourth asserted
`ambient.ssm !== instances.at(-1)` while `ambient.ssm` is a LAZY getter that
constructs at assertion time — it was measuring its own side effect.

**A probe COUNT goes stale across review rounds, so a matrix carried forward is
wrong even when every row was true when written.** Later rounds add cases that
depend on the same line, so the row that measured "exactly 1 RED" in round 1
measures 4 by round 3 — and the number is the part a reader uses to judge how
load-bearing the line is. Measured 2026-08-26 on one PR: two published rows said
1 RED each; re-run on the final tree they were 4 and 6. Nothing had regressed,
the matrix had simply been PATCHED (new rows appended) rather than RE-MEASURED.
So when a body or changelog publishes a matrix, re-run the whole thing on the
tree you are about to merge, and say which tree the counts are from — a count
with no subject is not a measurement.

So when you write the probe, name the discriminator first and assert THAT:
which client was constructed and with what region, which call the stub actually
received, what the second invocation saw. "The happy path still happens" is
almost never it. And run the probe: a test added because a reviewer asked, which
still passes under the mutation that motivated it, converts an open gap into a
false assurance and is worse than no test.

**A probe that reports NO discrimination is a claim about the FENCE, and three
other things produce the identical output.** Ask them in order before touching
the fence, because each was hit in one session (2026-08-25) and each cost a
working assertion nearly being deleted or rewritten:

1. **Did the edit land?** `sed`/`perl` one-liners fail silently in ways that read
   as "no match". A `perl -0pi -e "s|^\|...|...|m"` whose pattern is delimited by
   the same `|` it escapes matches nothing; a `sed -E`-only alternation (`\|`) is
   a GNU extension that matches nothing on macOS; a `sed: bad flag` prints ABOVE
   the suite output and scrolls past. Prove it with `grep -c '<the mutated text>'`
   before reading the result, and prefer `python3` with an `assert anchor in s`
   over a shell one-liner — an assertion that throws is louder than a quoting
   slip that quietly matches zero.
2. **Does the case's execution path REACH the edited line?** The edit can land
   and still prove nothing. Breaking a hook's branch-lookup call left its suite
   fully green because every case carried an explicit PR number, so the lookup
   never ran. The fence was fine; the probe was aimed outside the cases' path.
   The fix is a case that HAS to take that path, not a change to the fence.
3. **Did the command run where you think it did?** A relative-path edit under a
   silently reset cwd lands in another worktree, and the `git status` confirming
   it runs in that same wrong tree — so "clean" and "clean somewhere else" print
   identically. Use ABSOLUTE paths and confirm by a property the wrong tree
   cannot fake (`ls -la` mtime).

And one shape inside the fixture itself: **an expected value must be an
INDEPENDENT variable from the one under test.** A stub keyed its content on a
sha whose default was the same literal on both the producing and the consuming
side, so breaking the producing call still served the content and the case could
not fail.

Only after all four does "the fence is weak" remain as the explanation. Deleting
an assertion on the strength of an unexamined green is how a working guard gets
removed.

**Choose the probe's INPUT to discriminate too, not only its mutation.** The
mutation decides which code changes; the input decides whether that change is
observable at all. On 2026-08-20 a mask-before-`JSON.stringify` fix (PR
go-to-k/cdkd#2067) was probed with a SCALAR secret and the probe came back GREEN
under the very mutation it was written for — `stringify` escapes a JSON
document's quotes, so only a JSON-DOCUMENT secret makes the needle stop
occurring in the finished line. Both probes ran the same mutation; only one could
see it. Before trusting a green, ask what property of the INPUT the defect
depends on.

**When the change alters a CLASSIFIER, hand-picked cases cannot fence it —
measure the DELTA against the old implementation.** A classifier is any function
deciding which of several shapes an input is: a region-vs-stack-name predicate,
a route selector, an error categoriser. Its defects live in the shapes nobody
thought to write down, so a suite of chosen values goes green on exactly the
regressions that matter. On 2026-08-21 issue go-to-k/cdkd#2001 shipped THREE
green revisions that way. Each fixed the case the previous review named and
broke a neighbouring one: widening a region pattern's length bound fixed the
`eusc-` partition and started reading five idiomatic stack names (`api-prod-1`,
`demo-app-1`) as regions; an exact segment-depth rule fixed those under the
default prefix and mis-split legacy keys under a NESTED one; narrowing that rule
fixed the nested spelling and still left six shapes regressed under FOREIGN
prefixes, where the rule cannot reach at all. Every revision passed a suite that
grew a case per round.

The fence that ends it is a differential walk: enumerate the input space, run
BOTH the new implementation and a transcription of the old one, and fail on any
difference outside an explicitly enumerated set of intended classes. That
inverts the burden — a shape nobody imagined is a failure by default rather than
a silent pass — and it is what finally showed the delta was three classes when
the code comments said two. Two ways it goes inert, both measured on that lane:

- **Classify by the resulting VALUE, not by the input's shape.** The first cut
  bucketed a differing cell by which key it was, so mutating the fix to return
  the prefix outright — a total regression of the thing the PR added — left
  every cell inside the "intended repair" bucket and the fence stayed GREEN
  while nine ordinary cases caught it. Each arm must assert what the function
  now returns.
- **Carry a floor per class.** The walk reaches a class only if the input pool
  contains it; one class was real, intended and never reached, so a pool that
  quietly stops covering one would pass as "no regressions".

The transcription is the only real cost, and it is cheap for a predicate. Get it
from `git show origin/main:<path>` rather than from memory, and confirm the two
agree on the cells where they SHOULD agree before trusting the cells where they
differ.

**A VALUE import from a module other suites `vi.mock` reds those suites.** The
`type`-only import that module already had is invisible to the mock; adding a
runtime one is not, and the failure names the EXPORT rather than the
mock (`[vitest] No "<CONST>" export ...`), so it reads as a missing symbol in
the module you just edited rather than as a mocking problem in a suite you did
not touch. Measured on the same lane: importing one constant into
`state-file-keys.ts` reddened `gc.test.ts` and `bootstrap-destroy.test.ts`,
neither of which imports it. When two modules must agree on a constant and one
of them is widely mocked, spell it in both and fence the pair with a test that
imports both — the sync is what matters, not the single definition.

**Run probes with `vp test run <path>`, never `vp run test <path>`.** The
latter goes through the Vite+ task runner, where `test` is CACHED: a repeat
invocation prints `◉ cache hit, replaying` and re-reports the previous run's
counts and duration without executing. A probe edits a file the task hash does
not cover, so the replayed verdict is the PRE-mutation one and the probe reports
PASS having run nothing. Measured 2026-08-20 in this repo, and a reviewer on
that same run had FOUR probes report PASS without executing. `vp test run` is
the command the task delegates to, invoked directly, so it always executes.
`.claude/hooks/vp-run-test-path-gate.sh` blocks the cached form; a bare
`vp run test` (whole suite) is unaffected. Two further false greens ride the
same command and are not fixed by the hook, so read the OUTPUT as well as the
rc: a suite can report `skipped` rather than `passed` (the `version` test
`skipIf`s itself when `dist/` is absent, which is the normal state of a fresh
worktree), and a run whose every test passes can still exit non-zero — see the
rc rule in section 6.

**A repo-wide SCANNER test is calibrated against the PRE-FIX tree, not written
from the issue's wording.** When the test globs the tree — `git ls-files`, a
`readdirSync`, a markdown scan — the issue's description of the signature is what
its author noticed on ONE instance, never a rule with a measured false-positive
rate. Run the candidate rule over the still-broken tree FIRST, read every hit, and
tighten until the hits are all genuine: that is the only measurement that tells a
discriminating rule from one that flags idiomatic prose. This run did exactly that
for go-to-k/cdkd#1990 — the scanner reported 13 bare `#N` references over the
unrepaired `work-issues` SKILL.md, all 13 real, while the same regex applied to the
raw text without stripping frontmatter and code spans would have flagged the
`argument-hint` example and section 10-c's own counter-example as violations. Two
sub-traps for any markdown scanner: strip on the WHOLE text rather than per line,
since an inline code span in a hard-wrapped file can straddle a line break and a
per-line pass then pairs one span's closing backtick with the next span's opening
one and invents findings; and report the HIT's own line, not the start of the
region you stripped, or the failure message points at the wrong place.

**Calibrating against the broken tree is only HALF the measurement, and the half
it leaves out is the one that lets a fence ship inert.** Running the rule over
the pre-fix tree measures its PRECISION (are the hits real?) and its recall on
the instances that HAPPEN TO EXIST. It says nothing about the SHAPE — the
spellings the tree does not currently use, and the contexts that defeat your
exemption logic. So follow the calibration with two probes, both against the
REAL tree rather than by reasoning:

- **Write the defect in the spelling a PERSON would write, not the one that is
  easiest to inject.** This is the sub-case that keeps passing, because an
  artificial probe and a natural one look equally like "I mutated it". Measured
  2026-08-26 on the issue go-to-k/cdkd#2052 lane: a prefix-sync fence split on
  `'custom-resource-responses'` *with both quote characters*, and the probe
  used `` `${'custom-resource-responses'}/` ``, which reds it. The spelling
  anybody would actually type -- `listRawObjects('custom-resource-responses/')`
  -- puts the trailing slash before the closing quote and sailed straight
  through, as did a copy in any file outside the fence's hand-written list. A
  reviewer found both. Note what that fence was FOR: it is the mechanism this
  section's own "grep for the SHAPE, not for a NAME" rule prescribes, written by
  someone who had just read that rule, and it broke it anyway -- so when the
  probe is of a fence, mutate it the way a future contributor would, and derive
  the population rather than listing it.
- **Write the defect in every spelling the language allows** and confirm each is
  flagged. On 2026-08-20 (go-to-k/cdkd#2111) a scanner for
  `options.region || process.env['AWS_REGION']` calibrated perfectly — 19
  violations, zero false positives — and matched `||` only. The tree already used
  `??` at four sites, so the obvious way to reintroduce the bug passed clean, and
  the same rule was blind to the `opts.` / `args.` bag names two other files
  resolve regions from. Widening it immediately surfaced a real pre-existing bug
  nobody had filed.
- **Delete the thing the fence REQUIRES, and watch it fail.** A fence whose
  predicate is several whole-file substrings OR'd together is satisfied by any
  one of them, and files routinely contain more than one. The same run's
  coverage fence — "every region-taking handler folds" — passed 130/130 while a
  probe deleted the ONLY fold from four handlers at once, because each still
  contained a different accepted substring elsewhere. Its POPULATION was wrong
  too: derived from "mentions `options.region`", it pulled in helper modules that
  merely RECEIVE an already-folded value while missing the files that actually
  accept the flag. Deriving it from what declares the option, and making the
  predicate per-READ rather than per-file, is what made both probes fail.

  The worst population is one derived from the DEFECT itself, because deleting
  the required thing then drops the subject OUT of the population instead of
  failing. Running these probes across the sibling repos on 2026-08-20 found
  four such fences in one tree (go-to-k/cdk-real-drift#1797): a gate-parity test
  that selected its gates by `condition.includes('Bash(git commit*)')` stayed
  green at 7/7 with two gates disarmed outright, and a hook-coverage test that
  enumerated `*.test.sh` could never report the hook that had no harness — the
  one every commit passes through. A STATEFUL scanner fails the same way with no
  OR at all: go-to-k/cdk-local#537's reference scan flipped one `inFence` boolean
  on any fence marker, so a single nested fence inverted it and muted every check
  for the rest of the file, silently.

  **A population derived from an OPTIONAL language feature is derivable-around
  for free, and a type annotation is the commonest one.** This is the same class
  arriving through a spelling that looks rigorous rather than lazy. On
  2026-08-26 a fence written to END a four-round cascade — every round's blocker
  being "another site writes this field without the gate" — derived its
  population as "files annotating `: DestroyRunnerResult`". TypeScript infers,
  so the two files that hold the object as plain locals were never scanned, and
  planting the write in one of them (the site of round 1's own blocker) left the
  fence 4/4 GREEN. The fix is to derive from a relation the write CANNOT omit —
  here, that a file either constructs the result or receives it from the one
  function that returns it. Ask of any population: *what would this look like if
  the author simply did not write the optional part?* Annotations, explicit
  return types, `export` markers, and interface `implements` clauses all answer
  "identical, and invisible to you".

  **Probe the fence with the evasions the DEFECT would use, not with the one you
  just fixed.** Re-planting the exact line you removed is the cheapest probe and
  the least informative — it is the one spelling you have already proved you can
  see. The same 2026-08-26 fence caught its own removed line and missed four
  ordinary alternatives to it: a computed member (`x['field'] =`),
  `Object.assign`, an object literal, and a spread rebuild. The last is the one
  to reach for first when the cascade has been about early returns, because a
  new early return is written as a new object, not as a new assignment.

  **And watch the FLOOR for the same collapse.** A floor naming only the file
  the defect lives in is satisfied BY the collapse it exists to catch: narrowing
  that fence's pathspec to the owner file alone still passed 4/4, because the
  floor asked for exactly the file that survived. Name the members a collapse
  drops FIRST — the peripheral ones — not the central one.

And ask the dumbest question last: **is anything RUNNING it?** The nine hook
harnesses in go-to-k/cdk-real-drift were shell, so the vitest task never saw
them, and no CI step invoked them either — they had been exercised only by hand
since the day each was written.

The general shape: **a fence is not evidence until you have watched it go red on
something you had not already counted.** Calibration tells you it is not noisy;
only the spelling and deletion probes tell you it is load-bearing.

**And no number of probes can falsify the FIXTURE, because a mutation probe
perturbs the CODE and reads the TEST while both read the same mock.** Any
premise SHARED by code and mock is invariant under mutation, so a suite can be
fully discriminating and still describe a wire shape AWS never produces. On
2026-08-26 (go-to-k/cdkd#2227) seven cases passed, were probed two
complementary ways -- removing the guard reddened six, stripping a
normalization reddened the seventh -- and the guard could not fire against real
AWS at all: the mocks had been written from a measurement taken with the AWS
**CLI**, which follows S3's cross-region 301, while the SDK client cdkd uses
does not and yields a synthetic `UnknownError`. Only the live arm caught it.
So when a fixture encodes an AWS response, its shape needs its own evidence --
a recorded real response, a live arm, or a probe against the SDK rather than
the CLI. Probing harder is the one thing that cannot supply it.

Two more questions to ask of any fence you build, both learned on 2026-08-21
from go-to-k/cdkd#2027, and both of which let a fence pass while testing less
than it claims:

- **Does it watch the OTHER direction?** A fence that asks only "is the bad
  input refused?" never notices the gate starting to refuse GOOD input. That
  lane's class fence had no such case, and two consecutive rounds shipped false
  refusals — a commit message quoting `git -C $W`, a `--body` containing a
  newline plus a command, `cd <newdir> && git init && git commit`,
  `MSG=$(echo git commit -m x)` — every one of which the fence watched go by.
  For a guard, the pair is "refuses what it must" AND "leaves alone what it
  must"; only the second catches an over-tightening fix.
- **Is it hermetic, and on WHICH axis?** Hermeticity is per-dependency, so
  closing one axis says nothing about the others, and CI is where you find that
  out one axis per round-trip. The same fence was pinned to a git SHA (failed in
  CI's shallow clone — correctly, and loudly: `cannot read baseline … fence did
  NOT run`), then vendored as a fixture, and then failed AGAIN because a `~`
  expansion made its expected values depend on `$HOME`, so it passed only on the
  machine whose table was recorded. Enumerate the axes up front — git history,
  environment, cwd, clock, locale, user — and for each either pin it or record a
  measured negative. Prefer PINNING over normalizing: a normalization layer sits
  between the implementation and the assertions, which is exactly where a fence
  goes green-but-inert, and pinning lets the case keep asserting an exact known
  value instead of a token.

You may fan out **one subagent per lane** (disjoint files) to run them
concurrently — give each agent its worktree path, its allowed files, and an
explicit "do NOT touch <the other lanes' / other agents' files>; STOP and report
if the fix needs a forbidden file" guardrail. Note: a subagent's Bash **bypasses
the PreToolUse gate hooks**, so it can `gh pr create` past `verify-pr-gate` —
enforce quality yourself; you (the orchestrator) still gate the MERGE.

**Forbid the lane agents the FULL SUITE and run it yourself, serially.** Fanning
out is right for editing and for targeted probes, and wrong for `vp run test`:
on 2026-08-20 three lane agents plus two peer sessions each started one, machine
load reached 195, a single test FILE took 607s against a 5s per-test timeout, and
all three agents were killed by the 600s watchdog mid-run. The five resulting
failures were `Test timed out` in files none of the diffs touched — indistinguishable
by inspection from a real regression, and expensive to disprove. Serialized
afterwards, the same trees were green. Tell each agent to run only
`vp test run <its own suite>` and say that the authoritative full suite is yours;
then run one lane's at a time.

**Serializing YOUR suites is not the same as serializing the machine, and a
PEER SESSION's suite is invisible from every probe this skill lists.** On
2026-08-27 a full suite exited **1** with `Test Files 806 passed` /
`Tests 16597 passed` / `Type Errors no errors` — the failure was
`[vitest-pool]: Worker forks emitted error / Worker exited unexpectedly` at load
54, i.e. a dead fork rather than a red test, and by inspection indistinguishable
from a real regression. The natural reading was self-inflicted oversubscription;
`ps aux | grep vitest` then showed the heaviest run belonged to ANOTHER
session's worktree. So before treating any suite failure as a regression, read
the rc AND the error section AND `uptime`, and check `ps` for a vitest whose
path is not yours. You cannot serialize a peer — the correct response is to
re-run once the machine is quiet, not to hunt the diff.

Two costs of the fan-out that are worth budgeting for rather than discovering:
a lane agent that waits inside a tool call is killed at 600s of silence (have it
launch long runs backgrounded with a log redirect and poll with short `tail`
calls), and any fix round that re-touches `src/provisioning/providers/**` or
another `integ-*` scope invalidates that gate's marker — so a late review finding
buys another real-AWS run. That is the gate working; budget the run rather than
arguing the code "cannot have changed behaviour".

**Three guardrails every lane prompt must carry, all learned the hard way on
2026-08-19:**

- **Never force-push over a commit you did not author.** A lane agent resumed
  with edits predating four commits the orchestrator had landed on its branch,
  and force-pushed. Nothing was lost that time only because the rebase preserved
  them — the same agent later caught the second occurrence itself, by noticing an
  unfamiliar string in a file it thought it owned and running `git log -S`. Say
  in the prompt: re-`git fetch` and inspect the branch before any force-push, and
  if the branch carries work you did not write, STOP and report.
- **A new fixture literal must not collide with an existing assertion needle —
  and neither may a new fixture RESOURCE collide with an existing resource's
  VALUE.** The literal form: a `DB_URL` added to the secrets fixture hard-coded
  `cdkd-user` as its URL user component — exactly `EXPECTED_USERNAME`, the needle
  grepped over the whole persisted env to prove a whole-secret resolution did not
  land there. The run reported a secret LEAK that had not happened. A false leak
  report is worse than a missing assertion: it is indistinguishable from the real
  thing, and the natural response is to go hunting in the redaction code.

  The RESOURCE form is the same trap one level up, and it is harder to see
  because the new resource is correct in isolation. Measured 2026-08-26 on the
  go-to-k/cdkd#2270 lane: an arm testing a same-plaintext COLLAPSE necessarily
  gives two leaves one plaintext — that sharing is what makes the arm
  discriminate — and it reused the plaintext of a leaf a pre-existing assertion
  already owned. The pre-existing `StageParam` then persisted its new sibling's
  expression and the fixture failed on an assertion the lane never wrote (89
  chars, `:stage:AWSCURRENT:`, where 79 and `:stage::` were expected). So when an
  arm deliberately makes two things equal, ask what ELSE already holds that
  value: give the arm its own secret / key / name rather than borrowing one under
  assertion. The repair is not to break the sharing — that would retire the
  fence — but to scope it.

  **And check the arm's shape actually exercises the fix before spending a run
  on it.** In that same lane, the obvious decoupling (two separate RESOURCES
  holding the pair) would have been VACUOUS: `perResourceSecrets` is keyed by
  logical id, so two resources get two bags each holding a single pair and
  redact correctly with or without the fix. One resource holding both leaves was
  the only shape where the mechanism under test decides the answer.
- **Execute every read expression you write.** Two integ runs were lost to
  fixture code, not product defects: the literal collision above, and a `jq`
  assignment written through `to_entries[]`, which builds a new array and is not
  a path back into the document. The same file already had the correct shape one
  phase away. jq / JMESPath / AWS CLI `--query` are untested code; run each
  against real output shape before finishing, in both directions where the
  expression carries a guard.
- **A read-only REVIEWER can silently revert a live lane's uncommitted `src/`
  edits, and nothing surfaces it.** The reviewer agents run mutation probes by
  editing a file and restoring it from `git show HEAD:<path>` — which restores
  HEAD, not the lane's in-flight work. On 2026-08-20 that wiped three `src/`
  edits an implementing agent had just applied in the same worktree; it was
  caught only because `git status` disagreed with what the agent had written,
  and one reviewer independently reported seeing another's probe on disk. So:
  **do not dispatch reviewers against a worktree whose lane still has
  uncommitted work.** Commit the lane first (the gates make that cheap) and
  point the reviewers at the committed diff. When a lane resumes after a review
  round, have it re-run `git status --porcelain` and `git diff --stat` FIRST and
  report both, rather than assuming its edits survived — the orchestrator cannot
  tell a wiped edit from an unstarted one.

  **Reviewers collide with EACH OTHER too, and a 3-axis dispatch puts three or
  four of them in one worktree by construction.** They all probe by editing and
  restoring from `HEAD`, so a peer's in-flight mutation is indistinguishable from
  the subject, and restoring it is "correct" behaviour that silently discards
  their work. Measured 2026-08-27 across two lanes in one run: a security
  reviewer found another's marker (`MUTD_NO_INDETERMINATE_SIGNAL`) in the tree
  and its first pass reported **6 failures that were the peer's mutation**, not
  the diff; on the other lane a test reviewer saw a peer mid-probe on
  `logger.ts` and waited rather than clobbering it. Both recovered, which was
  judgement rather than the flow working. So say it IN THE PROMPT of every
  reviewer you dispatch: peers are probing this same worktree, `git status
  --porcelain` must be EMPTY before you start a probe, and if it is not, WAIT
  and re-check rather than restoring — a `git show HEAD:<path>` over a peer's
  edit reverts it. And read any surprising probe result as possibly theirs
  before concluding anything about the fence.

  **That is a DURATION constraint, not just a precondition, and the ORCHESTRATOR
  breaks it more easily than a lane agent does.** The tree being clean at
  dispatch buys nothing if you start editing while the reviewers run — their
  probes restore from a snapshot taken at THEIR t0, so an edit landing inside
  that window is reverted by a restore that is behaving correctly. Measured
  2026-08-21: four reviewers were dispatched against a committed tree, the
  orchestrator began applying an early blocker's fix minutes later, and a
  reviewer's report ended with a warning that its restores may have reverted
  concurrent edits to the three files it had probed. Nothing else would have
  said so. The edits happened to survive, which is luck rather than evidence.
  So: dispatch, then WAIT — do other lanes' work, write the PR body, watch CI,
  but do not touch the files under review. If you must, re-verify with
  `git status --porcelain` plus a `grep -c` for a marker of each edit before
  trusting it, exactly as §6 prescribes for a blocked restore.

**Two probe-harness failures from the same run, both of which reported a false
green rather than an error.** A probe that cannot fail is worse than no probe,
because it converts an open gap into a recorded assurance:

- **A scratch harness was silently REPLACED by another agent's file of the same
  name.** Its `__main__` was `pass`, so four probes "passed" having applied
  nothing. Parallel agents share `/tmp`-style scratch space and pick the same
  obvious filenames. Name scratch files per lane, and make every probe emit a
  positive receipt it cannot produce without having run —
  `bytes 41822 -> 41799; anchor now 0 (was 1); changed=True` — then read the
  receipt rather than the exit code.

  **This rule was already written here and was broken THREE times in one run
  (2026-08-26), so the fix is to stop asking agents to invent the name: the
  ORCHESTRATOR assigns each dispatched agent a unique scratch directory IN ITS
  PROMPT** (`$SCRATCHPAD/lane<issue>-private/`, `$SCRATCHPAD/rev-<role>-<sha>/`),
  and every prompt says never to write a bare generic name in the scratchpad root.
  Decided once per run, it cannot be re-derived wrongly per agent. What happened
  without it: lane B's loop picked up a `probe.sh` lane A had written and ran **lane
  A's entire probe table twelve times against lane A's worktree**; a reviewer's
  order-probe left an uncommitted mutation inside lane B's worktree, which a second
  reviewer then restored from `HEAD`; and — the one worth knowing about — an agent
  reported a live cross-session TRESPASS that had not happened, because the
  `_old-<name>.test.sh` copies a reviewer is TOLD to write beside their subject look
  identical, from inside the worktree, to a peer writing there. A collision and a
  correct convention are indistinguishable to the lane being written into, so the
  orchestrator has to be the one who knows which is which.

  A hook was considered and rejected: it would have to match command TEXT for writes
  to a scratch path, which is the unbounded-bypass-spelling shape go-to-k/cdkd#2156
  documents. Pre-assignment moves the decision instead of trying to police it.
- **A probe's FIXTURE, not its mutation, decided the outcome.** A region test
  set `AWS_REGION` to the CONSUMER's region, under which the correct code and
  the mutation bind identically, so the probe stayed green; pointing it at the
  PRODUCER's region separated them. Same lesson as choosing the probe's input
  (section 5, above), reached from the fixture side: when a probe comes back
  green, suspect the fixture before concluding the code is fenced.


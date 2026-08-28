<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One worktree per lane, then implement

This stage (and stages 6-8) normally runs INSIDE a lane subagent the
orchestrator dispatched — one general-purpose agent per claimed issue, so the
lane's diffs, test output and review round-trips never land in the parent
context. Every rule below applies unchanged inside the lane: hooks fire on the
lane's tool calls, and markgate markers land in the lane's own worktree.
Two actions are reserved to the parent's serialization turn and are NOT the
lane's to start: a real-AWS integ run and the merge (the orchestrator's
serialization invariant; §9). A lane stops at merge-ready and reports.

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
costs most.** An untrusted `.mise.toml` makes `mise exec -- markgate set` error
instead of writing, and a pipeline's rc hides it (2026-08-28: two `mise ERROR`
lines, every gate still `no marker`). Verify with `markgate status`, never an
exit code.

**Build BEFORE the first test run, and read a fresh worktree's failures with
that in mind.** A worktree has no `dist/`; a test spawning the built CLI fails
on the missing binary with an assertion message about its SUBJECT (`expected 1
to be 2`), and the main checkout passes only because it HAS a `dist/` — a
docs-only lane nearly reported "a peer merge broke main" over 13 such failures
(go-to-k/cdk-real-drift, 2026-08-27). **A fresh worktree failing where the main
checkout passes is evidence about the WORKTREE first**; a build costs seconds
against a false broken-main report.

**Before fixing, ask whether the defect has SIBLING SITES — and if it does,
sweep them in THIS lane rather than filing them.** Most defects here are a
CLASS, not an instance (one provider mishandling an empty sub-object, one
resolver arm missing an intrinsic, one caller assuming a helper's old
contract). Once the root cause is named, grep the shape across the repo:

```bash
# The shape depends on the defect; the DISCIPLINE is that you run one.
grep -rn "<the mishandled call / property / assumption>" src/ | grep -v test
grep -rln "implements ResourceProvider" src/provisioning/providers/   # per-implementer audits
```

**Query for the PRECONDITION minus the REMEDY, never for the remedy alone.**
When the defect is a MISSING thing, a grep for the missing thing returns only
the sites that already HAVE it — absent sites are invisible by construction.
Ask what makes a site ELIGIBLE, then which eligible sites lack the fix:

```bash
# WRONG -- finds only the providers that already validate.
grep -rln "validateDesiredProperties" src/provisioning/providers/
# RIGHT -- eligibility minus remedy.
for f in $(grep -rln "implements ResourceProvider" src/provisioning/providers/); do
  grep -q "validateDesiredProperties" "$f" || echo "NO VALIDATION: $f"
done
```

Measured in go-to-k/cdk-local 2026-08-27 (fixtures leaking Docker images): a
remedy-shaped grep (`docker rmi|docker image rm|docker image prune`) found 5
sites, all already clean; eligibility minus remedy found 12. This repo is the
most exposed — its defects are often missing entries (an absent
`handledProperties` row, a provider with no validation arm, a type with no
comparator), each invisible to a grep for what it lacks.

**The same run then repeated the mistake one level up, which is why this is a
rule and not a footnote:** it sized the deferred residue from the ONE instance
it tripped over ("one site, ~30 min"; the class was seven). **A count derived
from the instance you happened to hit is not a count** — and `Effort` /
`Estimate` are what a future session budgets from.

**This applies to a FIX ROUND at least as much as to the original find, and
that is where it actually gets skipped:** the fix lands on ONE call site while
a sibling keeps the defect, usually shipping a comment asserting completeness.
Measured 2026-08-27, FIVE times on two lanes, the last two in edits made while
fixing the previous instance:

| Fix | Sibling that kept the defect |
| --- | --- |
| the 2-arg `Fn::Sub` binding check | the bare-string arm, one line over |
| adding a region-header read | never bounded WHICH errors carry the region |
| redacting the update/delete warn | the create path, and its own `catch`'s sibling arm |
| adding a site to one enumeration | the second enumeration in the same file |
| completing that second enumeration | a third list on the same LINE |

Every one was found by ENUMERATING readers or call sites with grep; none by
re-reading the diff (three had review rounds that read the diff and missed it).
After writing a fix, before believing it:

```bash
# Derive the population from the CODE, not from the files your diff touched.
grep -rn "<the field / helper / message you just changed>" src/ | grep -v test
```

and check the count against what you changed. Touching two of three readers is
not a fix — and writing "all N sites now do X" over it makes the miss durable,
because an overstated invariant stops the next reader looking. The cheap tell:
a diff touching ONE site whose message says "every", "all", "never" or "only" —
derive the population or drop the quantifier.

**Grep for the SHAPE, not for a NAME — a name finds only the copies you already
knew about.** go-to-k/cdkd#2176 (2026-08-23) swept a duplicated secret-masking
walk by grepping `maskDeep` / `MASK_WALK_MAX_DEPTH`, found four copies, and
shipped "four" everywhere; there were SIX — two spelled `maskLeaf` /
`maskLeafValue` with no named constant to grep for. Grep a structural line the
copies must share whatever they are called — here `typeof value === 'string'`
beside an `Object.fromEntries`, or simply `Object.entries(.*).map`:

```bash
# Structural first (finds a renamed copy), name second (confirms what you found).
grep -rn "<a line the shape cannot omit>" src/ | grep -v test
```

**And count the population BEFORE you fix, then assert the count afterwards.**
Re-deriving the number from the post-fix tree cannot detect a copy the sweep
never saw — the fix removed the very thing you would grep for.

**Paste the command with the number, and re-run it before you ship.** The
go-to-k/cdkd#2227 sweep (2026-08-26) claimed "88 hits across 13 files"; the
reviewer's grep returned 47 and no single grep reproduced 88. The conclusion
held — which is why this ships: a right conclusion with an unreproducible
measurement reads as evidence and is not.

**Any CLAIM relayed from a subagent's report is unearned in the same way — not
just a count — and it is the harder half, because there is no command to paste:
you never ran one.** One 2026-08-26 run published FOUR relayed counts, every
one wrong ("all nine sibling `clearOnUpdateRemoval` sites" — grep found **78**
across 14 provider files; "nine mutation probes" — fourteen; "ten unit shapes"
— thirteen; "a third copy" — nine existed), two into GitHub artifacts that
outlive the session. Non-numeric claims fail identically: pins reported "each
probed adversarially" had a PATH decoy never placed on PATH, and deleting six
left the suite 65/65 green. The tell is grammatical: a number arriving as a
WORD ("nine sites") was counted by a person or an agent; one arriving as
output was counted by a machine. Before a relayed claim is published anywhere
durable, run the query yourself and put it in the text.

**Before deriving a fix, grep the repo for the SYMPTOM -- something may already
have solved it.** Different from the sibling-site sweep: that greps the
defect's shape for the same BUG; this greps the error string, API name, or
surprising behaviour for a place that already answered the same QUESTION.
`src/utils/aws-region-resolver.ts` already carried, verbatim, the mechanism the
go-to-k/cdkd#2227 lane spent a real-AWS round trip rediscovering (SDK v3's
region-redirect middleware mishandling the empty-body HEAD 301 → synthetic
`UnknownError`), plus the fail-OPEN trap the fix had to avoid — a grep for
`UnknownError` or `followRegionRedirects` would have found it in seconds.

**N sites of one root cause is ONE issue and ONE PR, never N issues.** Split
into N, each site pays the full fixed cost — triage, claim, worktree, review
tier, integ run, merge, release — for the same edit N times; swept together
that cost is paid once, the reviewer sees the whole class, and sites 2..N
cannot sit open while site 1's fix drifts away. Two boundaries:

- **A sweep that would make the PR unreviewable is a genuine `next`** — file an
  explicit umbrella naming every site (§3 sorts umbrellas last), and say which
  sites this lane DID close, so the residue is unambiguous.
- **Sweep the same ROOT CAUSE, not the same AREA.** Two unrelated bugs in one
  provider are two issues; one wrong assumption at five call sites is one. The
  test: a single sentence describes the fix at every site.

**And whatever you do file, resolve it against the issues ALREADY OPEN first.**
This looks for a sibling ISSUE, not a sibling site — the umbrella covering
your finding was written from a DIFFERENT site, by a different lane, naming a
different provider. §10-c runs this check rigorously for mirrored skill
LESSONS; the mid-lane defect-filing path, where the volume comes from, ran
none. Measured 2026-08-25: the backlog closes fast (115 open, median 0.17 d)
but the COUNT does not converge — 13 of 115 open issues are umbrella-shaped
and **all four of the oldest are** (go-to-k/cdkd#609 at 90 d,
go-to-k/cdkd#1160, go-to-k/cdkd#1225, go-to-k/cdkd#1393), because no single
lane can close an issue naming N sites. The unit drifted from one ROOT CAUSE
to one affected SITE, and the site space is types x properties wide — so an
umbrella either sits open for months or splits into forty issues each paying
the full fixed cost.

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
truncates `$U` before `gh` runs, so an unchained recipe whose `view` fails
(wrong number, non-repo cwd, transient error) leaves an empty file the
`printf` fills with one row — and the `edit` then replaces the umbrella's
WHOLE body with it, destroying every previously folded finding (the one
outcome §10-0 says must never happen). `mktemp` for the same reason at another
scale: parallel lanes share the scratchpad and an uncoordinated
read-modify-write loses a row — never run two folds against the same issue
concurrently.

On a MISS — the expected outcome for a genuinely new root cause — file it, and
record the search so the next lane can see the window was checked:

```text
Dup-check: searched open issues for <terms> -- none covers this root cause
```

**File it with its `Severity` / `Effort` values ALSO as labels** — the body
lines stay exactly as written, and the same two values ride the command:

```bash
gh issue create -t 'fix(provider): ...' --body-file "$B" \
  --label severity:high --label effort:large
```

Prose is invisible to `gh issue list`; the label makes §3's ranking rule 3 a
listing-time filter, which is what let it move ABOVE the title-prefix
heuristic (a prefix is a proxy for what `Severity` measures). It stays gated
on BOTH candidates carrying the value — a label-only query under-counts, so
the body remains the authority. Only these two get labels: `Session-fit` is
re-decided at claim (a stale label is worse than none), and `Estimate` is
free-form. The same applies at §4's CLAIM, where an old packed body is
rewritten into the four-line shape — carry `--add-label` on that
`gh issue edit`. Enforced by
`.claude/hooks/issue-classification-label-gate.sh`, which refuses a
`gh issue create` / `gh issue edit` whose body states a value the labels do
not carry; `gh issue comment` is not gated. A folded checklist row carries no
classification of its own — write the severity into the row's text.

**This is not a filing threshold, and it must never be used as one.** §10-0 is
explicit that `filed <= closed` is not a target and an unfiled finding is
strictly worse than a filed one. Nothing here changes WHETHER a defect gets
written down, only WHERE. An open issue then counts one unresolved root cause
instead of one unfixed site — root causes are bounded by the codebase, sites
by types x properties, so that is the number that can converge.

Enforced by `.claude/hooks/issue-dup-check-gate.sh`, which refuses
`gh issue create` without the `Dup-check:` line — the same refusal covers
`gh api repos/<o>/<r>/issues`, which mints an issue through the REST verb.
`gh issue edit` and `gh issue comment` are deliberately NOT gated BY THAT
GATE: folding is the outcome it steers toward, so taxing the cheap path would
defeat it (the classification-label gate makes the opposite call about `edit`
for the opposite reason; the two are independent). Folding is not CHEAPER than
minting (one command vs three); the gate makes minting non-free rather than
folding cheap. Two consequences: a folded row carries no `Session-fit` /
`Severity`, so §3's ranking cannot see it, and `gh issue edit` passes through
the `#N` item-number gate that `gh issue create` bodies get — keep bare `#N`
out of a folded row yourself. Registration is not execution.

Do the fix in the worktree (match the existing provider/pattern exactly; ESM
relative imports need the `.js` extension — even in TypeScript). After every
source change, `vp run build` — the CLI runs from `dist/`, so an unbuilt
change has no effect. **Always add a unit test that fails without the fix and
passes with it** (under `tests/unit/**`, AWS SDK mocked via `vi.mock()`) — do
not wait to be asked. **Check first whether the artifact already has a test
harness** — `.claude/hooks/` carries per-hook `*.test.sh` suites run by
`run-tests.sh` under its own `hooks.yml` workflow, not visible from
`tests/unit/**`.

**Run such a harness from BESIDE its subject, never from a scratch copy.**
Every suite resolves the hook under test from its own script path, so a copy
runs against a sibling that is not there and every case fails with exit 127 —
a regression your change did not cause (2026-08-19: `branch-gate.test.sh`
scores `Pass: 27  Fail: 0` from `.claude/hooks/`, exits 1 from scratch). Say
`$0` / `${BASH_SOURCE[0]}`-relative rather than naming one spelling (27 of 33
suites use `${BASH_SOURCE[0]}`, 6 use `$0`); `pr-review-gate.test.sh` derives
the REPO ROOT the same way, and `run-tests.sh` is itself
`${BASH_SOURCE[0]}`-relative, so a copied RUNNER cds to the wrong repo
entirely. The trap is invited by the before/after comparison a hook change
wants — the obvious `git show origin/main:<suite> > /tmp/x.sh && bash
/tmp/x.sh`. Instead write the old copy beside the real one as
`.claude/hooks/_old-<name>.test.sh` and delete it after. This is the one place
§8's scratch-copy idiom does NOT transfer: right for a data file, wrong for a
runnable harness.

**When the issue reports a stale ENTRY in an enumerated list, audit the whole
list, in both directions, before fixing the named entry.** Drift almost never
produces exactly the one instance noticed: check that every entry still
resolves to something real AND that everything real that belongs is present —
the second half is the one that gets skipped, because the issue only names the
first. go-to-k/cdkd#1972 (2026-08-19) reported one dead path in the
security-surface list; the audit found a second
(`src/local-invoke/docker-runner.ts`, stale since a PR go-to-k/cdkd#228
rename) and four live surfaces never added. Then make the recurrence
mechanical: a list that must stay in sync with the repo is a test, not a
sentence.

**When the audit is a MEASUREMENT, the shape of the sample is the finding — a
clean result from the wrong shape is indistinguishable from a clean subject.**
Auditing go-to-k/cdkd#2096 (2026-08-20) produced SIX confident wrong answers,
each from a different plausible sampling shape, each hiding a real secret:

- **Newest-N.** The 6 NEWEST state versions cleared `appsync`; versions 12-45
  held an API key in 17 of 33 — the newest versions come from the run most
  likely already fixed. Sample across the range, or grep everything.
- **One global needle.** A single `cdkd-known-*` grep reported
  `secrets-array-nested` clean while 5 of 7 versions carried
  `cdkd-array-nested-pw-789`. Each fixture spells its OWN literal — derive the
  needle per subject, or assert on a needle-INDEPENDENT observable (surviving
  version count == 0).
- **A name derived from convention.** `cognito-resource-server`'s stack is
  `CognitoResourceServerStack`, not the `Cdkd…Example` the directory implies;
  the convention probe returned `0 of 1`. Read the identifier from the subject
  (`verify.sh`'s `STACK=`), never infer it.
- **A silent parse failure inside a pipe.** `aws s3api get-object …
  /dev/stdout` emits metadata beside the body, so a `json.load` died and the
  loop counted `0 of 16`; a text match found 4. A parse that can fail must
  report failing, not fall through to a count.
- **A per-page aggregate.** `--query 'length(Versions)'` applies PER PAGE and
  concatenates: a 1189-entry prefix prints `1000\n189`, and `[ "$n" -ne 0 ]`
  on that is a bash error. Count ROWS of a projection instead.
- **Grepping the layer the subject does not use.** `AWS::ApiGateway::ApiKey`
  is registered to NO provider — it takes the generic Cloud Control readback
  whose model includes `Value`, so searching `src/provisioning/providers/**`
  cannot see it.

The through-line: every one FAILED CLEAN. Treat "nothing here" as the claim
needing evidence — run the shape against a case you KNOW is dirty first, and
only then trust a zero. The same run's merged repo-wide scanner failed clean a
seventh time: `stripComments` stripped block comments before line ones, so a
`//` comment containing the glob `src/provisioning/**` opened a block comment
and swallowed 235 lines of `deploy-engine.ts` silently.

**Adding a HANDLER to a slot that already has one REPLACES it.** Bash `trap`
does not chain: a second `trap ... EXIT` silently disarms the first, and in an
integ fixture the first is the AWS teardown — on the go-to-k/cdkd#2213 lane
(2026-08-25) a reviewer-nit fix (`trap 'rm -f "${OUT}"' EXIT`) would have
traded a leaked temp file for live AWS resources on every failure path, and
the happy path still passes. Put the extra work inside the EXISTING handler
(unset-guarded — it can run before the variable is assigned, under `set +eu`),
or re-install a handler that still CALLS the original (the form 16 fixtures
use). Fenced by `tests/unit/scripts/integ-single-exit-trap.test.ts`. Carry the
shape past `trap`: before adding to any single-slot registration — a signal
handler, a callback field, an `EXIT` hook — count what is already there.

**A mutation probe proves a test discriminates only if it changes the value
the test READS.** Four vacuous tests shipped across three lanes on 2026-08-19,
all one shape: the assertion targeted an observable the BROKEN code also
produces — a confluence point, not a discriminator. Examples: `.at(-1)`
re-reading a FIRST call's poll count that a second `delete()` never reached
(passed with the release deleted); asserting "the ambient client was reused",
which the reject-unsafe arm also produces; asserting
`ambient.ssm !== instances.at(-1)` where `ambient.ssm` is a LAZY getter
constructing at assertion time — measuring its own side effect.

**A probe COUNT goes stale across review rounds, so a matrix carried forward
is wrong even when every row was true when written.** Later rounds add cases
depending on the same line: two published "1 RED" rows measured 4 and 6 on the
final tree (2026-08-26) — nothing regressed; the matrix was PATCHED rather
than RE-MEASURED. When a body or changelog publishes a matrix, re-run it on
the tree you are about to merge and say which tree the counts are from — a
count with no subject is not a measurement.

So name the discriminator first and assert THAT: which client was constructed
with what region, which call the stub actually received, what the second
invocation saw. "The happy path still happens" is almost never it. And run the
probe: a test that still passes under the mutation that motivated it converts
an open gap into a false assurance — worse than no test.

**A probe that reports NO discrimination is a claim about the FENCE, and three
other things produce the identical output.** Ask them in order before touching
the fence (each hit on 2026-08-25, each nearly cost a working assertion):

1. **Did the edit land?** `sed`/`perl` one-liners fail silently in ways that
   read as "no match": a `perl -0pi -e "s|^\|...|...|m"` delimited by the same
   `|` it escapes matches nothing; a `sed -E`-only alternation (`\|`) is a GNU
   extension matching nothing on macOS; a `sed: bad flag` prints ABOVE the
   suite output and scrolls past. Prove it with
   `grep -c '<the mutated text>'` before reading the result; prefer `python3`
   with an `assert anchor in s` — an assertion that throws is louder than a
   quoting slip that matches zero.
2. **Does the case's execution path REACH the edited line?** Breaking a hook's
   branch-lookup left its suite green because every case carried an explicit
   PR number, so the lookup never ran. The fix is a case that HAS to take that
   path, not a change to the fence.
3. **Did the command run where you think it did?** A relative-path edit under
   a silently reset cwd lands in another worktree — and the confirming
   `git status` runs in that same wrong tree, so "clean" and "clean somewhere
   else" print identically. Use ABSOLUTE paths and confirm by a property the
   wrong tree cannot fake (`ls -la` mtime).

And one shape inside the fixture itself: **an expected value must be an
INDEPENDENT variable from the one under test.** A stub keyed its content on a
sha whose default was the same literal on both producing and consuming sides,
so breaking the producing call still served the content. Only after all four
does "the fence is weak" remain — deleting an assertion on an unexamined green
is how a working guard gets removed.

**Choose the probe's INPUT to discriminate too, not only its mutation.** The
mutation decides which code changes; the input decides whether the change is
observable. A mask-before-`JSON.stringify` fix (PR go-to-k/cdkd#2067,
2026-08-20) probed with a SCALAR secret came back GREEN under its own
motivating mutation — `stringify` escapes a JSON document's quotes, so only a
JSON-DOCUMENT secret makes the needle stop occurring. Before trusting a green,
ask what property of the INPUT the defect depends on.

**When the change alters a CLASSIFIER, hand-picked cases cannot fence it —
measure the DELTA against the old implementation.** A classifier is any
function deciding which of several shapes an input is (region-vs-stack-name
predicate, route selector, error categoriser); its defects live in shapes
nobody wrote down. go-to-k/cdkd#2001 (2026-08-21) shipped THREE green
revisions, each fixing the case the previous review named and breaking a
neighbour, every revision passing a suite that grew one case per round. The
fence that ends it is a differential walk: enumerate the input space, run BOTH
the new implementation and a transcription of the old one, and fail on any
difference outside an explicitly enumerated set of intended classes — a shape
nobody imagined is a failure by default (it showed three delta classes where
the comments said two). Get the transcription from
`git show origin/main:<path>`, not memory, and confirm agreement on the cells
where they SHOULD agree before trusting the cells where they differ. Two ways
it goes inert, both measured on that lane:

- **Classify by the resulting VALUE, not by the input's shape.** The first cut
  bucketed a differing cell by which key it was, so mutating the fix to return
  the prefix outright — a total regression — left every cell in the "intended
  repair" bucket and the fence GREEN. Each arm must assert what the function
  now returns.
- **Carry a floor per class.** The walk reaches a class only if the input pool
  contains it; one class was real, intended and never reached, so a pool that
  quietly stops covering one would pass as "no regressions".

**A VALUE import from a module other suites `vi.mock` reds those suites.** The
`type`-only import is invisible to the mock; a runtime one is not, and the
failure names the EXPORT (`[vitest] No "<CONST>" export ...`), reading as a
missing symbol in the module you just edited rather than a mocking problem in
a suite you did not touch (one constant imported into `state-file-keys.ts`
reddened `gc.test.ts` and `bootstrap-destroy.test.ts`). When two modules must
agree on a constant and one is widely mocked, spell it in both and fence the
pair with a test importing both — the sync is what matters.

**Run probes with `vp test run <path>`, never `vp run test <path>`.** The
latter goes through the Vite+ task runner, where `test` is CACHED: a repeat
prints `◉ cache hit, replaying` and re-reports the previous run without
executing — a probe edits a file the task hash does not cover, so the replayed
verdict is the PRE-mutation one and the probe reports PASS having run nothing
(2026-08-20; one reviewer had FOUR such probes). `vp test run` is the
delegated command invoked directly, so it always executes.
`.claude/hooks/vp-run-test-path-gate.sh` blocks the cached form; a bare
`vp run test` (whole suite) is unaffected. Two further false greens ride the
same command, so read the OUTPUT as well as the rc: a suite can report
`skipped` rather than `passed` (the `version` test `skipIf`s itself when
`dist/` is absent — the normal state of a fresh worktree), and a run whose
every test passes can still exit non-zero — see the rc rule in section 6.

**A repo-wide SCANNER test is calibrated against the PRE-FIX tree, not written
from the issue's wording.** When the test globs the tree, the issue's
signature is what its author noticed on ONE instance, never a rule with a
measured false-positive rate. Run the candidate rule over the still-broken
tree FIRST, read every hit, and tighten until all are genuine. Done for
go-to-k/cdkd#1990: 13 bare `#N` hits, all real, while the same regex without
stripping frontmatter and code spans would have flagged legitimate examples as
violations. Two markdown-scanner sub-traps: strip on the WHOLE text, not per
line — an inline code span straddling a hard-wrapped line break makes a
per-line pass pair one span's closing backtick with the next span's opening
one and invent findings — and report the HIT's own line, not the start of the
stripped region.

**Calibrating against the broken tree is only HALF the measurement, and the
half it leaves out is the one that lets a fence ship inert.** The pre-fix tree
measures PRECISION and recall on the instances that HAPPEN TO EXIST — nothing
about the SHAPE: spellings the tree does not currently use, and contexts that
defeat your exemption logic. Follow calibration with probes against the REAL
tree:

- **Write the defect in the spelling a PERSON would write, not the one that is
  easiest to inject.** On the go-to-k/cdkd#2052 lane (2026-08-26) a
  prefix-sync fence split on `'custom-resource-responses'` *with both quote
  characters*, and the probe used `` `${'custom-resource-responses'}/` ``,
  which reds it; the spelling anybody would type —
  `listRawObjects('custom-resource-responses/')` — puts the trailing slash
  before the closing quote and sailed through, as did a copy in any file
  outside the fence's hand-written list. That fence was the very mechanism the
  "grep for the SHAPE, not for a NAME" rule prescribes, written by someone who
  had just read that rule — so mutate a fence the way a future contributor
  would, and derive the population rather than listing it.
- **Write the defect in every spelling the language allows** and confirm each
  is flagged. go-to-k/cdkd#2111 (2026-08-20): a scanner for
  `options.region || process.env['AWS_REGION']` calibrated perfectly (19
  violations, zero false positives) and matched `||` only — the tree already
  used `??` at four sites, and the rule was blind to the `opts.` / `args.` bag
  names two other files use. Widening it immediately surfaced a real unfiled
  bug.
- **Delete the thing the fence REQUIRES, and watch it fail.** A predicate of
  whole-file substrings OR'd together is satisfied by any one: the "every
  region-taking handler folds" fence passed 130/130 while a probe deleted the
  ONLY fold from four handlers at once, each still containing a different
  accepted substring. Its POPULATION was wrong too — derived from "mentions
  `options.region`", it pulled in helpers that merely RECEIVE a folded value
  while missing the files that actually accept the flag. Derive from what
  declares the option, and make the predicate per-READ rather than per-file.

  The worst population is one derived from the DEFECT itself, because deleting
  the required thing then drops the subject OUT of the population instead of
  failing. Sibling-repo probes (2026-08-20) found four such fences in one tree
  (go-to-k/cdk-real-drift#1797): a gate-parity test selecting gates by
  `condition.includes('Bash(git commit*)')` stayed 7/7 green with two gates
  disarmed, and a hook-coverage test enumerating `*.test.sh` could never
  report the hook with no harness. A STATEFUL scanner fails the same way with
  no OR: go-to-k/cdk-local#537's scan flipped one `inFence` boolean on any
  fence marker, so a single nested fence inverted it and muted every later
  check silently.

  **A population derived from an OPTIONAL language feature is derivable-around
  for free, and a type annotation is the commonest one.** A 2026-08-26 fence
  built to END a four-round cascade derived its population as "files
  annotating `: DestroyRunnerResult`"; TypeScript infers, so the two files
  holding the object as plain locals were never scanned, and planting the
  write in one left the fence 4/4 GREEN. Derive from a relation the write
  CANNOT omit — here, that a file either constructs the result or receives it
  from the one function that returns it. Ask of any population: *what would
  this look like if the author simply did not write the optional part?*
  Annotations, explicit return types, `export` markers, and interface
  `implements` clauses all answer "identical, and invisible to you".

  **Probe the fence with the evasions the DEFECT would use, not with the one
  you just fixed.** Re-planting the exact removed line is the cheapest and
  least informative probe — the one spelling you have already proved you can
  see. The same fence caught its own removed line and missed four ordinary
  alternatives: a computed member (`x['field'] =`), `Object.assign`, an object
  literal, and a spread rebuild — the last is first to try when the cascade is
  about early returns, because a new early return is written as a new object.

  **And watch the FLOOR for the same collapse.** A floor naming only the file
  the defect lives in is satisfied BY the collapse it exists to catch:
  narrowing that fence's pathspec to the owner file alone still passed 4/4.
  Name the peripheral members a collapse drops FIRST, not the central one.

And ask the dumbest question last: **is anything RUNNING it?** The nine hook
harnesses in go-to-k/cdk-real-drift were shell, so neither the vitest task nor
any CI step invoked them — exercised only by hand since the day each was
written.

The general shape: **a fence is not evidence until you have watched it go red
on something you had not already counted.** Calibration tells you it is not
noisy; only the spelling and deletion probes tell you it is load-bearing.

**And no number of probes can falsify the FIXTURE, because a mutation probe
perturbs the CODE and reads the TEST while both read the same mock.** Any
premise SHARED by code and mock is invariant under mutation. go-to-k/cdkd#2227
(2026-08-26): seven cases passed and were probed two complementary ways, yet
the guard could not fire against real AWS at all — the mocks were written from
a measurement taken with the AWS **CLI**, which follows S3's cross-region 301,
while the SDK client cdkd uses does not and yields a synthetic `UnknownError`;
only the live arm caught it. A fixture encoding an AWS response needs its own
evidence — a recorded real response, a live arm, or a probe against the SDK
rather than the CLI. Probing harder cannot supply it.

Two more questions to ask of any fence, both from go-to-k/cdkd#2027
(2026-08-21):

- **Does it watch the OTHER direction?** A fence asking only "is the bad input
  refused?" never notices the gate starting to refuse GOOD input: that lane's
  fence had no such case, and two consecutive rounds shipped false refusals (a
  commit message quoting `git -C $W`; `MSG=$(echo git commit -m x)`). For a
  guard, the pair is "refuses what it must" AND "leaves alone what it must";
  only the second catches an over-tightening fix.
- **Is it hermetic, and on WHICH axis?** Hermeticity is per-dependency, and CI
  finds the open axes one per round-trip: the same fence was pinned to a git
  SHA (failed in CI's shallow clone — correctly, and loudly), vendored as a
  fixture, then failed AGAIN because a `~` expansion made its expected values
  depend on `$HOME`. Enumerate the axes up front — git history, environment,
  cwd, clock, locale, user — and for each either pin it or record a measured
  negative. Prefer PINNING over normalizing: a normalization layer sits
  between implementation and assertions, exactly where a fence goes
  green-but-inert; pinning keeps the case asserting an exact known value.

You may fan out **one subagent per lane** (disjoint files) to run them
concurrently — give each agent its worktree path, its allowed files, and an
explicit "do NOT touch <the other lanes' / other agents' files>; STOP and
report if the fix needs a forbidden file" guardrail. Note: a subagent's Bash
**bypasses the PreToolUse gate hooks**, so it can `gh pr create` past
`verify-pr-gate` — enforce quality yourself; you (the orchestrator) still gate
the MERGE.

**Forbid the lane agents the FULL SUITE and run it yourself, serially.**
Fan-out is right for editing and targeted probes, wrong for `vp run test`: on
2026-08-20 five concurrent full suites drove load to 195, one test FILE took
607s against a 5s per-test timeout, and all three lane agents were killed by
the 600s watchdog — `Test timed out` in files no diff touched,
indistinguishable from a real regression; serialized, the same trees were
green. Tell each agent to run only `vp test run <its own suite>`, that the
authoritative full suite is yours; run one lane's at a time.

**Serializing YOUR suites is not the same as serializing the machine, and a
PEER SESSION's suite is invisible from every probe this skill lists.** On
2026-08-27 a full suite exited **1** with `Test Files 806 passed` /
`Tests 16597 passed` — the failure was `[vitest-pool]: Worker forks emitted
error / Worker exited unexpectedly` at load 54, a dead fork, and
`ps aux | grep vitest` showed the heaviest run belonged to ANOTHER session's
worktree. Before treating a suite failure as a regression, read the rc AND the
error section AND `uptime`, and check `ps` for a vitest whose path is not
yours. You cannot serialize a peer — re-run once the machine is quiet; do not
hunt the diff.

Two fan-out costs to budget rather than discover: a lane agent that waits
inside a tool call is killed at 600s of silence (have it launch long runs
backgrounded with a log redirect and poll with short `tail` calls), and any
fix round re-touching `src/provisioning/providers/**` or another `integ-*`
scope invalidates that gate's marker — a late review finding buys another
real-AWS run. That is the gate working; budget the run rather than arguing the
code "cannot have changed behaviour".

**Three guardrails every lane prompt must carry, all learned the hard way on
2026-08-19:**

- **Never force-push over a commit you did not author.** A lane agent resumed
  with edits predating four orchestrator commits on its branch and
  force-pushed; nothing was lost only because the rebase preserved them. Say
  in the prompt: re-`git fetch` and inspect the branch before any force-push;
  if it carries work you did not write, STOP and report.
- **A new fixture literal must not collide with an existing assertion needle —
  and neither may a new fixture RESOURCE collide with an existing resource's
  VALUE.** The literal form: a `DB_URL` hard-coded `cdkd-user` as its URL user
  — exactly `EXPECTED_USERNAME`, the needle grepped over the whole persisted
  env — so the run reported a secret LEAK that had not happened; a false leak
  report is worse than a missing assertion, being indistinguishable from the
  real thing. The RESOURCE form is the same trap one level up
  (go-to-k/cdkd#2270, 2026-08-26): an arm testing a same-plaintext COLLAPSE
  necessarily gives two leaves one plaintext — that sharing is what makes the
  arm discriminate — and it reused the plaintext of a leaf a pre-existing
  assertion already owned, which then failed on an assertion the lane never
  wrote. When an arm deliberately makes two things equal, ask what ELSE
  already holds that value: give the arm its own secret / key / name. The
  repair is to scope the sharing, not break it — breaking it retires the
  fence.

  **And check the arm's shape actually exercises the fix before spending a run
  on it.** The obvious decoupling there (two separate RESOURCES) would have
  been VACUOUS: `perResourceSecrets` is keyed by logical id, so two resources
  get two single-pair bags and redact correctly with or without the fix. One
  resource holding both leaves was the only shape where the mechanism under
  test decides the answer.
- **Execute every read expression you write.** Two integ runs were lost to
  fixture code, not product defects: the literal collision above, and a `jq`
  assignment written through `to_entries[]`, which builds a new array and is
  not a path back into the document. jq / JMESPath / AWS CLI `--query` are
  untested code; run each against real output shape before finishing, in both
  directions where the expression carries a guard.
- **A read-only REVIEWER can silently revert a live lane's uncommitted `src/`
  edits, and nothing surfaces it.** Reviewers probe by editing a file and
  restoring it from `git show HEAD:<path>` — which restores HEAD, not the
  lane's in-flight work; on 2026-08-20 that wiped three `src/` edits, caught
  only because `git status` disagreed with what the agent had written. So:
  **do not dispatch reviewers against a worktree whose lane still has
  uncommitted work.** Commit the lane first (the gates make that cheap) and
  point the reviewers at the committed diff. When a lane resumes after a
  review round, have it re-run `git status --porcelain` and `git diff --stat`
  FIRST and report both — the orchestrator cannot tell a wiped edit from an
  unstarted one.

  **Reviewers collide with EACH OTHER too, and a 3-axis dispatch puts three or
  four of them in one worktree by construction.** All probe by
  edit-and-restore-from-`HEAD`, so a peer's in-flight mutation is
  indistinguishable from the subject, and restoring it is "correct" behaviour
  that silently discards their work (2026-08-27: a security reviewer's first
  pass reported **6 failures that were a peer's mutation**; both lanes
  recovered by judgement, not by the flow). Say it IN THE PROMPT of every
  reviewer: peers are probing this same worktree, `git status --porcelain`
  must be EMPTY before you start a probe, and if it is not, WAIT and re-check
  rather than restoring — a `git show HEAD:<path>` over a peer's edit reverts
  it. And read any surprising probe result as possibly theirs first.

  **That is a DURATION constraint, not just a precondition, and the
  ORCHESTRATOR breaks it more easily than a lane agent does.** A clean tree at
  dispatch buys nothing if you edit while the reviewers run — their probes
  restore from a snapshot taken at THEIR t0, so an edit landing inside that
  window is reverted by a restore behaving correctly (2026-08-21: an early
  blocker's fix was applied mid-review; only a reviewer's closing warning
  surfaced it, and the edits survived by luck). Dispatch, then WAIT — do other
  lanes' work, write the PR body, watch CI, but do not touch the files under
  review; if you must, re-verify with `git status --porcelain` plus a
  `grep -c` for a marker of each edit, exactly as §6 prescribes for a blocked
  restore.

**Two probe-harness failures from the same run, both of which reported a false
green rather than an error.** A probe that cannot fail is worse than no probe,
because it converts an open gap into a recorded assurance:

- **A scratch harness was silently REPLACED by another agent's file of the
  same name.** Its `__main__` was `pass`, so four probes "passed" having
  applied nothing — parallel agents share `/tmp`-style scratch space and pick
  the same obvious filenames. Name scratch files per lane, and make every
  probe emit a positive receipt it cannot produce without having run —
  `bytes 41822 -> 41799; anchor now 0 (was 1); changed=True` — then read the
  receipt rather than the exit code.

  **This rule was already written here and was broken THREE times in one run
  (2026-08-26), so the fix is to stop asking agents to invent the name: the
  ORCHESTRATOR assigns each dispatched agent a unique scratch directory IN ITS
  PROMPT** (`$SCRATCHPAD/lane<issue>-private/`,
  `$SCRATCHPAD/rev-<role>-<sha>/`), and every prompt says never to write a
  bare generic name in the scratchpad root. Decided once per run, it cannot be
  re-derived wrongly per agent. Without it: lane B ran lane A's entire probe
  table twelve times against lane A's worktree; a reviewer's mutation was
  restored from `HEAD` by a second reviewer; and an agent reported a live
  cross-session TRESPASS that had not happened, because the
  `_old-<name>.test.sh` copies a reviewer is TOLD to write beside their
  subject look identical, from inside the worktree, to a peer writing there —
  a collision and a correct convention are indistinguishable to the lane being
  written into, so the orchestrator has to be the one who knows which is
  which. A hook was considered and rejected: it would have to match command
  TEXT for scratch-path writes, the unbounded-bypass-spelling shape
  go-to-k/cdkd#2156 documents. Pre-assignment moves the decision instead of
  trying to police it.
- **A probe's FIXTURE, not its mutation, decided the outcome.** A region test
  set `AWS_REGION` to the CONSUMER's region, under which the correct code and
  the mutation bind identically, so the probe stayed green; the PRODUCER's
  region separated them. Same lesson as choosing the probe's input (section 5,
  above), from the fixture side: when a probe comes back green, suspect the
  fixture before concluding the code is fenced.

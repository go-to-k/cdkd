<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One tree per lane, then implement

This stage (and 6-8) normally runs INSIDE a lane subagent — one per claimed
issue, so its diffs, test output and review round-trips stay out of the parent
context. Every rule below holds unchanged there: hooks fire on the lane's tool
calls, markgate markers land in the lane's own tree. Two actions stay with the
parent's serialization turn: a real-AWS integ run and the merge (§9). A lane
stops at merge-ready.

Never edit in the main checkout (`main-tree-branch-gate` blocks branching there —
with the coverage limit measured below).
Per lane:

```bash
# MAIN-CHECKOUT mode only. IN-PLACE (launched inside a linked worktree) skips
# these two, keeps that tree and its branch, and creates nothing -- nesting dies
# with the outer workspace (go-to-k/cdkd#2390; the probe is in §3, its only copy).
git worktree add .claude/worktrees/<branch> -b <branch> origin/main
cd .claude/worktrees/<branch>
mise trust && mise install   # untrusted .mise.toml: vp / markgate will not resolve
pnpm install                 # worktrees have no node_modules
vp run build                 # ...and no dist/ — see below
```

**IN-PLACE: confirm the tree is YOURS before adopting it** — a stray `cd` into a
peer's live lane looks exactly like a workspace handed to you. Read every probe
below under §9's rule that every ownership signal establishes LIFE and never
absence: any one of them saying "someone is here" means STOP and report — never
nest a worktree inside a peer's lane to get out of it.

```bash
# The FIRST line is the anchor, and it is why none of the rest needs a `-C`:
# every probe under it describes THIS shell's tree, so a cwd that has silently
# reset to the main checkout (appendix, "Bash cwd silent reset") shows up IN THE
# OUTPUT instead of being invisible. Anchoring a READ this way is enough --
# noticing afterwards costs nothing, and the alternative (carrying a captured
# path forward) buys nothing a printed subject does not. A WRITE is a different
# problem: see the branch recipe below.
git rev-parse --show-toplevel   # STOP unless this is the tree you meant to adopt
git status --porcelain          # non-empty: someone's uncommitted work
git branch --show-current       # the branch you would be committing to
git log --oneline -3            # whose commits these are
cat "$(git rev-parse --git-dir)/session-owner" 2>/dev/null   # this repo's owner sentinel
```

Then read the issue thread for a claim naming this branch — across clones it is
the only signal the probes above cannot see.

**If the branch here is detached, or its PR has already merged, take a fresh one
WITHOUT leaving the tree** — and know what is and is not protecting you while
you do:

```bash
git fetch origin && git switch -c <branch> origin/main
```

The `&&` is deliberate: unchained, a failed `fetch` still branches, off a stale
`origin/main`. **`main-tree-branch-gate` is the backstop for running that line
after a cwd reset — but it did NOT cover this spelling until this session's
hooks change, so do not read the claim as one that always held.** Measured on
both copies of the hook, 2026-08-31: the version then on `main` skipped to the
FIRST `git` token, read `git fetch origin && git switch -c ...` as `sub=fetch`,
fell to a fail-open arm and exited 0 — a BARE `git switch -c <b> origin/main`
was refused (rc=2) while the chained form THIS FILE PRINTS was not (rc=0), so
the spelling the skill prescribes was exactly the one the gate missed. This
session's hooks lane makes the gate match in COMMAND POSITION and judge the
matched SEGMENT; driven against that copy the chained form is refused (rc=2)
and the allowance for `git fetch origin && git switch main` still passes (rc=0).
The protection is that FIXED gate. Until `fix/stop-and-body-file-gates`
(go-to-k/cdkd#2401) merges to `main`, the anchor is all you have: re-run
`git rev-parse --show-toplevel` immediately before the switch and confirm it is
this lane's tree. Ask whether the fix has LANDED by CONTENT, never by the last
commit subject on the file -- that subject names some earlier hooks change and
reads as though it were this one:

```bash
git show origin/main:.claude/hooks/main-tree-branch-gate.sh | grep -c gate_verb_rest_each
```

`0` means the fix is NOT on `main` and the anchor still stands (measured
2026-09-01); non-zero means it landed and the anchor can be retired. That helper
is what judges the matched SEGMENT, so it exists only in the fixed copy -- the
same grep against go-to-k/cdkd#2401's head prints 4.

**`mise trust` is not optional here, and skipping it fails in the direction that
costs most.** An untrusted `.mise.toml` makes `mise exec -- markgate set` error
instead of writing, and a pipeline's rc hides it (2026-08-28: two `mise ERROR`
lines, every gate still `no marker`). Verify with `markgate status`, never an
exit code.

**Build BEFORE the first test run, and read a fresh tree's failures with that
in mind.** A new worktree has no `dist/`; a test spawning the built CLI fails on
the missing binary with an assertion about its SUBJECT (`expected 1 to be 2`),
and the main checkout passes only because it HAS one — a docs-only lane nearly
reported "a peer merge broke main" over 13 such failures (go-to-k/cdk-real-drift,
2026-08-27). **A fresh tree failing where the main checkout passes is evidence
about the TREE first**; a build costs seconds against a false report.

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
sites, all already clean; eligibility minus remedy found six more, plus a
seventh neither query finds — the remedy-shaped query had seen 5 of 12
eligible sites. This repo is the most exposed — its defects are often missing
entries (an absent `handledProperties` row, a provider with no validation arm,
a type with no comparator), each invisible to a grep for what it lacks.

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

**A defect the sweep turns up that this lane is NOT fixing gets FILED, and
the rules for that are their own stage file: `references/filing.md` (§5-f)**
— N sites of one root cause is ONE issue and ONE PR, the dup-check window
that decides mint-vs-fold, and the `Severity` / `Effort` labels that filing
carries. Read it at the moment the sweep produces something this lane will
not close; it is not optional context.

Do the fix in the lane's tree (match the existing provider/pattern exactly; ESM
relative imports need the `.js` extension — even in TypeScript). Rebuild with
`vp run build` after every source change — the CLI runs from `dist/`, so an
unbuilt change has no effect. **Always add a unit test that fails without the
fix and passes with it** (under `tests/unit/**`, AWS SDK mocked via `vi.mock()`) — do
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
`.claude/hooks/_old-<name>.test.sh` and delete it after.

§8's scratch-copy idiom is right for a data file, wrong for a runnable
harness, and wrong for a WORKTREE in a way that WRITES to the live tree rather
than failing; §8 carries the mechanism and what a reviewer's brief owes for it.

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

- **Newest-N.** The 6 NEWEST state versions cleared `appsync` while versions
  12-45 held an API key in 17 of 33 — the newest come from the run most likely
  already fixed. Sample across the range, or grep everything.
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
latter wraps the run in the Vite+ task runner, where `test` USED TO BE cached: a
repeat replayed the previous run without executing, so a probe editing a file
the task hash does not cover reported PASS having run nothing (2026-08-20; one
reviewer had FOUR). Nothing caches since 2026-08-30, but `vp test run` stays the
spelling: it is the delegated command invoked directly, with nothing between the
caller and the verdict.
`.claude/hooks/vp-run-test-path-gate.sh` blocks the wrapped form; a bare
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
  easiest to inject.** go-to-k/cdkd#2052 (2026-08-26): a prefix-sync fence
  split on `'custom-resource-responses'` *with both quote characters*, so the
  probe's `` `${'...'}/` `` reds it while the spelling anybody would type —
  `listRawObjects('custom-resource-responses/')`, trailing slash inside the
  quote — sailed through, as did any copy outside the fence's hand-written file
  list. Its author had just read the "grep for the SHAPE, not for a NAME" rule.
  Mutate a fence the way a future contributor would, and derive the population
  rather than listing it.
- **Write the defect in every spelling the language allows** and confirm each
  is flagged. go-to-k/cdkd#2111 (2026-08-20): a scanner for
  `options.region || process.env['AWS_REGION']` calibrated perfectly (19
  violations, 0 false positives) yet matched `||` only, while the tree used
  `??` at four sites and two files spell the bag `opts.` / `args.`. Widening it
  surfaced a real unfiled bug.
- **Delete the thing the fence REQUIRES, and watch it fail.** A predicate of
  whole-file substrings OR'd together is satisfied by any one: the "every
  region-taking handler folds" fence passed 130/130 while a probe deleted the
  ONLY fold from four handlers at once, each still holding a different accepted
  substring. Its POPULATION was wrong too — derived from "mentions
  `options.region`", it pulled in helpers that merely RECEIVE a folded value
  and missed the files that accept the flag. Derive from what DECLARES the
  option, and make the predicate per-READ rather than per-file.

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
  **And derive the floor from a source the fence does not itself read.** A
  floor computed from the very pool it guards is unfalsifiable, because
  deleting pool entries moves both sides of the comparison together — measured
  2026-08-29: emptying the guarded pool left such a fence 10/10 GREEN. Write
  the expected count as a LITERAL, so the pool shrinking is what reddens it.

And ask the dumbest question last: **is anything RUNNING it?** The nine hook
harnesses in go-to-k/cdk-real-drift were shell, so neither the vitest task nor
any CI step invoked them — exercised only by hand since the day each was
written.

**When a fence must read another tool's CONFIG, parse it with a real parser and
fail CLOSED on anything unmodelled — do not hand-roll a scanner, and do not
patch one per spelling.** Measured across go-to-k/cdkd#2383,
go-to-k/cdk-real-drift#1838 and go-to-k/cdk-local#631 (2026-08-29) — three
different fences over the same config, all three ending on one that fails
CLOSED rather than on a better pattern:

- **The unused key.** markgate resolves a `hash: files` gate as `include` MINUS
  `exclude`. No repo in the family had ever written an `exclude`, so the fence
  modelled `include` alone and reported full coverage over a scope the tool
  would already have subtracted from. Read the tool's OWN schema, from the
  pinned binary rather than its `init` template: 0.4.1 has eight gate keys
  (`hash` / `include` / `exclude` / `base` / `ttl` / `state_dir` / `requires` /
  `composes`); `init` emits six, dropping the two a repo is likeliest never to
  have written.
- **Then the spelling treadmill, which is the real lesson.** Each round patched
  the one spelling that had just got through while the next sailed past. Block
  items only -> a FLOW list passed. Unquoted keys only -> `"exclude":` passed.
  A block scan terminating on `/^ {2}\S/` -> a two-space COMMENT ended it early
  and left all fourteen cases GREEN while markgate really did subtract. A "raw
  text" tripwire, added so the guard would not read the parser it protects ->
  another hand-rolled pattern over the same text, inheriting every blind spot.
  Last, a YAML merge key (`<<: *anchor`) splicing an `exclude` declared on a
  SIBLING gate — which that tripwire, added as exactly this backstop, did not
  fire on either, grepping only the `check` block. go-to-k/cdkd#2383 tallies it
  as **four spellings across four rounds, each patch moving the hole rather
  than closing it**. **Three spellings in three rounds is the signal to stop
  patterning and change instrument** — a YAML parser was a production
  dependency the whole time, and a third-party, versioned, separately-tested
  library is not the fence checking its own work.
- **Neither escape was a fifth pattern.** Either parse for real — with
  `parse(text, { merge: true })`, without which `yaml` reports the gate's keys
  as `["hash", "<<"]` and its `exclude` as undefined — then ALLOW-LIST the
  tool's own keys, fail CLOSED outside them, and raw-scan the WHOLE `gates:`
  map. Or, where the repo has no parser to reach for, REFUSE the construct
  rather than model it: go-to-k/cdk-local#631 took that route and then held
  against every respelling its reviewers constructed. Refusal is the STRICTER
  option, not the weaker one — an unmodelled shape stops the fence instead of
  passing through it, which is why an allow-list also beats deny-listing the
  spellings someone happened to think of.
- **And the probe that establishes any of this must move ONE variable.** The
  rule's first draft published "adding `exclude` while holding `include`
  constant takes `verify` from rc=1 to rc=0" — measured, it stays rc=1, because
  subtracting files changes the digest. The probe behind that sentence had
  re-`set` the marker in between. The real hazard needs the marker RECORDED
  with the exclude present: `set` rc=0, after which an edit to an excluded file
  keeps `verify` at rc=0 forever while an included file still reds. A rule
  about probes is exactly where an unreproducible probe does the most damage.

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
  force-pushed; only the rebase preserved them. Say in the prompt: re-`git
  fetch` and inspect the branch first, and if it carries work you did not
  write, STOP and report.
- **A new fixture literal must not collide with an existing assertion needle —
  and neither may a new fixture RESOURCE collide with an existing resource's
  VALUE.** The literal form: a `DB_URL` hard-coded `cdkd-user` as its URL user
  — exactly `EXPECTED_USERNAME`, the needle grepped over the whole persisted
  env — so the run reported a secret LEAK that had not happened; a false leak
  report is worse than a missing assertion, being indistinguishable from the
  real thing. The RESOURCE form is the same trap one level up
  (go-to-k/cdkd#2270, 2026-08-26): an arm testing a same-plaintext COLLAPSE
  must give two leaves one plaintext — that sharing is what makes it
  discriminate — and it reused a plaintext a pre-existing assertion already
  owned, failing on an assertion the lane never wrote. When an arm makes two
  things equal, ask what ELSE holds that value and give the arm its own secret
  / key / name. Scope the sharing; breaking it retires the fence.

  **And check the arm's shape actually exercises the fix before spending a run
  on it.** The obvious decoupling there (two separate RESOURCES) was VACUOUS:
  `perResourceSecrets` is keyed by logical id, so two resources get two
  single-pair bags and redact correctly with or without the fix. One resource holding both leaves was the
  only shape where the mechanism under test decides the answer.
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
  it. And read any surprising probe result as possibly theirs first. §8 adds
  the AFTER half of that check and the copied-worktree hazard; both also live
  in `.claude/agents/pr-*-reviewer.md`, so no dispatch can omit them.

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
  (2026-08-26), so stop asking agents to invent the name: the ORCHESTRATOR
  assigns each dispatched agent a unique scratch directory IN ITS PROMPT**
  (`$SCRATCHPAD/lane<issue>-private/`, `$SCRATCHPAD/rev-<role>-<sha>/`), plus
  "never a bare generic name in the scratchpad root". Decided once per run, it
  cannot be re-derived wrongly per agent. Without it: lane B ran lane A's whole
  probe table twelve times against lane A's worktree; one reviewer's mutation
  was restored from `HEAD` by another; and a TRESPASS was reported that had not
  happened, the `_old-<name>.test.sh` copy a reviewer is TOLD to write beside
  its subject being indistinguishable, from inside the worktree, from a peer
  writing there. Only the orchestrator can know which is which. A hook was
  rejected: it would have to match command TEXT for scratch-path writes, the
  unbounded-bypass shape go-to-k/cdkd#2156 documents.
- **A probe's FIXTURE, not its mutation, decided the outcome.** A region test
  set `AWS_REGION` to the CONSUMER's region, where the correct code and the
  mutation bind identically; only the PRODUCER's region separated them. When a
  probe comes back green, suspect the fixture first — and no count of passing
  cases can see the commonest instance, an expected value COINCIDING with the
  ambient default: assertions pinned to `'us-east-1'`, at once the fixture's
  region and this repo's hardcoded fallback, cannot tell a threaded binding
  from a defaulted one, and substituting the literal for the binding left 434
  tests green (2026-08-29). Choose a value the default can never produce.

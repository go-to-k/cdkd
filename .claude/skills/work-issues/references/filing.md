<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5-f. Filing what you find mid-lane

A defect you trip over while implementing something else is filed from
HERE, not at the end of the run: §5's sibling-site sweep decides what the
finding IS (one root cause or N of them), and this section decides where it
LANDS (one issue, a row folded into an umbrella that already covers it, or
nothing because it is this lane's to fix). Read it whenever the sweep turns
up something the current issue does not cover.

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
lane can close an issue naming N sites. Meanwhile 94 of the 115 open issues
carry `Session-fit: next` and `Session-fit: now` appears 3 times in the last
400 — the deferral classifier has one outcome in practice. The unit drifted
from one ROOT CAUSE
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
# A LITERAL path, and no shell variable anywhere in this command. Substitute
# `<issue-slug>` per FINDING, not per lane -- the root cause plus your branch.
# Two reasons, and the second is the one that bites: parallel lanes share /tmp,
# AND the gate prefers a READABLE file at that path over the heredoc below it.
# Measured: with a file already there carrying `Dup-check:`, a command whose
# heredoc omits that line exits 0 and then overwrites it, filing the
# marker-less body. Reusing one slug for a second finding is exactly how that
# happens. The REVERSE is reachable too, and it costs a FALSE BLOCK: run that
# same slug a THIRD time with a properly marked heredoc and the gate returns
# rc=2, because it reads the STALE marker-less file on disk in preference to
# the heredoc about to replace it -- the refusal is about a stale READABLE
# file, not a missing marker (measured 2026-09-01, here and in cdk-local).
# Nor does a marker-less file need a gated writer: a plain
# `cat > /tmp/wi-issue-body-x.md` carries no `gh` verb, so no gate sees it.
cat > /tmp/wi-issue-body-<issue-slug>.md <<'BODY' &&
<one paragraph: the root cause, and where the evidence for it is>

Dup-check: searched open issues for <terms> -- none covers this root cause
Session-fit: next (not this session) -- <reason>
Severity: high -- <what stays broken while it is undone>
Effort: large (L) -- <which verification cycle it drags>
Estimate: ~3 h+ -- <what eats the time>
BODY
gh issue create -t 'fix(provider): ...' \
  --body-file /tmp/wi-issue-body-<issue-slug>.md \
  --label severity:high --label effort:large
```

**The path is LITERAL because a `$VAR` one cannot be filed at all.**
`issue-dup-check-gate` reads the command TEXT at PreToolUse time, before any of
it has run, and refuses a `--body-file` path containing `$` or a backtick
outright: it cannot open such a file to look for the `Dup-check:` line, and it
fails closed rather than guessing. Measured 2026-08-31 by driving the hook with
each payload: the `B=$(mktemp)` + `--body-file "$B"` spelling this section used
to print returns **rc=2 in all three repos** (cdkd, cdk-local, cdk-real-drift),
so the body it so carefully writes is never filed; the literal-path form above
returns **rc=0** from every gate that sees it — `issue-dup-check-gate`,
`issue-classification-label-gate`, and cdkd's `gh-body-english-gate` and
`gated-command-preamble-gate`. Deleting just the `Dup-check:` line from the
literal form returns rc=2 again, so that rc=0 is the gate passing a good
command, not the gate failing to look.

**The FOLD recipe above keeps `mktemp`, and that asymmetry is the gate set, not
taste.** Folding runs `gh issue edit`, which `issue-dup-check-gate` does not
match at all, and the classification gate falls back to reading the command
text when a path is unresolvable — measured rc=0 from both, same day, same
driver. Folding also NEEDS a unique file it reads back, which a hand-written
name cannot promise; minting only needs a name no concurrent lane will reuse,
which the substituted slug gives.

**The `&&` on the `cat` line is the same load-bearing chaining the FOLD recipe
uses**, for the same reason one scale down: an unchained `cat` that fails
(unwritable path, full disk) leaves whatever was already at that literal slug
path, and the gate then reads THAT file, passes it, and `gh issue create` files
a body this finding never wrote — the stale-readable-file failure the comment
above already measured in the other direction. Verified 2026-09-01 by driving
all four gates with the chained payload: `issue-dup-check-gate`,
`issue-classification-label-gate`, `gh-body-english-gate` and
`gated-command-preamble-gate` each return rc=0, and deleting the `Dup-check:`
line from the same chained payload returns rc=2, so that rc=0 is the gates
passing a good command rather than failing to parse the `&&`.

**The `cat` is not filler for the reader to skip.** The two-line form — create
an empty file, then point `--body-file` at it with nothing in between — files
an issue with NO body: no `Dup-check:` line, no classification, nothing for §3
to rank. It is refused too, but for the reason you would expect ("carries no
`Dup-check:` line"), and only because the path is readable and empty. Write the
body; do not treat the gate as the thing that will notice. `heredoc -> file ->
--body-file` in ONE call is this repo's mandated publishing shape for
`gh issue create` (`gated-command-preamble-gate` refuses that shape for
`git commit` / `gh pr create` / `gh pr merge` and deliberately does not cover
this verb), and the delimiter is QUOTED so backticks and `$` in the body stay
literal instead of being run by the shell.

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

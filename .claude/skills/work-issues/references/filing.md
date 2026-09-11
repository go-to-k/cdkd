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

- **A sweep whose residue carries its own verification is a genuine `next`** —
  file an umbrella naming every site (§3 sorts umbrellas last), and say which
  sites this lane DID close, so the residue is unambiguous.

  **Say WHY in the criteria's terms, not the PR's.** This read "would make the
  PR unreviewable" until 2026-09-05, so the file blessed what its own rule
  refuses. Review size is the SIGNAL; under it is verification the residue needs
  and this lane is not paying. Else the residue is `now`.

  **The unreviewable state is never reached by drifting into it**, because each
  widening is small and real:
  go-to-k/cdkd#2514 asked for a guard hoist at one site and shipped a 2036 LOC
  PR, successive rounds each finding another data-destroying type the same
  guard failed open on — all verified, none requested, and the maintainer asked
  twice whether the run was taking too long. Two tripwires, either one: a SECOND
  unrequested widening in a lane, or a PR TITLE needing a clause the issue does
  not name. On a trip, STATE the call in one line — LOC so far, what the next
  widening adds, in-PR versus filed — before taking it, and `AskUserQuestion`
  when it would more than double the diff. Not "never fix a data-loss bug you
  find": the second one is a DECISION made out loud, not a continuation. What
  the fix would leave WRONG if omitted — the remedy text its own refusal
  prints — is a FORCED parallel change, not a widening, and spends no
  tripwire: the test is whether the artifact ships false without it
  (go-to-k/cdkd#2565).
- **Sweep the same ROOT CAUSE, not the same AREA.** Two unrelated bugs in one
  provider are two issues; one wrong assumption at five call sites is one. The
  test: a single sentence describes the fix at every site.

**The rule is about what a HUMAN files into the triaged backlog, and the
`backfill-type` issues are outside it — do not "consolidate" them back.**
go-to-k/cdkd#2949 fanned the silent-drop backfill umbrella into ~44 generated
per-resource-type sub-issues, which reads at a glance like the split this rule
forbids. Three things make it a different object, and all three have to hold
before any other set may be split this way:

- **Nothing pays the fixed cost.** `.github/workflows/backfill-umbrella-sync.yml`
  creates, updates, reopens and closes each one from `main`'s coverage map; no
  triage, no claim, no filing. Every backlog listing in `triage.md` — §1's, §3-0's
  cutoff query and §3-a's two signal queries — EXCLUDES the label for that
  reason; a listing that grows here must carry it too, or the ~44 come straight
  back onto the shortlist.
- **It is not one root cause.** A resource type is a provider with its own SDK
  input shape, its own drift read-back and its own integration fixture — no
  single sentence describes the fix at every site, which is this rule's own
  test. The 2026-05 audit grouped by type for the same reason.
- **The split is what makes a lane able to CLOSE one.** The umbrella had to stay
  open for the other 43 types, so a pull request wiring one type had nothing to
  `Closes` and the campaign was invisible to `pr-inherit-issue-labels.yml` and to
  §4's claim flow. That is the exact failure this rule's own evidence names — the
  four oldest open issues are umbrella-shaped because no lane can close one — and
  here it is answered by generating the slices rather than by hand-filing them.

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

**Search the CODE PATH too** — §5-b's issue-number sweep in reverse. Issue
search matches the TITLE's vocabulary: go-to-k/cdkd#2723 duplicated
go-to-k/cdkd#2651 with zero shared terms while a comment three lines above the
reported line named it. Record both probes below.

On a MISS — the expected outcome for a genuinely new root cause — file it, and
record the search so the next lane can see the window was checked:

```text
Dup-check: searched open issues for <terms> -- none covers this root cause
```

**Ask the WORKTREE question HERE, not at wrap.** Mid-lane the loud question is
"can this ride THIS PR?" (usually no); the quiet one is "is the owning lane's
worktree still open?" (usually yes) — and while it is, `next` is weak: another
PR from that tree costs almost nothing, deps and markers already paid.
`.claude/rules/session-report.md` owns the criteria and wins on conflict (a
frozen-scope reason is a SESSION-STATE clause there: legal, expiring, and it
must name its ending event). This step adds only the TIMING: twice a
frozen-scope `next` was filed while the owning lane was still open
(go-to-k/cdkd#2321 / go-to-k/cdkd#2322).

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
Session-fit: next (not this session) -- <reason the WORK owns, not this session's circumstances -- .claude/rules/session-report.md>
Severity: high -- <what stays broken while it is undone>
Effort: large (L) -- <which verification cycle it drags>
Estimate: ~3 h+ -- <what eats the time>
BODY
gh issue create -t 'fix(provider): ...' \
  --body-file /tmp/wi-issue-body-<issue-slug>.md \
  --label severity:high --label effort:large
```

**The path no longer has to be LITERAL** (go-to-k/cdkd#2717). `issue-dup-check-gate`
refused a `--body-file` path holding a `$` or backtick — it could not open one
to look for the `Dup-check:` line and failed closed (measured 2026-08-31:
`B=$(mktemp)` + `--body-file "$B"` was rc=2 in all three repos). That gate is
retired to CI and the restriction went with it: re-measured 2026-09-07, all
four surviving body-reading gates return **rc=0** for the `$VAR` form, so
`mktemp` is safe on the mint path too. An old transcript's rc=2 was true of a
gate set that no longer exists — do not re-derive the rule from it.

**The `&&` on the `cat` line is the same load-bearing chaining the FOLD recipe
uses**, one scale down: an unchained `cat` that fails (unwritable path, full
disk) leaves whatever sat at that literal slug path, and the gate reads THAT
file, passes it, and files a body this finding never wrote — the
stale-readable-file failure measured above in the other direction. Verified
2026-09-01 against all four gates with the chained payload (`issue-dup-check`,
`issue-classification-label`, `gh-body-english`, `gated-command-preamble`):
each rc=0, and deleting the `Dup-check:` line returns rc=2 — so the rc=0 is
them passing a good command, not failing to parse the `&&`.

**The `cat` is not filler.** The two-line form — create an empty file, then
point `--body-file` at it — files an issue with NO body: no `Dup-check:`, no
classification, nothing for §3 to rank. It is refused, but for the expected
reason and only because the path is readable and empty; write the body rather
than leaving the gate to notice. `heredoc -> file -> --body-file` in ONE call
is the mandated shape for `gh issue create` (`gated-command-preamble-gate`
refuses it for `git commit` / `gh pr create` / `gh pr merge` and deliberately
skips this verb), and the delimiter is QUOTED so backticks and `$` stay
literal.

Prose is invisible to `gh issue list`; the label makes §3's ranking rule 3 a
listing-time filter, which is what let it move ABOVE the title-prefix
heuristic (a prefix is a proxy for what `Severity` measures). It stays gated
on BOTH candidates carrying the value; a SWEPT label satisfies that gate, but
once the body states the line THAT is the value. Only these two get labels:
`Session-fit` is re-decided at claim (a stale label is worse than none), and
`Estimate` is free-form. The same applies at §4's CLAIM, where an old packed
body is rewritten into the four-line shape — carry `--add-label` on that
`gh issue edit`. Checked in CI (`.github/workflows/`, go-to-k/cdkd#2717) rather
than by a PreToolUse refusal: the workflow reads the body on `issues`
`opened` / `edited` and APPLIES the matching label, which is strictly more than
the retired `issue-classification-label-gate.sh` could do — that one could only
refuse. It reports instead of applying only when the body and an existing label
CONTRADICT, since overwriting a deliberate human label is the one case where
applying is wrong. A folded checklist row carries no classification of its own
— write the severity into the row's text.

**This is not a filing threshold, and it must never be used as one.** §10-0 is
explicit that `filed <= closed` is not a target and an unfiled finding is
strictly worse than a filed one. Nothing here changes WHETHER a defect gets
written down, only WHERE. An open issue then counts one unresolved root cause
instead of one unfixed site — root causes are bounded by the codebase, sites
by types x properties, so that is the number that can converge.

Checked in CI (go-to-k/cdkd#2717): the workflow reads a newly opened issue and
comments when the `Dup-check:` line is missing. **This is strictly weaker than
the refusal it replaces, and the trade is recorded rather than hidden** — the
retired `issue-dup-check-gate.sh` stopped the issue from existing, while CI can
only ask for the line once it does. It was accepted because a duplicate issue
closes cleanly and leaves no residue on anyone else's artifact, which is the
criterion go-to-k/cdkd#2717 settled on for what may block at PreToolUse. The
threat model is unchanged and is what actually carries the rule: it is
FORGETTING the search, not defeating a gate. Folding is not CHEAPER than
minting (one command vs three); the gate makes minting non-free rather than
folding cheap. Two consequences: a folded row carries no `Session-fit` /
`Severity`, so §3's ranking cannot see it, and `gh issue edit` passes through
the `#N` item-number gate that `gh issue create` bodies get — keep bare `#N`
out of a folded row yourself. Registration is not execution.

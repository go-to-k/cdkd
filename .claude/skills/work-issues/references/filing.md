<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 5-f. Filing what you find mid-lane

§5's sweep decides what a finding IS; this, where it LANDS.

**A finding about the TOOLING is a ROW in `docs/tooling-backlog.md`, not an
issue** — hooks, gates, `.claude/rules/**`, `.claude/skills/**`, CI fences and
the integ harness are unreachable from the CLI; build a fence only on a SECOND
occurrence.

**N sites of one root cause is ONE issue and ONE PR, never N issues** — each
split pays the full fixed cost (claim through merge) for the same edit. Sweep
the same ROOT CAUSE, not the same AREA: does one sentence describe the fix at
every site? A residue is `next` only on external input
(`.claude/rules/session-report.md`'s reason (a); never (b), its files being
loaded) — then file an umbrella naming every site, and say which this lane DID
close. **NOT external input**: an umbrella already owning the population, "a
different shape", a scope-creep trip, or a file shared with another code path
(one an OPEN PR holds IS (a)) — each is a SEPARATE PR, still `now`.

**Scope creep reaches an unreviewable PR one small, real step at a time**
(go-to-k/cdkd#2514). Tripwires: a SECOND unrequested widening, or a PR TITLE
needing a clause the issue does not name. On a trip, STATE the call in one line
(LOC so far, what the next adds, in-PR versus filed), and `AskUserQuestion`
when it would more than double the diff. What the fix would leave WRONG if
omitted is a FORCED parallel change.

**Do not fan one campaign out into generated per-item issues**
(go-to-k/cdkd#2949): each slice counts in the open-issue total and every listing
must filter it. The backfill campaign is ONE umbrella issue:
`.github/workflows/backfill-umbrella-sync.yml` rewrites only the region between
`<!-- backfill-types:start -->` and `<!-- backfill-types:end -->`, one `- [ ]`
row per type. Every backlog listing in `triage.md` (§1, §3-0, §3-a)
EXCLUDES the label (`backfill-type`),
and so does §10's folded-finding count in `retro.md`, where it matters most:
it also excludes `backfill-umbrella`, whose body a sync rewrites. A listing
added to either file carries both. A PR wiring one type writes `Refs`, not
`Closes`; the row disappears when the coverage map says the type is done.

**Resolve whatever you file against the issues ALREADY OPEN** — a sibling
ISSUE, not a sibling site.

```bash
# Search the CONCEPT, not this instance's spelling:
gh issue list --state open --limit 200 --search '<root-cause concept>' \
  --json number,title
# Then the body window the index misses: an umbrella names its sites in the
# body, not the title. `(.body // "")` is load-bearing -- one body-less issue
# makes `test` abort the whole jq program.
gh issue list --state open --limit 200 --json number,title,body \
  --jq '.[] | select((.body // "") | test("<shared symbol / call / assumption>";"i"))
        | "\(.number)\t\(.title)"'
```

Search the CODE PATH too. On a HIT the finding is a CHECKLIST ROW, not a new
issue:

```bash
U=$(mktemp)   # NOT a fixed path -- lanes share /tmp
gh issue view <hit> --json body -q .body > "$U" \
  && [ -s "$U" ] \
  && printf -- '- [ ] <site>: <one line, plus where the evidence is>\n' >> "$U" \
  && gh issue edit <hit> --body-file "$U"
```

**The chaining and `-s` are load-bearing**: unchained, a failed `view` hands
`edit` a one-row body REPLACING the umbrella's. Never fold twice at once; write
`owner/repo#N`; and state a folded row's severity as PROSE, since the body-wide
CI scan reads a `Severity:` key as the UMBRELLA's.

On a MISS, file it:

```bash
cat > /tmp/wi-issue-body-<issue-slug>.md <<'BODY' &&
<one paragraph: the root cause, and where the evidence for it is>

Session-fit: now (do it in this session) | next (not this session) -- <the context test, then a reason the WORK owns: .claude/rules/session-report.md>
Severity: high -- <what stays broken while it is undone>
Effort: large (L) -- <which verification cycle it drags>
Estimate: ~3 h+ -- <what eats the time>
BODY
gh issue create -t 'fix(provider): ...' \
  --body-file /tmp/wi-issue-body-<issue-slug>.md \
  --label severity:high --label effort:large
```

**A `next` reason must still be true when someone reads it.** Write it as a
condition a reader can CHECK (`PR #N holds this file`, `the fix belongs in
<repo>`), never as a state of the lane ("the files are cold", "the session
ended"). Check it before writing EITHER value: the fix's file in §2's
`gh pr list ... files` is `next` (a), never `now` (#3808).

The `<issue-slug>` is per FINDING (lanes share `/tmp`), the `&&` stops a failed
write from filing whatever sat at that path, and heredoc → file → `--body-file`
in ONE QUOTED-delimiter call is the shape — the two-line form files an issue
with NO body.

**Not a filing threshold** (§10-0: unfiled is worse than filed) — only WHERE
it is written changes.

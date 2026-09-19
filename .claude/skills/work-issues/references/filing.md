<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5-f. Filing what you find mid-lane

§5's sweep decides what a finding IS; this, where it LANDS.

**A finding about the TOOLING is a ROW in `docs/tooling-backlog.md`, not an
issue** — hooks, gates, `.claude/rules/**`, `.claude/skills/**`, CI fences and
the integ harness are unreachable from the CLI; build a fence only on a SECOND
occurrence.

**N sites of one root cause is ONE issue and ONE PR, never N issues** — split,
each pays the full fixed cost (triage, claim, worktree, review, integ, merge)
for the same edit. Sweep the same ROOT CAUSE, not the same AREA: does one
sentence describe the fix at every site? A residue is `next` only on external
input (`.claude/rules/session-report.md`'s reason (a); never (b), its files
being loaded) — then file an umbrella naming every site, and say which this
lane DID close.

**Scope creep reaches an unreviewable PR one small, real step at a time**
(go-to-k/cdkd#2514). Tripwires: a SECOND unrequested widening, or a PR TITLE
needing a clause the issue does not name. On a trip, STATE the call in one line
(LOC so far, what the next adds, in-PR versus filed), and `AskUserQuestion`
when it would more than double the diff. What the fix would leave WRONG if
omitted is a FORCED parallel change.

**The rule is about what a HUMAN files into the triaged backlog — and the one
attempt to exempt a GENERATED set from it was reversed. Do not re-fan the
backfill campaign into per-type issues.** go-to-k/cdkd#2949 split the silent-drop
umbrella into ~44 generated per-resource-type sub-issues on the reasoning that a
bot pays the fixed cost, so the split is free. It is not, and the cost lands
where no listing can filter it:

- **The public issue COUNT is a reader nobody can exclude.** 44 of the
  repository's 240 open issues were bot-filed slices of one campaign, and from
  outside they are indistinguishable from defects nobody has fixed. The campaign
  is ONE issue again, with a generated checklist block in its body
  (`.github/workflows/backfill-umbrella-sync.yml` rewrites the region between
  `<!-- backfill-types:start -->` and `<!-- backfill-types:end -->`, and nothing
  else on the page).
- **Filtering inside the corpus still costs every listing.**
  Every backlog listing in `triage.md` — §1's, §3-0's cutoff query and §3-a's
  two signal queries — EXCLUDES the label for that reason,
  and so does §10's folded-finding count in `retro.md`, where it matters MOST:
  that one selects issues whose body gained a `- [ ] ` row, and a sync rewrites
  a body region that is nothing else. A listing added to either file must carry
  it — and now also the `backfill-umbrella` label, since the rows moved into
  that one body.
- **What the split genuinely bought was a `Closes` target**, and that is the part
  worth remembering before proposing this shape for another set. The umbrella has
  to stay open for the other 43 types, so a pull request wiring one type has
  nothing to `Closes` — the exact failure this rule's own evidence names, where
  the four oldest open issues are umbrella-shaped because no lane can close one.
  It writes `Refs`, and the type's row disappears when the coverage map says it
  is done; a per-type issue is not the only way to make progress legible.

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

**The chaining and `-s` are load-bearing**: the redirect truncates `$U` first,
so an unchained recipe whose `view` fails hands `edit` a one-row body REPLACING
the umbrella's. Never fold twice at once; write `owner/repo#N`; and state a
folded row's severity as PROSE, since the body-wide CI scan reads a `Severity:`
key as the UMBRELLA's.

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

**A `next` reason must still be true when someone reads it.** Seven deferrals
filed across one run were re-opened by the orchestrator and every one had
expired or was wrong at filing: a gate named as the blocker had been deleted;
"the files are cold" named files the same run's own PR had edited; "the session
ended" is not one of the two licensed reasons at all. Write the reason as a
condition a reader can CHECK (`PR #N holds this file`, `the fix belongs in
<repo>`), never as a state of the lane, and check it yourself before writing
`next` rather than after.

The `<issue-slug>` is per FINDING (lanes share `/tmp`), the `&&` stops a failed
write from filing whatever sat at that path, and heredoc → file → `--body-file`
in ONE QUOTED-delimiter call is the shape — the two-line form files an issue
with NO body. CI applies the matching `severity:*` / `effort:*` label from the
body.

**This is not a filing threshold** (§10-0: an unfiled finding is worse than a
filed one) — only WHERE it is written down changes.

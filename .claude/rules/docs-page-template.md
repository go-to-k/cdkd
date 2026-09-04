---
description: Page shape and voice rules for docs/** — the source of the public cdkd.dev site
paths:
  - 'docs/**'
---

# Documentation page template (docs/**)

`docs/**` is the source of the public site at https://cdkd.dev. A page there
is read in a browser by someone who does not have the repository open. This
file is the shape every page follows, and the rules that keep it readable.

## Page skeleton

Every page opens with frontmatter, an H1 that matches the frontmatter `title`,
and one to three sentences saying what the page covers. A CLI reference page
then follows this order:

````markdown
---
title: cdkd <cmd>
description: "One sentence. Becomes the meta description and the OG image caption."
---

# cdkd <cmd>

<1-3 sentences: what the command does and when you reach for it.>

```bash
<3-6 representative invocations, each with a trailing comment>
```

## Options

| Flag | Default | Description |
| --- | --- | --- |

## <Behaviour section>

## Exit codes

| Code | Meaning |
| --- | --- |

## Related
````

Sections a page has nothing to say about are omitted, never left empty. A page
that is not a CLI reference keeps the H1 + intro and then uses whatever H2
sequence its subject calls for.

**Every page needs an H1.** Several CLI pages historically opened at H2, which
makes their first heading smaller than every other page's and leaves the
browser tab title as the only page name.

**A section documenting one flag is headed by the flag alone** — `` ## `--fail` ``
— with two allowed extensions, both of which carry information the flag name
does not: a `(scope)` suffix on a page that mixes scopes
(`` ## `--allow-unsupported-types` (deploy + destroy) ``), and a `: short gloss`
where the flag name alone does not say what it does
(`` ## `--purge-events`: also delete deployment-event history on destroy ``).
Pick one form per page and stay with it. Renaming an existing flag heading
changes its anchor, so check what links to it first.

## Rules

**Enumerable facts go in a table, not a paragraph.** Flags, modes, exit codes,
refusal codes, supported runtimes, per-type behaviour, schema versions — if a
reader would want to compare the entries, they belong in rows. A flag that
exists only inside a prose paragraph is a flag nobody finds.

**Table cells hold one clause.** Roughly 25 words. When a cell wants a
paragraph, the cell keeps the verdict and the paragraph becomes a note or an
H3 below the table. A 200-word cell is unreadable at any window width.

**No paragraph runs past about six lines** without a list, a table, a code
block, or a subheading breaking it up. A bullet is not exempt: a 40-line
bullet is a wall of prose with a dash in front of it.

**A section longer than a screenful gets subheadings.** They populate the
page's own table of contents, which is how a browser reader navigates.

**Show the command.** A page documenting a command that contains no example
invocation is not finished.

## Voice

**Describe current behaviour.** Not how it got that way. "Previously...",
"Before this change...", "was FIXED", "the pre-PR default", "as of v0.95",
"Upgrade note" — a reader should not have to reconstruct the history of fixed
bugs to learn what the tool does today.

When a version boundary genuinely matters to someone still on an older
release, say it once, at the end of the relevant section, in the form
"Changed in vX: ...". Do not weave it through the explanation.

**No maintainer-facing content on a public page.** Specifically:

- `src/**` paths cited as the authority for a behaviour. Describe the
  behaviour instead.
- Issue and PR numbers carrying the explanation. A parenthetical provenance
  link is fine; "see #1653" as the reason something is true is not.
- Measurement dates and spike records ("measured live, us-east-1, 2026-08-13").
- `.claude/**` files, memory filenames, internal design-doc section numbers.
- Roadmap framing: "MVP scope", "Phase 1", "future work", "deferred to a
  follow-up", "PR 8b". A limitation is documented as a limitation, without the
  plan attached.
- Remedies that tell the reader to edit cdkd's own source. They installed a
  binary.

Content of this kind that contributors genuinely need stays in `docs/`, on a
page carrying `unlisted: true` in its frontmatter — that keeps it out of the
nav, the sitemap and llms.txt while leaving it reachable and linkable. The
public page keeps a readable summary and a link.

## Links

- Link text is the target page's title, or the command it names in backticks
  (`` [`cdkd gc`](cli-gc.md) ``) — never a bare filename or repo path.
- Anchors are slugified by lowercasing, collapsing each run of non-alphanumeric
  characters to a single hyphen, and trimming. Verify a cross-page anchor
  against the target's actual heading before shipping it.
- A relative link must stay inside `docs/`. `../CLAUDE.md` and `../src/x.ts`
  resolve to nothing on the built site — use the GitHub blob URL.

## Generated pages

`docs/_generated/**`, `docs/cli-flag-coverage.md`, `docs/integ-coverage.md`
and `docs/scenario-coverage.md` are written by scripts and guarded by a CI
staleness check. Never hand-edit them; change the generator. Before running
any repo-wide sweep over `docs/**`, build the exclusion list from the
generators' output-path constants rather than by grepping for a banner — the
banner has more than one spelling.

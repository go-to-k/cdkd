import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The `.claude/skills/work-issues/` docs (SKILL.md + references/*.md) are
 * MIRRORED into the sibling repos
 * (`../cdk-local`, `../cdk-real-drift`) by their own section 10-c, so a bare `#N`
 * issue reference in it is a citation that breaks the moment the section
 * travels: GitHub renders `#N` against whichever repo is READING it, and that
 * number almost always exists there and is unrelated. Section 10-c states the
 * rule ("write `go-to-k/cdkd#1973`, never a bare `#1973`") and the same file
 * carried 13 bare references in plain prose across 10 distinct issues on
 * 2026-08-19 (go-to-k/cdkd#1990) -- so the rule was stated and violated in one
 * document. Section 10-b: a rule already in the text that got violated anyway
 * is not fixed by another sentence, it is escalated to a test.
 *
 * SCOPE: the mirrored doc only. Every other skill in this repo (`/hunt-bugs`,
 * `/run-integ`, ...) is never mirrored, so its bare refs are correct where they
 * are and a repo-wide rule would be pure churn.
 *
 * WHAT COUNTS AS QUALIFIED: `go-to-k/<repo>#N` and nothing else. GitHub
 * autolinks only the `owner/repo#N` form, so `cdk-local#525` (owner dropped --
 * the likeliest typo, since the doc is full of `go-to-k/cdk-local#...`) renders
 * as dead text in EVERY repo, and `someone-else/cdkd#5` renders as a working
 * link to a stranger's tracker. Both are the breakage this test exists to
 * prevent, so both fail.
 *
 * EXEMPT CONTEXTS, so a paragraph can still SHOW a bare `#N` as its own
 * counter-example and the YAML `argument-hint` can still demonstrate what a
 * user types: the frontmatter block, fenced code blocks (``` or ~~~, indented
 * or not, closed or running to EOF), and inline code spans -- including ones
 * that WRAP a line, which this hard-wrapped file produces.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The mirrored doc is now a DIRECTORY: a thin SKILL.md orchestrator plus the
 * per-stage files under references/. Every .md in it travels to the siblings,
 * so every one of them is scanned. The list is derived from the directory
 * rather than hand-enumerated, so a new stage file joins the scan on creation.
 */
const SKILL_DIR = join('.claude', 'skills', 'work-issues');
const MIRRORED_DOCS = [
  join(SKILL_DIR, 'SKILL.md'),
  ...readdirSync(join(repoRoot, SKILL_DIR, 'references'))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => join(SKILL_DIR, 'references', f)),
];

/**
 * Every `#N`, together with the `owner/repo`-ish run of characters glued to its
 * left (empty when there is none). The qualifier is judged separately rather
 * than excluded by a lookbehind, so `issue#1990`, `cdk-local#525` and
 * `someone-else/cdkd#5` are all seen instead of silently passing.
 */
const ANY_REF = /([A-Za-z0-9._/-]*)#(\d+)/g;
const QUALIFIER = /^go-to-k\/[A-Za-z0-9._-]+$/;

export interface RefViolation {
  line: number;
  ref: string;
  reason: 'bare' | 'not-go-to-k';
  text: string;
}

/**
 * Blank out every non-prose region while PRESERVING offsets, so the line number
 * reported is the HIT's own line rather than the start of the region or of the
 * paragraph. Newlines inside a blanked region are kept for the same reason.
 */
function proseOnly(markdown: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');

  // YAML frontmatter, only when it opens on the very first line. `\r?` so a
  // CRLF checkout of a mirrored copy is stripped too.
  let text = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n)/, blank);

  // Fenced blocks, line-based because a fence IS line-delimited: this handles
  // an indented fence inside a list, a `~~~` fence, and a fence that never
  // closes (it then runs to EOF, which is what a renderer does too).
  const lines = text.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^[ \t]*(```+|~~~+)/.exec(lines[i]!)?.[1];
    if (fence === null) {
      if (marker) {
        // Keep the marker VERBATIM. Collapsing it to three characters loses the
        // fence length, and CommonMark closes a fence only on a run of the same
        // character at least as long -- so a ``` inside a ```` block would end it
        // early and expose the rest of the file as prose.
        fence = marker;
        lines[i] = blank(lines[i]!);
      }
    } else {
      const closes =
        marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length;
      lines[i] = blank(lines[i]!);
      if (closes) fence = null;
    }
  }
  text = lines.join('\n');

  // Inline code spans, which in this hard-wrapped file may span a line break.
  return text.replace(/`[^`]*`/g, blank);
}

export function findBareIssueRefs(markdown: string): RefViolation[] {
  const prose = proseOnly(markdown);
  const lines = markdown.split('\n');
  // Offset of the first character of each line, for offset -> line lookup.
  const lineStarts: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineStarts.push(at);
    at += line.length + 1;
  }

  const violations: RefViolation[] = [];
  for (const m of prose.matchAll(ANY_REF)) {
    const qualifier = m[1]!;
    if (QUALIFIER.test(qualifier)) continue;
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid]! <= m.index) lo = mid;
      else hi = mid - 1;
    }
    violations.push({
      line: lo + 1,
      ref: `${qualifier}#${m[2]}`,
      reason: qualifier === '' ? 'bare' : 'not-go-to-k',
      text: lines[lo]!.trim(),
    });
  }
  return violations;
}

/** Every `go-to-k/<repo>#N` in the text, used only to size the stripper's output. */
function qualifiedRefs(text: string): string[] {
  return [...text.matchAll(ANY_REF)].filter((m) => QUALIFIER.test(m[1]!)).map((m) => m[0]);
}

describe('work-issues skill docs qualify every issue reference (go-to-k/cdkd#1990)', () => {
  for (const doc of MIRRORED_DOCS) {
    describe(doc, () => {
      const markdown = readFileSync(join(repoRoot, doc), 'utf8');

      it('has no bare or wrongly-qualified #N reference in plain prose', () => {
        const violations = findBareIssueRefs(markdown);
        const detail = violations
          .map((v) => `  L${v.line}: ${v.ref} (${v.reason}) -- ${v.text}`)
          .join('\n');
        expect(
          violations,
          `Unqualified issue reference(s) in ${doc}. This directory is mirrored ` +
            `into ../cdk-local and ../cdk-real-drift (references/retro.md section 10-c), ` +
            `where a bare #N resolves against the READING repo and a half-qualified ` +
            `cdk-local#N does not autolink anywhere -- write go-to-k/<repo>#N, or wrap ` +
            `a deliberate counter-example in a backtick span:\n${detail}`
        ).toEqual([]);
      });

      it('every inline code span is closed, so the stripper cannot blank live prose', () => {
        // Load-bearing, not hygiene: one unbalanced backtick flips inline-span
        // parity for the whole REST of the file, and every bare ref after it then
        // sits inside what the stripper thinks is a code span. The assertion above
        // would go green while missing exactly what it exists to catch, so this is
        // the guard on the guard. Counted after fences are blanked, since a fence
        // body legitimately holds odd backticks.
        const ticksOutsideFences = countTicksOutsideFences(markdown);
        expect(
          ticksOutsideFences % 2,
          `${doc} has an odd number (${ticksOutsideFences}) of backticks ` +
            `outside fenced blocks -- an unclosed inline span silently exempts every ` +
            `issue reference after it`
        ).toBe(0);
      });

      it('the stripper keeps essentially all of the prose refs (it is not blanking the file)', () => {
        const inProse = qualifiedRefs(proseOnly(markdown)).length;
        const inRaw = qualifiedRefs(markdown).length;
        // Proportional rather than a fixed slack: qualified refs legitimately appear
        // inside code spans and fences, and every one added there widens the gap.
        // What this must catch is WHOLESALE blanking, which drives the ratio to
        // about zero. Per-file counts vary (claim.md is short), so the absolute
        // floor lives in the corpus-level test below, not here.
        expect(
          inProse,
          `stripper kept only ${inProse} of ${inRaw} qualified refs in ${doc} -- it is ` +
            `blanking live prose, which would also hide violations`
        ).toBeGreaterThanOrEqual(Math.floor(inRaw * 0.8));
      });
    });
  }

  it('the corpus still carries a meaningful number of qualified refs at all', () => {
    // The proportional per-file check above is vacuous on an empty file, so the
    // absolute floor is corpus-wide: the split must not have silently dropped
    // the incident citations the per-stage files carry.
    const total = MIRRORED_DOCS.reduce(
      (n, doc) => n + qualifiedRefs(readFileSync(join(repoRoot, doc), 'utf8')).length,
      0
    );
    expect(total, 'the work-issues skill corpus has almost no qualified refs at all').toBeGreaterThanOrEqual(40);
  });

  it('the references directory actually holds the stage files (the scan is not vacuous)', () => {
    // readdirSync-derived lists inherit the "0 files scanned == green" failure
    // shape, so pin a floor: the split produced 8 stage files, and 2026-08-31
    // moved the mid-lane filing rules out of implement.md into a 9th
    // (references/filing.md), so the floor rises with it -- raising a floor is
    // strictly tighter, and it is what stops the new file being dropped again.
    expect(MIRRORED_DOCS.length).toBeGreaterThanOrEqual(10);
  });

  it('flags prose but not frontmatter / fences / code spans (self-test)', () => {
    const fixture = [
      '---',
      "argument-hint: \"[optional focus, e.g. '#651 #650']\"",
      '---',
      'Qualified go-to-k/cdkd#1990 is fine; a bare #1991 is not.',
      'A counter-example span like `#1992` is exempt, and so is a span that',
      'wraps: `never a bare',
      '#1993` stays quiet.',
      '~~~',
      'a tilde fence with an odd ` backtick and #1994 inside',
      '~~~',
      '- a list item with an indented fence:',
      '  ```bash',
      '  gh issue view 1995   # refs #1995 freely',
      '  ```',
      'But (PR #1996), see #1997, issue#1998, cdk-local#1999 and evil/cdkd#2000',
      'are all wrong.',
    ].join('\n');
    expect(findBareIssueRefs(fixture).map((v) => `L${v.line}:${v.ref}:${v.reason}`)).toEqual([
      'L4:#1991:bare',
      'L15:#1996:bare',
      'L15:#1997:bare',
      'L15:issue#1998:not-go-to-k',
      'L15:cdk-local#1999:not-go-to-k',
      'L15:evil/cdkd#2000:not-go-to-k',
    ]);
  });

  it('an unterminated fence runs to EOF rather than leaking its body (self-test)', () => {
    const fixture = ['prose with go-to-k/cdkd#1 is fine', '```bash', 'gh issue view 2 # ref #2'].join(
      '\n'
    );
    expect(findBareIssueRefs(fixture)).toEqual([]);
  });
});

/** Backticks that live outside fenced blocks, where span parity has to hold. */
function countTicksOutsideFences(markdown: string): number {
  let ticks = 0;
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const marker = /^[ \t]*(```+|~~~+)/.exec(line)?.[1];
    if (fence === null) {
      if (marker) {
        fence = marker;
        continue;
      }
      ticks += (line.match(/`/g) ?? []).length;
    } else if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
  }
  return ticks;
}

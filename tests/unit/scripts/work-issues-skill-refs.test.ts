import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `.claude/skills/work-issues/SKILL.md` is MIRRORED into the sibling repos
 * (`../cdk-local`, `../cdk-real-drift`) by its own section 10-c, so a bare `#N`
 * issue reference in it is a citation that breaks the moment the section
 * travels: GitHub renders `#N` against whichever repo is READING it, and that
 * number almost always exists there and is unrelated. Section 10-c states the
 * rule ("write `go-to-k/cdkd#1973`, never a bare `#1973`") and the same file
 * carried 20 bare references in plain prose across 15 distinct issues on
 * 2026-08-19 (go-to-k/cdkd#1990) -- so the rule was stated and violated in one
 * document. Section 10-b: a rule already in the text that got violated anyway
 * is not fixed by another sentence, it is escalated to a test.
 *
 * SCOPE: the mirrored doc only. Every other skill in this repo (`/hunt-bugs`,
 * `/run-integ`, ...) is never mirrored, so its bare refs are correct where they
 * are and a repo-wide rule would be pure churn.
 *
 * EXEMPT CONTEXTS, so a paragraph can still SHOW a bare `#N` as its own
 * counter-example and the YAML `argument-hint` can still demonstrate what a
 * user types: the frontmatter block, fenced code blocks, and inline code spans
 * (including ones that WRAP a line, which this hard-wrapped file produces --
 * the stripper works on the whole text and re-derives line numbers, rather than
 * pairing one span's closing backtick with the next span's opening backtick the
 * way a per-line scan does).
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const MIRRORED_DOC = join('.claude', 'skills', 'work-issues', 'SKILL.md');

/**
 * A bare reference: a `#` followed by digits whose preceding character is not
 * part of an `owner/repo` qualifier. `go-to-k/cdkd#1990` has a word character
 * directly before the `#`; ` #1990`, `(#1990)` and `(PR #1990)` do not.
 */
const BARE_REF = /(?<![\w/-])#\d+/g;

/** A fully-qualified reference, used only to prove the scanner sees its input. */
const QUALIFIED_REF = /[\w.-]+\/[\w.-]+#\d+/g;

export interface RefViolation {
  line: number;
  ref: string;
  text: string;
}

/**
 * Blank out every non-prose region while PRESERVING offsets, so the line number
 * reported is the HIT's own line rather than the start of the region or of the
 * paragraph. Newlines inside a blanked region are kept for the same reason.
 */
function proseOnly(markdown: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let text = markdown;
  // YAML frontmatter: only when it opens on the very first line.
  text = text.replace(/^---\n[\s\S]*?\n---(?=\n)/, blank);
  // Fenced code blocks (``` or ~~~), including unterminated trailing fences.
  text = text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, blank);
  // Inline code spans, which in this hard-wrapped file may span a line break.
  text = text.replace(/`[^`]*`/g, blank);
  return text;
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
  for (const m of prose.matchAll(BARE_REF)) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid]! <= m.index) lo = mid;
      else hi = mid - 1;
    }
    violations.push({ line: lo + 1, ref: m[0], text: lines[lo]!.trim() });
  }
  return violations;
}

describe('work-issues SKILL.md qualifies every issue reference (go-to-k/cdkd#1990)', () => {
  const markdown = readFileSync(join(repoRoot, MIRRORED_DOC), 'utf8');

  it('has no bare #N reference in plain prose', () => {
    const violations = findBareIssueRefs(markdown);
    const detail = violations.map((v) => `  L${v.line}: ${v.ref} -- ${v.text}`).join('\n');
    expect(
      violations,
      `Unqualified issue reference(s) in ${MIRRORED_DOC}. This file is mirrored ` +
        `into ../cdk-local and ../cdk-real-drift (section 10-c), where a bare #N ` +
        `resolves against the READING repo -- write go-to-k/<repo>#N instead, or ` +
        `wrap a deliberate counter-example in a backtick span:\n${detail}`
    ).toEqual([]);
  });

  it('sees its input: the doc carries many qualified refs the scanner leaves alone', () => {
    const qualified = [...proseOnly(markdown).matchAll(QUALIFIED_REF)];
    // Floor, not an exact count -- a scanner whose stripper blanked the whole
    // file would otherwise pass the assertion above by reading nothing.
    expect(
      qualified.length,
      `${MIRRORED_DOC} has almost no qualified refs in prose -- the stripper is ` +
        `probably blanking real content`
    ).toBeGreaterThanOrEqual(25);
  });

  it('flags prose but not frontmatter / fences / code spans, incl. a wrapped span', () => {
    const fixture = [
      '---',
      "argument-hint: \"[optional focus, e.g. '#651 #650']\"",
      '---',
      'Qualified go-to-k/cdkd#1990 is fine; a bare #1991 is not.',
      'A counter-example span like `#1992` is exempt, and so is a span that',
      'wraps: `never a bare',
      '#1993` stays quiet.',
      '```bash',
      'gh issue view 1994   # refs #1994 freely inside a fence',
      '```',
      'But (PR #1995) and see #1996 are both bare.',
    ].join('\n');
    const violations = findBareIssueRefs(fixture);
    expect(violations.map((v) => `L${v.line}:${v.ref}`)).toEqual([
      'L4:#1991',
      'L11:#1995',
      'L11:#1996',
    ]);
  });
});

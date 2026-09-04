import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Every Markdown table row in `docs/**` must have its header's cell count.
 *
 * A row with the wrong number of cells does not fail to render — it renders
 * WRONG, silently shifting every value one column right of the header that
 * names it. Nothing else catches this: `docs-site-links.test.ts` checks
 * anchors, the SSG build is happy to emit a ragged table, and the defect is
 * invisible in the Markdown source unless you count `|` characters by hand.
 *
 * Found live: a two-cell row added to a three-column table in
 * `docs/benchmarks.md` put Terraform's run count and region under the
 * CloudFormation column, which the page then contradicted fifty lines down.
 *
 * Two things the scan has to get right, both of which produced false positives
 * on the first cut:
 *
 *  - **An escaped `\|` is not a delimiter.** `docs/state-management.md`'s
 *    composite-physical-id table and `docs/local-invoke.md`'s runtime table
 *    both carry them inside inline code; 25 of the first run's 31 hits were
 *    these.
 *  - **A fenced code block can contain `|` lines.** Several pages embed shell
 *    pipelines and ASCII diagrams, so fences are tracked and skipped.
 *
 * An UNESCAPED `|` inside inline code IS still a delimiter in GitHub-flavoured
 * Markdown — backticks do not protect it — so those correctly stay violations.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const DOCS = join(ROOT, 'docs');

/**
 * The ONE generator-written page that currently emits ragged rows: its
 * generator interpolates descriptions containing `|` without escaping, open as
 * go-to-k/cdkd#2545. Excluded as a SOURCE only.
 *
 * Exactly one entry, deliberately. The first cut listed all three top-level
 * coverage matrices; measured, the other two carry ZERO violations, so their
 * entries removed 172 rows from the fence's reach while excusing nothing. And
 * `docs/_generated/**` is NOT excluded at all — being machine-written is not
 * the boundary, having a known open defect is.
 *
 * The entry cannot go stale silently: a test below asserts this file still HAS
 * violations, so when go-to-k/cdkd#2545 lands the fence fails and tells you to
 * delete the entry.
 */
const GENERATOR_OWNED = new Set(['scenario-coverage.md']);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return entry.endsWith('.md') ? [full] : [];
  });

/**
 * Cell count of a table row, with escaped pipes neutralised first.
 *
 * The `\|` substitution uses a space rather than a sentinel byte: only the
 * COUNT of surviving `|` matters here, so anything pipe-free does the job, and
 * a NUL would make `grep` treat this file as binary and skip it
 * (`source-control-bytes.test.ts` fails on exactly that).
 */
const cellCount = (line: string): number =>
  line.trim().replace(/^\||\|$/g, '').replace(/\\\|/g, ' ').split('|').length;

interface Ragged {
  file: string;
  line: number;
  cells: number;
  header: number;
  text: string;
}

interface ScanResult {
  ragged: Ragged[];
  /** Rows the scan actually EXAMINED — the floor's subject, so a regex that
   *  stopped matching cannot hide behind a separate count. */
  rowsExamined: number;
}

const scan = (markdown: string, file: string): ScanResult => {
  const out: Ragged[] = [];
  let rowsExamined = 0;
  let fence: string | null = null;
  let header: number | null = null;
  let lineNo = 0;
  for (const line of markdown.split('\n')) {
    lineNo += 1;
    // A CLOSING fence carries no info string, so the whole trimmed line must be
    // the marker. Matching an opener as a closer desyncs the tracker: inside
    // ```markdown a nested ```ts would close, and its own ``` would then open an
    // unterminated fence that swallows the rest of the file.
    const fenceMark = /^ {0,3}(```+|~~~+)/.exec(line);
    if (fence !== null) {
      const closer = /^ {0,3}(```+|~~~+)\s*$/.exec(line);
      if (closer && closer[1]![0] === fence[0] && closer[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMark) {
      fence = fenceMark[1]!;
      // A table abutting a fence with no blank line must not leak its width
      // past the block.
      header = null;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      rowsExamined += 1;
      const cells = cellCount(line);
      if (header === null) header = cells;
      else if (cells !== header) {
        out.push({ file, line: lineNo, cells, header, text: line.trim().slice(0, 80) });
      }
    } else {
      // A blank or prose line ends the table; the next one sets its own width.
      header = null;
    }
  }
  return { ragged: out, rowsExamined };
};

describe('published docs tables', () => {
  const files = walk(DOCS).filter((f) => !GENERATOR_OWNED.has(relative(DOCS, f)));
  const scanned = files.map((f) => scan(readFileSync(f, 'utf8'), relative(DOCS, f)));

  it('still SEES its input — floors on what the scan itself examined', () => {
    // Floored on `scan`'s OWN row count, not a second copy of the row regex: a
    // duplicate counter stays truthful while the real one goes blind, which is
    // the shape this floor exists to refuse.
    //
    // Measured 2026-09-04: 68 files, 2446 rows. The floors sit just under, not
    // at 20% of, those numbers — at 30 / 500 a `walk` that stopped recursing
    // (losing docs/design, docs/plans and docs/_generated: 17 files, 716 rows)
    // still passed.
    expect(files.length).toBeGreaterThan(60);
    expect(scanned.reduce((n, r) => n + r.rowsExamined, 0)).toBeGreaterThan(2000);
  });

  it.each([
    // header, then a row one cell short — the shape found live
    ['| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |', 1],
    // ...and one cell long
    ['| a | b |\n| --- | --- |\n| 1 | 2 | 3 |', 1],
    // an escaped pipe is content, not a delimiter
    ['| a | b |\n| --- | --- |\n| 1 | x \\| y |', 0],
    // an UNESCAPED pipe inside inline code still splits the row
    ['| a | b |\n| --- | --- |\n| 1 | `x|y` |', 1],
    // A fenced block's pipe lines are not a table. TWO differing rows, because
    // one row alone becomes its own header and compares against nothing — with
    // that fixture, deleting fence tracking entirely changed no verdict.
    ['```text\n| a | b |\n| c |\n```', 0],
    // ...and the fence must still be tracked when the block follows a real table
    ['| a | b |\n| --- | --- |\n| 1 | 2 |\n```text\n| x |\n```', 0],
    // A closer carrying an info string is an OPENER, so the block stays open.
    // Two differing rows AFTER the inner marker, because with only one the
    // desynced tracker reaches a lone row that becomes its own header and
    // compares against nothing — the loose closer survived that fixture.
    ['```markdown\n| a | b |\n```ts\n| 1 |\n| 2 | 3 |\n```', 0],
    // a table abutting a fence does not leak its width past the block
    ['| a | b |\n| --- | --- |\n| 1 | 2 |\n```text\nx\n```\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |', 0],
    // two adjacent tables of different widths are each measured on their own
    ['| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |', 0],
  ])('discriminates a ragged row from its look-alikes (%#)', (markdown, expected) => {
    expect(scan(markdown as string, 'x.md').ragged).toHaveLength(expected as number);
  });

  it('has no row whose cell count differs from its header', () => {
    const ragged = scanned.flatMap((r) => r.ragged);
    expect(
      ragged.map((r) => `docs/${r.file}:${r.line} has ${r.cells} cells, header has ${r.header}`)
    ).toEqual([]);
  });

  it('still needs every file it excludes', () => {
    // An exclusion that stopped excusing anything would sit there forever,
    // quietly shrinking the fence's reach. When go-to-k/cdkd#2545 escapes the
    // generator's pipes this fails, naming the entry to delete.
    for (const name of GENERATOR_OWNED) {
      const found = scan(readFileSync(join(DOCS, name), 'utf8'), name).ragged;
      expect(
        found.length,
        `docs/${name} no longer has ragged rows — remove it from GENERATOR_OWNED`
      ).toBeGreaterThan(0);
    }
  });
});

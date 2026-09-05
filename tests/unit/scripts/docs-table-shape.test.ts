import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
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

// There is NO exclusion list. There was exactly one entry —
// `scenario-coverage.md`, whose generator interpolated descriptions containing
// `|` unescaped — and go-to-k/cdkd#2545 fixed the generator
// (`scripts/build-scenario-coverage-matrix.ts`'s `escapeCell`), which is what
// the companion test asserting the exclusion still excused something was there
// to force. Machine-written pages are NOT excluded as a class: being generated
// was never the boundary, having a known open defect was, and a generator
// emitting a ragged row is a defect in the generator.
//
// Deliberately a line comment, not a JSDoc block: with no declaration of its
// own left to document, a `/** */` here binds to `walk` and every editor shows
// "There is NO exclusion list" as that function's documentation.

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return entry.endsWith('.md') ? [full] : [];
  });

/**
 * Cell count of a table row, with backslash escapes neutralised first.
 *
 * The pass consumes ANY escape pair (`\\.`), not just `\|`. A row carrying
 * `\\|` — an escaped BACKSLASH followed by a live delimiter — matched the
 * narrower `\|` form on its last two characters, so the delimiter was eaten and
 * a genuinely ragged row scored clean. Consuming the pair left to right takes
 * the `\\` and leaves the `|` counted, which is what CommonMark does.
 *
 * The substitution uses a space rather than a sentinel byte: only the COUNT of
 * surviving `|` matters here, so anything pipe-free does the job, and a NUL
 * would make `grep` treat this file as binary and skip it
 * (`source-control-bytes.test.ts` fails on exactly that).
 *
 * TWIN: `cellCount` in `tests/unit/scripts/build-scenario-coverage-matrix.test.ts`
 * measures the generator's output before it is written, with the same rule
 * re-spelled so that one blinded counter cannot blind both measurements. The
 * two expressions are held byte-identical by a case in THAT file — widening
 * only one left the other scoring a `\\|` row as clean, and a comment asking
 * for them to be changed together is exactly what failed.
 */
const cellCount = (line: string): number =>
  line.trim().replace(/^\||\|$/g, '').replace(/\\[\s\S]/g, ' ').split('|').length;

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
  const files = walk(DOCS);
  const scanned = files.map((f) => scan(readFileSync(f, 'utf8'), relative(DOCS, f)));

  it('still SEES its input — fences recursion, then floors what the scan examined', () => {
    // The named collapse is a `walk` that stopped recursing, losing
    // docs/design, docs/plans and docs/_generated. It is fenced STRUCTURALLY:
    // EVERY immediate subdirectory of docs/ must be represented in the result,
    // derived from the tree rather than listed here, so a new subdirectory
    // joins the fence on its own.
    //
    // Not merely "some nested path exists": measured, a walk recursing into
    // only the FIRST subdirectory yields 67 files / 2814 rows and clears a
    // presence check and both floors below. And not a count at all, because a
    // count cannot fence this durably — the top level keeps growing toward
    // whatever number is written here and quietly stops discriminating, which
    // had already happened once (2026-09-05: 78 files / 2901 rows total against
    // 60 / 2066 for the top level alone, so the previous 2000-row floor no
    // longer caught the collapse and the file floor caught it by one file).
    const subdirs = readdirSync(DOCS).filter((e) => statSync(join(DOCS, e)).isDirectory());
    expect(subdirs.length, 'docs/ has no subdirectory — this fence is vacuous').toBeGreaterThan(1);
    const reached = new Set(files.map((f) => relative(DOCS, f).split(sep)[0]));
    for (const d of subdirs) {
      expect(reached, `the walk never reached docs/${d}/`).toContain(d);
    }

    // The counts are NOT a second copy of the check above — that one is
    // satisfied by one file per subdirectory. What they uniquely still catch is
    // the INVERSE collapse: a walk that returned only the nested files, 18
    // files / 835 rows measured 2026-09-05. Floored on `scan`'s OWN row count
    // rather than a second copy of the row regex, since a duplicate counter
    // stays truthful while the real one goes blind.
    expect(files.length).toBeGreaterThan(64);
    expect(scanned.reduce((n, r) => n + r.rowsExamined, 0)).toBeGreaterThan(2400);
  });

  it.each([
    // header, then a row one cell short — the shape found live
    ['| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |', 1],
    // ...and one cell long
    ['| a | b |\n| --- | --- |\n| 1 | 2 | 3 |', 1],
    // an escaped pipe is content, not a delimiter
    ['| a | b |\n| --- | --- |\n| 1 | x \\| y |', 0],
    // ...but an escaped BACKSLASH does not protect the pipe behind it. Under
    // the narrower `\|`-only neutralisation this scored CLEAN: the substitution
    // matched the pair's last two characters and ate the live delimiter.
    ['| a | b |\n| --- | --- |\n| 1 | x \\\\| y |', 1],
    // ...and the escape pass must not consume an unrelated pipe when the
    // escaped character is something else — the inverse of the case above.
    ['| a | b |\n| --- | --- |\n| 1 | x \\n y |', 0],
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

  it('reaches the page that used to be excluded, and EXAMINES its rows', () => {
    // go-to-k/cdkd#2545's page was the fence's only exclusion, so an empty
    // `ragged` list is the same green whether it was scanned and clean or never
    // scanned at all. Membership alone does not separate those: the page opens
    // with a fenced ```json block ABOVE both its tables, so a desynced fence
    // tracker would skip all ~93 of its rows while the file stayed in `files`
    // and the aggregate floor below stayed clear. Assert the page's OWN
    // examined-row count.
    const i = files.findIndex((f) => relative(DOCS, f) === 'scenario-coverage.md');
    expect(i, 'scenario-coverage.md is not in the scanned set').toBeGreaterThanOrEqual(0);
    expect(scanned[i]!.rowsExamined).toBeGreaterThan(80);
  });
});

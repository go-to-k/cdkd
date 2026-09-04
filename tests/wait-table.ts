import { readFileSync } from 'node:fs';

/**
 * Shared reader for the per-resource-type wait table in `docs/cli-deploy.md`.
 *
 * Both `no-wait-doc-coverage.test.ts` and `full-wait-doc-coverage.test.ts` bind
 * to that one table, and they bind to it in ways that differ only by which
 * column they read. Keeping the parser here rather than copied into each keeps
 * the two from drifting apart — which matters more than usual, because a
 * parser that silently stops matching turns both fences green.
 */

/** The single H2 holding the per-resource-type wait table. */
export const WAIT_TABLE_HEADING = '## Wait behaviour by resource type';

/** Column order the parser depends on, asserted against the header row. */
const EXPECTED_HEADER = [
  'Resource type',
  '`--no-wait`',
  'Default',
  '`--full-wait`',
  'CloudFormation',
  'Terraform',
];

export interface WaitTableRow {
  /** A resource type named in the row's first column. */
  type: string;
  /** The row's `--full-wait` cell, trimmed. */
  fullWait: string;
}

const splitRow = (line: string): string[] => line.split('|').slice(1, -1).map((c) => c.trim());

/**
 * Every resource type named in the table, one entry per (row, type) pair.
 *
 * Parses ROWS rather than the section's text on purpose: the section also
 * carries prose naming resource types, and a type mentioned only there would
 * satisfy a substring check while being absent from the table a reader
 * consults. Measured — with a whole-section check, deleting the
 * `AWS::Lambda::MicrovmImage` row left both fences green, because the routing
 * caveat below the table names that type in a sentence.
 *
 * Throws rather than returning a short list when the table's shape moves: a
 * parser that quietly matches nothing reports "every provider is documented".
 */
export function readWaitTable(deployDocPath: string): WaitTableRow[] {
  return parseWaitTable(readFileSync(deployDocPath, 'utf8'));
}

/**
 * The parsing half, over the markdown text.
 *
 * Split from the file read so it can be exercised against fixture documents.
 * Three successive review rounds each found a hole in this parser that only a
 * hand-probe caught — a prose mention counted as a row, a moved column left
 * both fences green, a foreign two-column table admitted a fake type. Probes
 * find the hole someone thought to look for; `tests/unit/scripts/wait-table.test.ts`
 * is what keeps the closed ones closed.
 */
export function parseWaitTable(md: string): WaitTableRow[] {
  const start = md.indexOf(WAIT_TABLE_HEADING);
  if (start < 0) {
    throw new Error(`cli-deploy.md must have a "${WAIT_TABLE_HEADING}" section`);
  }
  const rest = md.slice(start + 1);
  const next = rest.indexOf('\n## ');
  const section = next >= 0 ? rest.slice(0, next) : rest;

  // The table is the CONTIGUOUS run of pipe lines that begins at the section's
  // first one. Anchoring on contiguity rather than on a per-row shape test is
  // what makes a second table in the same section unreachable BY CLASS: an
  // earlier cut discriminated by column COUNT, which is only a proxy for table
  // identity, and a six-column foreign table would have walked straight through
  // it. The section does hold sub-headings, so a future table under one of them
  // is a real shape, not a hypothetical.
  const rows: WaitTableRow[] = [];
  let header: string[] | null = null;
  let rowCount = 0;
  let done = false;
  let fence: string | null = null;
  for (const line of section.split('\n')) {
    if (done) break;
    // A fenced block can hold pipe-leading lines that are not table rows.
    const fenceMark = /^ {0,3}(```+|~~~+)/.exec(line);
    if (fenceMark) {
      if (fence === null) fence = fenceMark[1]!;
      else if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (!line.startsWith('|')) {
      if (header !== null) done = true; // the run ended; anything after is a different table
      continue;
    }

    const cells = splitRow(line);
    if (header === null) {
      header = cells;
      continue;
    }
    const types = cells[0]?.match(/AWS::[A-Za-z0-9]+::[A-Za-z0-9]+/g) ?? [];
    if (types.length === 0) continue; // drops the `| --- |` separator
    rowCount += 1;
    for (const type of types) rows.push({ type, fullWait: cells[3] ?? '' });
  }

  // Three checks, in the order that makes each failure name its own cause. An
  // unclosed fence or a deleted table leaves no header at all, and reporting
  // that as "the columns moved, found []" sends the reader after the wrong
  // thing; conversely a DROPPED column leaves zero parseable rows, so the
  // row-count message would hide the real edit.
  if (header === null) {
    throw new Error(
      `found no table under "${WAIT_TABLE_HEADING}" — the section was renamed or ` +
        `emptied, or an unclosed code fence swallowed it. These fences are ` +
        `measuring nothing.`
    );
  }
  // Guard the guard. The column INDEX is what both fences read, and a reordered
  // column leaves the row count untouched — measured: swapping `--full-wait`
  // with `CloudFormation` left both fences green while the full-wait filter
  // silently matched every row.
  if (header.join(' | ') !== EXPECTED_HEADER.join(' | ')) {
    throw new Error(
      `the wait table's columns moved: expected [${EXPECTED_HEADER.join(', ')}], ` +
        `found [${header.join(', ')}]. Both wait fences read by column index, ` +
        `so update this list in the same commit as the table.`
    );
  }
  if (rowCount < 10) {
    throw new Error(
      `parsed only ${rowCount} rows out of "${WAIT_TABLE_HEADING}" — the table's shape ` +
        `changed and these fences are measuring nothing.`
    );
  }
  return rows;
}

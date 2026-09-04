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
  const md = readFileSync(deployDocPath, 'utf8');
  const start = md.indexOf(WAIT_TABLE_HEADING);
  if (start < 0) {
    throw new Error(`cli-deploy.md must have a "${WAIT_TABLE_HEADING}" section`);
  }
  const rest = md.slice(start + 1);
  const next = rest.indexOf('\n## ');
  const section = next >= 0 ? rest.slice(0, next) : rest;

  const rows: WaitTableRow[] = [];
  let header: string[] | null = null;
  let rowCount = 0;
  let fence: string | null = null;
  for (const line of section.split('\n')) {
    // A fenced block can hold pipe-leading lines that are not table rows.
    const fenceMark = /^ {0,3}(```+|~~~+)/.exec(line);
    if (fenceMark) {
      if (fence === null) fence = fenceMark[1]!;
      else if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null || !line.startsWith('|')) continue;

    const cells = splitRow(line);
    if (header === null) {
      header = cells;
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue; // the `| --- |` separator
    const types = cells[0]?.match(/AWS::[A-Za-z0-9]+::[A-Za-z0-9]+/g) ?? [];
    if (types.length === 0) continue;
    rowCount += 1;
    for (const type of types) rows.push({ type, fullWait: cells[3] ?? '' });
  }

  // Guard the guard. The column INDEX is what both fences read, and a reordered
  // or dropped column leaves the row count untouched — measured: deleting the
  // `--no-wait` column, or swapping `--full-wait` with `CloudFormation`, left
  // both fences green while the full-wait filter silently matched every row.
  if (header === null || header.join(' | ') !== EXPECTED_HEADER.join(' | ')) {
    throw new Error(
      `the wait table's columns moved: expected [${EXPECTED_HEADER.join(', ')}], ` +
        `found [${(header ?? []).join(', ')}]. Both wait fences read by column index, ` +
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

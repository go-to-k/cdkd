import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWaitTable, readWaitTable, WAIT_TABLE_HEADING } from '../../wait-table.js';

/**
 * Unit tests for the wait-table parser that `no-wait-doc-coverage.test.ts` and
 * `full-wait-doc-coverage.test.ts` both bind to.
 *
 * Those two fences answer "is every provider documented". Neither can tell
 * whether the PARSER still works: a parser that quietly matches nothing reports
 * that every provider is documented, which is the exact shape
 * `.claude/rules/testing.md` calls a vacuous pass.
 *
 * Every case below was a real defect found by review rather than an imagined
 * one — three successive fix rounds on the same parser each introduced the
 * next. That is why the parser is tested here instead of being re-probed by
 * hand each time it changes.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const deployDocPath = join(repoRoot, 'docs', 'cli-deploy.md');

const HEADER = [
  '| Resource type | `--no-wait` | Default | `--full-wait` | CloudFormation | Terraform |',
  '| --- | --- | --- | --- | --- | --- |',
];

/** A document with `count` well-formed rows, plus whatever `extra` adds. */
const doc = (count: number, extra = ''): string => {
  const rows = Array.from(
    { length: count },
    (_, i) =>
      `| \`AWS::Test::Type${i}\` | Return immediately | Wait for ready | ${
        i === 0 ? 'Wait for deployed' : 'same as default'
      } | Waits | Waits |`
  );
  return [`${WAIT_TABLE_HEADING}`, '', ...HEADER, ...rows, '', extra].join('\n');
};

describe('wait-table parser', () => {
  it('reads one entry per (row, type) pair, carrying the --full-wait cell', () => {
    const rows = parseWaitTable(doc(11));
    expect(rows).toHaveLength(11);
    expect(rows[0]).toEqual({ type: 'AWS::Test::Type0', fullWait: 'Wait for deployed' });
    expect(rows[1]!.fullWait).toBe('same as default');
  });

  it('splits a row whose type cell names two types', () => {
    const md = doc(10).replace(
      '| `AWS::Test::Type0` |',
      '| `AWS::RDS::DBCluster` / `AWS::RDS::DBInstance` |'
    );
    const rows = parseWaitTable(md);
    // 9 single-type rows plus the 2 from the split row.
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.type)).toContain('AWS::RDS::DBInstance');
  });

  it('ignores a type named only in prose inside the section', () => {
    const rows = parseWaitTable(doc(11, 'Only `AWS::Prose::Only` routes differently.'));
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.type)).not.toContain('AWS::Prose::Only');
  });

  it('ignores a pipe-leading line inside a fenced block', () => {
    const fenced = ['```text', '| `AWS::Fenced::Thing` | a | b | c | d | e |', '```'].join('\n');
    const rows = parseWaitTable(doc(11, fenced));
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.type)).not.toContain('AWS::Fenced::Thing');
  });

  it('ignores a row of a DIFFERENT table in the same section', () => {
    // The header binds to the first pipe line, so a second table's rows would
    // otherwise be read under this table's validated column order — and a short
    // row yields an empty `--full-wait` cell, which the full-wait filter reads
    // as "not the default".
    const foreign = ['| Type | Note |', '| --- | --- |', '| `AWS::Foreign::Thing` | zzz |'].join(
      '\n'
    );
    const rows = parseWaitTable(doc(11, foreign));
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.type)).not.toContain('AWS::Foreign::Thing');
  });

  it('ignores a SIX-column foreign table too, not just a short one', () => {
    // Column count is only a proxy for table identity; the parser anchors on
    // the contiguous run instead, so a same-width table below the real one is
    // out of reach by class rather than by shape.
    const foreign = [
      '| Resource type | `--no-wait` | Default | `--full-wait` | CloudFormation | Terraform |',
      '| --- | --- | --- | --- | --- | --- |',
      '| `AWS::CloudFront::Distribution` | x | y | see above | z | z |',
      '| `AWS::Foreign::Wide` | x | y | also affected | z | z |',
    ].join('\n');
    const rows = parseWaitTable(doc(11, foreign));
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.type)).not.toContain('AWS::Foreign::Wide');
    expect(rows.filter((r) => r.fullWait === 'see above')).toEqual([]);
  });

  it('refuses a moved column rather than silently reindexing', () => {
    const swapped = doc(11).replace(
      '| Resource type | `--no-wait` | Default | `--full-wait` | CloudFormation | Terraform |',
      '| Resource type | `--no-wait` | Default | CloudFormation | `--full-wait` | Terraform |'
    );
    expect(() => parseWaitTable(swapped)).toThrow(/columns moved/);
  });

  it('refuses a dropped column', () => {
    const dropped = doc(11)
      .split('\n')
      .map((l) => (l.startsWith('|') ? `|${l.split('|').slice(2).join('|')}` : l))
      .join('\n');
    expect(() => parseWaitTable(dropped)).toThrow(/columns moved/);
  });

  it('reports a shrunken table as a row-count problem, not a column one', () => {
    expect(() => parseWaitTable(doc(3))).toThrow(/parsed only 3 rows/);
  });

  it('reports an unclosed fence that swallows the table as a missing table', () => {
    // Distinct from both other failures: there is no header to compare and no
    // rows to count, so naming it "the columns moved, found []" would send the
    // reader after an edit nobody made.
    const swallowed = doc(11).replace(WAIT_TABLE_HEADING, `${WAIT_TABLE_HEADING}\n\n\`\`\`text`);
    expect(() => parseWaitTable(swallowed)).toThrow(/found no table under/);
  });

  it('refuses a document with no such section', () => {
    expect(() => parseWaitTable('# Something else\n\nNo table here.\n')).toThrow(
      /must have a ".*" section/
    );
  });

  it('stops at the next H2', () => {
    const md = [doc(11), '', '## Next section', '', '| `AWS::After::Section` | a | b | c | d | e |']
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
    const rows = parseWaitTable(md);
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.type)).not.toContain('AWS::After::Section');
  });

  it('parses the real docs/cli-deploy.md, and agrees with a direct read', () => {
    const fromPath = readWaitTable(deployDocPath);
    const fromText = parseWaitTable(readFileSync(deployDocPath, 'utf8'));
    expect(fromPath).toEqual(fromText);
    // Anti-vacuity: the shipped table carries eleven rows today, and at least
    // two of them must be types `--full-wait` actually changes.
    expect(fromPath.length).toBeGreaterThanOrEqual(11);
    expect(
      fromPath.filter((r) => r.fullWait.toLowerCase() !== 'same as default').length
    ).toBeGreaterThanOrEqual(2);
  });
});

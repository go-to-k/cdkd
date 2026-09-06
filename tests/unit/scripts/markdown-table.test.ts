import { describe, it, expect } from 'vite-plus/test';
import { escapeCell } from '../../../scripts/markdown-table.ts';

/**
 * The contract stated in `scripts/markdown-table.ts` — one case per clause,
 * including the ones that assert `escapeCell` leaves something ALONE.
 *
 * Both directions matter. The `|` / `\` / line-ending cases catch an escape
 * that stopped happening; the pass-through cases catch an over-tightening fix
 * that starts rewriting values (a trim, a tab collapse, a backtick balancer),
 * which is invisible to a row-shape check because it does not change the cell
 * COUNT — it changes what the cell says.
 */
describe('escapeCell', () => {
  it.each([
    // The live #2545 shapes: a pipe is a delimiter even inside a code span.
    ['invoke|start-api|run-task', 'invoke\\|start-api\\|run-task'],
    ['<databaseName>|<tableName>', '<databaseName>\\|<tableName>'],
    // A backslash is escaped FIRST, in the same pass. Escaping only the pipe
    // turns `\|` into `\\|` — an escaped backslash plus a LIVE delimiter.
    ['a \\| b', 'a \\\\\\| b'],
    ['C:\\path', 'C:\\\\path'],
    // Line endings END the row, so a run collapses to one space. All three
    // spellings, including a LONE `\r` (a CommonMark line ending on its own,
    // which `/\r?\n/` would let through).
    ['a\nb', 'a b'],
    ['a\r\nb', 'a b'],
    ['a\rb', 'a b'],
    ['a\n\n\nb', 'a b'],
    // Both transformations applying to one value. NOT an ordering case: the two
    // passes commute (disjoint character classes, and the space they substitute
    // is in neither), so writing them the other way round changes nothing.
    ['a\nb|c', 'a b\\|c'],
  ])('escapes %j', (input, expected) => {
    expect(escapeCell(input as string)).toBe(expected as string);
  });

  it.each([
    // Deliberately NOT trimmed: GFM strips cell whitespace when it renders, so
    // this cannot change the row's SHAPE, and trimming would silently rewrite a
    // deliberately padded value.
    ['  padded  '],
    // A tab is not a delimiter of anything.
    ['a\tb'],
    // `<br>` is how several generators join a multi-value cell.
    ['a<br>b'],
    // An unbalanced backtick renders oddly inside the ONE cell it belongs to;
    // it does not misfile the others, which is the invariant this helper owes.
    ['a ` b'],
    [''],
  ])('passes %j through unchanged', (input) => {
    expect(escapeCell(input as string)).toBe(input as string);
  });

  it('leaves an adversarial value with no live delimiter and no line ending', () => {
    // The property the character list exists to buy, asserted end to end.
    //
    // Deliberately NOT a cell counter. `docs-table-shape.test.ts` and
    // `build-scenario-coverage-matrix.test.ts` each carry one and a case in the
    // latter pins those TWO in step by comparing the expressions; a third copy
    // here would drift freely while being the instrument behind this assertion,
    // so the property is stated directly instead.
    const nasty = 'a|b \\| c \\\\| d\ne|f';
    const escaped = escapeCell(nasty);

    // A line ending would end the ROW, which no escaping repairs.
    expect(escaped).not.toMatch(/[\r\n]/);
    // Dropping every escape PAIR must leave no `|` behind — i.e. every
    // surviving delimiter is escaped. The pair form, not `\\\|`, for the same
    // reason the two counters use it: `\\\\|` is an escaped BACKSLASH followed
    // by a live delimiter.
    expect(escaped.replace(/\\[\s\S]/g, '')).not.toContain('|');
    // Control: the same input unescaped FAILS that test, so the assertion above
    // is not satisfied by every string.
    expect(nasty.replace(/\\[\s\S]/g, '')).toContain('|');

    // ...and the escape is REVERSIBLE, which is what makes it safe for a value
    // GFM will un-escape when it renders the cell. Only the line-ending
    // collapse is lossy, so that is the one thing the expectation restates.
    expect(escaped.replace(/\\([\s\S])/g, '$1')).toBe(nasty.replace(/[\r\n]+/g, ' '));
  });
});

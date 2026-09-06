/**
 * Markdown table-cell escaping, shared by every generator under `scripts/`.
 *
 * Extracted from `build-scenario-coverage-matrix.ts` by issue #2636, which
 * found five more generators interpolating author-written prose straight into
 * a table row. The count, stated once because it was written three different
 * ways first: exactly ONE implementation existed, in that file, and the other
 * five sites had no escape at all. What this module changes is that six
 * generators now CALL one implementation instead of one calling its own and
 * five calling nothing — so a SECOND private copy is the wrong answer, at any
 * point. The escape's CONTRACT — which characters it neutralises and which it
 * deliberately does not — is a single decision, and copies of it drift one
 * character at a time.
 *
 * ## The contract
 *
 * `escapeCell(value)` returns a string that occupies exactly ONE cell of the
 * row it is interpolated into, whatever `value` contains. Three characters
 * decide that, and nothing else does:
 *
 *  - **`|` — the delimiter.** In GitHub-flavoured Markdown a `|` inside a
 *    table row splits cells even when it sits inside an inline code span:
 *    backticks do NOT protect it, because the row is split into cells before
 *    inline parsing runs. This is the live defect issue #2545 shipped — six
 *    `KNOWN_SCENARIOS` descriptions carried one (`invoke|start-api|run-task`,
 *    `-c phase=a|b`, `<databaseName>|<tableName>`, …) and rendered rows with
 *    up to six columns against a three-column header, filing every value under
 *    a heading that did not name it.
 *  - **`\` — the escape character.** Escaping only the pipe turns an input
 *    `\|` into `\\|`, which CommonMark reads as an escaped BACKSLASH followed
 *    by a LIVE delimiter — ragged again. So a backslash is escaped first, in
 *    the same pass. `tests/unit/scripts/docs-table-shape.test.ts`'s
 *    neutralisation consumes any escape pair for the mirrored reason.
 *  - **A LINE ENDING — `\n`, `\r\n`, or a LONE `\r`.** A line ending does not
 *    split a cell, it ends the ROW, and no amount of escaping fixes that; the
 *    only repair is to not emit one, so a run collapses to a single space. A
 *    lone `\r` counts: CommonMark treats it as a line ending on its own, so
 *    `/\r?\n/` would let it through.
 *
 * ## What it deliberately does NOT do
 *
 *  - **Leading / trailing whitespace is left alone.** GFM strips it when it
 *    renders the cell, so it cannot change the row's SHAPE — trimming here
 *    would be a cosmetic edit made by a function whose job is shape, and would
 *    silently rewrite values (a deliberately indented continuation).
 *  - **A tab, a `<br>`, an HTML tag or a stray backtick pass through.** None
 *    is a cell or row delimiter. An unbalanced backtick renders oddly inside
 *    the one cell it belongs to; it does not misfile the other cells, which is
 *    the invariant this helper owes its caller.
 *
 * ## One accepted cost
 *
 * Cells are usually wrapped in backticks by the caller. GFM un-escapes `\|`
 * inside a table cell, but a code span renders `\\` as two visible
 * backslashes — so a backslash-bearing value shows its escape. Row shape wins
 * over that: a ragged row misfiles every OTHER cell in it, while a doubled
 * backslash is a legible blemish in one. No value any generator renders
 * carries a backslash today.
 *
 * ## Where it must be applied
 *
 * On every cell whose value is author-written or composed prose — a
 * `rationale`, a `detail`, a `description`. `tests/unit/scripts/table-cell-escape.test.ts`
 * derives that population from the tree and reds when such a cell reaches a
 * row unescaped, so a generator written tomorrow is covered that day — for the
 * row and read shapes that test's header enumerates, which is deliberately a
 * SHORT list. It is not a claim of total coverage; the page-level
 * `docs-table-shape.test.ts` is what covers the rest, and it is indifferent to
 * how a row was built. Read the two together before assuming a cell is watched.
 *
 * Structural cells (a resource type, a file name, a count, a `yes`/`no`) are
 * left unescaped deliberately: escaping them is a no-op that would only obscure
 * which cells actually needed it. **But the line is PROVENANCE, not the value's
 * role.** A cell whose value arrives from an AWS API is escaped however
 * structural it looks, because nothing in this repository bounds its
 * characters — `audit-stateful-candidates.ts` renders a type name and a
 * JSON-pointer property name off a `cloudformation:DescribeType` response,
 * third-party public-registry schemas included, and only a REMOTE meta-schema
 * keeps a `|` out of them. The other exception the scenario matrix keeps is a
 * COMPOSED link cell escaped as a whole — see its call sites for why the href
 * is escaped along with the label.
 */
export const escapeCell = (value: string): string =>
  value.replace(/[\r\n]+/g, ' ').replace(/([\\|])/g, '\\$1');

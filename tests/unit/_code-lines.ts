import { parseSync } from 'vite-plus';

/**
 * Code lines only, with every comment REMOVED by a real parser.
 *
 * A mention in a comment is prose, but code after a closed block comment on
 * the same line is still code. The comment spans come from oxc (`parseSync`,
 * re-exported by `vite-plus`), which knows strings, template literals and
 * regular expressions. A hand-rolled stripper read the `/*` inside the string
 * `'MyStage/*'` as a comment opener and dropped the rest of several real files.
 * (TypeScript's own scanner is not available: the repo's `typescript@7` has no
 * JS API.)
 *
 * Each comment is blanked to spaces, keeping its newlines, so line numbers
 * survive. A file oxc cannot parse throws rather than being skipped.
 *
 * Shared by the source-scanning fences (role-arn shape, #3826's auxiliary-mark
 * population).
 */
export function codeLines(text: string, file = 'input.ts'): Array<{ line: number; text: string }> {
  const parsed = parseSync(file, text);
  if (parsed.errors.length > 0) {
    throw new Error(`cannot parse ${file}: ${parsed.errors[0]!.message}`);
  }
  // One pass, one join: re-slicing the whole file per comment was quadratic.
  const chunks: string[] = [];
  let at = 0;
  for (const c of [...parsed.comments].sort((x, y) => x.start - y.start)) {
    chunks.push(text.slice(at, c.start), text.slice(c.start, c.end).replace(/[^\n]/g, ' '));
    at = c.end;
  }
  chunks.push(text.slice(at));
  return chunks
    .join('')
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter((l) => l.text.trim() !== '');
}

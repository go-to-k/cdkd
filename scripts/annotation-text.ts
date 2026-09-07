/**
 * Make attacker-controlled text safe to interpolate into a GitHub Actions
 * annotation.
 *
 * ## The failure this prevents
 *
 * The Actions runner reads WORKFLOW COMMANDS out of a step's own output: it
 * splits the stream into lines, trims each, and treats one beginning `::` as a
 * command. Every checker in this family echoes attacker-controlled text back --
 * a PR body, or a line of a fork PR's file content -- into a `::error` /
 * `::warning` message.
 *
 * Each echoed line is PREFIXED (`  body:12: `, or `::error file=...::`), so the
 * payload never starts at column 0 and cannot be a command. That holds only
 * while the payload cannot forge a LINE BREAK. If it can, everything after the
 * break is a fresh line the runner parses on its own terms, and
 * `::stop-commands::` / `::add-mask::` / `::error::` become injectable.
 *
 * ## Why this is shared rather than three folds
 *
 * Measured 2026-09-07, the three checks in this family disagreed three ways:
 * `check-pr-closes-paren.ts` folded one of its two body-derived fields,
 * `check-pr-non-english-text.ts` stripped only a TRAILING carriage return
 * (`/\r$/`), and `check-pr-internal-labels.ts` stripped nothing -- so a fork PR
 * file line ending `<CR>::stop-commands::x` reached column 0 through two of
 * them. One rule in one place is what stops the next sibling being written with
 * a fourth answer; enumerating the bad shapes per file is how the first three
 * drifted apart.
 *
 * ## The character class
 *
 * CR and LF are what the runner's line splitter actually breaks on, so they are
 * the load-bearing pair. U+2028, U+2029, U+0085, vertical tab and form feed are
 * folded too -- not because that splitter honours them (measured: it does not),
 * but so the property here does not depend on a runner internal this file would
 * then have to track. They cost nothing: none can legitimately appear mid-line
 * in text that was itself produced by splitting on LF.
 *
 * Spelled with `\uXXXX` ESCAPES, never literal characters, matching
 * `check-gh-body-english.ts`'s class: a literal U+2028 here would be a byte no
 * reviewer can see in a diff, in the one file whose subject is exactly that.
 *
 * NUL and the other C0 bytes are deliberately NOT touched. They cannot break a
 * line, and a checker whose job is to REPORT what it found must not quietly
 * rewrite the finding beyond the one property it needs.
 */

/** Every character that could start a new output line, or be mistaken for one. */
export const LINE_BREAKING_CHARS = /[\r\n\u2028\u2029\u0085\v\f]/g;

/**
 * Fold every line-breaking character to a space, so the result cannot begin a
 * new line in a step's output.
 *
 * Folded to a SPACE rather than removed: a CR between two words becoming
 * nothing silently changes the text a human is being shown, and the point of
 * the annotation is to quote the offending line accurately.
 */
export function foldAnnotationText(text: string): string {
  return text.replace(LINE_BREAKING_CHARS, ' ');
}

/**
 * As `foldAnnotationText`, but a RUN of line-breaking characters becomes ONE
 * space rather than one space each.
 *
 * For a caller that renders the text for a human -- `fencedQuote`, whose output
 * is posted as an issue comment -- CRLF should read as a single space, not two.
 *
 * It exists because the obvious alternative is WRONG: folding each character
 * and then collapsing spaces (`.replace(/ +/g, ' ')`) also collapses runs the
 * fold never created. Measured: `"    const x = 1;  // a"` became
 * `" const x = 1; // a"`, silently re-indenting code inside a
 * whitespace-preserving fence -- in a check whose entire subject is text
 * fidelity (go-to-k/cdkd#2736 round-4 review, found independently by two
 * reviewers and by the author).
 */
export function foldAnnotationRuns(text: string): string {
  return text.replace(new RegExp(`(?:${LINE_BREAKING_CHARS.source})+`, 'g'), ' ');
}

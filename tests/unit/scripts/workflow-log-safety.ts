/**
 * Rendering fork-controlled text safely, shared by the two workflow fences.
 *
 * EXTRACTED RATHER THAN COPIED. `workflow-job-hardening.test.ts`
 * (go-to-k/cdkd#3272) needed four review rounds to close log forgery, because
 * every instance hid inside the fix for the previous one, and it was finally
 * closed by a branded type rather than by another patch. When
 * `workflow-timeout-headroom.test.ts` (go-to-k/cdkd#3283) began rendering the
 * same fork-controlled fields — a job key, a workflow file name — the choice
 * was a second copy of these helpers or one module. A second copy is how a
 * fix lands in one place and not the other, which is a failure this pair has
 * already had in prose and in a filter.
 *
 * Importing the helpers from the other TEST file was tried first and is worse
 * than it looks: a `.test.ts` import re-runs that file's whole suite (92 cases
 * measured), so the two fences become one run and a failure in either reports
 * against both.
 */

/**
 * A string that has passed through a sanitiser.
 *
 * THE BRAND IS THE FIX FOR A CLASS, not a style. Three review rounds found the
 * same defect in three different places — and each time in the code that had
 * just fixed the previous one: the renderer (round 1), the twins' raw
 * interpolation and unguarded parse (round 2), then `safeJson`'s output, which
 * was the ONE field in the file still reaching output without `safeText`
 * (round 3). Every instance was a human choosing the wrong helper, or no
 * helper, at a new site; every fix was a patch at that site; and the class
 * survived all three.
 *
 * So the choice is taken away from the author. A line constructor accepts only
 * `Safe`, the sanitisers are the only functions that produce one, and a site
 * that forgets is a TYPE ERROR rather than a review finding. That matters
 * doubly here, because `vp run typecheck:test` is the gate that already
 * demonstrated it sees what this file's own suite cannot — vitest's
 * `typecheck.include` is `*.test-d.ts` alone, so the "Type Errors" line printed
 * by a run of THIS file is vacuous.
 */
export declare const SANITISED: unique symbol;
export type Safe = string & { readonly [SANITISED]: true };

/** Longest fork-controlled string a rendered finding may carry. */
export const MAX_FIELD_LENGTH = 120;

/**
 * Collapse everything that could move a cursor, break a line, or reorder the
 * text around it into single spaces.
 *
 * Written so that NO escape sequence ENCODES A CONTROL CHARACTER: an earlier
 * version of this helper in the sibling fence was authored twice with a literal
 * control byte in its own source, which `grep` then classified as a binary file
 * and skipped at exit 0 — the `check-source-control-bytes.ts` class. Numeric
 * comparisons cannot make that mistake. The `/\s/` test is an escape sequence
 * and is deliberately kept: it is the ONLY row that catches NBSP, U+2028 and
 * U+FEFF, which no numeric range below covers. An earlier draft of this
 * paragraph claimed the file had no escape sequence at all, which was false of
 * the line directly beneath it.
 */
export const flatten = (text: string): string => {
  let out = '';
  let blank = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const unsafe =
      // C0 and space.
      code <= 0x20 ||
      // DEL and the C1 range — U+0085 is NEL, a line break to a Unicode-aware
      // reader, and it is neither `<= 0x20` nor matched by `\s`.
      (code >= 0x7f && code <= 0x9f) ||
      // Every bidi control, not only the overrides: the marks and the isolates
      // reorder a rendered line just as well.
      code === 0x61c ||
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      /\s/.test(ch);
    if (unsafe) {
      if (!blank) out += ' ';
      blank = true;
    } else {
      out += ch;
      blank = false;
    }
  }
  return out;
};

/** Flatten and clamp any fork-controlled string, marking the clip. */
export const safeText = (text: string): Safe => {
  const flat = flatten(text);
  return (flat.length > MAX_FIELD_LENGTH
    ? `${flat.slice(0, MAX_FIELD_LENGTH)}…`
    : flat) as Safe;
};

/**
 * A workflow file name as it may appear in a finding — CONSTRAINED, not merely
 * flattened.
 *
 * The distinction is the whole point and it is not obvious: a file can be named
 * in pure ASCII so that it reads as a complete finding about a DIFFERENT file.
 * `ci.yml / check-build-test: no-timeout - and also.yml` passes the `.ya?ml`
 * filter and is a `flatten` no-op. A real workflow name is a short, dull thing;
 * anything else is quoted, so it can only ever be read as one field.
 */
const WORKFLOW_NAME = /^[A-Za-z0-9._-]+\.ya?ml$/;
export const safeName = (name: string): Safe =>
  // The cast is scoped to the quoting branch alone. Spanning the whole ternary
  // would let a future edit return `name` raw from the passing branch and still
  // typecheck — the brand silently switched off at the one site whose job is to
  // be paranoid about names.
  WORKFLOW_NAME.test(name) ? safeText(name) : (JSON.stringify(safeText(name)) as Safe);

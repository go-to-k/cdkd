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
 * IN `scripts/`, NOT BESIDE THE FENCES, and that placement is the fix for a
 * finding rather than a filing preference. The generator is the THIRD consumer
 * and the one that most needed it: it was the only file in this pair with no
 * sanitiser at all, interpolating raw workflow file names and raw YAML/JSON
 * parse errors — a fork's own bytes — into eight of its own messages. A module
 * under `tests/` cannot be imported by a script without reversing the
 * dependency, so the module moved rather than the rule bending.
 *
 * THREE OF FOUR, NOT ALL FOUR. `workflow-expression-syntax.test.ts` holds a
 * fourth, unbranded `safeName` of its own and is NOT a consumer of this module.
 * It was left alone deliberately — it is another fence with its own review
 * history, and folding it in here would put an unrelated file in this PR's
 * blast radius — but the consequence has to be stated rather than implied by
 * the word "shared": a fix made here reaches three files, not the repo.
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
/**
 * A JOB id, constrained the way `safeName` constrains a file name.
 *
 * THE SECOND HALF OF A KEY IS AS FORK-CONTROLLED AS THE FIRST, and it was
 * getting only `safeText`. That flattens control bytes and clamps length, which
 * is not the threat here: a job id of pure ASCII, with no byte either helper
 * touches, reads as a complete finding about a different job —
 * `a.yml/j: not-in-snapshot - and ci.yml/check-build-test: not-in-snapshot`
 * was measured rendering exactly that. Quoting is what closes it, and quoting
 * is what `safeName` already does for the file half; the only reason this is a
 * second function is that the two halves have different legal shapes.
 */
// `*`, not `+`: the EMPTY job half is legal here. An `unreadable-workflow`
// finding names a file and has no job, so it is constructed as `<file>/`, and
// quoting an empty string turns a clean `evil.yml/: unreadable-workflow` into
// `evil.yml/"": unreadable-workflow`. An empty string can carry no payload,
// which is the whole test this pattern applies.
const JOB_ID = /^[A-Za-z0-9_-]*$/;

export const safeJobId = (id: string): Safe =>
  // Cast scoped to the quoting branch alone, for the reason given on `safeName`.
  JOB_ID.test(id) ? safeText(id) : (JSON.stringify(safeText(id)) as Safe);

/**
 * A `<file>/<job>` key, each half by the helper that constrains it.
 *
 * HERE, NOT IN ONE FENCE, for the reason the whole module exists: the first
 * version of this lived inline in the headroom fence, and the round that added
 * it left four other key-shaped values — two snapshot refusal messages, a
 * generator warning and a generator summary — reaching output through
 * `safeText`, which flattens and clamps but does not QUOTE. A key is the shape
 * this pair renders most often; it gets one implementation.
 *
 * TWO DEFECTS LIVED IN THE INLINE VERSION. (1) With no `/` in the key,
 * `indexOf` returns -1, so `slice(0, -1)` dropped the last character and
 * `slice(0)` re-emitted the whole key — `evil` rendered as `"evi"/evil`.
 * (2) The job half got only `safeText`.
 */
export const safeKey = (key: string): Safe => {
  const cut = key.indexOf('/');
  // A key with no separator is not a `<file>/<job>` pair at all, so it is
  // rendered as ONE constrained name rather than split into two halves, one of
  // which would be empty.
  if (cut < 0) return safeName(key);
  return `${safeName(key.slice(0, cut))}/${safeJobId(key.slice(cut + 1))}` as Safe;
};

/**
 * A snapshot RANGE (`YYYY-MM-DD..YYYY-MM-DD`), constrained like a name.
 *
 * It is read from the committed snapshot with no shape check, a fork may edit
 * that file, and it lands at the END of a `too-tight` line with room to spare —
 * measured rendering `a ci.yml/x: 1 min against 9999 s observed (0.01x, floor
 * 2x`, which reads as a complete finding about another job. `safeText` does not
 * stop that; quoting does, and the shape is narrow enough to check.
 */
const RANGE = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;

export const safeRange = (range: string): Safe =>
  RANGE.test(range) ? safeText(range) : (JSON.stringify(safeText(range)) as Safe);

/** How many findings a renderer emits before the rest are summarised. */
export const MAX_RENDERED_FINDINGS = 20;

/**
 * Cap any list of fork-derived lines.
 *
 * HERE RATHER THAN IN ONE FENCE, because the per-field clamp and this per-LIST
 * clamp are two halves of one contract and they have already come apart twice:
 * go-to-k/cdkd#3272 round 2 capped its findings and left its twins unbounded
 * (measured: 3000 entries, nothing truncated), and when the sanitisers were
 * extracted for go-to-k/cdkd#3283 this half stayed behind, so the new fence
 * shipped a bare `.map`. A fork adding 5,000 keys to the committed snapshot
 * forges no line — every one is sanitised — but it buries the real finding,
 * which is the same harm one layer up.
 */
export const boundedList = (lines: readonly Safe[]): Safe[] =>
  lines.length > MAX_RENDERED_FINDINGS
    ? [
        ...lines.slice(0, MAX_RENDERED_FINDINGS),
        // The only string this function builds itself, and it carries nothing
        // fork-controlled — a subtraction of two lengths.
        `… and ${lines.length - MAX_RENDERED_FINDINGS} more` as Safe,
      ]
    : [...lines];

export const safeName = (name: string): Safe =>
  // The cast is scoped to the quoting branch alone. Spanning the whole ternary
  // would let a future edit return `name` raw from the passing branch and still
  // typecheck — the brand silently switched off at the one site whose job is to
  // be paranoid about names.
  WORKFLOW_NAME.test(name) ? safeText(name) : (JSON.stringify(safeText(name)) as Safe);

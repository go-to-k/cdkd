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
      // BLANK BUT NOT WHITESPACE. `/\s/` does not match these, and each RENDERS
      // as a space — so a fork pads a forged finding with them and it reads as
      // an ordinary line while surviving every check above. Measured on
      // U+2800 and U+3164; the rest of the class is here because enumerating
      // bad shapes one at a time is how this file reached a tenth venue.
      // THE CANONICAL MEMBERS FIRST. An earlier revision of this list reached
      // for U+2800 and U+17B4 — the code points a review had just named — and
      // omitted ZERO WIDTH SPACE and its neighbours, which are the ones an
      // attacker reaches for first and the ones every other tool lists.
      // Measured surviving `flatten` unchanged: U+200B, U+200C, U+200D, U+2060,
      // U+2061, U+2064. JS `\s` covers `\u2000-\u200a`, so it stops one code
      // point short of ZWSP, and the bidi rows added later start at U+200E —
      // the gap was exactly the three in between.
      code === 0x00ad ||
      (code >= 0x206a && code <= 0x206f) ||
      (code >= 0xe0100 && code <= 0xe01ef) ||
      code === 0x034f ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0x200b && code <= 0x200d) ||
      (code >= 0x2060 && code <= 0x2064) ||
      code === 0x115f ||
      code === 0x1160 ||
      code === 0x17b4 ||
      code === 0x17b5 ||
      code === 0x180e ||
      code === 0x2800 ||
      code === 0x3164 ||
      code === 0xffa0 ||
      (code >= 0xfff9 && code <= 0xfffb) ||
      (code >= 0xe0000 && code <= 0xe007f) ||
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
  // `safeText` on BOTH branches, never the raw `id`: a job id of 5,000 legal
  // characters matches `JOB_ID` and would otherwise reach the line unclamped,
  // which is the bound `MAX_FIELD_LENGTH` exists to hold. `safeName` learned
  // this in go-to-k/cdkd#3272 round 2 and has a case for it; this helper was
  // written from `safeName` and inherited the shape without the case.
  //
  // Cast scoped to the quoting branch alone, for the reason given on `safeName`.
  JOB_ID.test(id) ? safeText(id) : quoteClamped(id);

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
  // THE FIRST slash, not the last. A workflow file name cannot contain one and
  // a job id can, so the first is the only split that puts the whole file name
  // in the file half; `lastIndexOf` was a surviving mutant with every case
  // green, and it would hand part of a fork-chosen job id to `safeName`.
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
// BOTH ANCHORS ARE LOAD-BEARING and both were droppable with every case green:
// without `^` a range PREFIXED with a forged finding matches, without `$` one
// SUFFIXED with it does, and either renders unquoted at the end of the line.
// `safeName`'s anchors are pinned from its own round; these were not.
const RANGE = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;

export const safeRange = (range: string): Safe =>
  RANGE.test(range) ? safeText(range) : quoteClamped(range);

/**
 * A free-form DETAIL, always quoted.
 *
 * THE TENTH VENUE, and the last field on its line. `safeText` flattens and
 * clamps, and the round that carried quoting to four other shapes — a name, a
 * job id, a key, a range — did not carry it here, in the same function whose
 * sibling line it edited. For `kind: 'unparseable'` the detail is a YAML
 * parser's own message, which echoes the fork's bytes: measured rendering
 *
 *     zz-evil.yml: unparseable (Unresolved alias ... : ) and ci.yml / check-build-test: no-timeout)
 *
 * where the `)` closes the parenthesis early and the tail reads as a genuine
 * finding against a real critical job.
 *
 * THE SHAPE IS DEFINED BY WHAT A FORGERY NEEDS, not by what a detail is. Every
 * detail this pair generates itself is a `typeof` word, a `safeJson` scalar or
 * a comparison — `object`, `"write-all"`, `2.5`, `360 >= 360` — and none of
 * them needs `:` or `/` or a parenthesis. A forged finding needs all three,
 * because the line it must imitate is `<file> / <job>: <kind> (<detail>)`. So
 * the safe set excludes exactly those, and a detail carrying one is quoted.
 * Unconditional quoting was tried first and is worse: it put quotes around
 * every machine-generated detail this pair emits — fourteen cases changed
 * colour — and none of them could forge anything, which is the noise that gets
 * a rule switched off. (The enumeration above is of SHAPES, not of sites: a
 * `safeJson` of a mapping or an array is reachable too, and is quoted.)
 */
const DETAIL = /^[A-Za-z0-9_"'.,=<> -]*$/;

export const safeDetail = (detail: string): Safe =>
  DETAIL.test(detail) ? safeText(detail) : quoteClamped(detail);

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
/**
 * Which workflow a rendered line belongs to.
 *
 * A QUOTED NAME IS ONE TOKEN, not a prefix. Cutting at the first space, slash
 * or colon works for a bare `a.yml / j: kind`, and merges every quoted name
 * that shares a prefix: `"zz alpha.yml"`, `"zz beta.yml"` and `"zz gamma.yml"`
 * all cut to `"zz`, so two of the three are dropped under one key and the
 * summary cannot name them. It also emits partial tokens like `"ci.yml_`, which
 * breaks the quoting invariant every other value here maintains.
 *
 * So a line that STARTS with a quote is grouped by its whole JSON string,
 * scanned with the escape rule rather than by searching for the next quote.
 * Everything else cuts at the first separator — space, slash and colon, all
 * three load-bearing: without the colon a file takes two shares (the two
 * renderers emit `a.yml / j: kind` and `a.yml: kind`), and without the space a
 * quoted name would split again.
 */
const groupKey = (line: string): string => {
  if (!line.startsWith('"')) {
    // ALL THREE MEMBERS ARE LOAD-BEARING, and an earlier revision of this
    // comment called the SPACE equivalent — measured false. The hardening
    // renderer emits `a.yml / j: kind` with spaces around the slash, so without
    // the space the cut lands on the `/` and yields `a.yml ` WITH A TRAILING
    // SPACE, while its sibling `a.yml: kind` yields `a.yml`: one workflow, two
    // groups, two shares — the very defect the `:` member was added for, plus
    // the partial token this function's own docstring forbids.
    //
    // The label survived a mutation probe because no case mixed the two
    // hardening shapes; the case that pins it now does.
    const cut = line.search(/[ /:]/);
    return cut < 0 ? line : line.slice(0, cut);
  }
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '"') return line.slice(0, i + 1);
  }
  // UNREACHABLE from either renderer, and labelled rather than pinned: every
  // line that starts with `"` starts with `quoteClamped` output, which is
  // `JSON.stringify` output, which always terminates. A case would have to
  // hand-build a line no sanitiser can produce.
  return line;
};

export const boundedList = (lines: readonly Safe[]): Safe[] => {
  if (lines.length <= MAX_RENDERED_FINDINGS) return [...lines];
  // ROUND-ROBIN BY WORKFLOW, not the first 20. Taking a prefix lets ONE file
  // fill the cap, and a fork controls how many findings its own file produces:
  // 25 jobs in an `aaa.yml` bury a genuine `hooks.yml` finding whether the
  // caller sorts by kind or not, because the burial is within the winning kind.
  // Sorting is the caller's business; fair SHARE of the cap is this function's,
  // and it is here so both fences inherit it.
  //
  // The group is the text before the first space or `/` — every line either
  // fence renders begins `<workflow>/...` or `<workflow> / ...`. A line with
  // neither is its own group, which is the safe direction.
  // GROUPS HOLD INDICES, NOT LINES. Two fork job ids long enough to clamp to
  // the same rendered text produce two IDENTICAL lines, and a `Set` of strings
  // cannot tell them apart — so one could be dropped while the group still read
  // as complete. An earlier revision fixed the same defect by swapping an
  // `Array#includes` for a `Set`, and labelled it "by identity", which is not
  // what a `Set<string>` does. Indices are the only thing here that is unique.
  const groups = new Map<string, number[]>();
  for (const [index, line] of lines.entries()) {
    const key = groupKey(line);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [index]);
    else bucket.push(index);
  }
  const keptIndices: number[] = [];
  const queues = [...groups.values()];
  for (let round = 0; keptIndices.length < MAX_RENDERED_FINDINGS; round += 1) {
    let took = false;
    for (const queue of queues) {
      if (keptIndices.length >= MAX_RENDERED_FINDINGS) break;
      const index = queue[round];
      if (index === undefined) continue;
      keptIndices.push(index);
      took = true;
    }
    if (!took) break;
  }
  const keptSet = new Set<number>(keptIndices);
  const kept = keptIndices.map((index) => lines[index] as Safe);
  // NAME WHAT WAS DROPPED ENTIRELY. Round-robin guarantees a SHARE to every
  // group that fits, and a fork controls the NUMBER of groups: 21 fork files
  // with one finding each leave one group with no line at all, and a reader
  // cannot tell a workflow that had nothing to report from one whose report was
  // crowded out. The group names are already `Safe` — they are prefixes of
  // lines this function received — so listing them adds no new venue.
  // PARTIALLY dropped, not only entirely dropped. Naming just the groups with
  // NO kept line misses the case a fork reaches for next: leave the workflow
  // one line and push the interesting one out of its group. Measured — 19 fork
  // files plus three fork-chosen snapshot keys under `hooks.yml` dropped that
  // workflow's `unreadable-workflow` line while `hooks.yml` kept a line, so it
  // was not named and the reader could not learn a real workflow had stopped
  // parsing.
  //
  // CAPPED AT FIVE, and the cap is the point: a fork controls the number of
  // groups, so an uncapped list puts thousands of names on one line — the
  // burial this function exists to stop, achieved through its own summary.
  // STARVED GROUPS FIRST. Widening this filter from "lost every line" to "lost
  // any line" was right, and it silently demoted the case it was named for:
  // `incomplete` is built in insertion order, which is the order the
  // round-robin serves, so a group that got NOTHING is always last and is
  // pushed out of the five names by groups that merely lost a line. Measured —
  // a real `ci.yml` unreadable-workflow finding was dropped from the log AND
  // unnamed, where the narrower filter had named it. Ranking by kept-count
  // ascending puts the ones a reader most needs to know about at the front.
  const incomplete = [...groups.entries()]
    .filter(([, queue]) => !queue.every((index) => keptSet.has(index)))
    .sort(
      (a, b) =>
        a[1].filter((i) => keptSet.has(i)).length - b[1].filter((i) => keptSet.has(i)).length,
    )
    .map(([key]) => key);
  const dropped = `… and ${lines.length - kept.length} more` as Safe;
  return [
    ...kept,
    // The only strings this function builds itself carry nothing
    // fork-controlled beyond those names — a subtraction of two lengths and a
    // join of keys that were already sanitised upstream.
    incomplete.length === 0
      ? dropped
      : (`${dropped} (not all shown for: ${incomplete.slice(0, 5).join(', ')}${
          // `>`, not `>=`: at exactly five the tail would read ", and 0 more".
          incomplete.length > 5 ? `, and ${incomplete.length - 5} more` : ''
        })` as Safe),
  ];
};

/**
 * Quote a string so the result is ALWAYS well-formed JSON and within the cap.
 *
 * ORDER IS THE WHOLE POINT, and getting it wrong is a forgery rather than an
 * aesthetic slip. `JSON.stringify` ESCAPES, so a field clamped after quoting
 * loses its CLOSING QUOTE — the value never terminates, and everything after it
 * on the line reads as part of it. Measured on a `timeout-minutes` string of
 * 120 characters rendering
 *
 *     zz-evil.yml / a: "......ci.yml / check-build-test: no-timeout......…
 *
 * with no closing quote. Clamping BEFORE quoting has the opposite failure: the
 * output is well-formed but can be twice the cap, because each escaped
 * character grows. So the inner text is shrunk until the QUOTED form fits, and
 * the ellipsis goes INSIDE the quotes where it cannot be mistaken for content.
 *
 * Both mistakes were live in this file at once: `safeJson` clamped after
 * quoting, and the first fix for `safeDetail` did the same thing in the round
 * that was correcting it.
 */
export const quoteClamped = (text: string): Safe => {
  const flat = flatten(text);
  const whole = JSON.stringify(flat);
  if (whole.length <= MAX_FIELD_LENGTH) return whole as Safe;
  let inner = flat.slice(0, MAX_FIELD_LENGTH);
  while (inner.length > 0 && JSON.stringify(`${inner}…`).length > MAX_FIELD_LENGTH) {
    inner = inner.slice(0, -1);
  }
  return JSON.stringify(`${inner}…`) as Safe;
};

export const safeName = (name: string): Safe =>
  // NEITHER BRANCH CASTS any more: both call a function that returns `Safe`, so
  // the RETURN ANNOTATION is what refuses a raw `name`. An earlier revision of
  // this comment described a cast "scoped to the quoting branch alone" — true
  // while the branch read `JSON.stringify(safeText(name)) as Safe`, and
  // falsified by the round that replaced it with `quoteClamped`, in that
  // round's own commit.
  WORKFLOW_NAME.test(name) ? safeText(name) : quoteClamped(name);

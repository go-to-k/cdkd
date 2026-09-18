import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

/**
 * Every masked value this resolver RENDERS goes through `displayMasked`.
 *
 * ## The treadmill this replaces
 *
 * go-to-k/cdkd#3408 fixed the same defect class in three consecutive review
 * rounds, each time inside the previous round's fix:
 *
 * | round | what it found |
 * | --- | --- |
 * | 1 | the four `Fn::GetStackOutput` throws rendered a masked name RAW |
 * | 2 | so did the CloudFormation-fallback warn — the DEFAULT path, at DEFAULT verbosity — and the self-reference throw |
 * | 3 | so did the `reresolveCrossStackValue` origin builder and `describeAvailableOutputs` |
 *
 * Each round fixed what it found. The population was **86 render sites** (71
 * interpolations of a `maskSecretsForLog` result, 13 hand-spelled
 * `displaySafe(maskThenStripThenMask(...))` compositions and 2 bare
 * `maskThenStripThenMask` interpolations, measured 2026-09-19 with a
 * comment-stripped scan), and three reviewers between them reached eight.
 * Three rounds finding the same class inside the previous fix is the signal
 * `.claude/skills/work-issues/references/implement.md` names: the INSTRUMENT is
 * wrong, not the fix.
 *
 * ## Why a scanner, and why THIS predicate
 *
 * `maskSecretsForLog` cannot simply strip. Its result is also a COMPARISON —
 * `maskNeedlesForLog(text) !== text` decides whether a twin was registered — so
 * stripping inside it would change what that comparison means everywhere it is
 * used. The two jobs had to separate, and once they did, "which call sites
 * render" became answerable mechanically: **a call interpolated into a template
 * IS a render, by construction.**
 *
 * So the rule is not "remember to strip at display sites". It is "the masker is
 * never interpolated" — a property of the TEXT, checkable over the whole file
 * at once, and one a new site cannot satisfy accidentally. That is the
 * difference between closing a class and enumerating it.
 *
 * Deliberately NOT an allow-list of sites, and not a count of "known raw
 * renders": both are satisfied by the collapse they are supposed to detect. The
 * assertion is that the offending SHAPE has zero instances, plus floors proving
 * the scan reached a file with the population it claims.
 */

const SUBJECT = 'src/deployment/intrinsic-function-resolver.ts';

/**
 * The subject with comments removed.
 *
 * Comment-stripping is load-bearing in BOTH directions here. `displayMasked`'s
 * own doc comment quotes the forbidden shape in prose to explain the rule — so
 * a scanner reading raw text reports its own documentation and the only way to
 * green it is to delete the explanation. And a real offender could be hidden
 * inside a block comment only if the code were commented out, which is not a
 * render at all.
 *
 * Block comments first, then line comments, the same order and the same
 * expressions `tests/unit/state/malformed-resources-bag.test.ts` uses over this
 * very file — deliberately, so two scanners over one subject cannot disagree
 * about what its code IS.
 */
function rawSubject(): string {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  return readFileSync(path.join(repoRoot, SUBJECT), 'utf8');
}

/**
 * Every span {@link subjectCode}'s block-comment expression removes, with a
 * verdict on whether its `/*` was a real opener.
 *
 * `openedFrom` is `'comment'` when only whitespace or a JSDoc continuation
 * `*` precedes the `/` on its line — the shape every genuine block comment in
 * this tree has. Anything else (a quote, a `//`, code) means the span is an
 * accident, and the characters it removed were never comment text.
 *
 * Written over the RAW file rather than over `code`, because the evidence is
 * destroyed by the very strip it is judging: from `code` alone a swallowed
 * region and a region that was never there are the same absence.
 */
function blockCommentSpans(
  raw: string
): { line: number; length: number; prefix: string; openedFrom: 'comment' | 'code' }[] {
  const spans: { line: number; length: number; prefix: string; openedFrom: 'comment' | 'code' }[] =
    [];
  const re = /\/\*[\s\S]*?\*\//g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const lineStart = raw.lastIndexOf('\n', match.index) + 1;
    const prefix = raw.slice(lineStart, match.index);
    spans.push({
      line: raw.slice(0, match.index).split('\n').length,
      length: match[0].length,
      prefix: prefix.trimEnd().slice(-60),
      openedFrom: /^[\s*]*$/.test(prefix) ? 'comment' : 'code',
    });
  }
  return spans;
}

function subjectCode(): string {
  return rawSubject()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the resolver never interpolates a raw masker result (issue #3397 review)', () => {
  const code = subjectCode();

  it('sees a subject of the size and shape it claims to guard', () => {
    // The floor, and the reason it is three assertions rather than one: an
    // emptied read, a stripper that ate the code with the comments, and a
    // renamed helper all produce a clean result from a broken scan, and only a
    // positive claim about the remaining text can tell them from a clean tree.
    expect(code.length, 'the subject read back too small to be the real file').toBeGreaterThan(
      150_000
    );
    expect(code, 'the display builder is gone or renamed').toContain(
      'private displayMasked(value: string, context?: ResolverContext): string'
    );
    expect(code, 'the masker this rule is about is gone or renamed').toContain(
      'private maskSecretsForLog(text: string, context?: ResolverContext): string'
    );

    // The stripper is the one thing above that can fail QUIETLY in the
    // direction that matters. Its block-comment expression is non-greedy over
    // the RAW file, so a `/*` anywhere that is not a real opener — inside a
    // string, a regex literal, or a LINE comment, since block comments are
    // stripped first — opens a span that runs to the next `*/` and takes
    // every render in between out of `code`. The scan then goes green because
    // the offender is no longer in the text being scanned, not because it is
    // no longer in the file.
    //
    // The span is what is asserted, not a size. A RATIO band was written
    // first and MEASURED NOT DISCRIMINATING (2026-09-19): the probe shape —
    // a `/*` on a code line — swallows only to the NEXT `*/`, which in a file
    // this comment-dense is a few hundred characters, moving the ratio from
    // 0.3153 to 0.3132 and leaving the band green. The `>= 88` population
    // floor below does not cover it either: one hidden offender does not move
    // a count of 88.
    //
    // This case found a LIVE instance on its first run, in a comment added by
    // the same change that added the case: a line comment naming a source
    // tree with a trailing glob spells `/*`, and it had swallowed 1,036
    // characters of real code.
    for (const span of blockCommentSpans(rawSubject())) {
      expect(
        span.openedFrom,
        `a '/*' at line ${span.line} is not a comment opener (prefix: ${JSON.stringify(span.prefix)}), ` +
          `so the stripper removed ${span.length} characters the scan then could not see`
      ).toBe('comment');
    }
  });

  it('routes a LARGE population through the builder, so the rule is not vacuous', () => {
    // Measured 2026-09-19 after go-to-k/cdkd#3408 collapsed 71 interpolated
    // `maskSecretsForLog` renders, 13 hand-spelled
    // `displaySafe(maskThenStripThenMask(...))` compositions and 2 bare
    // `maskThenStripThenMask` interpolations into one call: 88 occurrences of
    // `this.displayMasked(`, of which 87 are call sites and one is
    // `displayLeaf`'s own body.
    //
    // A FLOOR rather than an equality: adding a render is ordinary work and
    // must not red. What must red is the population EMPTYING, which is what a
    // revert to per-site spellings looks like from here.
    const rendered = code.match(/this\.displayMasked\(/g) ?? [];
    expect(rendered.length, 'display-builder call sites').toBeGreaterThanOrEqual(88);
  });

  it('has NO interpolation of the raw masker', () => {
    // THE RULE. Every previous round's defect is one instance of this shape,
    // and so is every instance nobody has written yet.
    const offenders = code
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /\$\{\s*this\.maskSecretsForLog\(/.test(text))
      .map(({ line, text }) => `${SUBJECT}:${line}  ${text.trim()}`);

    expect(
      offenders,
      'This interpolates a `maskSecretsForLog` result straight into a message. That helper ' +
        'answers "does this text contain a recorded secret" and makes NO claim about CONTROL ' +
        'CHARACTERS, so the rendered line can carry ESC / CR / U+2028 from a template-supplied ' +
        'name and redraw an operator\'s terminal. Render through `this.displayMasked(value, ' +
        'context)` instead -- it masks, strips, masks again and then `displaySafe`s, and it is ' +
        'in `MASKERS` so the mask-coverage checker still accepts the site. Keep the bare masker ' +
        'only where the result is COMPARED or stored, never where it is interpolated.'
    ).toEqual([]);
  });

  it('has no interpolation of the bare strip-and-mask helper either', () => {
    // The near-miss. `maskThenStripThenMask` is most of the answer and reads
    // like all of it, so a site reaching for it directly is the likeliest way
    // back onto the treadmill -- it omits `displaySafe`, and therefore
    // `U+2028` / `U+2029` and the bidi overrides, which `stripControlChars`
    // does not touch.
    const offenders = code
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /\$\{\s*this\.maskThenStripThenMask\(/.test(text))
      .map(({ line, text }) => `${SUBJECT}:${line}  ${text.trim()}`);

    expect(
      offenders,
      'This interpolates `maskThenStripThenMask` directly, which omits the `displaySafe` pass ' +
        'and so leaves U+2028 / U+2029 and the Trojan-Source bidi overrides. Use ' +
        '`this.displayMasked(value, context)`, which is that composition under one name.'
    ).toEqual([]);
  });

  it('has NO interpolation of the raw LOG-TWIN masker either', () => {
    // THE SECOND ROUTE, and the reason the first rule alone did not close the
    // class. `logTextOfLeaf` resolves a value to its registered twin — a
    // MASKING answer that, like `maskSecretsForLog`'s, says nothing about
    // control characters. Nine interpolations of it built the `origin` strings
    // that flow into `redactedAttributeReads[].display` and out through a
    // `ProvisioningError` message.
    //
    // Two routes needed two names, which is itself the finding: a scanner
    // written against ONE masker would have reported a clean file while this
    // route stayed raw — the same false green the per-site rounds kept getting.
    const offenders = code
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /\$\{\s*this\.logTextOfLeaf\(/.test(text))
      .map(({ line, text }) => `${SUBJECT}:${line}  ${text.trim()}`);

    expect(
      offenders,
      'This interpolates a `logTextOfLeaf` result straight into a message. Use ' +
        '`this.displayLeaf(value, context)`, which is that call under `displayMasked`.'
    ).toEqual([]);
  });

  it('masks list ENTRIES through the builder, not one call away from the render', () => {
    // The shape that defeats BOTH rules above: `describeAvailableOutputs` masked
    // each key inside a `.map(...)` callback and returned the joined string, so
    // the interpolation its callers write contains no masker call at all. It was
    // round 3's second blocker, and a line-shaped scanner cannot see it —
    // pinning the builder's own body is what covers it.
    expect(
      code,
      'the available-outputs list builder stopped rendering through `displayMasked`, so its ' +
        "callers interpolate producer-supplied output names that are masked but not stripped"
    ).toMatch(/shown\.map\(\(k\) => this\.displayMasked\(k, context\)\)/);
  });

  it('keeps the builder DELEGATING, so listing it in MASKERS stays true', () => {
    // Guard-the-guard, and it guards a SECURITY decision: `displayMasked` is in
    // `MASKERS` in `scripts/check-resolver-mask-coverage.ts`, i.e. that checker
    // treats a site using it as masked and asks nothing further. That is only
    // sound while the body actually masks. Re-pointing it at `displaySafe`
    // alone would silently downgrade all 84 sites from masked to merely
    // control-stripped, and BOTH scanners would stay green.
    expect(code).toMatch(
      /private displayMasked\([^)]*\): string \{\s*return displaySafe\(this\.maskThenStripThenMask\(value, context\)\);\s*\}/
    );
    // ...and its log-twin sibling, which is in `MASKERS` on the strength of
    // DELEGATING to it. Re-pointing this one at `logTextOfLeaf` alone would
    // drop the strip and the `displaySafe` pass from all nine `origin` sites
    // while both scanners stayed green.
    expect(code).toMatch(
      /private displayLeaf\([^)]*\): string \{\s*return this\.displayMasked\(this\.logTextOfLeaf\(value, context\), context\);\s*\}/
    );
  });
});

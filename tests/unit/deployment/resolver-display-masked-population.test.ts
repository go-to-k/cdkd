import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';
import ts from 'typescript-v6';

/**
 * Functions that return a MASKING ANSWER and nothing more — masked text that is
 * NOT safe to put on a terminal.
 *
 * INLINED here in go-to-k/cdkd#3435, from
 * `scripts/check-resolver-mask-coverage.ts`, which that change DELETED. This
 * file was its only importer outside the checker's own suite, and importing a
 * security-relevant list across a file the repo has decided to stop carrying is
 * the kind of coupling that makes a deletion expensive. The list is data, not
 * machinery — sixteen method names — so it travels with the rule that reads it.
 *
 * WHY THESE, and the rule for adding one: each returns text whose SECRETS have
 * been removed and whose CONTROL CHARACTERS have not. A render reaching one
 * directly is the defect go-to-k/cdkd#3397 / #3408 / #3426 chased through four
 * review rounds; the remedy is always `displayMasked` / `displayLeaf`. The
 * earlier enumeration missed five of these (`regionLogText`,
 * `straddleSafeTwin`, `productLogTwin`, `logTwinOfProduct`,
 * `resolveDynamicReferencesWithLogTwin`), each found by measurement rather than
 * by reading — so a NEW private method returning masked-but-unstripped text
 * belongs here, and the floor below is what stops the list quietly emptying.
 */
const RAW_MASKERS = [
  'maskSecretsRaw',
  'maskNeedlesForLog',
  'maskThenStripThenMask',
  'registeredLogTwin',
  'logTextOfLeaf',
  'logTwinText',
  'nameLogText',
  'outputNameLogText',
  'maskSecretsInText',
  'regionLogText',
  'straddleSafeTwin',
  'productLogTwin',
  'splitLogTwins',
  'dynamicReferenceNameLogText',
  'logTwinOfProduct',
  'resolveDynamicReferencesWithLogTwin',
] as const;

/**
 * Every masked value this resolver RENDERS goes through `displayMasked`, and
 * the masking machinery has no OTHER exit.
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
 *
 * ROUND FOUR's answer was the display builder plus a scanner forbidding
 * `${this.maskSecretsForLog(...)}` — and round four's own reviewers showed the
 * class had MOVED rather than ended, to the BINDING:
 *
 *     const loggedExportName = this.maskSecretsForLog(exportName, context);
 *     ...
 *     this.logger.warn(`Exports index lookup failed for '${loggedExportName}': ...`);
 *
 * which a line-shaped scanner cannot see. Ten of those existed and one was a
 * LIVE exposure (go-to-k/cdkd#3426).
 *
 * ## Why THIS file no longer carries the rule
 *
 * A line-shaped scanner with one more pattern is the same instrument that had
 * already missed the class four times. The rule now lives where identifier
 * RESOLUTION already lived: the AST mask-coverage checker walked the
 * AST, resolves an interpolated identifier to its declaration and judges the
 * initializer, and its `MASKERS` list means "masks AND sanitizes" since
 * go-to-k/cdkd#3426 — so a binding of a bare masker is a finding wherever it is
 * interpolated, by construction rather than by spelling.
 *
 * What is left here is the half that walk cannot state: the CONTAINMENT of the
 * unsafe helpers (a property of the file's structure, not of any render site),
 * the builder bodies the checker's `MASKERS` entries are trusted on, and the
 * population floor that proves the builder is still the file's render route.
 */

const SUBJECT = 'src/deployment/intrinsic-function-resolver.ts';

/**
 * The subject with comments removed.
 *
 * Comment-stripping is load-bearing in BOTH directions here. The doc comments
 * quote the forbidden shapes in prose to explain the rules — so a scanner
 * reading raw text reports its own documentation and the only way to green it
 * is to delete the explanation. And a real offender could be hidden inside a
 * block comment only if the code were commented out, which is not a render at
 * all.
 *
 * Block comments first, then line comments, the same order and the same
 * expressions `tests/unit/state/malformed-resources-bag.test.ts` uses over this
 * very file — deliberately, so two scanners over one subject cannot disagree
 * about what its code IS. The ORDER is unsound in general (a `/` + `*` inside a
 * line comment opens a span that runs to the next close marker), which is why
 * the case below asserts that no such span exists rather than trusting the
 * strip, and why every rule that needs real structure uses the parser instead.
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
  return (
    rawSubject()
      // NEWLINES KEPT, content blanked. The first cut deleted the span whole,
      // which shifted every line number after it — the line rules below then
      // reported an offender at a line 2,941 rows away from the real one
      // (measured, go-to-k/cdkd#3426 review round 3), pointing the next reader
      // at unrelated code. The offending TEXT was right and the citation was
      // not, which is the worse failure of the two.
      .replace(/\/\*[\s\S]*?\*\//g, (span) => '\n'.repeat((span.match(/\n/g) ?? []).length))
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  );
}

/**
 * Every reference to `name` in the subject, paired with the method that
 * ENCLOSES it — the parser's answer, so a mention in a comment or a string is
 * not one and a wrapped call is still one.
 *
 * The declaration itself is excluded: what the containment rules are about is
 * who may CALL these, not that they exist.
 *
 * KNOWN BOUND, recorded rather than closed (go-to-k/cdkd#3426 review): this
 * matches an IDENTIFIER, so a COMPUTED member access —
 * `(this as any)['maskSecretsRaw'](v, c)` — is invisible to it, as it is to the
 * mask-coverage checker's `calleeName`. That spelling appears nowhere in this
 * repo and cannot be reached accidentally: it takes an `as any` cast and a
 * string key to write, which is a deliberate act of routing around a fence
 * rather than an edit someone makes by habit. Modelling it would mean
 * resolving string keys through the whole file, which buys nothing against an
 * author who has already decided to bypass the rule.
 */
function referencesByEnclosingMethod(name: string): { line: number; method: string }[] {
  const src = ts.createSourceFile(SUBJECT, rawSubject(), ts.ScriptTarget.ES2022, true);
  const diagnostics =
    (src as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  // A partial tree drops references silently, which is a GREEN containment
  // result over a file nobody read — the collapse every rule below depends on
  // not happening.
  expect(diagnostics.length, 'the subject does not parse; every rule below is vacuous').toBe(0);

  const out: { line: number; method: string }[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const isDeclarationName =
        (ts.isMethodDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent)) &&
        node.parent.name === node;
      if (!isDeclarationName) {
        let p: ts.Node | undefined = node.parent;
        let method = '<module scope>';
        while (p) {
          if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) {
            method = p.name.text;
            break;
          }
          if (ts.isFunctionDeclaration(p) && p.name) {
            method = p.name.text;
            break;
          }
          p = p.parent;
        }
        out.push({ line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, method });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(src);
  return out;
}

describe('the resolver has ONE exit from the masking machinery (go-to-k/cdkd#3426)', () => {
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
    expect(code, 'the bare masker this rule is about is gone or renamed').toContain(
      'private maskSecretsRaw(text: string, context?: ResolverContext): string'
    );
    // The name the class was closed by DELETING. Its own comment records why
    // ("for log" read as "log-ready"), and a merge restoring it would restore a
    // masker callable from a render site with nothing structural to stop it.
    expect(code, 'the pre-go-to-k/cdkd#3426 masker name is back').not.toContain(
      'private maskSecretsForLog('
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
    // 0.3153 to 0.3132 and leaving the band green. The population floor below
    // does not cover it either: one hidden offender does not move a count of 88.
    //
    // This case found a LIVE instance on its first run, in a comment added by
    // the same change that added the case: a line comment naming a source
    // tree with a trailing glob spells a block-comment opener, and it had
    // swallowed 1,036 characters of real code.
    for (const span of blockCommentSpans(rawSubject())) {
      expect(
        span.openedFrom,
        `a block-comment opener at line ${span.line} is not one (prefix: ${JSON.stringify(span.prefix)}), ` +
          `so the stripper removed ${span.length} characters the scan then could not see`
      ).toBe('comment');
    }
  });

  it('routes a LARGE population through the builder, so the rule is not vacuous', () => {
    // Measured 2026-09-19 after go-to-k/cdkd#3408 collapsed 71 interpolated
    // masker renders, 13 hand-spelled `displaySafe(maskThenStripThenMask(...))`
    // compositions and 2 bare `maskThenStripThenMask` interpolations into one
    // call: 88 occurrences. go-to-k/cdkd#3426 then moved the old
    // `maskSecretsForLog`'s 20 remaining call sites onto the same builder.
    //
    // A FLOOR rather than an equality: adding a render is ordinary work and
    // must not red. What must red is the population EMPTYING, which is what a
    // revert to per-site spellings looks like from here.
    const rendered = code.match(/this\.displayMasked\(/g) ?? [];
    expect(rendered.length, 'display-builder call sites').toBeGreaterThanOrEqual(107);
  });

  it('CONTAINS the bare masker: only the strip-and-mask helper may call it', () => {
    // THE RULE, and the reason it is a containment claim rather than a render
    // rule: a render rule can only watch the sites that exist today, while this
    // says there is no way to OBTAIN unsanitized masked text outside one
    // three-line helper. A new binding cannot be written; the name is not
    // reachable.
    //
    // Judged by the PARSER, so a prose mention in the doc comments (there are
    // several, explaining exactly this) is not a reference.
    const refs = referencesByEnclosingMethod('maskSecretsRaw');
    expect(
      refs
        .filter((r) => r.method !== 'maskThenStripThenMask')
        .map((r) => `${SUBJECT}:${r.line} in ${r.method}`),
      'a call to the bare masker escaped `maskThenStripThenMask`. Its result is masked but NOT ' +
        'control-stripped, so rendering it anywhere lets a template-supplied name carry ESC / CR / ' +
        'U+2028 to a terminal (go-to-k/cdkd#3426). Use `this.displayMasked(value, context)`.'
    ).toEqual([]);
    // ...and the helper really does call it, twice — mask, strip, mask. A
    // containment rule is satisfied by a name nobody calls at all, which is
    // the same absence as the helper having been gutted.
    expect(refs.length, 'the bare masker is called nowhere; the composition was gutted').toBe(2);
  });

  it('CONTAINS the strip-and-mask helper: only the builder may call it', () => {
    // The near-miss, and the second half of the same property.
    // `maskThenStripThenMask` is most of the answer and reads like all of it —
    // it omits `displaySafe`, and therefore `U+2028` / `U+2029` and the
    // Trojan-Source bidi overrides — so a site reaching for it directly is the
    // likeliest way back onto the treadmill.
    const refs = referencesByEnclosingMethod('maskThenStripThenMask');
    expect(
      refs
        .filter((r) => r.method !== 'displayMasked')
        .map((r) => `${SUBJECT}:${r.line} in ${r.method}`),
      'a call to `maskThenStripThenMask` escaped `displayMasked`. It strips control characters but ' +
        'does NOT run `displaySafe`, so U+2028 / U+2029 and the bidi overrides survive. Use ' +
        '`this.displayMasked(value, context)`, which is that composition plus the sanitizer.'
    ).toEqual([]);
    expect(refs.length, 'the builder no longer composes the strip-and-mask helper').toBe(1);
  });

  it('has NO interpolation of a raw masker, whatever encloses it', () => {
    // THE LINE RULES, kept alongside the containment ones and NOT redundant
    // with them. Containment says who may CALL the two contained helpers; this
    // says no render may interpolate a masking answer directly — including the
    // OTHER raw maskers, which are not contained because the file needs them
    // (`logTextOfLeaf` resolves a twin, `nameLogText` a dynamic-reference
    // name).
    //
    // They also cover what go-to-k/cdkd#3426's review WITHDREW: the checker's
    // taint walk no longer follows a value through a callback, a literal, a
    // spread or an `await`, because every one of those arms drew a defect. A
    // line rule cannot see those shapes either — but it does see the direct
    // interpolation, which is the spelling a site reverts to, and it has no
    // dataflow model to get wrong.
    //
    // The name list is IMPORTED rather than spelled here, so the two fences
    // cannot disagree about what a raw masker is: review round 3 found the
    // regex naming five of the entries while the comment beside it claimed a
    // sixth. A floor guards the import — an emptied list would make the rule
    // vacuous rather than red.
    const offenders = code
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => new RegExp(`\\$\\{\\s*this\\.(${[...RAW_MASKERS].join('|')})\\(`).test(text))
      .map(({ line, text }) => `${SUBJECT}:${line}  ${text.trim()}`);

    expect(
      RAW_MASKERS.length,
      'the name list is empty, so this rule scans for nothing'
    ).toBeGreaterThanOrEqual(14);
    expect(
      offenders,
      'This interpolates a masking ANSWER straight into a message. Those helpers answer "does this ' +
        'text contain a recorded secret" and make NO claim about CONTROL CHARACTERS, so the ' +
        'rendered line can carry ESC / CR / U+2028 from a template-supplied name and redraw an ' +
        "operator's terminal. Render through `this.displayMasked(value, context)` -- or " +
        '`this.displayLeaf(value, context)` for a log-twin leaf.'
    ).toEqual([]);
  });

  it('masks list ENTRIES through the builder, not one call away from the render', () => {
    // The shape that defeats a render rule: `describeAvailableOutputs` masked
    // each key inside a `.map(...)` callback and returned the joined string, so
    // the interpolation its callers write contains no masker call at all. It was
    // round 3's second blocker, and pinning the builder's own body is what
    // covers it.
    expect(
      code,
      'the available-outputs list builder stopped rendering through `displayMasked`, so its ' +
        'callers interpolate producer-supplied output names that are masked but not stripped'
    ).toMatch(/shown\.map\(\(k\) => this\.displayMasked\(k, context\)\)/);
  });

  it('keeps the builders DELEGATING, so listing them in MASKERS stays true', () => {
    // Guard-the-guard, and it guards a SECURITY decision: `displayMasked` is in
    // the deleted checker's `MASKERS` list, i.e. that checker
    // treats a site using it as masked AND sanitized, and asks nothing further.
    // That is only sound while the body actually does both. Re-pointing it at
    // `displaySafe` alone would silently downgrade every site from masked to
    // merely sanitized, and both scanners would stay green.
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
    // The THIRD `MASKERS` entry with a body in this file, and the one a sweep
    // would forget: `maskInherited` masks against the inherited bag alone and
    // sanitizes in its own closure, since it cannot reach the builder's
    // context-shaped masker. Dropping either half leaves its three parameter
    // debug lines rendering a template-supplied VALUE raw.
    expect(code).toMatch(/return displaySafe\(mask\(stripControlChars\(mask\(text\)\)\)\);/);
  });
});

/**
 * `cdkd scrub`'s abandoned-scan counter is a CONJUNCTION, and this file fences
 * the half that says WHERE the throw came from (issue go-to-k/cdkd#3160).
 *
 * The counter reached its shipped shape after being wrong in BOTH directions,
 * one review round each, so both mistakes are pinned here rather than described:
 *
 *  - Round 1 keyed on the resolver's own `Dynamic reference: ` prose and so
 *    missed every RAW SDK rejection. `GetParameter` / `GetSecretValue` go
 *    through `sendWithThrottleRetry`, which rethrows verbatim, so a genuinely
 *    deleted parameter arrives as `ParameterNotFound` — the issue's headline
 *    repro — and went uncounted.
 *  - Round 2 dropped the error entirely and asked only whether the bag carried
 *    a `{{resolve:...}}`. That counted the ORDINARY failure the catch exists
 *    for: `scrubStack` catches `resolveParameters` wholesale and continues with
 *    an EMPTY parameter bag, so ONE `Default`-less parameter makes every
 *    `{Ref: <param>}` in the stack throw, and any resource whose properties
 *    also hold a secret reference reddened `--dry-run --fail` — the documented
 *    standing CI gate — on a healthy stack, unclearable by the operator.
 *
 * The excluded set is cdkd-AUTHORED prose, which is what makes matching it
 * sound: those strings are built in `intrinsic-function-resolver.ts`, so they
 * change only when this repo changes them, and the cases below red when one
 * does. The INCLUDED set is left unnamed because it is AWS's — naming it is
 * what round 1 got wrong, and a name AWS adds later would silently rejoin the
 * false-clean population the issue is about.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const scrubSource = readFileSync(
  fileURLToPath(new URL('../../../src/cli/commands/scrub.ts', import.meta.url)),
  'utf8'
);
const resolverSource = readFileSync(
  fileURLToPath(new URL('../../../src/deployment/intrinsic-function-resolver.ts', import.meta.url)),
  'utf8'
);

/**
 * The patterns as the shipped module spells them, read out of the source rather
 * than restated. A copy here would agree with the module until someone edited
 * one of them, which is the failure this file exists to catch.
 */
function shippedPatterns(): RegExp[] {
  const block = scrubSource.match(
    /const TEMPLATE_SHAPE_FAILURE_PATTERNS = \[([\s\S]*?)\] as const;/
  );
  expect(block, 'TEMPLATE_SHAPE_FAILURE_PATTERNS was renamed or removed').not.toBeNull();
  const literals = [...block![1]!.matchAll(/^\s*\/(.+)\/,\s*$/gm)].map((m) => m[1]!);
  // EQUALITY with the block's own entry count, not a `>= 2` floor. A floor is
  // satisfied while a THIRD pattern — added later, or reformatted onto two
  // lines, or given a flag (`/x/i,`) this regex cannot match — is silently
  // dropped, and every `.some()` below then answers about a smaller set than
  // ships. Vacuity in that direction reads as "nothing is excluded", which is
  // the round-2 bug certified green.
  const entries = block![1]!
    .split('\n')
    .filter((line) => line.includes('/')).length;
  expect(
    literals.length,
    `parsed ${literals.length} pattern literals out of ${entries} entries in ` +
      'TEMPLATE_SHAPE_FAILURE_PATTERNS. An entry this parser cannot read is an exclusion ' +
      'this suite never checks.'
  ).toBe(entries);
  expect(entries, 'the constant is empty — nothing is excluded').toBeGreaterThanOrEqual(2);
  return literals.map((l) => new RegExp(l));
}

const excluded = (message: string): boolean => shippedPatterns().some((p) => p.test(message));

describe('scrub abandoned-scan origin (go-to-k/cdkd#3160)', () => {
  describe('cdkd-authored template-shape failures are EXCLUDED', () => {
    // Each case pairs the message with the resolver site that builds it. The
    // second assertion is what keeps the pair honest: a message the resolver
    // no longer produces would still satisfy the first one forever.
    const OWNED: ReadonlyArray<readonly [string, string, string]> = [
      // Third element is the THROW EXPRESSION, not the message text. That
      // distinction is the whole value of the second assertion: `Ref ${logicalId}
      // not found` is ALSO a substring of the resolver's LOG line one branch
      // above the throw, so a needle of just the message stays green after the
      // throw alone is reworded — leaving the pattern matching nothing anyone
      // raises, ordinary `Ref` failures counted again, and the round-2
      // regression certified green.
      [
        'a Ref to something not in state',
        'Ref MyBucket not found',
        // The interpolated NAME moved to a sanitized binding in
        // go-to-k/cdkd#3426 (`loggedLogicalId = this.displayMasked(logicalId,
        // context)`). The message TEMPLATE is unchanged, but what the pattern
        // MATCHES is not: the builder strips control characters and trims, so
        // an id carrying a CR or padding now produces a message this pattern
        // accepts where it did not before — the classification delta the case
        // below pins. Re-pinned rather than loosened: a needle that stopped
        // naming the binding would go green on the next reword too.
        'throw markNonRetryable(new Error(`Ref ${loggedLogicalId} not found`))',
      ],
      [
        'a Fn::GetAtt to a resource not in state',
        'Resource MyBucket not found for Fn::GetAtt',
        // The interpolated NAME moved to the display builder in
        // go-to-k/cdkd#3432, the same change the `Ref` sibling took one issue
        // earlier and with the same consequence for this pattern -- pinned by
        // the classification-delta case below. The statement is wrapped across
        // lines in the source, so the needle is the EXPRESSION rather than the
        // whole `throw`: a whitespace-exact match on a multi-line statement is
        // a needle that reds on a reformat and says nothing about behaviour.
        '`Resource ${this.displayMasked(logicalId, context)} not found for Fn::GetAtt`',
      ],
      [
        'a parameter with no Default and no supplied value',
        'Parameter DbName is required but no value was provided and no default exists',
        // Sanitized in go-to-k/cdkd#3432's review rounds, for the reason its two
        // siblings above were: a `Parameters` KEY is arbitrary JSON, and a
        // reviewer MEASURED a raw ESC + CR reaching this throw. The
        // classification delta is the same one, pinned below.
        //
        // `maskInherited`, not `displayMasked`: round 2 corrected the site to
        // the pass this method already defines and its five sibling debug lines
        // already take -- mask against the INHERITED bag, strip, mask, then
        // `displaySafe`. The needle names it so a swap back to a weaker pass
        // reds here rather than only in the behavioural suite.
        '`Parameter ${maskInherited(name)} is required but no value was provided and no default exists`',
      ],
    ];

    for (const [label, message, resolverSpelling] of OWNED) {
      it(`excludes ${label}`, () => {
        expect(
          excluded(message),
          `"${message}" is cdkd's own refusal to resolve a template SHAPE, not a failure to ` +
            'fetch a dynamic reference. Counting it reds `--dry-run --fail` on a healthy stack.'
        ).toBe(true);
      });

      it(`and the resolver still THROWS the message behind ${label}`, () => {
        const needle = resolverSpelling.replace(/^`|`$/g, '');
        expect(
          resolverSource.includes(needle),
          `intrinsic-function-resolver.ts no longer builds "${needle}". The exclusion above is ` +
            'now matching a string nothing raises, so the real throw for this case is being ' +
            'COUNTED again. Re-derive the pattern from the current throw site.'
        ).toBe(true);
      });
    }

    it('a HOSTILE or PADDED logical id now takes the same exclusion — the go-to-k/cdkd#3426 delta', () => {
      // A CLASSIFICATION CHANGE, pinned because it moves a unit across the exit
      // code: `count` gates `cdkd scrub --dry-run --fail`, `warn` does not.
      //
      // Before go-to-k/cdkd#3426 the resolver interpolated the RAW logical id,
      // so an id carrying a CR produced `Ref Prod\rEvil not found`, which
      // `^Ref \S+ not found$` cannot match (`\s` includes CR) — the unit was
      // COUNTED. The id now renders through the display builder, which deletes
      // the control character and trims, so the message matches and the unit
      // WARNS, exactly as a plain dangling `Ref` already did.
      //
      // Both spellings are asserted, and that is the point: the pair states the
      // delta rather than the endpoint, so a future change that restores the
      // raw spelling reds here instead of silently moving the gate back.
      const ESC = String.fromCharCode(0x1b);
      expect(
        excluded(`Ref Prod${ESC}[2K\rEvil not found`),
        'the PRE-sanitization spelling: whitespace in the id keeps it out of the pattern'
      ).toBe(false);
      expect(
        excluded('Ref Prod[2KEvil not found'),
        'the spelling the sanitized render actually produces — now excluded, i.e. WARN not COUNT'
      ).toBe(true);
      // A PADDED id reaches the same place through `displaySafe`'s trim.
      expect(excluded('Ref   Padded   not found'), 'padded, as raised before the trim').toBe(false);
      expect(excluded('Ref Padded not found'), 'padded, as the builder renders it').toBe(true);
    });

    it('a HOSTILE or PADDED logical id takes the Fn::GetAtt exclusion too — the go-to-k/cdkd#3432 delta', () => {
      // The `Ref` case above, one pattern over. go-to-k/cdkd#3432 routed
      // `Resource <id> not found for Fn::GetAtt` through the same builder, so
      // the same units move `count` -> `warn` here.
      //
      // Written as its OWN case rather than folded into the one above, because
      // the two patterns are independent: a change to either renderer must red
      // the case for THAT pattern and leave the other green, which a merged
      // case with a shared `.some()` cannot report.
      const ESC = String.fromCharCode(0x1b);
      expect(
        excluded(`Resource Prod${ESC}[2K\rEvil not found for Fn::GetAtt`),
        'the PRE-sanitization spelling: whitespace in the id keeps it out of the pattern'
      ).toBe(false);
      expect(
        excluded('Resource Prod[2KEvil not found for Fn::GetAtt'),
        'the spelling the sanitized render actually produces — now excluded, i.e. WARN not COUNT'
      ).toBe(true);
      expect(
        excluded('Resource   Padded   not found for Fn::GetAtt'),
        'padded, as raised before the trim'
      ).toBe(false);
      expect(
        excluded('Resource Padded not found for Fn::GetAtt'),
        'padded, as the builder renders it'
      ).toBe(true);
    });

    it("and the Fn::GetAtt spelling is the RESOLVER's own, not one this test assumed", async () => {
      // The `Ref` twin below states why a hand-written spelling is not enough:
      // the strip-before-sanitize ORDER inside the builder decides whether a CR
      // vanishes or becomes a space, and only the real throw can answer that.
      const ESC = String.fromCharCode(0x1b);
      const template: CloudFormationTemplate = { Resources: {} };
      const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      const err = await resolver
        .resolve({ 'Fn::GetAtt': [`Prod${ESC}[2K\rEvil`, 'Arn'] }, { template, resources: {} })
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      const message = err instanceof Error ? err.message : String(err ?? '');

      // BOUND THE ARM before asserting its exclusion.
      expect(message, 'the Fn::GetAtt refusal did not fire').toMatch(
        /^Resource .* not found for Fn::GetAtt$/
      );
      expect(message, 'a raw ESC survived into the thrown message').not.toContain(ESC);
      expect(excluded(message), 'the message the resolver really raises is the excluded one').toBe(
        true
      );
    });

    it('a HOSTILE or PADDED parameter name takes the third exclusion too', () => {
      // The third pattern, swept in by go-to-k/cdkd#3432's review round. Its own
      // case for the same reason the other two have theirs: the three renderers
      // are independent, and a merged case with a shared `.some()` cannot report
      // which one regressed.
      const ESC = String.fromCharCode(0x1b);
      expect(
        excluded(`Parameter Prod${ESC}[2K\rEvil is required but no value was provided`),
        'the PRE-sanitization spelling: whitespace in the name keeps it out of the pattern'
      ).toBe(false);
      expect(
        excluded('Parameter Prod[2KEvil is required but no value was provided'),
        'the spelling the sanitized render actually produces — now excluded, i.e. WARN not COUNT'
      ).toBe(true);
      expect(
        excluded('Parameter   Padded   is required but no value was provided'),
        'padded, as raised before the trim'
      ).toBe(false);
      expect(
        excluded('Parameter Padded is required but no value was provided'),
        'padded, as the builder renders it'
      ).toBe(true);
    });

    it("and the spelling is the RESOLVER's own, not one this test assumed", async () => {
      // The case above feeds hand-written strings to the shipped patterns,
      // which pins the CLASSIFIER and assumes the renderer. That assumption is
      // exactly what `displayMasked`'s composition order decides: it strips
      // (DELETES) before it sanitizes (REPLACES), so a CR vanishes rather than
      // becoming a space. Flip that order and `Ref Prod [2K Evil not found`
      // stops matching `\\S+`, the gate delta silently reverses, and the case
      // above stays green because it never asked the resolver anything.
      //
      // So this one drives the real throw and feeds ITS message to the shipped
      // predicate (go-to-k/cdkd#3426 review round 2, test m9).
      const ESC = String.fromCharCode(0x1b);
      const template: CloudFormationTemplate = { Resources: {} };
      const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      // Through the PUBLIC entry point, so no test-only seam exists in `src/`
      // and the message is the one a deploy would raise.
      const err = await resolver
        .resolve({ Ref: `Prod${ESC}[2K\rEvil` }, { template, resources: {} })
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      const message = err instanceof Error ? err.message : String(err ?? '');

      // BOUND THE ARM: the refusal must be the `Ref ... not found` one.
      expect(message, 'the Ref refusal did not fire').toMatch(/^Ref .* not found$/);
      expect(message, 'a raw ESC survived into the thrown message').not.toContain(ESC);
      expect(excluded(message), 'the message the resolver really raises is the excluded one').toBe(
        true
      );
    });
  });

  describe('AWS-authored rejections are NOT excluded', () => {
    // `ParameterNotFound` is the one that matters most, and it is the reason
    // the patterns are anchored: a loose `'Parameter '` substring test matches
    // BOTH it and cdkd's own parameter refusal, and would have excluded this
    // issue's headline repro while every test written for it still passed.
    const FOREIGN: ReadonlyArray<readonly [string, string]> = [
      ['ParameterNotFound', 'Parameter /deleted not found.'],
      ['ResourceNotFoundException', "Secrets Manager can't find the specified secret."],
      [
        'AccessDeniedException',
        'User is not authorized to perform secretsmanager:GetSecretValue',
      ],
      [
        'InvalidRequestException',
        "You can't perform this operation on the secret because it was marked for deletion.",
      ],
      ['DecryptionFailure', 'Secrets Manager cannot decrypt the protected secret text.'],
      ['the resolver ssm-secure refusal', 'Refusing to resolve ssm-secure against a String parameter'],
      [
        'the resolver 200-with-no-Value prose',
        "Dynamic reference: SSM parameter '/p' not found or has no value",
      ],
    ];

    for (const [label, message] of FOREIGN) {
      it(`counts ${label}`, () => {
        expect(
          excluded(message),
          `"${message}" was EXCLUDED. It is a failure to fetch a reference, so the leaf's ` +
            'remaining tokens recorded no needle and a plaintext behind them would survive ' +
            'under `No plaintext secrets found`, exit 0.'
        ).toBe(false);
      });
    }
  });

  it('is a CONJUNCTION — position alone does not count', () => {
    // Guards the WIRING, not the predicate: a call site that dropped `err`
    // would compile (the parameter is `unknown`) and silently restore round 2.
    const calls = [...scrubSource.matchAll(/abandonedScanVerdict\(([^)]*)\)/g)]
      .map((m) => m[1]!)
      .filter((args) => !args.includes(':')); // skip the declaration
    expect(calls.length, 'no call sites found — the counter was renamed').toBe(4);
    for (const args of calls) {
      expect(
        args.split(',').length,
        `a call site passes only \`${args}\`. Without the error the verdict is positional ` +
          'again, and an ordinary `Ref` failure over a secret-bearing bag reds the CI gate.'
      ).toBe(2);
    }
  });

  it('decides SILENCE on reference PRESENCE alone, never on fetchability', () => {
    // Round 5's near-miss, pinned on the SOURCE because it is an ORDERING
    // property of three tests and no single behavioural case exhibits an order.
    // (The per-site visibility this replaces is covered behaviourally in
    // `scrub-malformed-and-nameless.test.ts`, which asserts all four subjects
    // on the non-gating arm -- a source grep there reds on a legitimate
    // extract-a-helper refactor AND stays green if a site's `logger.warn` is
    // deleted while its `if` survives.)
    //
    // An earlier cut asked `carriesFetchableDynamicReference` FIRST and
    // returned `silent` on a miss, turning a gate-DOWNGRADE test into a
    // universal silencer. The token pattern's inner class is `[^}]`, so a
    // placeholder anywhere in a token fails that test -- including the dominant
    // CDK spelling, where the reference is assembled by `Fn::Sub` over
    // parameters that DO have defaults. go-to-k/cdkd#3160's own headline repro
    // then printed nothing at all.
    const body = scrubSource.match(
      /function abandonedScanVerdict\([^)]*\): [^{]*\{([\s\S]*?)\n\}/
    );
    expect(body, 'abandonedScanVerdict was renamed or reshaped').not.toBeNull();
    const lines = body![1]!
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const silent = lines.find((l) => l.includes("return 'silent'"));
    expect(silent, "no `return 'silent'` arm").toBeDefined();
    expect(
      silent,
      'the silence decision consults something other than `carriesDynamicReference`. Only ' +
        '"did this bag hold a reference at all" may decide SILENCE -- fetchability and the ' +
        'error class decide the EXIT CODE, and using either to silence hides the abandoned ' +
        'scan entirely (go-to-k/cdkd#3178 round 5).'
    ).toContain('!carriesDynamicReference(source)');
    expect(silent, 'fetchability is deciding silence again').not.toContain('Fetchable');
  });

  it('applies the SAME silence rule to the per-unit verdict', () => {
    // `abandonedUnitVerdict` (issue go-to-k/cdkd#3181) is the twin of the
    // function above, and since that PR it is the one on the PRIMARY path:
    // every opted-in pass reaches it, and the function above now runs only
    // when the resolve threw for a reason the recovery does not catch. So the
    // round-5 near-miss this file exists for is live again on a new function,
    // and was unfenced -- measured: flipping its first two lines to
    // `if (!entry.carriedFetchableReference) return 'silent'` reds nothing.
    //
    // Same assertion, on the twin's own evidence source: the booleans are
    // per-unit rather than per-bag, but which QUESTION may decide silence is
    // unchanged.
    const body = scrubSource.match(
      /function abandonedUnitVerdict\([^)]*\): [^{]*\{([\s\S]*?)\n\}/
    );
    expect(body, 'abandonedUnitVerdict was renamed or reshaped').not.toBeNull();
    const lines = body![1]!
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // EVERY silent arm, not `find`'s first. A second silence condition added
    // later is exactly the regression this file exists to catch, and a
    // first-match read would not see it.
    const silentArms = lines.filter((l) => l.includes("return 'silent'"));
    expect(silentArms, "no `return 'silent'` arm in abandonedUnitVerdict").not.toHaveLength(0);
    expect(
      silentArms,
      'abandonedUnitVerdict grew a SECOND silence arm. Only "did this unit hold a reference at ' +
        'all" may decide silence; a second condition is how the go-to-k/cdkd#3178 round-5 ' +
        'near-miss returns.'
    ).toHaveLength(1);
    const silent = silentArms[0];
    expect(
      silent,
      'the per-unit silence decision consults something other than whether the unit carried a ' +
        'reference. Only "did THIS unit hold a reference at all" may decide SILENCE — ' +
        'fetchability and the error class decide the EXIT CODE, and silencing on either hides ' +
        'the abandoned unit entirely (go-to-k/cdkd#3178 round 5, on the go-to-k/cdkd#3181 twin).'
    ).toContain('!entry.carriedDynamicReference');
    expect(silent, 'fetchability is deciding silence again').not.toContain('Fetchable');
  });
});

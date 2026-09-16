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
        'throw markNonRetryable(new Error(`Ref ${logicalId} not found`))',
      ],
      [
        'a Fn::GetAtt to a resource not in state',
        'Resource MyBucket not found for Fn::GetAtt',
        'throw markNonRetryable(new Error(`Resource ${logicalId} not found for Fn::GetAtt`))',
      ],
      [
        'a parameter with no Default and no supplied value',
        'Parameter DbName is required but no value was provided and no default exists',
        '`Parameter ${name} is required but no value was provided and no default exists`',
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
});

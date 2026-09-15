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
  // A FLOOR, not decoration: a regex that stopped parsing would leave this
  // empty and every `.some()` below would be vacuously false, which reads as
  // "nothing is excluded" — the round-2 bug, certified green.
  expect(literals.length, 'no pattern literals parsed out of the constant').toBeGreaterThanOrEqual(
    2
  );
  return literals.map((l) => new RegExp(l));
}

const excluded = (message: string): boolean => shippedPatterns().some((p) => p.test(message));

describe('scrub abandoned-scan origin (go-to-k/cdkd#3160)', () => {
  describe('cdkd-authored template-shape failures are EXCLUDED', () => {
    // Each case pairs the message with the resolver site that builds it. The
    // second assertion is what keeps the pair honest: a message the resolver
    // no longer produces would still satisfy the first one forever.
    const OWNED: ReadonlyArray<readonly [string, string, string]> = [
      ['a Ref to something not in state', 'Ref MyBucket not found', 'Ref ${logicalId} not found'],
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

      it(`and the resolver still produces the message behind ${label}`, () => {
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
    // Guards the wiring, not the predicate: a call site that dropped `err`
    // would compile (the parameter is `unknown`) and silently restore round 2.
    const calls = [...scrubSource.matchAll(/abandonedDynamicReferenceScan\(([^)]*)\)/g)]
      .map((m) => m[1]!)
      .filter((args) => !args.includes(':')); // skip the declaration
    expect(calls.length, 'no call sites found — the counter was renamed').toBe(4);
    for (const args of calls) {
      expect(
        args.split(',').length,
        `a call site passes only \`${args}\`. Without the error the predicate is positional ` +
          'again, and an ordinary `Ref` failure over a secret-bearing bag reds the CI gate.'
      ).toBe(2);
    }
  });
});

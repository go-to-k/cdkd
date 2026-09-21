/**
 * go-to-k/cdkd#3496 — the composite keys OUTSIDE the record class that
 * go-to-k/cdkd#3323's whole-tree sweep surfaced.
 *
 * `tests/unit/state/malformed-resources-bag.test.ts` proves the encoding is
 * injective and that no unaccounted NUL join is left in `src/`. Neither
 * answers the question these cases do: does the SITE still hand one thing's
 * answer to another's query? A source-text fence goes green on a call that
 * passes the wrong arguments, and a helper-injectivity case goes green on a
 * site that never calls the helper.
 *
 * Every case plants a pair that COLLIDES under the separator the site used to
 * carry, and every one is paired with a guard-the-guard assertion proving the
 * pair really does collide under it — without that, "these two stayed apart"
 * is satisfied by any two distinct inputs.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  acquireIdempotencyToken,
  resetIdempotencyTokensForTests,
} from '../../../src/provisioning/providers/idempotency-token.js';
import { injectiveKey } from '../../../src/state/record-keys.js';
import { extractLambdaVpcDeleteDeps } from '../../../src/analyzer/lambda-vpc-deps.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import { deleteBudgetKey } from '../../../src/provisioning/providers/dynamodb-delete-budget.js';

const NUL = String.fromCharCode(0);

/** The naive key each site used to build, for the guard-the-guard control. */
const separated = (...parts: ReadonlyArray<string | number>): string => parts.join(NUL);

describe('injectiveKey is injective where a separator is not', () => {
  it('separates a pair a NUL separator merges', () => {
    const a = [`Evil${NUL}b`, 'c'] as const;
    const b = ['Evil', `b${NUL}c`] as const;
    // The control FIRST: without it the assertion below is satisfied by any
    // two distinct inputs at all.
    expect(separated(...a), 'precondition: the pair collides under a separator').toBe(
      separated(...b)
    );
    expect(injectiveKey(...a)).not.toBe(injectiveKey(...b));
  });

  it('holds for a tuple of more than two, which is what several sites build', () => {
    const a = ['s', `r${NUL}x`, 'o'] as const;
    const b = ['s', 'r', `x${NUL}o`] as const;
    expect(separated(...a), 'precondition: the triple collides under a separator').toBe(
      separated(...b)
    );
    expect(injectiveKey(...a)).not.toBe(injectiveKey(...b));
  });

  it('keeps a NUMBER apart from its own spelling as a string', () => {
    // Several of these tuples carry a number, and the helper takes it rather
    // than making each call site coerce — so the coercion has to be one a
    // caller cannot get wrong.
    expect(injectiveKey('a', 32)).not.toBe(injectiveKey('a', '32'));
  });

  it('COLLAPSES NaN / Infinity, which is a recorded hole rather than a guard', () => {
    // Pinned so the limit is a measured fact rather than a sentence in a
    // JSDoc: `JSON.stringify` renders all three as `null`, so they share a key
    // with each other and with a literal `null`. No call site passes a
    // computed number today; this case is what makes that assumption visible
    // if one ever does.
    expect(injectiveKey('a', Number.NaN)).toBe(injectiveKey('a', Number.POSITIVE_INFINITY));
    expect(injectiveKey('a', Number.NaN)).toBe(injectiveKey('a', Number.NEGATIVE_INFINITY));
  });

  it('emits no raw control character, so a DIGEST over it stays injective too', () => {
    // `idempotency-token.ts` hashes `${NONCE}<NUL>${key}<NUL>${generation}`.
    // That input is injective only if `key` cannot carry the separator, which
    // is a property of the ENCODING rather than of the digest.
    const encoded = injectiveKey(`a${NUL}b`, 'c');
    expect(encoded.includes(NUL)).toBe(false);
    expect(encoded).toContain(String.raw`\u0000`);
  });
});

describe('lambda-vpc-deps keeps two edges whose ids straddle the separator', () => {
  it('does not drop a delete-dependency edge to a colliding pair', () => {
    // Under `${lambdaId}<NUL>${targetId}` these two edges share a key, so the
    // second was skipped by the `seen` set — and a dropped edge means the
    // Lambda is deleted without waiting on the resource holding its ENI.
    const lambdaA = `Fn${NUL}Subnet`;
    const targetA = 'A';
    const lambdaB = 'Fn';
    const targetB = `Subnet${NUL}A`;
    expect(
      separated(lambdaA, targetA),
      'precondition: the two edges collide under a separator'
    ).toBe(separated(lambdaB, targetB));

    const resources = {
      [lambdaA]: {
        Type: 'AWS::Lambda::Function',
        Properties: { VpcConfig: { SubnetIds: [{ Ref: targetA }] } },
      },
      [lambdaB]: {
        Type: 'AWS::Lambda::Function',
        Properties: { VpcConfig: { SubnetIds: [{ Ref: targetB }] } },
      },
      [targetA]: { Type: 'AWS::EC2::Subnet', Properties: {} },
      [targetB]: { Type: 'AWS::EC2::Subnet', Properties: {} },
    };

    const edges = extractLambdaVpcDeleteDeps(resources as never);
    const pairs = edges.map((e) => `${e.before}|${e.after}`);
    expect(pairs).toContain(`${lambdaA}|${targetA}`);
    expect(pairs).toContain(`${lambdaB}|${targetB}`);
  });
});

describe('deleteBudgetKey keeps two records whose halves straddle the separator', () => {
  it('does not put two tables in one budget slot', () => {
    const a = [`us-east-1${NUL}T`, 'X'] as const;
    const b = ['us-east-1', `T${NUL}X`] as const;
    expect(separated(...a), 'precondition: the pair collides under a separator').toBe(
      separated(...b)
    );
    // `deleteBudgetKey(physicalId, region)` — region first in the key.
    expect(deleteBudgetKey(a[1], a[0])).not.toBe(deleteBudgetKey(b[1], b[0]));
  });
});

describe('the idempotency-token memo keys on the whole tuple', () => {
  /**
   * The straddle has to be built across a boundary BOTH halves of which the
   * caller controls, and `tokenKey` is six parts —
   * `scope | AWS_REGION | stackName | logicalId | maxLength | charset` — so
   * `scope` and `logicalId` are NOT adjacent.
   *
   * An earlier revision of this case ignored that and built its control from
   * `(scope, logicalId)` alone. It passed under the separator, because the two
   * keys really were distinct: the precondition modelled a two-part key the
   * site does not build, so the case proved nothing. The mutation probe is
   * what caught it — the case stayed GREEN with the encoding removed.
   *
   * The real adjacent pair is `(stackName, logicalId)`, and both are
   * template-or-state derived.
   */
  const keyOf = (stackName: string, logicalId: string): string =>
    separated('s', process.env['AWS_REGION'] ?? '', stackName, logicalId, 64, 'default');

  it('two straddling call sites get DIFFERENT tokens', () => {
    const a = { stack: `t${NUL}x`, logicalId: 'y' } as const;
    const b = { stack: 't', logicalId: `x${NUL}y` } as const;
    // The control, over the key the SITE builds rather than a two-part stand-in.
    expect(
      keyOf(a.stack, a.logicalId),
      'precondition: the pair collides under the six-part separated key'
    ).toBe(keyOf(b.stack, b.logicalId));

    resetIdempotencyTokensForTests();
    const first = withStackName(a.stack, () =>
      acquireIdempotencyToken({ scope: 's', logicalId: a.logicalId })
    );
    const second = withStackName(b.stack, () =>
      acquireIdempotencyToken({ scope: 's', logicalId: b.logicalId })
    );
    // Under the separator these shared a memo entry, so the second create was
    // handed the first's token — the file's own "answered with the first
    // region's resource" failure, one boundary over.
    expect(first.value).not.toBe(second.value);
  });

  it('an identical repeat still shares a token, so the memo still memoizes', () => {
    // The inverse regression: making every key unique would pass the case
    // above while defeating the idempotency this module exists to provide.
    resetIdempotencyTokensForTests();
    const once = (): string =>
      withStackName('Stack', () =>
        acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' })
      ).value;
    expect(once()).toBe(once());
  });
});

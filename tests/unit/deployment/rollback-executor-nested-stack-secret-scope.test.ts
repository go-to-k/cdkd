/**
 * Every rollback-executor provider call binds the async-local secrets scope
 * `NestedStackProvider` reads to seed a nested CHILD engine (issue
 * [#2086](https://github.com/go-to-k/cdkd/issues/2086)).
 *
 * The #1903 fix stops a nested child's `state.json` from holding the parent's
 * decrypted secret, and the deploy engine binds
 * `withCurrentResourceSecrets(...)` around all of its provider CREATE / UPDATE
 * calls to make it work. The rollback executor drives the SAME providers on the
 * recovery path — `resolveReplayProps` has just turned the journal's
 * `{{resolve:...}}` back into plaintext, so the bag is right there — and bound
 * it nowhere. A rollback that reverted an `AWS::CloudFormation::Stack` row
 * therefore re-persisted the child's plaintext, i.e. the recovery path re-opened
 * the disclosure the fix closes.
 *
 * These tests assert the BINDING, by reading `getCurrentResourceSecrets()` from
 * inside the provider call — the same thing `NestedStackProvider.runChildDeploy`
 * does. Asserting the child's persisted state instead would need the whole
 * nested-stack machinery and would fence the seed rather than the scope.
 *
 * All FOUR binding sites are covered, across FIVE cases, because they are
 * separate code paths and a fix applied to one says nothing about the others:
 * the retried and the single-shot `update` branch (`NestedStackProvider` sets
 * `disableOuterRetry`, so the SINGLE-SHOT branch is the one it actually takes),
 * the completed-op and failed-op callers, and BOTH reverse-replacement
 * replay-CREATEs — the create-first attempt and the delete-new-first fallback.
 * The fallback needs its own case: the create-first case fails with a Lambda
 * role error, which `isNameCollisionError` REJECTS, so control never leaves the
 * first site and the fallback's binding was unfenced.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { getCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import {
  inheritNestedStackParameterAssociations,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { ResourceState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

// The REAL retry loop with its waits removed, NOT a pass-through stub. The
// binding under test sits INSIDE the thunk `withRetry` re-invokes, so a
// pass-through would collapse every attempt into one call and the
// per-attempt assertion below would be vacuous.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    withRetry: (
      operation: () => Promise<unknown>,
      logicalId: string,
      opts: Record<string, unknown> = {}
    ) => actual.withRetry(operation, logicalId, { ...opts, sleep: async () => {} }),
  };
});

const SECRET_PLAINTEXT = 'nested-child-db-password-2086';
const SECRET_EXPR = '{{resolve:secretsmanager:prod/child/db:SecretString:password::}}';

const mockSMSend = vi.fn(async () => ({
  SecretString: JSON.stringify({ password: SECRET_PLAINTEXT }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: mockSMSend } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const NESTED = 'AWS::CloudFormation::Stack';

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
    resourceType: NESTED,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function makeCtx(provider: {
  update?: unknown;
  create?: unknown;
  delete?: unknown;
  disableOuterRetry?: boolean;
}): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
}

/**
 * The observation seam: the value `NestedStackProvider` would read. Captured
 * as a PLAIN OBJECT rather than the live `Map`, because the executor keeps
 * mutating that same map for the rest of the op — a stored reference would be
 * read after the fact and could pass on a binding that was empty at call time.
 */
function captureScope(seen: Array<Record<string, string> | undefined>): void {
  const bag = getCurrentResourceSecrets();
  seen.push(bag ? Object.fromEntries(bag) : undefined);
}

/** The previous (journaled) child-stack row: its parameter holds the EXPRESSION. */
function prevNestedRow(): ResourceState {
  return res({
    properties: { Parameters: { DbPassword: SECRET_EXPR }, TemplateURL: 'child.json' },
  });
}

beforeEach(() => {
  mockSMSend.mockClear();
  resetAccountInfoCache();
});

describe('rollback-executor binds the nested-stack secrets scope (#2086)', () => {
  it('revert UPDATE, retried branch: provider.update sees the re-resolved plaintext bag', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const update = vi.fn(async () => {
      captureScope(seen);
      return { physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child' };
    });
    const ctx = makeCtx({ update });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
        previousState: prevNestedRow(),
      },
    ];
    const state: Record<string, ResourceState> = {
      Child: res({
        properties: { Parameters: { DbPassword: SECRET_EXPR }, TemplateURL: 'child-v2.json' },
      }),
    };

    await replayRollback(ops, state, 'Parent', ctx);

    // Non-vacuity: the replay really did decrypt, so the bag below is a real
    // re-resolution rather than an empty map that happens to be present.
    expect(mockSMSend).toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ [SECRET_PLAINTEXT]: SECRET_EXPR }]);
  });

  it('revert UPDATE, SINGLE-SHOT branch (disableOuterRetry, which is what NestedStackProvider sets)', async () => {
    // The branch `NestedStackProvider` actually takes. Binding only the retried
    // branch would leave the reachable case unbound, and the retried-branch test
    // above could not tell.
    const seen: Array<Record<string, string> | undefined> = [];
    const update = vi.fn(async () => {
      captureScope(seen);
      return { physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child' };
    });
    const ctx = makeCtx({ update, disableOuterRetry: true });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
        previousState: prevNestedRow(),
      },
    ];
    const state: Record<string, ResourceState> = {
      Child: res({
        properties: { Parameters: { DbPassword: SECRET_EXPR }, TemplateURL: 'child-v2.json' },
      }),
    };

    await replayRollback(ops, state, 'Parent', ctx);

    expect(update).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ [SECRET_PLAINTEXT]: SECRET_EXPR }]);
  });

  it('revert a FAILED UPDATE: the second updateWithRollbackRetry caller binds it too', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const update = vi.fn(async () => {
      captureScope(seen);
      return { physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child' };
    });
    const ctx = makeCtx({ update });
    const failed: FailedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
        previousState: prevNestedRow(),
        attemptedProperties: {
          Parameters: { DbPassword: SECRET_EXPR },
          TemplateURL: 'child-v2.json',
        },
      },
    ];
    const state: Record<string, ResourceState> = {
      Child: res({
        properties: { Parameters: { DbPassword: SECRET_EXPR }, TemplateURL: 'child-v2.json' },
      }),
    };

    await replayFailedOperations(failed, state, 'Parent', ctx);

    expect(update).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ [SECRET_PLAINTEXT]: SECRET_EXPR }]);
  });

  it('reverse-replacement replay-CREATE: createProvider.create sees the bag on every attempt', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    let attempts = 0;
    const create = vi.fn(async () => {
      captureScope(seen);
      attempts += 1;
      // Fail once so the RETRY path is exercised: the binding lives inside the
      // thunk, so a fix that wrapped the loop instead of the call would leave
      // attempt 2 unbound and only this assertion could see it.
      if (attempts === 1) {
        throw new Error('The role defined for the function cannot be assumed by Lambda.');
      }
      return { physicalId: 'old-child' };
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'new-child',
        previousState: res({
          physicalId: 'old-child',
          properties: { Parameters: { DbPassword: SECRET_EXPR }, TemplateURL: 'child.json' },
        }),
      },
    ];
    const state: Record<string, ResourceState> = { Child: res({ physicalId: 'new-child' }) };

    const result = await replayRollback(ops, state, 'Parent', ctx);

    expect(result.failures).toBe(0);
    expect(create).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      { [SECRET_PLAINTEXT]: SECRET_EXPR },
      { [SECRET_PLAINTEXT]: SECRET_EXPR },
    ]);
  });

  it('reverse-replacement DELETE-NEW-FIRST fallback: the second replay-CREATE binds it too', async () => {
    // THE FOURTH CREATE SITE, which the case above cannot reach. Its create
    // fails with a Lambda-role error, and `isNameCollisionError` REJECTS that
    // message — so control never leaves the create-first site and the fallback
    // create was completely untested. A NAME COLLISION is what routes into it:
    // the new resource still holds the physical name the old one needs, so the
    // executor deletes the new resource and re-creates the old under its name.
    const seen: Array<Record<string, string> | undefined> = [];
    let attempts = 0;
    const create = vi.fn(async () => {
      captureScope(seen);
      attempts += 1;
      // "already exists" is deliberately NOT a transient-retry pattern, so the
      // inner loop does not swallow it and the collision catch sees it.
      if (attempts === 1) throw new Error('Parameter already exists: new-child');
      return { physicalId: 'old-child' };
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'new-child',
        previousState: res({
          physicalId: 'old-child',
          properties: { Parameters: { DbPassword: SECRET_EXPR }, TemplateURL: 'child.json' },
        }),
      },
    ];
    const state: Record<string, ResourceState> = { Child: res({ physicalId: 'new-child' }) };

    const result = await replayRollback(ops, state, 'Parent', ctx);

    expect(result.failures).toBe(0);
    // Non-vacuity: the fallback really was taken — the NEW resource was deleted
    // to release the name, and only then did the second create run.
    expect(del).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      { [SECRET_PLAINTEXT]: SECRET_EXPR },
      { [SECRET_PLAINTEXT]: SECRET_EXPR },
    ]);
  });

  it('binds an EMPTY bag rather than leaking a previous op scope when the op carries no secret', async () => {
    // Scope control. `undefined` would be the pre-#2086 reading and an
    // unrelated op's bag would be a leak; an empty map is the honest answer and
    // is what the child engine reads as "nothing to inherit".
    const seen: Array<Record<string, string> | undefined> = [];
    const update = vi.fn(async () => {
      captureScope(seen);
      return { physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child' };
    });
    const ctx = makeCtx({ update });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
        previousState: res({
          properties: { Parameters: { Stage: 'prod' }, TemplateURL: 'child.json' },
        }),
      },
    ];
    const state: Record<string, ResourceState> = {
      Child: res({ properties: { Parameters: { Stage: 'dev' }, TemplateURL: 'child.json' } }),
    };

    await replayRollback(ops, state, 'Parent', ctx);

    expect(mockSMSend).not.toHaveBeenCalled();
    expect(seen).toEqual([{}]);
  });
});

/**
 * TWO journaled child `Parameters` resolving to ONE plaintext keep DISTINCT
 * expressions across the REPLAY handoff (issue
 * [#2291](https://github.com/go-to-k/cdkd/issues/2291)).
 *
 * The deploy path records, per child PARAMETER NAME, which `{{resolve:...}}`
 * expression that parameter came from, because the bag it hands the child is
 * keyed by PLAINTEXT and has already collapsed such a pair. The REPLAY path
 * binds the very same kind of bag around the very same providers and recorded
 * nothing, so replaying an `AWS::CloudFormation::Stack` row handed the child a
 * bag with no table — and the child re-persisted the SURVIVOR for BOTH leaves,
 * silently rewriting correct state back into the #2291 shape. A
 * `cdkd drift --revert` inside that window then pushes the WRONG secret version
 * to the live child resource (the GHSA-p5qg-v9gv-hc7w replay class). It
 * self-heals only on the next successful deploy, which is no answer: `--revert`
 * is used precisely when there has not been one.
 *
 * OBSERVED AT CALL TIME, INSIDE THE PROVIDER, for the reason `captureScope`
 * gives about the live map — and because that is literally where
 * `NestedStackProvider.runChildDeploy` reads it. Each case computes the answer a
 * child resource's own bag would get and stores the STRINGS, so nothing is read
 * after the executor has moved on.
 *
 * THE DISCRIMINATING SHAPE IS TWO LEAVES IN ONE CHILD BAG, as everywhere else in
 * this fix: with one needle there is nothing to collapse onto.
 */
const PAIR_EXPR_A = '{{resolve:secretsmanager:prod/child/db:SecretString:password::}}';
const PAIR_EXPR_B = '{{resolve:secretsmanager:prod/child/db:SecretString:password:AWSCURRENT:}}';
const PAIR_A = 'DbPasswordA';
const PAIR_B = 'DbPasswordB';

/** The journaled row whose two parameters collapse to one plaintext. */
function collidingNestedRow(templateUrl = 'child.json'): ResourceState {
  return res({
    properties: {
      Parameters: { [PAIR_A]: PAIR_EXPR_A, [PAIR_B]: PAIR_EXPR_B },
      TemplateURL: templateUrl,
    },
  });
}

/**
 * What a CHILD resource consuming both parameters would persist, computed from
 * the bag currently bound — i.e. exactly what the child engine derives from
 * `getCurrentResourceSecrets()`.
 */
function childLeavesFromBoundScope(): { value: unknown; description: unknown; size: number } {
  const bound = getCurrentResourceSecrets();
  if (!bound) return { value: undefined, description: undefined, size: -1 };
  const childBag: RecordedSecretValues = new Map(bound);
  inheritNestedStackParameterAssociations(childBag, bound);
  const persisted = redactSecretsForState(
    { Value: SECRET_PLAINTEXT, Description: SECRET_PLAINTEXT },
    childBag,
    { Value: { Ref: PAIR_A }, Description: { Ref: PAIR_B } }
  ) as Record<string, unknown>;
  return { value: persisted['Value'], description: persisted['Description'], size: bound.size };
}

describe('rollback-executor keeps colliding child Parameters apart on replay (#2291)', () => {
  it('revert UPDATE, SINGLE-SHOT branch (the one NestedStackProvider takes)', async () => {
    const seen: Array<ReturnType<typeof childLeavesFromBoundScope>> = [];
    const update = vi.fn(async () => {
      seen.push(childLeavesFromBoundScope());
      return { physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child' };
    });
    const ctx = makeCtx({ update, disableOuterRetry: true });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
        previousState: collidingNestedRow(),
      },
    ];
    const state: Record<string, ResourceState> = { Child: collidingNestedRow('child-v2.json') };

    await replayRollback(ops, state, 'Parent', ctx);

    expect(mockSMSend).toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    // The collapse PREMISE, asserted rather than assumed: the bound bag really
    // does hold ONE entry for the two references.
    expect(seen[0]!.size).toBe(1);
    expect(seen[0]!.value).toBe(PAIR_EXPR_A);
    expect(seen[0]!.description).toBe(PAIR_EXPR_B);
  });

  it('revert a FAILED UPDATE (--revert-failed)', async () => {
    const seen: Array<ReturnType<typeof childLeavesFromBoundScope>> = [];
    const update = vi.fn(async () => {
      seen.push(childLeavesFromBoundScope());
      return { physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child' };
    });
    const ctx = makeCtx({ update });
    const failed: FailedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
        previousState: collidingNestedRow(),
        attemptedProperties: {
          Parameters: { [PAIR_A]: PAIR_EXPR_A, [PAIR_B]: PAIR_EXPR_B },
          TemplateURL: 'child-v2.json',
        },
      },
    ];
    const state: Record<string, ResourceState> = { Child: collidingNestedRow('child-v2.json') };

    await replayFailedOperations(failed, state, 'Parent', ctx);

    expect(update).toHaveBeenCalledOnce();
    expect(seen[0]!.size).toBe(1);
    expect(seen[0]!.value).toBe(PAIR_EXPR_A);
    expect(seen[0]!.description).toBe(PAIR_EXPR_B);
  });

  it('reverse-replacement replay-CREATE, on every attempt', async () => {
    const seen: Array<ReturnType<typeof childLeavesFromBoundScope>> = [];
    let attempts = 0;
    const create = vi.fn(async () => {
      seen.push(childLeavesFromBoundScope());
      attempts += 1;
      if (attempts === 1) {
        throw new Error('The role defined for the function cannot be assumed by Lambda.');
      }
      return { physicalId: 'old-child' };
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'new-child',
        previousState: res({
          physicalId: 'old-child',
          properties: {
            Parameters: { [PAIR_A]: PAIR_EXPR_A, [PAIR_B]: PAIR_EXPR_B },
            TemplateURL: 'child.json',
          },
        }),
      },
    ];
    const state: Record<string, ResourceState> = { Child: res({ physicalId: 'new-child' }) };

    const result = await replayRollback(ops, state, 'Parent', ctx);

    expect(result.failures).toBe(0);
    expect(create).toHaveBeenCalledTimes(2);
    // The retry re-enters the SAME bag, so both attempts must answer alike; a
    // recorder placed inside the retry thunk would re-record per attempt and a
    // recorder placed outside it must still be visible on attempt 2.
    for (const observed of seen) {
      expect(observed.size).toBe(1);
      expect(observed.value).toBe(PAIR_EXPR_A);
      expect(observed.description).toBe(PAIR_EXPR_B);
    }
  });

  it('uses STATE_DERIVED_RULES, which a TOKEN-SHAPED plaintext discriminates (#2291)', async () => {
    // THE DISCRIMINATOR for the `rules` argument at the replay CALL SITES. An
    // earlier revision of this lane asserted it was unfenceable there, reasoning
    // that only `trustAnyExpression` separates the two constants and that a live
    // resolver necessarily PINS an `ssm` verdict. That argument covers one flag
    // and the two constants differ on TWO; the second is
    // `sourceIsSameGeneration`, and a TOKEN-SHAPED plaintext reaches it -- a
    // secret whose stored VALUE is itself a `{{resolve:...}}` string, different
    // from either source leaf.
    //
    //   STATE_DERIVED_RULES  -> `sourceIsSameGeneration` is true, so
    //                           `redactByPath` returns the SOURCE, the loser is
    //                           certified, and the two child leaves stay apart;
    //   TEMPLATE_DERIVED_RULES -> the issue #1917 guard fires instead
    //                           (`!sourceIsSameGeneration &&
    //                           isSingleDynamicReferenceToken(bag)`), returning
    //                           the SURVIVOR, which refusal 2b then rejects as
    //                           an uncertified value-scan answer -- so no
    //                           association is recorded and BOTH leaves collapse.
    //
    // Without this case, a future "normalize these to the default" refactor
    // silently reintroduces the #2291 collapse on the replay path with every
    // other test green.
    const TOKEN_SHAPED_PW = '{{resolve:secretsmanager:decoy/other:SecretString:v::}}';
    const original = mockSMSend.getMockImplementation()!;
    mockSMSend.mockImplementation(
      async () => ({ SecretString: JSON.stringify({ password: TOKEN_SHAPED_PW }) }) as never
    );
    try {
      const seen: Array<{ value: unknown; description: unknown; size: number }> = [];
      const update = vi.fn(async () => {
        const bound = getCurrentResourceSecrets();
        const childBag: RecordedSecretValues = new Map(bound);
        inheritNestedStackParameterAssociations(childBag, bound!);
        const persisted = redactSecretsForState(
          { Value: TOKEN_SHAPED_PW, Description: TOKEN_SHAPED_PW },
          childBag,
          { Value: { Ref: PAIR_A }, Description: { Ref: PAIR_B } }
        ) as Record<string, unknown>;
        seen.push({
          value: persisted['Value'],
          description: persisted['Description'],
          size: bound!.size,
        });
        return { physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child' };
      });
      const ctx = makeCtx({ update, disableOuterRetry: true });
      const ops: CompletedOperation[] = [
        {
          logicalId: 'Child',
          changeType: 'UPDATE',
          resourceType: NESTED,
          physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
          previousState: collidingNestedRow(),
        },
      ];
      const state: Record<string, ResourceState> = { Child: collidingNestedRow('child-v2.json') };

      await replayRollback(ops, state, 'Parent', ctx);

      expect(update).toHaveBeenCalledOnce();
      // The premise: the token-shaped plaintext really did collapse the bag.
      expect(seen[0]!.size).toBe(1);
      // The discriminator: each leaf still on its OWN expression.
      expect(seen[0]!.value).toBe(PAIR_EXPR_A);
      expect(seen[0]!.description).toBe(PAIR_EXPR_B);
    } finally {
      mockSMSend.mockImplementation(original);
    }
  });

  it('records nothing for a NON-nested row, so an ordinary resource is unaffected', async () => {
    // Scope control: the recorder is gated on the resource TYPE, so an ordinary
    // resource carrying a `Parameters` map contributes no associations and its
    // child-shaped read collapses exactly as it does today.
    const seen: Array<ReturnType<typeof childLeavesFromBoundScope>> = [];
    const update = vi.fn(async () => {
      seen.push(childLeavesFromBoundScope());
      return { physicalId: 'phys' };
    });
    const ctx = makeCtx({ update, disableOuterRetry: true });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Pipeline',
        changeType: 'UPDATE',
        resourceType: 'AWS::SageMaker::Pipeline',
        physicalId: 'phys',
        previousState: res({
          physicalId: 'phys',
          resourceType: 'AWS::SageMaker::Pipeline',
          properties: { Parameters: { [PAIR_A]: PAIR_EXPR_A, [PAIR_B]: PAIR_EXPR_B } },
        }),
      },
    ];
    // The CURRENT row must DIFFER from the journaled one or the op classifies as
    // already-reverted and the provider is never called — which would make the
    // assertion below vacuous rather than false.
    const state: Record<string, ResourceState> = {
      Pipeline: res({
        physicalId: 'phys',
        resourceType: 'AWS::SageMaker::Pipeline',
        properties: {
          Parameters: { [PAIR_A]: PAIR_EXPR_A, [PAIR_B]: PAIR_EXPR_B },
          PipelineDefinition: 'v2',
        },
      }),
    };

    await replayRollback(ops, state, 'Parent', ctx);

    expect(update).toHaveBeenCalledOnce();
    expect(seen[0]!.value).toBe(seen[0]!.description);
  });
});

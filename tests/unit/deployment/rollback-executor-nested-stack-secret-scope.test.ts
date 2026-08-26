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

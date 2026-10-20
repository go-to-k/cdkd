/**
 * generated-name-lifecycle A5 (integ run 4): `cdkd deploy --replace
 * --force-stateful-recreation --no-rollback` replaced a DynamoDB table
 * delete-first under the same name, beside a sibling that failed. The table
 * was deleted, the re-create met DynamoDB's late name release
 * (`ResourceInUseException: Table already exists`), and the sibling's failure
 * -- which sets the engine's interrupt flag with cause `sibling-failure` --
 * aborted the re-create's retry: the stack was left with neither table.
 * Once the old resource is gone only the user's interrupt stops the re-create.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { replaceDeleteFirstAndRecreate } from '../../../src/deployment/deploy-engine/replacement.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
  })),
}));

const TABLE = 'AWS::DynamoDB::Table';
const NAME = 'CdkdGenNameLife-Table';

function lateNameRelease(): Error {
  const error = new Error(`Table already exists: ${NAME}`);
  error.name = 'ResourceInUseException';
  return error;
}

describe('a delete-first re-create is not aborted by a sibling failure (A5)', () => {
  let engine: InstanceType<typeof DeployEngine>;
  let provider: ResourceProvider;
  let tableExists: boolean;

  beforeEach(() => {
    tableExists = true;
    provider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(async () => {
        tableExists = false;
      }),
      getAttribute: vi.fn(),
    } as unknown as ResourceProvider;
    engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getProviderFor: vi.fn() } as never,
      { concurrency: 2, forceStatefulRecreation: true, replace: true } as never,
      'us-east-1'
    );
  });

  const old: ResourceState = {
    physicalId: NAME,
    resourceType: TABLE,
    properties: { TableName: NAME, KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }] },
    attributes: {},
  };

  function recreate(): Promise<unknown> {
    return replaceDeleteFirstAndRecreate(
      engine.replacementRun,
      engine.replacementDeps(),
      'Table',
      TABLE,
      TABLE,
      old,
      provider,
      provider,
      { TableName: NAME, KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] },
      new Map(),
      undefined,
      'sdk',
      undefined
    );
  }

  it('keeps retrying the late name release after a sibling fails, and re-creates the table', async () => {
    let attempts = 0;
    vi.mocked(provider.create).mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        // The sibling fails while this re-create waits out the release.
        engine.interrupted = true;
        engine.interruptCause = 'sibling-failure';
        throw lateNameRelease();
      }
      tableExists = true;
      return { physicalId: NAME, attributes: {} };
    });

    await expect(recreate()).resolves.toMatchObject({ physicalId: NAME });

    expect(attempts).toBe(2);
    expect(tableExists).toBe(true);
  }, 20_000);

  it("the user's interrupt still stops it", async () => {
    vi.mocked(provider.create).mockImplementation(async () => {
      // What the SIGINT handler sets (the test below fires the real one).
      engine.interrupted = true;
      engine.interruptCause = 'user';
      engine.userInterrupted = true;
      throw lateNameRelease();
    });

    await expect(recreate()).rejects.toThrow();
    expect(provider.create).toHaveBeenCalledTimes(1);
  }, 20_000);

  // go-to-k/cdkd#5118 review S1: a sibling's failure claims `interruptCause`
  // first (`??=`), so a Ctrl-C that follows leaves the cause at
  // `sibling-failure`. The SIGINT listener `deploy()` itself registers is
  // fired here -- found by diffing the listener list, held by a lock acquire
  // that never settles -- so the handler-to-retry link is what is proven.
  // The second attempt's error picks the loop that must see the interrupt: a
  // late name release reaches the outer re-create loop (`replacement.ts`), a
  // throttle the engine's inner transient retry (`DeployEngine.withRetry`).
  it.each([
    ['the outer re-create loop (a late name release)', lateNameRelease],
    [
      'the inner transient retry (a throttle)',
      () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
    ],
  ] as const)('a Ctrl-C after a sibling has failed still stops %s (the real SIGINT handler)', async (_label, secondError) => {
    let endAcquire: (error: Error) => void = () => undefined;
    const lockManager = {
      acquireLockWithRetry: vi.fn(
        () => new Promise<boolean>((_resolve, reject) => (endAcquire = reject))
      ),
      releaseLock: vi.fn(),
    };
    engine = new DeployEngine(
      {} as never,
      lockManager as never,
      {} as never,
      {} as never,
      { getProviderFor: vi.fn() } as never,
      { concurrency: 2, forceStatefulRecreation: true, replace: true } as never,
      'us-east-1'
    );
    const before = new Set(process.listeners('SIGINT'));
    const deploying = engine.deploy('Stack', { Resources: {} } as never).catch(() => undefined);
    let registered: Array<(...args: unknown[]) => void> = [];
    for (let i = 0; i < 50 && registered.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
      registered = process.listeners('SIGINT').filter((l) => !before.has(l)) as typeof registered;
    }
    expect(registered, 'deploy() registered no SIGINT listener').toHaveLength(1);
    try {
      let attempts = 0;
      vi.mocked(provider.create).mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          // As `execute.ts` does on a sibling's failure.
          engine.interrupted = true;
          engine.interruptCause ??= 'sibling-failure';
        } else if (attempts === 2) {
          registered[0]!();
          expect(engine.interruptCause).toBe('sibling-failure');
          throw secondError();
        } else {
          tableExists = true;
          return { physicalId: NAME, attributes: {} };
        }
        throw lateNameRelease();
      });

      await expect(recreate()).rejects.toThrow();
      expect(attempts).toBe(2);
      expect(tableExists).toBe(false);
    } finally {
      endAcquire(new Error('test over'));
      await deploying;
    }
    expect(process.listeners('SIGINT').filter((l) => !before.has(l))).toHaveLength(0);
  }, 20_000);

  it('the inner transient retry does not abort on a sibling failure either (a throttle)', async () => {
    let attempts = 0;
    vi.mocked(provider.create).mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        engine.interrupted = true;
        engine.interruptCause = 'sibling-failure';
        const throttle = new Error('Rate exceeded');
        throttle.name = 'ThrottlingException';
        throw throttle;
      }
      return { physicalId: NAME, attributes: {} };
    });

    await expect(recreate()).resolves.toMatchObject({ physicalId: NAME });
    expect(attempts).toBe(2);
  }, 30_000);

  // go-to-k/cdkd#5131: DynamoDB keeps the name while the deleted table is
  // DELETING, and the create's refusal (ResourceInUseException, its AWS text
  // withheld) is deliberately not retryable. The provider's name-release wait
  // runs between this run's own delete and the re-create.
  describe('a table whose delete returns before its name is released (#5131)', () => {
    const nameStillHeld = (): Error =>
      new Error(`Failed to create DynamoDB table Table: ResourceInUseException.`);
    let released: boolean;
    beforeEach(() => {
      released = false;
      vi.mocked(provider.create).mockImplementation(async () => {
        if (!released) throw nameStillHeld();
        return { physicalId: NAME, attributes: {} };
      });
    });

    it('waits for the name, then re-creates the table in one attempt', async () => {
      const order: string[] = [];
      vi.mocked(provider.delete).mockImplementation(async () => {
        order.push('delete');
      });
      provider.waitForNameReleased = vi.fn(async (_id, physicalId, type, ctx) => {
        order.push(`wait ${physicalId} ${type} interrupted=${ctx.isInterrupted()}`);
        released = true;
      });
      await expect(recreate()).resolves.toMatchObject({ physicalId: NAME });
      expect(order).toEqual(['delete', `wait ${NAME} ${TABLE} interrupted=false`]);
      expect(provider.create).toHaveBeenCalledTimes(1);
    });

    it("the wait ends on the user's interrupt only", async () => {
      let seen: (() => boolean) | undefined;
      provider.waitForNameReleased = vi.fn(async (_id, _p, _t, ctx) => {
        seen = ctx.isInterrupted;
        released = true;
      });
      await recreate();
      engine.interrupted = true;
      engine.interruptCause = 'sibling-failure';
      expect(seen!()).toBe(false);
      engine.userInterrupted = true;
      expect(seen!()).toBe(true);
    });

    it('a name never released fails the re-create with the existing message', async () => {
      provider.waitForNameReleased = vi.fn(async () => undefined);
      await expect(recreate()).rejects.toThrow(/already deleted the old resource/);
      expect(provider.create).toHaveBeenCalledTimes(1);
    });
  });
});


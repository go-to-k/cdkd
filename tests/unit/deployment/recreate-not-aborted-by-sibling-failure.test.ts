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
      engine.interrupted = true;
      engine.interruptCause = 'user';
      throw lateNameRelease();
    });

    await expect(recreate()).rejects.toThrow();
    expect(provider.create).toHaveBeenCalledTimes(1);
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
});

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#5638: a delete-first replacement of a cluster restoring from
// itself deletes its source, with no final snapshot, and then restores from
// nothing. The refusal counts only if no delete ran.

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
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
  })),
}));

const { DeployEngine } = await import('../../../src/deployment/deploy-engine.js');
const { provisionResource } = await import('../../../src/deployment/deploy-engine/provision.js');
const { replaceDeleteFirstAndRecreate } = await import(
  '../../../src/deployment/deploy-engine/replacement.js'
);
const { refuseRestoreFromItself } = await import(
  '../../../src/provisioning/restore-source-guard.js'
);
const { isMarkedNonRetryable } = await import('../../../src/deployment/retryable-errors.js');
const { ResourceUpdateNotSupportedError } = await import('../../../src/utils/error-handler.js');

const CLUSTER = 'AWS::Neptune::DBCluster';
const PHYSICAL = 'mystack-cluster-abc123';
const ACCOUNT = '123456789012';
const REFUSAL = /SourceDBClusterIdentifier must be another cluster/;

/** Every message on the cause chain: the engine wraps what a path throws. */
function chain(error: unknown): string {
  const parts: string[] = [];
  let link: unknown = error;
  for (let depth = 0; depth < 10 && link != null; depth++) {
    if (link instanceof Error) parts.push(link.message);
    link = (link as { cause?: unknown }).cause;
  }
  return parts.join('\n');
}

describe('a replacement restoring from the cluster it deletes (go-to-k/cdkd#5638)', () => {
  const provider = {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    disableOuterRetry: true,
  };

  beforeEach(() => {
    provider.create.mockReset().mockResolvedValue({ physicalId: 'new-id', attributes: {} });
    provider.delete.mockReset().mockResolvedValue(undefined);
  });

  const makeEngine = (recreate?: 'viaCcApi' | 'viaSdkProvider', replace = false) =>
    new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(new Map()),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      {
        consumerAccount: ACCOUNT,
        ...(replace && { replace: true, forceStatefulRecreation: true }),
        ...(recreate !== undefined && {
          recreateTargets: {
            stackName: 'MyStack',
            viaCcApi: recreate === 'viaCcApi' ? new Set(['Cluster']) : new Set<string>(),
            viaSdkProvider: recreate === 'viaSdkProvider' ? new Set(['Cluster']) : new Set<string>(),
          },
        }),
      },
      'us-east-1'
    );

  const record = (properties: Record<string, unknown> = {}) => ({
    physicalId: PHYSICAL,
    resourceType: CLUSTER,
    properties,
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk' as const,
  });

  const recreateWith = async (
    flag: 'viaCcApi' | 'viaSdkProvider',
    source: string
  ): Promise<unknown> => {
    const desired = { SourceDBClusterIdentifier: source, UseLatestRestorableTime: true };
    const change = {
      logicalId: 'Cluster',
      changeType: 'UPDATE',
      resourceType: CLUSTER,
      currentProperties: {},
      desiredProperties: desired,
      propertyChanges: [
        {
          path: 'SourceDBClusterIdentifier',
          requiresReplacement: true,
          oldValue: undefined,
          newValue: source,
        },
      ],
    };
    return provisionResource(
      makeEngine(flag) as never,
      'Cluster',
      change as never,
      { Cluster: record() } as never,
      'MyStack',
      { Resources: { Cluster: { Type: CLUSTER, Properties: desired } } } as never,
      undefined,
      undefined,
      undefined
    ).then(
      () => undefined,
      (error: unknown) => error
    );
  };

  it.each([
    ['viaSdkProvider', PHYSICAL],
    ['viaCcApi', PHYSICAL],
    ['viaSdkProvider', PHYSICAL.toUpperCase()],
    ['viaSdkProvider', `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:${PHYSICAL}`],
  ] as const)('refuses --recreate-%s with source %s before any delete', async (flag, source) => {
    const failure = await recreateWith(flag, source);
    expect(chain(failure)).toMatch(REFUSAL);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each([
    'another-cluster',
    `arn:aws:rds:eu-west-1:${ACCOUNT}:cluster:${PHYSICAL}`,
    `arn:aws:rds:us-east-1:999999999999:cluster:${PHYSICAL}`,
  ])('lets --recreate through for source %s', async (source) => {
    const failure = await recreateWith('viaSdkProvider', source);
    expect(failure).toBeUndefined();
    expect(provider.delete).toHaveBeenCalledTimes(1);
  });

  /** An in-place update the provider refuses, on the `--replace` fallback. */
  const fallbackWith = (source: string): Promise<unknown> => {
    provider.update.mockReset().mockRejectedValue(
      new ResourceUpdateNotSupportedError(CLUSTER, 'Cluster', 'immutable')
    );
    const desired = { SourceDBClusterIdentifier: source, UseLatestRestorableTime: true };
    const change = {
      logicalId: 'Cluster',
      changeType: 'UPDATE',
      resourceType: CLUSTER,
      currentProperties: {},
      desiredProperties: desired,
      propertyChanges: [
        { path: 'Port', requiresReplacement: false, oldValue: 1, newValue: 2 },
      ],
    };
    return provisionResource(
      makeEngine(undefined, true) as never,
      'Cluster',
      change as never,
      { Cluster: record() } as never,
      'MyStack',
      {
        Resources: { Cluster: { Type: CLUSTER, Properties: desired } },
      } as never,
      undefined,
      undefined,
      undefined
    ).then(
      () => undefined,
      (error: unknown) => error
    );
  };

  it('refuses the update-failure fallback before any delete', async () => {
    const failure = await fallbackWith(PHYSICAL);
    expect(chain(failure)).toMatch(REFUSAL);
    expect(provider.update).toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('lets the update-failure fallback through for another source', async () => {
    await fallbackWith('another-cluster');
    expect(provider.delete).toHaveBeenCalledTimes(1);
  });

  const replaceWith = (source: string): Promise<unknown> => {
    const engine = makeEngine() as unknown as {
      replacementRun: never;
      replacementDeps(): never;
    };
    return replaceDeleteFirstAndRecreate(
      engine.replacementRun,
      engine.replacementDeps(),
      'Cluster',
      CLUSTER,
      CLUSTER,
      record() as never,
      provider as never,
      provider as never,
      { SourceDBClusterIdentifier: source, UseLatestRestorableTime: true },
      new Map() as never,
      'Delete',
      'sdk',
      undefined
    ).then(
      () => undefined,
      (error: unknown) => error
    );
  };

  it('refuses the --replace delete-first fallback before any delete', async () => {
    const failure = await replaceWith(PHYSICAL);
    expect(chain(failure)).toMatch(REFUSAL);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('lets the --replace fallback through for another source', async () => {
    expect(await replaceWith('another-cluster')).toBeUndefined();
    expect(provider.delete).toHaveBeenCalledTimes(1);
  });
});

describe('refuseRestoreFromItself', () => {
  const refuse = (resourceType: string, source: unknown, physicalId = 'cluster-1') => {
    refuseRestoreFromItself(
      resourceType,
      { SourceDBClusterIdentifier: source },
      physicalId,
      'Cluster',
      { region: 'us-east-1', account: ACCOUNT }
    );
  };

  it('throws a non-retryable refusal, naming no value', () => {
    let failure: unknown;
    try {
      refuse(CLUSTER, 'cluster-1');
    } catch (error) {
      failure = error;
    }
    expect(isMarkedNonRetryable(failure)).toBe(true);
    expect((failure as Error).message).not.toContain('cluster-1');
  });

  it('compares the name of an ARN physical id too', () => {
    expect(() => refuse(CLUSTER, 'cluster-1', 'arn:aws:rds:r:1:cluster:Cluster-1')).toThrow(REFUSAL);
  });

  it('refuses an ARN whose scope it cannot compare', () => {
    expect(() =>
      refuseRestoreFromItself(
        CLUSTER,
        { SourceDBClusterIdentifier: 'arn:aws:rds:eu-west-1:999999999999:cluster:cluster-1' },
        'cluster-1',
        'Cluster',
        {}
      )
    ).toThrow(REFUSAL);
  });

  it('leaves another type, an absent key and a malformed key alone', () => {
    expect(() => refuse('AWS::S3::Bucket', 'cluster-1')).not.toThrow();
    expect(() => refuse(CLUSTER, undefined)).not.toThrow();
    expect(() => refuse(CLUSTER, ['cluster-1'])).not.toThrow();
  });
});

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
const { RESOURCE_NOT_FOUND } = await import('../../../src/types/resource.js');
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
    // go-to-k/cdkd#5639: the live read of a record holding no resource id.
    import: vi.fn(),
    // go-to-k/cdkd#5640: the live DbiResourceId of a DB instance record.
    resourceIdentity: vi.fn(),
    disableOuterRetry: true,
  };

  beforeEach(() => {
    provider.create.mockReset().mockResolvedValue({ physicalId: 'new-id', attributes: {} });
    provider.delete.mockReset().mockResolvedValue(undefined);
    provider.import.mockReset().mockResolvedValue(null);
    provider.resourceIdentity.mockReset().mockResolvedValue(undefined);
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

  /** go-to-k/cdkd#5639: a case may name another type, its desired bag and the record's attributes. */
  interface Case {
    type?: string;
    desired?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
  }

  const record = (properties: Record<string, unknown> = {}, c: Case = {}) => ({
    physicalId: PHYSICAL,
    resourceType: c.type ?? CLUSTER,
    properties,
    attributes: c.attributes ?? {},
    dependencies: [],
    provisionedBy: 'sdk' as const,
  });

  const recreateWith = async (
    flag: 'viaCcApi' | 'viaSdkProvider',
    source: string,
    c: Case = {}
  ): Promise<unknown> => {
    const type = c.type ?? CLUSTER;
    const desired = c.desired ?? {
      SourceDBClusterIdentifier: source,
      UseLatestRestorableTime: true,
    };
    const change = {
      logicalId: 'Cluster',
      changeType: 'UPDATE',
      resourceType: type,
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
      { Cluster: record({}, c) } as never,
      'MyStack',
      { Resources: { Cluster: { Type: type, Properties: desired } } } as never,
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
  const fallbackWith = (source: string, c: Case = {}): Promise<unknown> => {
    const type = c.type ?? CLUSTER;
    provider.update.mockReset().mockRejectedValue(
      new ResourceUpdateNotSupportedError(type, 'Cluster', 'immutable')
    );
    const desired = c.desired ?? {
      SourceDBClusterIdentifier: source,
      UseLatestRestorableTime: true,
    };
    const change = {
      logicalId: 'Cluster',
      changeType: 'UPDATE',
      resourceType: type,
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
      { Cluster: record({}, c) } as never,
      'MyStack',
      {
        Resources: { Cluster: { Type: type, Properties: desired } },
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

  const replaceWith = (source: string, c: Case = {}): Promise<unknown> => {
    const engine = makeEngine() as unknown as {
      replacementRun: never;
      replacementDeps(): never;
    };
    return replaceDeleteFirstAndRecreate(
      engine.replacementRun,
      engine.replacementDeps(),
      'Cluster',
      c.type ?? CLUSTER,
      c.type ?? CLUSTER,
      record({}, c) as never,
      provider as never,
      provider as never,
      c.desired ?? { SourceDBClusterIdentifier: source, UseLatestRestorableTime: true },
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

  // go-to-k/cdkd#5639: an RDS point-in-time restore may name its source by
  // resource id; each delete-first path hands the guard the record's id.
  describe('by the recorded DBClusterResourceId (go-to-k/cdkd#5639)', () => {
    const RDS = 'AWS::RDS::DBCluster';
    const OWN = { DBClusterResourceId: 'cluster-OWNID123' };
    const byId = (id: string) => ({ SourceDbClusterResourceId: id, UseLatestRestorableTime: true });
    const paths: Array<[string, (c: Case) => Promise<unknown>]> = [
      ['--recreate via the SDK provider', (c) => recreateWith('viaSdkProvider', '', c)],
      ['--recreate via Cloud Control', (c) => recreateWith('viaCcApi', '', c)],
      ['the update-failure fallback', (c) => fallbackWith('', c)],
      ['the --replace delete-first fallback', (c) => replaceWith('', c)],
    ];

    it.each(paths)('%s refuses the own resource id before any delete', async (_path, run) => {
      const failure = await run({ type: RDS, attributes: OWN, desired: byId('CLUSTER-ownid123') });
      expect(chain(failure)).toMatch(/SourceDbClusterResourceId must be another cluster's/);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
    });

    it.each(paths)(
      '%s goes ahead for another id, a record without one, or another type',
      async (_path, run) => {
        for (const c of [
          { type: RDS, attributes: OWN, desired: byId('cluster-OTHER') },
          { type: RDS, attributes: { DBClusterResourceId: '' }, desired: byId('') },
          { type: RDS, attributes: {}, desired: { UseLatestRestorableTime: true } },
          { type: 'AWS::DocDB::DBCluster', attributes: OWN, desired: byId('cluster-OWNID123') },
          { type: 'AWS::Neptune::DBCluster', attributes: OWN, desired: byId('cluster-OWNID123') },
        ]) {
          provider.delete.mockClear();
          provider.create.mockClear();
          const failure = await run(c);
          expect(chain(failure), JSON.stringify(c)).not.toMatch(/must be another cluster/);
          expect(provider.delete, JSON.stringify(c)).toHaveBeenCalledTimes(1);
        }
      }
    );

    // A record holding no resource id: the live cluster's is read and compared.
    const NO_ID = { type: RDS, attributes: {}, desired: byId('cluster-OWNID123') };
    const live = (id: string | undefined) =>
      provider.import.mockResolvedValue({
        physicalId: PHYSICAL,
        attributes: id === undefined ? {} : { DBClusterResourceId: id },
      });

    it.each(paths)('%s refuses when the live cluster holds the source id', async (_path, run) => {
      live('CLUSTER-OWNID123');
      const failure = await run(NO_ID);
      expect(chain(failure)).toMatch(/SourceDbClusterResourceId must be another cluster's/);
      expect(provider.import).toHaveBeenCalledWith(
        expect.objectContaining({ knownPhysicalId: PHYSICAL, resourceType: RDS })
      );
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it.each(paths)('%s proceeds when the live cluster holds another id', async (_path, run) => {
      live('cluster-OTHER');
      expect(chain(await run(NO_ID))).not.toMatch(/SourceDbClusterResourceId/);
      expect(provider.delete).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'the read throws',
        () =>
          provider.import.mockRejectedValue(
            Object.assign(new Error('User arn:aws:iam::123456789012:role/x is not authorized'), {
              name: 'AccessDenied',
            })
          ),
      ],
      ['the cluster is not found', () => provider.import.mockResolvedValue(null)],
      ['the read answers no id', () => live(undefined)],
    ] as const)('refuses when %s, before any delete', async (_n, arrange) => {
      arrange();
      for (const [path, run] of paths) {
        provider.delete.mockClear();
        const failure = await run(NO_ID);
        expect(chain(failure), path).toMatch(/its identity could not be verified/);
        expect(provider.delete, path).not.toHaveBeenCalled();
      }
    });

    it('names only the failed read\'s class, never its text', async () => {
      provider.import.mockRejectedValue(
        Object.assign(new Error('User arn:aws:iam::123456789012:role/x is not authorized'), {
          name: 'AccessDenied',
        })
      );
      for (const [path, run] of paths) {
        const text = chain(await run(NO_ID));
        expect(text, path).toContain('(the read failed (AccessDenied))');
        expect(text, path).not.toContain('arn:aws:iam::123456789012:role/x');
      }
    });

    it('refuses when no provider can read the cluster, before any delete', async () => {
      const read = provider.import;
      (provider as { import?: unknown }).import = undefined;
      try {
        for (const [path, run] of paths) {
          provider.delete.mockClear();
          const failure = await run(NO_ID);
          expect(chain(failure), path).toMatch(/could not be verified \(no provider can read it\)/);
          expect(provider.delete, path).not.toHaveBeenCalled();
        }
      } finally {
        (provider as { import?: unknown }).import = read;
      }
    });

    it('reads nothing live for a record holding its id, another type, or no SourceDbClusterResourceId', async () => {
      for (const c of [
        { type: RDS, attributes: OWN, desired: byId('cluster-OTHER') },
        { type: 'AWS::DocDB::DBCluster', attributes: {}, desired: byId('cluster-OWNID123') },
        { type: 'AWS::Neptune::DBCluster', attributes: {}, desired: byId('cluster-OWNID123') },
        { type: RDS, attributes: {}, desired: { UseLatestRestorableTime: true } },
      ]) {
        for (const [, run] of paths) await run(c);
      }
      expect(provider.import).not.toHaveBeenCalled();
    });
  });

  // go-to-k/cdkd#5640: a DB instance restoring from one of its own automated
  // snapshots, which its delete removes; each delete-first path refuses it.
  describe('a DB instance restoring from its own automated snapshot (go-to-k/cdkd#5640)', () => {
    const INSTANCE: Case = { type: 'AWS::RDS::DBInstance' };
    const fromSnapshot = (snapshot: string): Case => ({
      ...INSTANCE,
      desired: { DBSnapshotIdentifier: snapshot },
    });
    const paths: Array<[string, (c: Case) => Promise<unknown>]> = [
      ['--recreate via the SDK provider', (c) => recreateWith('viaSdkProvider', '', c)],
      ['--recreate via Cloud Control', (c) => recreateWith('viaCcApi', '', c)],
      ['the update-failure fallback', (c) => fallbackWith('', c)],
      ['the --replace delete-first fallback', (c) => replaceWith('', c)],
    ];

    it.each(paths)('%s refuses it before any delete', async (_path, run) => {
      const failure = await run(fromSnapshot(`rds:${PHYSICAL}-2026-11-01-03-04`));
      expect(chain(failure)).toMatch(/automated snapshot of the DB instance/);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
    });

    it.each(paths)('%s lets a manual snapshot through', async (_path, run) => {
      expect(await run(fromSnapshot('manual-snap-1'))).toBeUndefined();
      expect(provider.delete).toHaveBeenCalledTimes(1);
    });
  });

  // go-to-k/cdkd#5640: a DB instance restored to a point in time from its own
  // automated backups, which its delete removes; each delete-first path refuses it.
  describe('a DB instance restoring to a point in time from itself (go-to-k/cdkd#5640)', () => {
    const INSTANCE = 'AWS::RDS::DBInstance';
    const OWN_ID = 'db-OWNID123';
    const OWN_BACKUPS = `arn:aws:rds:us-east-1:${ACCOUNT}:auto-backup:ab-ownid123`;
    const pitr = (source: Record<string, unknown>, attributes: Record<string, unknown> = {}): Case => ({
      type: INSTANCE,
      attributes,
      desired: { ...source, UseLatestRestorableTime: true },
    });
    const paths: Array<[string, (c: Case) => Promise<unknown>]> = [
      ['--recreate via the SDK provider', (c) => recreateWith('viaSdkProvider', '', c)],
      ['--recreate via Cloud Control', (c) => recreateWith('viaCcApi', '', c)],
      ['the update-failure fallback', (c) => fallbackWith('', c)],
      ['the --replace delete-first fallback', (c) => replaceWith('', c)],
    ];

    it.each(paths)('%s refuses its own SourceDBInstanceIdentifier before any delete', async (_p, run) => {
      for (const source of [PHYSICAL, PHYSICAL.toUpperCase(), `arn:aws:rds:us-east-1:${ACCOUNT}:db:${PHYSICAL}`]) {
        provider.delete.mockClear();
        const failure = await run(pitr({ SourceDBInstanceIdentifier: source }));
        expect(chain(failure), source).toMatch(
          /SourceDBInstanceIdentifier names the DB instance this creates or replaces/
        );
        expect(provider.delete, source).not.toHaveBeenCalled();
        expect(provider.create, source).not.toHaveBeenCalled();
      }
      expect(provider.resourceIdentity).not.toHaveBeenCalled();
    });

    it.each(paths)('%s lets another source instance through, with no live read', async (_p, run) => {
      for (const source of ['another-db', `arn:aws:rds:eu-west-1:${ACCOUNT}:db:${PHYSICAL}`]) {
        provider.delete.mockClear();
        expect(await run(pitr({ SourceDBInstanceIdentifier: source })), source).toBeUndefined();
        expect(provider.delete, source).toHaveBeenCalledTimes(1);
      }
      expect(provider.resourceIdentity).not.toHaveBeenCalled();
    });

    it.each(paths)('%s refuses when the live instance holds the source id, before any delete', async (_p, run) => {
      provider.resourceIdentity.mockResolvedValue(OWN_ID);
      for (const [key, value, refusal] of [
        ['SourceDbiResourceId', 'DB-ownid123', /SourceDbiResourceId must be another DB instance's/],
        [
          'SourceDBInstanceAutomatedBackupsArn',
          OWN_BACKUPS,
          /SourceDBInstanceAutomatedBackupsArn must name another DB instance's automated backups/,
        ],
      ] as const) {
        provider.delete.mockClear();
        provider.resourceIdentity.mockClear();
        const failure = await run(pitr({ [key]: value }));
        expect(chain(failure), key).toMatch(refusal);
        expect(provider.resourceIdentity, key).toHaveBeenCalledWith(PHYSICAL, INSTANCE, {
          expectedRegion: 'us-east-1',
        });
        expect(provider.delete, key).not.toHaveBeenCalled();
        expect(provider.create, key).not.toHaveBeenCalled();
      }
    });

    it.each(paths)('%s proceeds when the live instance holds another id', async (_p, run) => {
      provider.resourceIdentity.mockResolvedValue('db-OTHER');
      for (const source of [{ SourceDbiResourceId: OWN_ID }, { SourceDBInstanceAutomatedBackupsArn: OWN_BACKUPS }]) {
        provider.delete.mockClear();
        expect(await run(pitr(source)), JSON.stringify(source)).toBeUndefined();
        expect(provider.delete, JSON.stringify(source)).toHaveBeenCalledTimes(1);
      }
    });

    it.each([
      [
        'the read throws',
        () =>
          provider.resourceIdentity.mockRejectedValue(
            Object.assign(new Error('User arn:aws:iam::123456789012:role/x is not authorized'), {
              name: 'AccessDenied',
            })
          ),
        '(the read failed (AccessDenied))',
      ],
      [
        'the instance is not found',
        () => provider.resourceIdentity.mockResolvedValue(RESOURCE_NOT_FOUND),
        '(it was not found)',
      ],
      [
        'the read answers no id',
        () => provider.resourceIdentity.mockResolvedValue(undefined),
        '(no resource id was read)',
      ],
    ] as const)('refuses when %s, before any delete', async (_n, arrange, why) => {
      arrange();
      for (const [path, run] of paths) {
        provider.delete.mockClear();
        const text = chain(await run(pitr({ SourceDbiResourceId: OWN_ID })));
        expect(text, path).toMatch(/SourceDbiResourceId may name the DB instance this replacement deletes first/);
        expect(text, path).toContain(why);
        expect(text, path).not.toContain('arn:aws:iam::123456789012:role/x');
        expect(provider.delete, path).not.toHaveBeenCalled();
      }
    });

    it('refuses when no provider can read the instance, before any delete', async () => {
      const read = provider.resourceIdentity;
      (provider as { resourceIdentity?: unknown }).resourceIdentity = undefined;
      try {
        for (const [path, run] of paths) {
          provider.delete.mockClear();
          const failure = await run(pitr({ SourceDBInstanceAutomatedBackupsArn: OWN_BACKUPS }));
          expect(chain(failure), path).toMatch(/could not be verified \(no provider can read it\)/);
          expect(provider.delete, path).not.toHaveBeenCalled();
        }
      } finally {
        (provider as { resourceIdentity?: unknown }).resourceIdentity = read;
      }
    });

    it.each(paths)('%s compares a recorded DbiResourceId without a live read', async (_p, run) => {
      const failure = await run(pitr({ SourceDbiResourceId: OWN_ID }, { DbiResourceId: OWN_ID }));
      expect(chain(failure)).toMatch(/SourceDbiResourceId names the DB instance this creates or replaces/);
      expect(provider.delete).not.toHaveBeenCalled();
      provider.delete.mockClear();
      expect(await run(pitr({ SourceDbiResourceId: 'db-OTHER' }, { DbiResourceId: OWN_ID }))).toBeUndefined();
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(provider.resourceIdentity).not.toHaveBeenCalled();
    });

    it.each(paths)('%s skips the own-snapshot check under a point-in-time key', async (_p, run) => {
      // The handler restores to a point in time and never reads the snapshot.
      const failure = await run(
        pitr({ SourceDBInstanceIdentifier: 'another-db', DBSnapshotIdentifier: `rds:${PHYSICAL}-2026-11-01-03-04` })
      );
      expect(failure).toBeUndefined();
      expect(provider.delete).toHaveBeenCalledTimes(1);
    });
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

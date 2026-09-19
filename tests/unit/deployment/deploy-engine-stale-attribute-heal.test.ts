/**
 * Issue [#1852](https://github.com/go-to-k/cdkd/issues/1852), ENGINE half: the
 * deploy engine supplies the resolver's `attributeHealer`. Pinned here, with
 * the REAL resolver and a mocked provider registry:
 *
 * - the read is the provider's `import()` with `knownPhysicalId`, routed by the
 *   record's `resourceType` + `provisionedBy` (a `cc-api` record included);
 * - one read per record per deploy, however many resolutions miss (single
 *   flight), and a fresh one on the next `deploy()` of a reused engine;
 * - the read-back is MERGED into `attributes` at the state save — never into
 *   `properties` / `observedProperties` / `physicalId` / `provisionedBy`, never
 *   over a recorded value, never as an empty value;
 * - a failed read degrades to the pre-#1852 outcome and persists nothing;
 * - `--dry-run` may read but writes no state (both polarities);
 * - a heal survives a deploy that FAILS afterwards (the failure-path save).
 *
 * The resolver-side behaviour is in `stale-attribute-heal.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '111122223333' }) },
  }),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK = 'stale-attr-stack';
const REAL_ARN = 'arn:aws:ssm:us-east-1:111122223333:parameter/app/config';
const PARAM_PROPS = { Name: '/app/config', Type: 'String', Value: 'v' };

describe('DeployEngine - heals a stale attribute map on a Fn::GetAtt miss (#1852)', () => {
  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  const noChange = (ids: Record<string, string>): Map<string, ResourceChange> =>
    new Map(
      Object.entries(ids).map(([logicalId, resourceType]) => [
        logicalId,
        { logicalId, changeType: 'NO_CHANGE', resourceType } as ResourceChange,
      ])
    );

  beforeEach(() => {
    vi.clearAllMocks();
    resetAccountInfoCache();
    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
      import: vi.fn().mockResolvedValue({ physicalId: '/app/config', attributes: { Arn: REAL_ARN } }),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(noChange({ Param: 'AWS::SSM::Parameter' })),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
  });

  /** The pre-#1824 record: `{Type, Value}`, no `Arn`. */
  const staleRecord = (over: Partial<ResourceState> = {}): ResourceState => ({
    physicalId: '/app/config',
    resourceType: 'AWS::SSM::Parameter',
    properties: { ...PARAM_PROPS },
    observedProperties: { ...PARAM_PROPS },
    attributes: { Type: 'String', Value: 'v' },
    dependencies: [],
    ...over,
  });

  const stateOf = (resources: Record<string, ResourceState>): { state: StackState; etag: string } => ({
    state: {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK,
      resources,
      outputs: {},
      exportNames: [],
      lastModified: 0,
    },
    etag: 'etag-old',
  });

  /** v2 of the issue's repro: the ONLY change is the new output. */
  const template: CloudFormationTemplate = {
    Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: { ...PARAM_PROPS } } },
    Outputs: { ParamArn: { Value: { 'Fn::GetAtt': ['Param', 'Arn'] } } },
  };

  const makeEngine = (options: Record<string, unknown> = {}) =>
    new DeployEngine(
      mockStateBackend as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...options },
      'us-east-1'
    );

  const savedStates = (): StackState[] =>
    mockStateBackend.saveState!.mock.calls.map((c) => c[2] as StackState);

  it('resolves the output from a re-read and MERGES the attribute into the record', async () => {
    mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));

    const result = await makeEngine().deploy(STACK, template);

    expect(result.outputs?.['ParamArn']).toBe(REAL_ARN);
    expect(mockProvider.import).toHaveBeenCalledTimes(1);
    expect(mockProvider.import).toHaveBeenCalledWith({
      logicalId: 'Param',
      resourceType: 'AWS::SSM::Parameter',
      stackName: STACK,
      region: 'us-east-1',
      properties: PARAM_PROPS,
      knownPhysicalId: '/app/config',
    });
    // The resource itself was never touched.
    expect(mockProvider.update).not.toHaveBeenCalled();
    expect(mockProvider.create).not.toHaveBeenCalled();

    const saved = savedStates();
    expect(saved).toHaveLength(1);
    const record = saved[0]!.resources['Param']!;
    // Merged: the create-time attributes survive beside the healed one.
    expect(record.attributes).toEqual({ Type: 'String', Value: 'v', Arn: REAL_ARN });
    expect(record.properties).toEqual(PARAM_PROPS);
    expect(record.observedProperties).toEqual(PARAM_PROPS);
    expect(record.physicalId).toBe('/app/config');
    expect(record.provisionedBy).toBeUndefined();
    expect(saved[0]!.outputs['ParamArn']).toBe(REAL_ARN);
  });

  it('persists the heal even when it is the ONLY thing the no-change path has to save', async () => {
    // The output already holds the right value (say, a previous deploy healed
    // in memory but its save failed): outputs unchanged, nothing else pending.
    const loaded = stateOf({ Param: staleRecord() });
    loaded.state.outputs = { ParamArn: REAL_ARN };
    mockStateBackend.getState!.mockResolvedValue(loaded);

    await makeEngine().deploy(STACK, template);

    expect(savedStates()).toHaveLength(1);
    expect(savedStates()[0]!.resources['Param']!.attributes?.['Arn']).toBe(REAL_ARN);
  });

  it('issues NO read and NO extra save when the record already holds the attribute', async () => {
    const loaded = stateOf({
      Param: staleRecord({ attributes: { Type: 'String', Value: 'v', Arn: REAL_ARN } }),
    });
    loaded.state.outputs = { ParamArn: REAL_ARN };
    mockStateBackend.getState!.mockResolvedValue(loaded);

    await makeEngine().deploy(STACK, template);

    expect(mockProvider.import).not.toHaveBeenCalled();
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('is single-flight: many misses on one record cost ONE read', async () => {
    mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockProvider.import!.mockImplementation(async () => {
      await gate;
      return { physicalId: '/app/config', attributes: { Arn: REAL_ARN } };
    });
    const many: CloudFormationTemplate = {
      ...template,
      Outputs: {
        A: { Value: { 'Fn::GetAtt': ['Param', 'Arn'] } },
        B: { Value: { 'Fn::GetAtt': ['Param', 'Arn'] } },
        C: { Value: { 'Fn::Sub': 'x-${Param.Arn}' } },
      },
    };

    const deploy = makeEngine().deploy(STACK, many);
    // Let every output reach its miss before the one read answers.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const result = await deploy;

    expect(mockProvider.import).toHaveBeenCalledTimes(1);
    expect(result.outputs).toMatchObject({ A: REAL_ARN, B: REAL_ARN, C: `x-${REAL_ARN}` });
  });

  it('a reused engine reads AGAIN on its next deploy (the memo is per deploy)', async () => {
    mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
    const engine = makeEngine();
    await engine.deploy(STACK, template);
    mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
    await engine.deploy(STACK, template);
    expect(mockProvider.import).toHaveBeenCalledTimes(2);
  });

  it("routes the read by the record's provisionedBy — a cc-api record reads through CC", async () => {
    const ccProvider = {
      ...mockProvider,
      import: vi.fn().mockResolvedValue({ physicalId: '/app/config', attributes: { Arn: REAL_ARN } }),
    };
    mockProviderRegistry.getProviderFor!.mockImplementation(
      (input: { provisionedBy?: string }) =>
        input.provisionedBy === 'cc-api'
          ? { provider: ccProvider, provisionedBy: 'cc-api' }
          : { provider: mockProvider, provisionedBy: 'sdk' }
    );
    mockStateBackend.getState!.mockResolvedValue(
      stateOf({ Param: staleRecord({ provisionedBy: 'cc-api' }) })
    );

    const result = await makeEngine().deploy(STACK, template);

    expect(result.outputs?.['ParamArn']).toBe(REAL_ARN);
    expect(ccProvider.import).toHaveBeenCalledTimes(1);
    expect(mockProvider.import).not.toHaveBeenCalled();
    expect(mockProviderRegistry.getProviderFor).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'AWS::SSM::Parameter', provisionedBy: 'cc-api' })
    );
    const record = savedStates()[0]!.resources['Param']!;
    expect(record.provisionedBy).toBe('cc-api');
    expect(record.attributes?.['Arn']).toBe(REAL_ARN);
  });

  describe('a read that cannot heal degrades — never a failed deploy', () => {
    const denied = (): Error => {
      const err = new Error('User: arn:aws:sts::111122223333:assumed-role/D/s is not authorized');
      err.name = 'AccessDeniedException';
      (err as Error & { $metadata?: unknown }).$metadata = { httpStatusCode: 403 };
      return err;
    };

    it('AccessDenied: the deploy succeeds, the output is skipped, the message is true', async () => {
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
      mockProvider.import!.mockRejectedValue(denied());

      const result = await makeEngine().deploy(STACK, template);

      expect(result.outputs?.['ParamArn']).toBeUndefined();
      expect(mockProvider.import).toHaveBeenCalledTimes(1); // no retry
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('tried to re-read the attributes from AWS');
      expect(warned).toContain('AccessDeniedException, HTTP 403');
      expect(warned).not.toContain('not enriched');
      expect(warned).not.toContain('assumed-role');
      for (const s of savedStates()) {
        expect(s.resources['Param']!.attributes).toEqual({ Type: 'String', Value: 'v' });
      }
    });

    it('not found (import answers null): nothing persisted', async () => {
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
      mockProvider.import!.mockResolvedValue(null);

      await makeEngine().deploy(STACK, template);

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('AWS reports no resource behind the recorded physical id');
      for (const s of savedStates()) {
        expect(s.resources['Param']!.attributes).toEqual({ Type: 'String', Value: 'v' });
      }
    });

    it('a provider answering for a DIFFERENT resource heals nothing', async () => {
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
      mockProvider.import!.mockResolvedValue({
        physicalId: '/someone/elses',
        attributes: { Arn: 'arn:aws:ssm:us-east-1:999999999999:parameter/someone/elses' },
      });

      const result = await makeEngine().deploy(STACK, template);

      expect(result.outputs?.['ParamArn']).toBeUndefined();
      for (const s of savedStates()) {
        expect(s.resources['Param']!.attributes?.['Arn']).toBeUndefined();
      }
    });

    it('a provider with no import() is not asked, and the pre-#1852 message stands', async () => {
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
      delete mockProvider.import;

      await makeEngine().deploy(STACK, template);

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('attributes are not enriched for this resource type');
    });
  });

  it('never reads a custom resource — its attributes are handler Data, not an AWS read-back', async () => {
    mockDiffCalculator.calculateDiff!.mockResolvedValue(noChange({ Cr: 'Custom::Thing' }));
    mockStateBackend.getState!.mockResolvedValue(
      stateOf({
        Cr: {
          physicalId: 'cr-1',
          resourceType: 'Custom::Thing',
          properties: { ServiceToken: 'arn:aws:lambda:us-east-1:111122223333:function:h' },
          attributes: {},
        },
      })
    );
    await makeEngine().deploy(STACK, {
      Resources: { Cr: { Type: 'Custom::Thing', Properties: {} } },
      Outputs: { O: { Value: { 'Fn::GetAtt': ['Cr', 'SomeArn'] } } },
    });
    expect(mockProvider.import).not.toHaveBeenCalled();
  });

  describe('the merge never rewrites or invents', () => {
    it('a recorded value wins over the read-back; only ABSENT keys are added', async () => {
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
      mockProvider.import!.mockResolvedValue({
        physicalId: '/app/config',
        attributes: { Type: 'SecureString', Arn: REAL_ARN },
      });
      await makeEngine().deploy(STACK, template);
      expect(savedStates()[0]!.resources['Param']!.attributes).toEqual({
        Type: 'String',
        Value: 'v',
        Arn: REAL_ARN,
      });
    });

    it('the --no-wait DBInstance row: an instance with no endpoint yet caches NOTHING (#3077)', async () => {
      const db: ResourceState = {
        physicalId: 'mydb',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { DBInstanceIdentifier: 'mydb' },
        attributes: { Arn: 'arn:aws:rds:us-east-1:111122223333:db:mydb' },
      };
      mockDiffCalculator.calculateDiff!.mockResolvedValue(noChange({ Db: 'AWS::RDS::DBInstance' }));
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Db: db }));
      mockProvider.import!.mockResolvedValue({
        physicalId: 'mydb',
        attributes: { 'Endpoint.Address': '', 'Endpoint.Port': undefined },
      });
      const dbTemplate: CloudFormationTemplate = {
        Resources: { Db: { Type: 'AWS::RDS::DBInstance', Properties: {} } },
        Outputs: { Host: { Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } } },
      };

      const result = await makeEngine().deploy(STACK, dbTemplate);

      // Today's behaviour, kept: warn + the instance identifier.
      expect(result.outputs?.['Host']).toBe('mydb');
      for (const s of savedStates()) {
        expect(s.resources['Db']!.attributes).toEqual(db.attributes);
        expect(Object.hasOwn(s.resources['Db']!.attributes!, 'Endpoint.Address')).toBe(false);
      }
    });

    it('the --no-wait DBInstance row: once available, both endpoint attributes heal (#3077)', async () => {
      const db: ResourceState = {
        physicalId: 'mydb',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { DBInstanceIdentifier: 'mydb' },
        attributes: { Arn: 'arn:aws:rds:us-east-1:111122223333:db:mydb' },
      };
      mockDiffCalculator.calculateDiff!.mockResolvedValue(noChange({ Db: 'AWS::RDS::DBInstance' }));
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Db: db }));
      mockProvider.import!.mockResolvedValue({
        physicalId: 'mydb',
        attributes: { 'Endpoint.Address': 'mydb.abc.rds.amazonaws.com', 'Endpoint.Port': '3306' },
      });

      const result = await makeEngine().deploy(STACK, {
        Resources: { Db: { Type: 'AWS::RDS::DBInstance', Properties: {} } },
        Outputs: {
          Host: { Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] } },
          Port: { Value: { 'Fn::GetAtt': ['Db', 'Endpoint.Port'] } },
        },
      });

      expect(result.outputs).toMatchObject({ Host: 'mydb.abc.rds.amazonaws.com', Port: '3306' });
      expect(mockProvider.import).toHaveBeenCalledTimes(1);
      expect(savedStates()[0]!.resources['Db']!.attributes).toEqual({
        Arn: 'arn:aws:rds:us-east-1:111122223333:db:mydb',
        'Endpoint.Address': 'mydb.abc.rds.amazonaws.com',
        'Endpoint.Port': '3306',
      });
    });
  });

  describe('--dry-run writes no state', () => {
    /** A new resource consuming the stale attribute — resolved by the deploy's DIFF pass. */
    const consumerTemplate: CloudFormationTemplate = {
      Resources: {
        Param: template.Resources['Param']!,
        Copy: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/copy', Type: 'String', Value: { 'Fn::GetAtt': ['Param', 'Arn'] } },
        },
      },
    };
    const armDiffPass = (): void => {
      // The real DiffCalculator resolves the desired side through the fn it is
      // handed; this double does the same for the one property that matters.
      mockDiffCalculator.calculateDiff!.mockImplementation(
        async (_state: unknown, _tpl: unknown, resolveFn: (v: unknown) => Promise<unknown>) => {
          await resolveFn({ 'Fn::GetAtt': ['Param', 'Arn'] });
          return new Map<string, ResourceChange>([
            [
              'Copy',
              {
                logicalId: 'Copy',
                changeType: 'CREATE',
                resourceType: 'AWS::SSM::Parameter',
                desiredProperties: consumerTemplate.Resources['Copy']!.Properties,
              } as ResourceChange,
            ],
          ]);
        }
      );
      mockDiffCalculator.hasChanges!.mockReturnValue(true);
      mockDagBuilder.getExecutionLevels!.mockReturnValue([['Copy']]);
    };

    it('dry-run: the diff pass may READ, and nothing is saved', async () => {
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
      armDiffPass();

      await makeEngine({ dryRun: true }).deploy(STACK, consumerTemplate);

      expect(mockProvider.import).toHaveBeenCalledTimes(1);
      expect(mockStateBackend.saveState).not.toHaveBeenCalled();
      expect(mockProvider.create).not.toHaveBeenCalled();
    });

    it('real run of the same template: ONE read serves diff + provisioning, and the heal is saved', async () => {
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
      armDiffPass();
      mockProvider.create!.mockResolvedValue({ physicalId: '/app/copy', attributes: {} });

      await makeEngine().deploy(STACK, consumerTemplate);

      expect(mockProvider.import).toHaveBeenCalledTimes(1);
      expect(mockProvider.create).toHaveBeenCalledTimes(1);
      // The consumer was created with the REAL ARN, not a refusal and not the name.
      expect(mockProvider.create.mock.calls[0]![2]).toMatchObject({ Value: REAL_ARN });
      const last = savedStates().at(-1)!;
      expect(last.resources['Param']!.attributes).toEqual({
        Type: 'String',
        Value: 'v',
        Arn: REAL_ARN,
      });
    });

    it('a deploy that FAILS after the heal still persists the healed record', async () => {
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
      armDiffPass();
      mockProvider.create!.mockRejectedValue(new Error('ValidationException: bad value'));

      await expect(
        makeEngine({ noRollback: true }).deploy(STACK, consumerTemplate)
      ).rejects.toThrow();

      const saved = savedStates();
      expect(saved.length).toBeGreaterThan(0);
      expect(saved.at(-1)!.resources['Param']!.attributes?.['Arn']).toBe(REAL_ARN);
    });

    it('a record this deploy RE-WROTE is not re-read (its provider just answered)', async () => {
      // Param is UPDATED this run and its provider returns a fresh map with no
      // `Arn`; the output's miss is then the provider's answer, not staleness.
      mockStateBackend.getState!.mockResolvedValue(stateOf({ Param: staleRecord() }));
      const changed = { ...PARAM_PROPS, Value: 'v2' };
      mockDiffCalculator.calculateDiff!.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Param',
            {
              logicalId: 'Param',
              changeType: 'UPDATE',
              resourceType: 'AWS::SSM::Parameter',
              desiredProperties: changed,
              currentProperties: PARAM_PROPS,
              propertyChanges: [{ path: 'Value', oldValue: 'v', newValue: 'v2' }],
            } as unknown as ResourceChange,
          ],
        ])
      );
      mockDiffCalculator.hasChanges!.mockReturnValue(true);
      mockDagBuilder.getExecutionLevels!.mockReturnValue([['Param']]);
      mockProvider.update!.mockResolvedValue({
        physicalId: '/app/config',
        wasReplaced: false,
        attributes: { Type: 'String', Value: 'v2' },
      });

      await makeEngine().deploy(STACK, {
        Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: changed } },
        Outputs: template.Outputs,
      });

      expect(mockProvider.update).toHaveBeenCalledTimes(1);
      expect(mockProvider.import).not.toHaveBeenCalled();
    });
  });
});

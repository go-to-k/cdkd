import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { unwrittenCreateOnlyRefusal } from '../../../src/deployment/deploy-engine/update.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { getPropertyCoverage } from '../../../src/provisioning/property-coverage.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { PropertyChange, ResourceChange } from '../../../src/types/state.js';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

/**
 * go-to-k/cdkd#2790 — the ENGINE half.
 *
 * A create-only silent drop an earlier deploy accepted with
 * `--prefer-sdk-route` was never written, and the record keeps
 * it. Once the flag is gone the diff reports it as an addition — a
 * REPLACEMENT — and the only thing that moved is the flag. The engine refuses
 * that replacement unless the user opted into it (`--replace`, or naming the
 * resource in `--recreate-via-cc-api`), before anything is deleted.
 *
 * `AWS::EC2::Subnet` / `AvailabilityZoneId` is the pair
 * `tests/integration/sdk-to-cc-autoroute/` deploys.
 */
describe('DeployEngine — a replacement driven only by an unwritten create-only drop (#2790)', () => {
  const TYPE = 'AWS::EC2::Subnet';
  const CREATE_ONLY = 'AvailabilityZoneId';
  const PLAIN = 'EnableDns64';
  const WRITTEN = { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/24' };
  const DECLARED = { ...WRITTEN, [CREATE_ONLY]: 'use1-az1' };
  const ADDED: PropertyChange = {
    path: CREATE_ONLY,
    oldValue: undefined,
    newValue: 'use1-az1',
    requiresReplacement: true,
  };

  let callOrder: string[];
  let provider: ResourceProvider;
  let allowed: ReadonlySet<string>;

  beforeEach(() => {
    callOrder = [];
    allowed = new Set();
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: 'subnet-new', attributes: {} };
      }),
      update: vi.fn().mockImplementation(async () => {
        callOrder.push('update');
        return { physicalId: 'subnet-old', wasReplaced: false, attributes: {} };
      }),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  it('PREMISE: AvailabilityZoneId is a create-only drop, EnableDns64 a plain one', () => {
    const cov = getPropertyCoverage(TYPE);
    if (!cov) throw new Error(`${TYPE} lost its property-coverage record`);
    expect(cov.createOnlyDrops.has(CREATE_ONLY)).toBe(true);
    expect(cov.createOnlyDrops.has(PLAIN)).toBe(false);
    expect(cov.silentDrop.has(PLAIN)).toBe(true);
  });

  function makeEngine(options: Record<string, unknown> = {}): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      getAllowedUnsupportedProperties: vi.fn(() => allowed),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') } as never,
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
      registry as never,
      options,
      'us-east-1'
    );
  }

  async function provision(
    engine: InstanceType<typeof DeployEngine>,
    opts: {
      recorded?: Record<string, unknown>;
      desired?: Record<string, unknown>;
      changes?: PropertyChange[];
      provisionedBy?: 'sdk' | 'cc-api';
    } = {}
  ): Promise<void> {
    const recorded = opts.recorded ?? DECLARED;
    const desired = opts.desired ?? DECLARED;
    const change: ResourceChange = {
      logicalId: 'MySubnet',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: recorded,
      desiredProperties: desired,
      propertyChanges: opts.changes ?? [ADDED],
    };
    const stateResources = {
      MySubnet: {
        physicalId: 'subnet-old',
        resourceType: TYPE,
        properties: recorded,
        attributes: {},
        dependencies: [],
        provisionedBy: opts.provisionedBy ?? 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { MySubnet: { Type: TYPE, Properties: desired } },
    };
    const provisionResource = (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource.bind(engine);
    await provisionResource('MySubnet', change, stateResources, 'MyStack', template);
  }

  async function refusal(
    engine: InstanceType<typeof DeployEngine>,
    opts?: Parameters<typeof provision>[1]
  ) {
    return provision(engine, opts).then(
      () => null,
      (e) => e as Error & { cause?: Error & { code?: string } }
    );
  }

  it('REFUSES with no flag, before anything is deleted or created', async () => {
    const err = await refusal(makeEngine());
    expect(err).not.toBeNull();
    expect(err!.cause?.code).toBe('CREATE_ONLY_DROP_NEEDS_REPLACEMENT');
    expect(isMarkedNonRetryable(err!.cause)).toBe(true);
    expect(err!.cause?.message).toContain(`MySubnet (${TYPE}): ${CREATE_ONLY} is create-only`);
    expect(err!.cause?.message).toContain('--recreate-via-cc-api MySubnet');
    expect(callOrder).toEqual([]);
  });

  it('--replace opts in: the resource is replaced', async () => {
    await provision(makeEngine({ replace: true }));
    expect(callOrder).toContain('create');
    expect(callOrder).toContain('delete');
  });

  it('--recreate-via-cc-api naming the resource opts in', async () => {
    await provision(
      makeEngine({
        recreateTargets: {
          stackName: 'MyStack',
          viaCcApi: new Set(['MySubnet']),
          viaSdkProvider: new Set(),
        },
      })
    );
    expect(callOrder).toContain('create');
    expect(callOrder).toContain('delete');
  });

  it('a recreate target of ANOTHER stack does not opt this one in', async () => {
    const err = await refusal(
      makeEngine({
        recreateTargets: {
          stackName: 'OtherStack',
          viaCcApi: new Set(['MySubnet']),
          viaSdkProvider: new Set(),
        },
      })
    );
    expect(err!.cause?.code).toBe('CREATE_ONLY_DROP_NEEDS_REPLACEMENT');
  });

  it('lets a replacement through when ANOTHER property also requires it', async () => {
    const desired = { ...DECLARED, CidrBlock: '10.0.1.0/24' };
    await provision(makeEngine(), {
      desired,
      changes: [
        ADDED,
        {
          path: 'CidrBlock',
          oldValue: '10.0.0.0/24',
          newValue: '10.0.1.0/24',
          requiresReplacement: true,
        },
      ],
    });
    expect(callOrder).toContain('create');
  });

  it('lets a replacement through when the template CHANGED the create-only value', async () => {
    const desired = { ...DECLARED, [CREATE_ONLY]: 'use1-az2' };
    await provision(makeEngine(), {
      desired,
      changes: [{ ...ADDED, newValue: 'use1-az2' }],
    });
    expect(callOrder).toContain('create');
  });

  it('a cc-api record is never refused: Cloud Control DID write the key', async () => {
    // A second, in-place change keeps the no-change re-check from absorbing
    // the case, so it reaches the refusal's own route gate.
    await provision(makeEngine(), {
      provisionedBy: 'cc-api',
      desired: { ...DECLARED, MapPublicIpOnLaunch: true },
      changes: [
        ADDED,
        {
          path: 'MapPublicIpOnLaunch',
          oldValue: undefined,
          newValue: true,
          requiresReplacement: false,
        },
      ],
    });
    expect(callOrder).toContain('create');
  });

  /**
   * The flag-ful redeploy, which the record keeping the drop exists for: the
   * re-check keeps the key on BOTH sides, so a change the diff reported as
   * this replacement is absorbed and nothing is called.
   */
  it('under the flag, the no-change re-check absorbs it: no refusal, no provider call', async () => {
    allowed = new Set([`${TYPE}:${CREATE_ONLY}`]);
    await provision(makeEngine());
    expect(callOrder).toEqual([]);
  });

  it('names every route-driving drop in the keep-dropping remedy', async () => {
    allowed = new Set([`${TYPE}:${CREATE_ONLY}`]);
    const err = await refusal(makeEngine(), { desired: { ...DECLARED, [PLAIN]: true } });
    expect(err!.cause?.code).toBe('CREATE_ONLY_DROP_NEEDS_REPLACEMENT');
    expect(err!.cause?.message).toContain(
      `--prefer-sdk-route ${TYPE}:${CREATE_ONLY},${TYPE}:${PLAIN}.`
    );
  });

  it('inside a nested child, names only --replace', async () => {
    const err = await refusal(
      makeEngine({
        parentStackInfo: { parentStack: 'P', parentLogicalId: 'C', parentRegion: 'us-east-1' },
      })
    );
    expect(err!.cause?.message).toContain('re-run with --replace;');
    expect(err!.cause?.message).not.toContain('--recreate-via-cc-api');
  });
});

describe('unwrittenCreateOnlyRefusal', () => {
  const base = {
    logicalId: 'Db',
    resourceType: 'AWS::RDS::DBInstance',
    routeDriving: [] as string[],
    nested: false,
  };

  it('agrees in number with one property', () => {
    const msg = unwrittenCreateOnlyRefusal({ ...base, unwritten: ['DBName'] });
    expect(msg).toContain('DBName is create-only and was never written to AWS');
    expect(msg).toContain('To keep dropping it,');
    expect(msg).toContain('--prefer-sdk-route AWS::RDS::DBInstance:DBName.');
  });

  it('agrees in number with several, and sorts and de-duplicates the keep list', () => {
    const msg = unwrittenCreateOnlyRefusal({
      ...base,
      unwritten: ['Timezone', 'DBName'],
      routeDriving: ['Timezone', 'DBName', 'BackupTarget'],
    });
    expect(msg).toContain('Timezone, DBName are create-only and were never written to AWS');
    expect(msg).toContain('To keep dropping them,');
    expect(msg).toContain(
      '--prefer-sdk-route ' +
        'AWS::RDS::DBInstance:BackupTarget,AWS::RDS::DBInstance:DBName,AWS::RDS::DBInstance:Timezone.'
    );
  });

  it('names the stateful consent flag', () => {
    expect(unwrittenCreateOnlyRefusal({ ...base, unwritten: ['DBName'] })).toContain(
      '--force-stateful-recreation'
    );
  });
});

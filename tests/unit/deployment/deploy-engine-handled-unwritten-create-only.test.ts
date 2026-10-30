import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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
 * go-to-k/cdkd#5572 — the ENGINE half. The replacement the diff now reports
 * for an unwritten create-only key the SDK provider has started writing is
 * refused like #2790's (`CREATE_ONLY_DROP_NEEDS_REPLACEMENT`) unless opted
 * into, and the refusal says the provider now writes the key.
 */
describe('DeployEngine — an unwritten create-only key the provider now writes (#5572)', () => {
  const TYPE = 'AWS::S3Tables::Table';
  const KEY = 'StorageClassConfiguration';
  const DECLARED = {
    TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
    Namespace: 'ns',
    TableName: 't',
    OpenTableFormat: 'ICEBERG',
    [KEY]: { StorageClass: 'INTELLIGENT_TIERING' },
  };

  let callOrder: string[];
  let provider: ResourceProvider;

  beforeEach(() => {
    callOrder = [];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: 'ns|t2', attributes: {} };
      }),
      update: vi.fn().mockImplementation(async () => {
        callOrder.push('update');
        return { physicalId: 'ns|t', wasReplaced: false, attributes: {} };
      }),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      getAllowedUnsupportedProperties: vi.fn(() => new Set([`${TYPE}:${KEY}`])),
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

  async function provision(engine: InstanceType<typeof DeployEngine>): Promise<void> {
    const change: ResourceChange = {
      logicalId: 'IcebergTable',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: DECLARED,
      desiredProperties: DECLARED,
      propertyChanges: [
        { path: KEY, oldValue: undefined, newValue: DECLARED[KEY], requiresReplacement: true },
      ],
    };
    const stateResources = {
      IcebergTable: {
        physicalId: 'ns|t',
        resourceType: TYPE,
        properties: DECLARED,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
        acceptedCreateOnlyDrops: [KEY],
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { IcebergTable: { Type: TYPE, Properties: DECLARED } },
    };
    await provisionResource(
      engine,
      'IcebergTable',
      change,
      stateResources as unknown as Record<string, never>,
      'MyStack',
      template
    );
  }

  it('REFUSES, even under the old flag, before anything is sent', async () => {
    const err = await provision(makeEngine()).then(
      () => null,
      (e) => e as Error & { cause?: Error & { code?: string } }
    );
    expect(err).not.toBeNull();
    expect(err!.cause?.code).toBe('CREATE_ONLY_DROP_NEEDS_REPLACEMENT');
    expect(isRefusedBeforeApplying(err, 'IcebergTable')).toBe(true);
    expect(err!.cause?.message).toContain(`This cdkd version's SDK provider writes ${KEY}`);
    expect(err!.cause?.message).toContain(`remove ${KEY} from the template`);
    expect(callOrder).toEqual([]);
  });

  it('--recreate-via-cc-api naming the resource opts in (a Table is stateful, so with consent)', async () => {
    await provision(
      makeEngine({
        forceStatefulRecreation: true,
        recreateTargets: {
          stackName: 'MyStack',
          viaCcApi: new Set(['IcebergTable']),
          viaSdkProvider: new Set(),
        },
      })
    );
    expect(callOrder).toContain('create');
    expect(callOrder).toContain('delete');
  });

  it('--replace opts in: the resource is replaced (a Table is stateful, so with consent)', async () => {
    await provision(makeEngine({ replace: true, forceStatefulRecreation: true }));
    expect(callOrder).toContain('create');
    expect(callOrder).toContain('delete');
  });
});

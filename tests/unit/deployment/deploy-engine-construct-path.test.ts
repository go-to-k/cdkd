/**
 * `ResourceState.constructPath` (#4607): every deploy save stamps each record
 * with its template `aws:cdk:path`, so a resource the template later drops is
 * still listed by construct path. Harness: `deploy-engine-require-approval.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK_NAME = 'MyStack';

function record(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'pid',
    resourceType: 'AWS::SQS::Queue',
    properties: { Marker: 'old' },
    attributes: {},
    dependencies: [],
    ...extra,
  } as ResourceState;
}

const inPlaceUpdate: ResourceChange = {
  logicalId: 'Kept',
  changeType: 'UPDATE',
  resourceType: 'AWS::SQS::Queue',
  currentProperties: { Marker: 'old' },
  desiredProperties: { Marker: 'new' },
  propertyChanges: [{ path: 'Marker', oldValue: 'old', newValue: 'new', requiresReplacement: false }],
};

describe('DeployEngine stamps constructPath on every save', () => {
  let getState: ReturnType<typeof vi.fn>;
  let saveState: ReturnType<typeof vi.fn>;
  let calculateDiff: ReturnType<typeof vi.fn>;
  let hasChanges: ReturnType<typeof vi.fn>;
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
    update: vi.fn().mockResolvedValue({ physicalId: 'pid' }),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getState = vi.fn();
    saveState = vi.fn().mockResolvedValue('etag-new');
    calculateDiff = vi.fn();
    hasChanges = vi.fn().mockReturnValue(true);
  });

  function engine() {
    return new DeployEngine(
      { getState, saveState } as never,
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
        calculateDiff,
        hasChanges,
        filterByType: vi
          .fn()
          .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
            Array.from(changes.values()).filter((c) => c.changeType === type)
          ),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  function load(resources: Record<string, ResourceState>, outputs: Record<string, string> = {}) {
    getState.mockResolvedValue({
      state: {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: 'us-east-1',
        stackName: STACK_NAME,
        resources,
        outputs,
        lastModified: 0,
      },
      etag: 'etag-old',
    });
  }

  const template = (extra: Record<string, unknown> = {}): CloudFormationTemplate =>
    ({
      Resources: {
        Kept: {
          Type: 'AWS::SQS::Queue',
          Properties: { Marker: 'new' },
          Metadata: { 'aws:cdk:path': 'MyStack/Data/Kept/Resource' },
        },
        NoPath: { Type: 'AWS::SQS::Queue', Properties: { Marker: 'old' } },
      },
      ...extra,
    }) as CloudFormationTemplate;

  it('stamps an updated record and an unchanged one, and keeps a template-less record as recorded', async () => {
    load({
      Kept: record(),
      NoPath: record({ physicalId: 'np' }),
      // A record the template no longer declares, whose DELETE is not in this
      // diff (a failed earlier delete): it keeps the path it was stamped with.
      Leftover: record({ physicalId: 'lo', constructPath: 'MyStack/Old/Leftover/Resource' }),
    });
    calculateDiff.mockResolvedValue(new Map([['Kept', inPlaceUpdate]]));
    await engine().deploy(STACK_NAME, template());
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Kept']!.constructPath).toBe('MyStack/Data/Kept/Resource');
    expect(saved.resources['NoPath']).not.toHaveProperty('constructPath');
    expect(saved.resources['Leftover']!.constructPath).toBe('MyStack/Old/Leftover/Resource');
  });

  it('stamps on a no-change save (an Outputs-only change), with no extra save', async () => {
    load({ Kept: record(), NoPath: record({ physicalId: 'np' }) }, { Url: 'old' });
    calculateDiff.mockResolvedValue(new Map());
    hasChanges.mockReturnValue(false);
    await engine().deploy(STACK_NAME, template({ Outputs: { Url: { Value: 'new' } } }));
    expect(saveState).toHaveBeenCalledTimes(1);
    const saved = saveState.mock.calls[0]![2] as StackState;
    expect(saved.resources['Kept']!.constructPath).toBe('MyStack/Data/Kept/Resource');
  });

  it('adds no save to a no-change deploy with nothing else to write', async () => {
    load({ Kept: record(), NoPath: record({ physicalId: 'np' }) });
    calculateDiff.mockResolvedValue(new Map());
    hasChanges.mockReturnValue(false);
    await engine().deploy(STACK_NAME, template());
    expect(saveState).not.toHaveBeenCalled();
  });

  it('stamps each deploy from its own template, never a previous deploy\'s on the same engine', async () => {
    const shared = engine();
    load({ Kept: record(), NoPath: record({ physicalId: 'np' }) });
    calculateDiff.mockResolvedValue(new Map([['Kept', inPlaceUpdate]]));
    await shared.deploy(STACK_NAME, template());
    // A second stack (as a child engine would be: a different template) whose
    // `Kept` declares no path must not inherit the first deploy's.
    load({ Kept: record() });
    calculateDiff.mockResolvedValue(new Map([['Kept', inPlaceUpdate]]));
    await shared.deploy('OtherStack', {
      Resources: { Kept: { Type: 'AWS::SQS::Queue', Properties: { Marker: 'new' } } },
    } as CloudFormationTemplate);
    expect(saveState.mock.calls.at(-1)![0]).toBe('OtherStack');
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Kept']).not.toHaveProperty('constructPath');
  });
});

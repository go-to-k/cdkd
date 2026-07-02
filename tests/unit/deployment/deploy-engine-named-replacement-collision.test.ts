import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

/**
 * Custom-named resource requiring a property-driven replacement (issue #960
 * follow-up): the CFn-safe create-first order collides with the old resource
 * still holding the user-supplied name. Without --replace the deploy must
 * fail with the actionable NAMED_REPLACEMENT_COLLISION error (CloudFormation
 * parity: "cannot update a stack when a custom-named resource requires
 * replacing"); with --replace the engine falls back to delete-first and the
 * replacement proceeds under the same name.
 */
describe('DeployEngine — custom-named replacement collision', () => {
  let callOrder: string[];
  let provider: ResourceProvider;
  let createFailures: Error[];

  const TYPE = 'AWS::Pipes::Pipe'; // non-stateful: the stateful guard stays out of the way

  const alreadyExists = () =>
    new Error(
      "CREATE failed for Pipe: Resource of type 'AWS::Pipes::Pipe' with identifier 'my-pipe' already exists."
    );

  beforeEach(() => {
    callOrder = [];
    createFailures = [];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        const failure = createFailures.shift();
        if (failure) throw failure;
        return { physicalId: 'my-pipe', attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(opts: { replace?: boolean } = {}): InstanceType<typeof DeployEngine> {
    const mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as unknown as never,
      mockLockManager as unknown as never,
      mockDagBuilder as unknown as never,
      mockDiffCalculator as unknown as never,
      mockProviderRegistry as unknown as never,
      { ...(opts.replace !== undefined && { replace: opts.replace }) },
      'us-east-1'
    );
  }

  async function invokeProvision(
    engine: InstanceType<typeof DeployEngine>,
    { retain = false }: { retain?: boolean } = {}
  ): Promise<void> {
    const change: ResourceChange = {
      logicalId: 'Pipe',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { Name: 'my-pipe', Source: 'arn:a' },
      desiredProperties: { Name: 'my-pipe', Source: 'arn:b' },
      propertyChanges: [
        { path: 'Source', oldValue: 'arn:a', newValue: 'arn:b', requiresReplacement: true },
      ],
    };
    const stateResources: Record<string, StateRecord> = {
      Pipe: {
        physicalId: 'my-pipe',
        resourceType: TYPE,
        properties: { Name: 'my-pipe', Source: 'arn:a' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Pipe: {
          Type: TYPE,
          Properties: { Name: 'my-pipe', Source: 'arn:b' },
          ...(retain && { UpdateReplacePolicy: 'Retain' }),
        },
      },
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
    await provisionResource('Pipe', change, stateResources, 'MyStack', template);
  }

  it('fails with the actionable collision error without --replace (old resource untouched)', async () => {
    createFailures = [alreadyExists()];

    const err = await invokeProvision(makeEngine()).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/custom-named resource requires replacing/);
    expect(err!.cause?.message).toMatch(/rename the resource/i);
    expect(err!.cause?.message).toMatch(/cdkd deploy --replace/);
    // The safe create-first order left the old resource alive.
    expect(callOrder).toEqual(['create']);
  });

  it('falls back to delete-first under --replace and re-creates under the same name', async () => {
    createFailures = [alreadyExists()];

    await invokeProvision(makeEngine({ replace: true }));

    // Collided create-first -> delete the old name holder -> re-create.
    expect(callOrder).toEqual(['create', 'delete', 'create']);
    expect(provider.delete).toHaveBeenCalledWith(
      'Pipe',
      'my-pipe',
      TYPE,
      { Name: 'my-pipe', Source: 'arn:a' },
      { expectedRegion: 'us-east-1' }
    );
  });

  it('refuses a same-name replacement under UpdateReplacePolicy: Retain even with --replace', async () => {
    createFailures = [alreadyExists()];

    const err = await invokeProvision(makeEngine({ replace: true }), { retain: true }).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/UpdateReplacePolicy: Retain pins that resource/);
    expect(callOrder).toEqual(['create']);
  });

  it('passes a NON-collision create failure through unchanged', async () => {
    createFailures = [new Error('AccessDenied: not authorized')];

    const err = await invokeProvision(makeEngine({ replace: true })).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/AccessDenied/);
    expect(err!.cause?.message).not.toMatch(/custom-named/);
    expect(callOrder).toEqual(['create']);
  });
});

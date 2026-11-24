/**
 * go-to-k/cdkd#6871: `cdkd deploy` merges the stack's `StackProps.tags` into
 * each taggable resource before the diff, so creates, in-place updates and
 * the recorded state all carry them; a nested row runs its child when the
 * child's effective tags change. Harness from
 * `deploy-engine-termination-protection.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { resetRefactorMarkerReadsForTest } from '../../../src/state/refactor-marker.js';

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

vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'S';
const REGION = 'us-east-1';
const ROW = 'AWS::CloudFormation::Stack';

const savedStates = (save: ReturnType<typeof vi.fn>) =>
  save.mock.calls.map((c) => c[2] as StackState);

function makeState(resources: Record<string, unknown>, patch: Partial<StackState> = {}): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: resources as never,
    outputs: {},
    lastModified: 0,
    ...patch,
  };
}

// Queue (list-shaped Tags) declaring a key the stack shares, and a
// map-shaped SSM parameter. The inert CloudFormation client fails every
// DescribeType, so both resolve through the bundled property-shape rows.
const template: CloudFormationTemplate = {
  Resources: {
    Q: { Type: 'AWS::SQS::Queue', Properties: { Tags: [{ Key: 'shared', Value: 'fromresource' }] } },
    P: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'v' } },
  },
};

describe('cdkd deploy applies stack tags (go-to-k/cdkd#6871)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let provider: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRefactorMarkerReadsForTest();
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-new') };
    provider = {
      create: vi.fn().mockImplementation(async (id: string) => ({ physicalId: `${id}-p` })),
      update: vi.fn().mockImplementation(async (id: string) => ({ physicalId: `${id}-p`, wasReplaced: false })),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn().mockResolvedValue(undefined),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
  });

  function makeEngine(levels: string[][], options: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue(levels),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        reportSdkUnwiredDecisions: vi.fn(),
        getEffectivePropertiesFn: vi.fn().mockReturnValue(undefined),
      } as never,
      options,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const createdProps = (id: string) =>
    provider.create.mock.calls.find((c) => c[0] === id)?.[2] as Record<string, unknown> | undefined;

  it('creates each taggable resource with the stack tags merged, its own key winning, and records them', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'e' });
    const input = structuredClone(template);
    await makeEngine([['Q', 'P']], { stackTags: { shared: 'fromstack', team: 'platform' } }).deploy(
      STACK,
      input
    );
    expect(createdProps('Q')?.['Tags']).toEqual([
      { Key: 'shared', Value: 'fromresource' },
      { Key: 'team', Value: 'platform' },
    ]);
    expect(createdProps('P')?.['Tags']).toEqual({ shared: 'fromstack', team: 'platform' });
    const last = savedStates(stateBackend.saveState).at(-1)!;
    expect((last.resources['P']!.properties as Record<string, unknown>)['Tags']).toEqual({
      shared: 'fromstack',
      team: 'platform',
    });
    // The caller's template is never mutated.
    expect(input).toEqual(template);
  });

  it('CONTROL: without stack tags nothing is merged', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'e' });
    await makeEngine([['Q', 'P']]).deploy(STACK, structuredClone(template));
    expect(createdProps('Q')?.['Tags']).toEqual([{ Key: 'shared', Value: 'fromresource' }]);
    expect(createdProps('P')?.['Tags']).toBeUndefined();
  });

  it('a stack-tag-only change updates the resource in place with the new tags', async () => {
    const recordedParam = {
      resourceType: 'AWS::SSM::Parameter',
      physicalId: 'P-p',
      properties: { Type: 'String', Value: 'v', Tags: { shared: 'fromstack', team: 'platform' } },
      attributes: {},
      dependencies: [],
    };
    stateBackend.getState.mockResolvedValue({
      state: makeState({ P: recordedParam }),
      etag: 'e',
    });
    await makeEngine([['P']], { stackTags: { team: 'core' } }).deploy(STACK, {
      Resources: { P: template.Resources['P']! },
    });
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect((provider.update.mock.calls[0]![3] as Record<string, unknown>)['Tags']).toEqual({
      team: 'core',
    });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("runs a nested row whose child's tags changed, and records the child's tags", async () => {
    const nested = { Type: ROW, Properties: { TemplateURL: 'u' } };
    const rowRecord = {
      resourceType: ROW,
      physicalId: 'arn:cdkd-local:x',
      properties: { TemplateURL: 'u' },
      attributes: {},
      dependencies: [],
    };
    stateBackend.getState.mockResolvedValue({ state: makeState({ Child: rowRecord }), etag: 'e' });
    await makeEngine([['Child']], { stackTags: { team: 'platform' } }).deploy(STACK, {
      Resources: { Child: nested },
    });
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(provider.update.mock.calls[0]![0]).toBe('Child');
    expect(savedStates(stateBackend.saveState).at(-1)!.nestedStackTags).toEqual({
      Child: { team: 'platform' },
    });

    // Deployed again with the same tags, the row stays unchanged.
    provider.update.mockClear();
    stateBackend.saveState.mockClear();
    stateBackend.getState.mockResolvedValue({
      state: makeState({ Child: rowRecord }, { nestedStackTags: { Child: { team: 'platform' } } }),
      etag: 'e2',
    });
    await makeEngine([['Child']], { stackTags: { team: 'platform' } }).deploy(STACK, {
      Resources: { Child: nested },
    });
    expect(provider.update).not.toHaveBeenCalled();
  });

  it('CONTROL: an untagged nested row with no recorded field is not run', async () => {
    const rowRecord = {
      resourceType: ROW,
      physicalId: 'arn:cdkd-local:x',
      properties: { TemplateURL: 'u' },
      attributes: {},
      dependencies: [],
    };
    stateBackend.getState.mockResolvedValue({ state: makeState({ Child: rowRecord }), etag: 'e' });
    await makeEngine([['Child']]).deploy(STACK, {
      Resources: { Child: { Type: ROW, Properties: { TemplateURL: 'u' } } },
    });
    expect(provider.update).not.toHaveBeenCalled();
  });

  it('drops the recorded field once no nested row has tags, so the next deploy runs nothing (test review)', async () => {
    const rowRecord = {
      resourceType: ROW,
      physicalId: 'arn:cdkd-local:x',
      properties: { TemplateURL: 'u' },
      attributes: {},
      dependencies: [],
    };
    const nested = { Resources: { Child: { Type: ROW, Properties: { TemplateURL: 'u' } } } };
    stateBackend.getState.mockResolvedValue({
      state: makeState({ Child: rowRecord }, { nestedStackTags: { Child: { team: 'x' } } }),
      etag: 'e',
    });
    await makeEngine([['Child']]).deploy(STACK, structuredClone(nested));
    // The tags were removed: the child runs once to untag, and the record drops the field.
    expect(provider.update).toHaveBeenCalledTimes(1);
    const saved = savedStates(stateBackend.saveState).at(-1)!;
    expect(Object.hasOwn(saved, 'nestedStackTags')).toBe(false);

    provider.update.mockClear();
    stateBackend.getState.mockResolvedValue({ state: saved, etag: 'e2' });
    await makeEngine([['Child']]).deploy(STACK, structuredClone(nested));
    expect(provider.update).not.toHaveBeenCalled();
  });
});

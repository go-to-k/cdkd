import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type {
  ResourceState,
  StackState,
  SupersededResourceRecord,
} from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#6117: a custom resource's old physical id left in
// `supersededResources` (a failed `--no-rollback` deploy, a killed one) is
// deleted through its handler, which the stack's own resources (the
// ServiceToken function, a provider framework) take down. So `cdkd destroy`
// deletes it BEFORE them; every other superseded type still goes AFTER them.

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
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

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:handler';

function record(physicalId: string, resourceType: string, dependencies: string[] = []): ResourceState {
  return {
    physicalId,
    resourceType,
    properties: resourceType.startsWith('Custom::') ? { ServiceToken: TOKEN, Name: physicalId } : {},
    attributes: {},
    dependencies,
  };
}

const superseded = (logicalId: string, state: ResourceState): SupersededResourceRecord => ({
  logicalId,
  supersededAt: 1,
  state,
});

describe("runDestroyForStack deletes a custom resource's superseded old id first (#6117)", () => {
  const order: string[] = [];
  const mockDeleteState = vi.fn();
  /** The answers the old id's deletes give, in turn (default: deleted). */
  let oldIdAnswers: Array<'throw' | 'skip'> = [];

  function run(state: StackState): ReturnType<typeof runDestroyForStack> {
    return runDestroyForStack('TestStack', state, {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: mockDeleteState,
        getState: vi.fn(async () => ({ state, etag: 'e' })),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({
          provider: {
            delete: vi.fn(async (_logicalId: string, physicalId: string) => {
              order.push(physicalId);
              if (physicalId !== 'name-1') return undefined;
              const answer = oldIdAnswers.shift();
              if (answer === 'throw') throw new Error('the old id is still in use');
              if (answer === 'skip') return { outcome: 'skipped', reason: 'handler answered FAILED' };
              return undefined;
            }),
          },
        }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as never);
  }

  beforeEach(() => {
    order.length = 0;
    oldIdAnswers = [];
    mockDeleteState.mockReset().mockResolvedValue(undefined);
  });

  it("sends the old id's Delete before the handler and the rest of the stack go", async () => {
    const state: StackState = {
      version: 15,
      stackName: 'TestStack',
      region: REGION,
      resources: {
        Handler: record('handler', 'AWS::Lambda::Function'),
        Res: record('name-2', 'Custom::Thing', ['Handler']),
      },
      outputs: {},
      lastModified: 1,
      supersededResources: [
        superseded('Res', record('name-1', 'Custom::Thing')),
        superseded('Cr2', record('old-cr2', 'AWS::CloudFormation::CustomResource')),
        superseded('Tg', record('old-tg', 'AWS::ElasticLoadBalancingV2::TargetGroup')),
      ],
    };

    const result = await run(state);

    // Custom resources' old ids first, the stack's own resources (dependents
    // before what they depend on), then every other superseded type.
    expect(order).toEqual(['name-1', 'old-cr2', 'name-2', 'handler', 'old-tg']);
    expect(result.errorCount).toBe(0);
    expect(result.deletedCount).toBe(5);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  it('still never deletes an old id a record of the stack holds', async () => {
    const state: StackState = {
      version: 15,
      stackName: 'TestStack',
      region: REGION,
      resources: { Other: record('name-1', 'Custom::Thing') },
      outputs: {},
      lastModified: 1,
      supersededResources: [superseded('Res', record('name-1', 'Custom::Thing'))],
    };

    await run(state);

    // Deleted once, as Other's own resource; never as Res's superseded copy.
    expect(order).toEqual(['name-1']);
  });

  const withOldId = (): StackState => ({
    version: 15,
    stackName: 'TestStack',
    region: REGION,
    resources: {
      Handler: record('handler', 'AWS::Lambda::Function'),
      Res: record('name-2', 'Custom::Thing', ['Handler']),
    },
    outputs: {},
    lastModified: 1,
    supersededResources: [superseded('Res', record('name-1', 'Custom::Thing'))],
  });

  it("sends a failed early Delete again after the stack's own resources", async () => {
    oldIdAnswers = ['throw'];

    const result = await run(withOldId());

    expect(order).toEqual(['name-1', 'name-2', 'handler', 'name-1']);
    expect(result.errorCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  it('counts a skip once, from the second attempt', async () => {
    oldIdAnswers = ['skip', 'skip'];

    const result = await run(withOldId());

    expect(order).toEqual(['name-1', 'name-2', 'handler', 'name-1']);
    expect(result.skippedCount).toBe(1);
    expect(result.errorCount).toBe(0);
  });
});

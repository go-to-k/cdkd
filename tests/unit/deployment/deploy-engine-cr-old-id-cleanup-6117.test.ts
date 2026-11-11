/**
 * go-to-k/cdkd#6117: a custom resource whose `Update` handler answers a NEW
 * `PhysicalResourceId` leaves the old id with the handler. CloudFormation
 * sends the old id a `Delete` (with the OLD properties) in the stack's cleanup
 * phase, after every other change succeeded; so must cdkd. A failed deploy
 * sends nothing (its rollback finds the old id as the update left it), and a
 * failed or skipped cleanup delete warns naming the old id without failing
 * the deploy.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

const printed = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', async () => {
  const sink = (level: 'info' | 'warn') =>
    vi.fn((message: unknown) => {
      printed[level].push(String(message));
    });
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: sink('info'),
    warn: sink('warn'),
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
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
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

const CR = 'Custom::Thing';
const TOPIC = 'AWS::SNS::Topic';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:handler';
const OLD_PROPS = { ServiceToken: TOKEN, Name: 'name-1' };
const NEW_PROPS = { ServiceToken: TOKEN, Name: 'name-2' };

describe("a custom resource Update that answers a new physical id (#6117)", () => {
  let provider: ResourceProvider;
  /** Every provider call, in order. */
  let calls: string[];
  /** Whether the `Topic` update (after `Res`) fails the deploy. */
  let topicFails: boolean;
  /** What the provider's delete does. */
  let deleteMode: 'ok' | 'throw' | 'skip';
  /** Whether the update reports the old id is left for cleanup (the CR provider does). */
  let leavesOld: boolean;
  let saved: StackState[];

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    calls = [];
    topicFails = false;
    deleteMode = 'ok';
    leavesOld = true;
    saved = [];
    provider = {
      create: vi.fn(async (logicalId: string, _type: string, props: Record<string, unknown>) => {
        calls.push(`create ${logicalId} ${String(props['Name'])}`);
        return { physicalId: String(props['Name']), attributes: {} };
      }),
      update: vi.fn(async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
        calls.push(`update ${logicalId} ${physicalId}`);
        if (logicalId === 'Topic') {
          if (topicFails) throw new Error('InvalidParameter: topic update rejected');
          return { physicalId, wasReplaced: false };
        }
        const next = String(props['Name']);
        return {
          physicalId: next,
          wasReplaced: next !== physicalId,
          ...(leavesOld && next !== physicalId && { oldPhysicalIdLeftForCleanup: true }),
          attributes: {},
        };
      }),
      delete: vi.fn(async (logicalId: string, physicalId: string) => {
        calls.push(`delete ${logicalId} ${physicalId}`);
        if (deleteMode === 'throw') throw new Error('AccessDenied: lambda:InvokeFunction');
        if (deleteMode === 'skip') {
          return { outcome: 'skipped', reason: 'the Delete handler returned FAILED' };
        }
        return undefined;
      }),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(noRollback: boolean): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      {
        getState: vi.fn(),
        saveState: vi.fn(async (_s: string, _r: string, state: StackState) => {
          saved.push(structuredClone(state));
          return 'etag';
        }),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      {
        getDirectDependencies: (_d: unknown, id: string) => (id === 'Topic' ? ['Res'] : []),
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4, noRollback } as never,
      'us-east-1'
    );
  }

  async function deploy(
    opts: { noRollback?: boolean; updateReplacePolicy?: string; oldRecord?: Partial<ResourceState> } = {}
  ): Promise<{ updatePartial: number; final: StackState }> {
    const engine = makeEngine(opts.noRollback ?? true);
    const template = {
      Resources: {
        Res: {
          Type: CR,
          Properties: NEW_PROPS,
          ...(opts.updateReplacePolicy !== undefined && {
            UpdateReplacePolicy: opts.updateReplacePolicy,
          }),
        },
        Topic: { Type: TOPIC, Properties: { DisplayName: 'v2' } },
      },
    } as unknown as CloudFormationTemplate;
    const record = (physicalId: string, resourceType: string, properties: Record<string, unknown>) =>
      ({
        physicalId,
        resourceType,
        properties,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      }) as ResourceState;
    const currentState = {
      version: 15,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {
        Res: { ...record('name-1', CR, OLD_PROPS), ...opts.oldRecord },
        Topic: record('topic', TOPIC, { DisplayName: 'v1' }),
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'Res',
        {
          logicalId: 'Res',
          changeType: 'UPDATE',
          resourceType: CR,
          currentProperties: OLD_PROPS,
          desiredProperties: NEW_PROPS,
          propertyChanges: [
            { path: 'Name', oldValue: 'name-1', newValue: 'name-2', requiresReplacement: false },
          ],
        } as unknown as ResourceChange,
      ],
      [
        'Topic',
        {
          logicalId: 'Topic',
          changeType: 'UPDATE',
          resourceType: TOPIC,
          currentProperties: { DisplayName: 'v1' },
          desiredProperties: { DisplayName: 'v2' },
          propertyChanges: [
            { path: 'DisplayName', oldValue: 'v1', newValue: 'v2', requiresReplacement: false },
          ],
        } as unknown as ResourceChange,
      ],
    ]);
    const result = await executeDeployment(
      engine,
      template,
      currentState,
      changes,
      {} as never,
      [['Res'], ['Topic']],
      'MyStack',
      template,
      undefined,
      undefined,
      'etag-0'
    );
    // What the deploy's final save persists.
    return {
      updatePartial: result.actualCounts.updatePartial,
      final: engine.withParentInfo(result.state),
    };
  }

  const oldIdDeletes = (): unknown[][] =>
    vi.mocked(provider.delete).mock.calls.filter((c) => c[1] === 'name-1');

  it('sends the old id a Delete with the OLD properties after every other update', async () => {
    const { updatePartial } = await deploy();
    expect(calls).toEqual([
      'update Res name-1',
      'update Topic topic',
      // The cleanup phase: after the dependent's update, never inline.
      'delete Res name-1',
    ]);
    expect(oldIdDeletes()).toEqual([
      ['Res', 'name-1', CR, OLD_PROPS, expect.objectContaining({ expectedRegion: 'us-east-1' })],
    ]);
    expect(updatePartial).toBe(0);
    expect(printed.info.some((l) => l.includes('Old Res (name-1) deleted'))).toBe(true);
    expect(printed.warn).toEqual([]);
  });

  it('keeps the old id in state until its Delete is sent, then drops it', async () => {
    const { final } = await deploy();
    // A save between the update and the cleanup holds the old record, so a
    // deploy killed there leaves it for the next deploy or `cdkd destroy`.
    const pending = saved.find((s) => (s.supersededResources ?? []).length > 0);
    expect(pending?.supersededResources).toEqual([
      expect.objectContaining({
        logicalId: 'Res',
        state: expect.objectContaining({ physicalId: 'name-1', properties: OLD_PROPS }),
      }),
    ]);
    expect(pending?.resources['Res']?.physicalId).toBe('name-2');
    expect(final.supersededResources).toBeUndefined();
  });

  it('sends nothing when a later update fails the deploy, and keeps the old id in state', async () => {
    topicFails = true;
    await expect(deploy()).rejects.toThrow(/Failed to update resource Topic/);
    expect(oldIdDeletes()).toEqual([]);
    expect(
      printed.warn.some(
        (l) =>
          l.includes('The old physical id of Res (name-1) was not sent its Delete') &&
          l.includes('the next deploy sends the Delete')
      )
    ).toBe(true);
    expect(saved.at(-1)?.supersededResources).toEqual([
      expect.objectContaining({ state: expect.objectContaining({ physicalId: 'name-1' }) }),
    ]);
  });

  it('leaves the rollback of a failed deploy as it was: the old id is never deleted', async () => {
    topicFails = true;
    await expect(deploy({ noRollback: false })).rejects.toThrow(/Failed to update resource Topic/);
    // The reverse replacement takes name-1 back and removes name-2.
    expect(oldIdDeletes()).toEqual([]);
    expect(calls).toContain('delete Res name-2');
  });

  it('warns naming the old id when its Delete fails, and the deploy completes', async () => {
    deleteMode = 'throw';
    const { updatePartial, final } = await deploy();
    expect(oldIdDeletes()).toHaveLength(1);
    expect(updatePartial).toBe(0);
    expect(
      printed.warn.some(
        (l) => l.includes('Failed to delete old resource Res (name-1)') && l.includes('AccessDenied')
      )
    ).toBe(true);
    // Kept in state: the next deploy or `cdkd destroy` sends it again.
    expect(final.supersededResources).toEqual([
      expect.objectContaining({ state: expect.objectContaining({ physicalId: 'name-1' }) }),
    ]);
  });

  it('warns naming the old id when the handler declines the Delete, counting the row partial', async () => {
    deleteMode = 'skip';
    const { updatePartial } = await deploy();
    expect(updatePartial).toBe(1);
    expect(printed.warn.some((l) => l.includes('name-1') && l.includes('no longer tracked'))).toBe(
      true
    );
  });

  it('sends no Delete under UpdateReplacePolicy: Retain', async () => {
    const { final } = await deploy({ updateReplacePolicy: 'Retain' });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((s) => s.supersededResources === undefined)).toBe(true);
    expect(final.supersededResources).toBeUndefined();
  });

  it('hands the delete the record NoEcho leaves, and keeps such a record out of state', async () => {
    const masked = { ServiceToken: TOKEN, Name: 'name-1', Secret: '***' };
    await deploy({ oldRecord: { properties: masked, noEchoLeaves: [['Secret']] } });
    expect(oldIdDeletes()).toEqual([
      [
        'Res',
        'name-1',
        CR,
        masked,
        expect.objectContaining({ recordedNoEchoLeaves: [['Secret']] }),
      ],
    ]);
    // Only this run can re-resolve the masked leaf, so no later run is handed it.
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((s) => s.supersededResources === undefined)).toBe(true);
  });

  it("deletes nothing for a provider that retires the old resource itself", async () => {
    leavesOld = false;
    await deploy();
    expect(provider.delete).not.toHaveBeenCalled();
  });
});

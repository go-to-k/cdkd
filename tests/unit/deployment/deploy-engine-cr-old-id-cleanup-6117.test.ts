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
import { deleteOldIdAfterDeploy } from '../../../src/deployment/deploy-engine/replacement/cleanup-old-id.js';
import {
  ReplacementRunState,
  type ReplacementDeps,
} from '../../../src/deployment/deploy-engine/replacement/run-state.js';
import { getLogger } from '../../../src/utils/logger.js';
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
    // `{ Ref: 'Secret' }` resolves to the NoEcho parameter's value.
    resolve: vi.fn().mockImplementation((value: unknown) =>
      Promise.resolve(
        JSON.parse(JSON.stringify(value), (_k, v: unknown) =>
          v !== null && typeof v === 'object' && (v as { Ref?: unknown }).Ref === 'Secret'
            ? 's3cret'
            : v
        ) as unknown
      )
    ),
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
        // What the real provider throws rather than skips (a non-string token).
        if (deleteMode === 'throw') {
          throw new Error('Custom Resource Res: ServiceToken is not a resolved string ARN');
        }
        if (deleteMode === 'skip') {
          return { outcome: 'skipped', reason: 'the Delete handler returned FAILED' };
        }
        return undefined;
      }),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(noRollback: boolean, skipFinalSnapshot = false): InstanceType<typeof DeployEngine> {
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
      { concurrency: 4, noRollback, ...(skipFinalSnapshot && { skipFinalSnapshot: true }) } as never,
      'us-east-1'
    );
  }

  async function deploy(
    opts: {
      noRollback?: boolean;
      updateReplacePolicy?: string;
      skipFinalSnapshot?: boolean;
      oldRecord?: Partial<ResourceState>;
      /** The template's `Res` properties (default {@link NEW_PROPS}). */
      newProps?: Record<string, unknown>;
      /** Another record of the stack, unchanged by the deploy. */
      other?: ResourceState;
      /** `Res` already moved to name-2, with name-1 recorded as superseded. */
      carried?: boolean;
      /** `Other` (name-2) moves to name-1 in the same deploy: a swap. */
      swap?: boolean;
    } = {}
  ): Promise<{ updatePartial: number; final: StackState }> {
    const engine = makeEngine(opts.noRollback ?? true, opts.skipFinalSnapshot ?? false);
    const template = {
      Parameters: { Secret: { Type: 'String', NoEcho: true } },
      Resources: {
        Res: {
          Type: CR,
          Properties: opts.newProps ?? NEW_PROPS,
          ...(opts.updateReplacePolicy !== undefined && {
            UpdateReplacePolicy: opts.updateReplacePolicy,
          }),
        },
        Topic: { Type: TOPIC, Properties: { DisplayName: 'v2' } },
        ...(opts.other !== undefined && { Other: { Type: CR, Properties: opts.other.properties } }),
        ...(opts.swap && { Other: { Type: CR, Properties: OLD_PROPS } }),
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
        Res: opts.carried
          ? record('name-2', CR, NEW_PROPS)
          : { ...record('name-1', CR, OLD_PROPS), ...opts.oldRecord },
        Topic: record('topic', TOPIC, { DisplayName: 'v1' }),
        ...(opts.other !== undefined && { Other: opts.other }),
        ...(opts.swap && { Other: record('name-2', CR, NEW_PROPS) }),
      },
      ...(opts.carried && {
        supersededResources: [
          { logicalId: 'Res', supersededAt: 1, state: record('name-1', CR, OLD_PROPS) },
        ],
      }),
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      ...(opts.carried ? [] : ([[
        'Res',
        {
          logicalId: 'Res',
          changeType: 'UPDATE',
          resourceType: CR,
          currentProperties: OLD_PROPS,
          desiredProperties: opts.newProps ?? NEW_PROPS,
          propertyChanges: [
            { path: 'Name', oldValue: 'name-1', newValue: 'name-2', requiresReplacement: false },
          ],
        } as unknown as ResourceChange,
      ]] as [string, ResourceChange][])),
      ...(opts.swap
        ? ([
            [
              'Other',
              {
                logicalId: 'Other',
                changeType: 'UPDATE',
                resourceType: CR,
                currentProperties: NEW_PROPS,
                desiredProperties: OLD_PROPS,
                propertyChanges: [
                  { path: 'Name', oldValue: 'name-2', newValue: 'name-1', requiresReplacement: false },
                ],
              } as unknown as ResourceChange,
            ],
          ] as [string, ResourceChange][])
        : []),
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
      opts.carried ? [['Topic']] : opts.swap ? [['Res', 'Other'], ['Topic']] : [['Res'], ['Topic']],
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
    // Announced as a delete, never as a retry of a failed one.
    expect(
      printed.info.some((l) => l.includes('Deleting the old physical id of 1 replaced custom resource(s)'))
    ).toBe(true);
    expect(printed.info.some((l) => l.includes('Retrying the delete of'))).toBe(false);
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
    expect(oldIdDeletes()).toEqual([]);
    // The reverse replacement, unchanged by #6117: it re-creates name-1 and
    // deletes name-2 (CloudFormation sends an Update instead: #6120).
    expect(calls.slice(2)).toEqual(['create Res name-1', 'delete Res name-2']);
  });

  it('says to delete it manually when a failed deploy leaves an old id it could not record', async () => {
    topicFails = true;
    const masked = { ServiceToken: TOKEN, Name: 'name-1', Secret: '***' };
    await expect(
      deploy({ oldRecord: { properties: masked, noEchoLeaves: [['Secret']] } })
    ).rejects.toThrow(/Failed to update resource Topic/);
    expect(oldIdDeletes()).toEqual([]);
    expect(
      printed.warn.some(
        (l) =>
          l.includes('The old physical id of Res (name-1) was not sent its Delete') &&
          l.includes('no longer tracked in state, so delete it manually')
      )
    ).toBe(true);
  });

  it('warns naming the old id when its Delete fails, and the deploy completes', async () => {
    deleteMode = 'throw';
    const { updatePartial, final } = await deploy();
    expect(oldIdDeletes()).toHaveLength(1);
    expect(updatePartial).toBe(0);
    expect(
      printed.warn.some(
        (l) =>
          l.includes('Failed to delete old resource Res (name-1)') &&
          l.includes('not a resolved string ARN')
      )
    ).toBe(true);
    // Kept in state: the next deploy or `cdkd destroy` sends it again.
    expect(final.supersededResources).toEqual([
      expect.objectContaining({ state: expect.objectContaining({ physicalId: 'name-1' }) }),
    ]);
  });

  it('warns naming the old id when the handler declines the Delete, counting the row partial', async () => {
    deleteMode = 'skip';
    const { updatePartial, final } = await deploy();
    expect(updatePartial).toBe(1);
    expect(printed.warn.some((l) => l.includes('name-1') && l.includes('no longer tracked'))).toBe(
      true
    );
    expect(final.supersededResources).toBeUndefined();
  });

  it('sends no Delete under UpdateReplacePolicy: Retain', async () => {
    const { final } = await deploy({ updateReplacePolicy: 'Retain' });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((s) => s.supersededResources === undefined)).toBe(true);
    expect(final.supersededResources).toBeUndefined();
  });

  it('sends no Delete under UpdateReplacePolicy: Snapshot, which a custom resource cannot take', async () => {
    const { updatePartial } = await deploy({ updateReplacePolicy: 'Snapshot' });
    expect(provider.delete).not.toHaveBeenCalled();
    // Left untracked, so the row is a partial update (#1819).
    expect(updatePartial).toBe(1);
    expect(printed.warn.some((l) => l.includes('UpdateReplacePolicy: Snapshot') && l.includes('name-1'))).toBe(
      true
    );
  });

  it('deletes under UpdateReplacePolicy: Snapshot with --skip-final-snapshot', async () => {
    await deploy({ updateReplacePolicy: 'Snapshot', skipFinalSnapshot: true });
    expect(oldIdDeletes()).toHaveLength(1);
  });

  it('never deletes an old id another record of the stack names', async () => {
    const other = {
      physicalId: 'name-1',
      resourceType: CR,
      properties: OLD_PROPS,
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    } as ResourceState;
    const { final } = await deploy({ other });
    expect(oldIdDeletes()).toEqual([]);
    expect(
      printed.warn.some(
        (l) => l.includes("Res's old physical id (name-1) is not sent a Delete") && l.includes('Other')
      )
    ).toBe(true);
    expect(final.supersededResources).toBeUndefined();
  });

  it('deletes neither old id when two custom resources swap names, and records neither', async () => {
    const { final, updatePartial } = await deploy({ swap: true });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(updatePartial).toBe(0);
    expect(final.supersededResources).toBeUndefined();
    expect(saved.at(-1)?.supersededResources).toBeUndefined();
    for (const [id, old, holder] of [
      ['Res', 'name-1', 'Other'],
      ['Other', 'name-2', 'Res'],
    ]) {
      expect(
        printed.warn.some(
          (l) => l.includes(`${id}'s old physical id (${old}) is not sent a Delete`) && l.includes(holder!)
        )
      ).toBe(true);
    }
  });

  it('re-resolves the NoEcho value of the old record into the Delete payload', async () => {
    const masked = { ServiceToken: TOKEN, Name: 'name-1', Secret: '***' };
    await deploy({
      newProps: { ...NEW_PROPS, Secret: { Ref: 'Secret' } },
      oldRecord: { properties: masked, noEchoLeaves: [['Secret']] },
    });
    const context = oldIdDeletes()[0]?.[4] as {
      noEchoDeleteValues?: { leaves: { coordinate: string[]; value: unknown }[] };
    };
    expect(context.noEchoDeleteValues?.leaves).toEqual([{ coordinate: ['Secret'], value: 's3cret' }]);
    // The value never reaches a printed line.
    expect([...printed.info, ...printed.warn].some((l) => l.includes('s3cret'))).toBe(false);
  });

  it('a later deploy sends the Delete of an old id an earlier deploy left in state', async () => {
    const { final } = await deploy({ carried: true });
    expect(oldIdDeletes()).toEqual([['Res', 'name-1', CR, OLD_PROPS, expect.anything()]]);
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

describe('deleteOldIdAfterDeploy when the old properties cannot be prepared (#6117)', () => {
  it('sends no Delete, warns naming the old id without the error text, and marks the row partial', async () => {
    printed.info.length = 0;
    printed.warn.length = 0;
    const run = new ReplacementRunState();
    run.deferredReplacedDeletes = new Map();
    const deleteProvider = { delete: vi.fn() } as unknown as ResourceProvider;
    await deleteOldIdAfterDeploy(
      run,
      {
        logger: getLogger(),
        options: {},
        deployStateResources: () => ({}),
      } as unknown as ReplacementDeps,
      {
        logicalId: 'Res',
        oldResource: {
          physicalId: 'name-1',
          resourceType: CR,
          properties: OLD_PROPS,
          attributes: {},
          dependencies: [],
        } as unknown as ResourceState,
        deleteProvider,
        deleteProvisionedBy: 'sdk',
        updateReplacePolicy: undefined,
        secrets: new Map(),
        noEchoDeleteValues: () => Promise.reject(new Error('resolved value s3cret-leak')),
      }
    );
    expect(deleteProvider.delete).not.toHaveBeenCalled();
    expect(run.deferredReplacedDeletes.size).toBe(0);
    expect(run.replacedDeleteSkips.get('Res')).toContain('name-1');
    expect(
      printed.warn.some(
        (l) => l.includes("Res's old physical id (name-1)") && l.includes('could not prepare its properties')
      )
    ).toBe(true);
    expect([...printed.info, ...printed.warn].some((l) => l.includes('s3cret-leak'))).toBe(false);
  });
});

/**
 * go-to-k/cdkd#6958: a replaced `AWS::EC2::VPCGatewayAttachment` or
 * `AWS::EC2::SubnetRouteTableAssociation` (and, go-to-k/cdkd#6990, an
 * `AWS::EC2::EIPAssociation`) is deleted BEFORE its replacement is
 * created, as CloudFormation replaces them: AWS refuses the new link
 * (`Resource.AlreadyAssociated`) while the old one holds the gateway or the
 * subnet. The journal records `oldDeletedBeforeCreate`, so a failed deploy's
 * automatic rollback deletes the new link and re-creates the old one.
 *
 * The provider double enforces AWS's one-link rule, so the create-first order
 * fails here exactly as it does on AWS.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type {
  CompletedOperation,
  FailedOperation,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { classifyFailedOp } from '../../../src/deployment/rollback-executor/plan.js';

const printed = vi.hoisted(() => ({ info: [] as string[] }));
vi.mock('../../../src/utils/logger.js', async () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn((message: unknown) => {
      printed.info.push(String(message));
    }),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
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

// Each journal segment the engine writes, as a clone taken before the write.
const journalTap = vi.hoisted(() => ({
  push: (_ops: unknown, _failed: unknown): void => {},
}));
vi.mock('../../../src/deployment/deploy-engine/rollback.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/deploy-engine/rollback.js')>();
  return {
    ...actual,
    writeRollbackJournalSegment: vi.fn(
      async (...args: Parameters<typeof actual.writeRollbackJournalSegment>) => {
        journalTap.push(structuredClone(args[2]), structuredClone(args[3]));
        return actual.writeRollbackJournalSegment(...args);
      }
    ),
  };
});

const ATTACHMENT = 'AWS::EC2::VPCGatewayAttachment';
const RT_ASSOCIATION = 'AWS::EC2::SubnetRouteTableAssociation';
const ACL_ASSOCIATION = 'AWS::EC2::SubnetNetworkAclAssociation';
const EIP_ASSOCIATION = 'AWS::EC2::EIPAssociation';
const ROUTE = 'AWS::EC2::Route';

interface Shape {
  type: string;
  /** The property AWS lets hold one link at a time. */
  holder: string;
  /** The create-only property the template moves. */
  moved: string;
  /** Whether the create replaces the holder's current link instead of refusing. */
  createReplaces?: boolean;
}

const SHAPES: Record<string, Shape> = {
  attachment: { type: ATTACHMENT, holder: 'InternetGatewayId', moved: 'VpcId' },
  association: { type: RT_ASSOCIATION, holder: 'SubnetId', moved: 'RouteTableId' },
  acl: { type: ACL_ASSOCIATION, holder: 'SubnetId', moved: 'NetworkAclId', createReplaces: true },
  // go-to-k/cdkd#6990: an Elastic IP moved to a replaced instance.
  eip: { type: EIP_ASSOCIATION, holder: 'AllocationId', moved: 'InstanceId' },
};

describe('a gateway attachment or a route table association is replaced delete-first (go-to-k/cdkd#6958)', () => {
  let provider: ResourceProvider;
  /** Live links: physical id -> properties. */
  let live: Map<string, Record<string, unknown>>;
  let order: string[];
  let journaled: CompletedOperation[][];
  let journaledFailed: FailedOperation[][];
  let saved: StackState[];
  let routeFails: boolean;
  /** How many of the next creates AWS refuses outright (an invalid value). */
  let refuseCreates: number;
  /** Ids AWS has ever minted: a re-created link gets a new one. */
  let minted: Set<string>;
  let shape: Shape;

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    order = [];
    journaled = [];
    journaledFailed = [];
    saved = [];
    routeFails = false;
    refuseCreates = 0;
    minted = new Set(['link-a']);
    shape = SHAPES['attachment']!;
    live = new Map([['link-a', { [shape.holder]: 'h-1', [shape.moved]: 'a' }]]);
    provider = {
      create: vi.fn(async (_logicalId: string, _type: string, props: Record<string, unknown>) => {
        const base = `link-${String(props[shape.moved])}`;
        const id = minted.has(base) ? `${base}-2` : base;
        if (refuseCreates > 0) {
          refuseCreates--;
          order.push(`create ${id} refused`);
          throw new Error('InvalidParameterValue: the create was refused');
        }
        order.push(`create ${id}`);
        for (const [otherId, other] of live) {
          if (other[shape.holder] !== props[shape.holder]) continue;
          if (shape.createReplaces === true) {
            live.delete(otherId);
            continue;
          }
          const error = new Error(
            `Resource.AlreadyAssociated: ${String(props[shape.holder])} is already associated`
          );
          error.name = 'Resource.AlreadyAssociated';
          throw error;
        }
        live.set(id, { ...props });
        minted.add(id);
        return { physicalId: id, attributes: {} };
      }),
      update: vi.fn(async (_logicalId: string, physicalId: string) => {
        order.push(`update ${physicalId}`);
        if (routeFails) throw new Error('ValidationException: route update rejected');
        return { physicalId, wasReplaced: false, attributes: {} };
      }),
      delete: vi.fn(async (_logicalId: string, physicalId: string) => {
        order.push(`delete ${physicalId}`);
        live.delete(physicalId);
        return undefined;
      }),
      readCurrentState: vi.fn(async (physicalId: string) =>
        live.has(physicalId) ? { ...live.get(physicalId) } : RESOURCE_NOT_FOUND
      ),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    const engine = new DeployEngine(
      {
        getState: vi.fn(),
        saveState: vi.fn(async (_stack: string, _region: string, state: StackState) => {
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
        getDirectDependencies: (_d: unknown, id: string) => (id === 'Route' ? ['Link'] : []),
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4, noRollback: true, ...options } as never,
      'us-east-1'
    );
    journalTap.push = (ops, failed) => {
      journaled.push(ops as CompletedOperation[]);
      journaledFailed.push(failed as FailedOperation[]);
    };
    return engine;
  }

  async function deploy(
    opts: { engine?: DeployEngine; updateReplacePolicy?: string } = {}
  ): Promise<{ completedOperations: CompletedOperation[]; state: StackState }> {
    const engine = opts.engine ?? makeEngine();
    const oldProps = { [shape.holder]: 'h-1', [shape.moved]: 'a' };
    const newProps = { [shape.holder]: 'h-1', [shape.moved]: 'b' };
    const template = {
      Resources: {
        Link: {
          Type: shape.type,
          Properties: newProps,
          ...(opts.updateReplacePolicy !== undefined && {
            UpdateReplacePolicy: opts.updateReplacePolicy,
          }),
        },
        Route: { Type: ROUTE, Properties: { GatewayId: 'h-1', Tag: 'v2' } },
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
      version: 12,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {
        Link: record('link-a', shape.type, oldProps),
        Route: record('route-1', ROUTE, { GatewayId: 'h-1', Tag: 'v1' }),
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'Link',
        {
          logicalId: 'Link',
          changeType: 'UPDATE',
          resourceType: shape.type,
          currentProperties: oldProps,
          desiredProperties: newProps,
          propertyChanges: [
            { path: shape.moved, oldValue: 'a', newValue: 'b', requiresReplacement: true },
          ],
        } as unknown as ResourceChange,
      ],
      [
        'Route',
        {
          logicalId: 'Route',
          changeType: 'UPDATE',
          resourceType: ROUTE,
          currentProperties: { GatewayId: 'h-1', Tag: 'v1' },
          desiredProperties: { GatewayId: 'h-1', Tag: 'v2' },
          propertyChanges: [{ path: 'Tag', oldValue: 'v1', newValue: 'v2', requiresReplacement: false }],
        } as unknown as ResourceChange,
      ],
    ]);
    return (await executeDeployment(
      engine,
      template,
      currentState,
      changes,
      {} as never,
      [['Link'], ['Route']],
      'MyStack',
      template,
      undefined,
      undefined,
      'etag-0'
    )) as unknown as { completedOperations: CompletedOperation[]; state: StackState };
  }

  const linkOp = (ops: CompletedOperation[]): CompletedOperation | undefined =>
    ops.find((o) => o.logicalId === 'Link');

  it.each(['attachment', 'association', 'eip'])(
    'a replaced %s deletes the old link, then creates the new one, and journals the order',
    async (name) => {
      shape = SHAPES[name]!;
      live = new Map([['link-a', { [shape.holder]: 'h-1', [shape.moved]: 'a' }]]);

      const result = await deploy();

      expect(order).toEqual(['delete link-a', 'create link-b', 'update route-1']);
      expect([...live.keys()]).toEqual(['link-b']);
      expect(result.state.resources['Link']!.physicalId).toBe('link-b');
      expect(linkOp(result.completedOperations)).toMatchObject({
        physicalId: 'link-b',
        oldDeletedBeforeCreate: true,
      });
      // Nothing left for the cleanup phase: the old link went first.
      expect(vi.mocked(provider.delete)).toHaveBeenCalledTimes(1);
      expect(
        printed.info.some((l) =>
          l.includes(`${shape.type} allows one link at a time — deleting old Link (link-a) before creating its replacement`)
        )
      ).toBe(true);
    }
  );

  it('a subnet network ACL association keeps the create-first order, which AWS accepts', async () => {
    shape = SHAPES['acl']!;
    live = new Map([['link-a', { [shape.holder]: 'h-1', [shape.moved]: 'a' }]]);

    const result = await deploy();

    expect(order[0]).toBe('create link-b');
    expect(linkOp(result.completedOperations)?.oldDeletedBeforeCreate).not.toBe(true);
  });

  it('UpdateReplacePolicy: Retain keeps the old link and the create-first order', async () => {
    await expect(deploy({ updateReplacePolicy: 'Retain' })).rejects.toThrow();
    expect(order).toEqual(['create link-b']);
    expect(vi.mocked(provider.delete)).not.toHaveBeenCalled();
    expect(live.has('link-a')).toBe(true);
  });

  it('a failed deploy journals the early delete, and its rollback re-creates the old link', async () => {
    routeFails = true;
    await expect(deploy({ engine: makeEngine({ noRollback: false }) })).rejects.toThrow();

    expect(linkOp(journaled[0]!)).toMatchObject({ oldDeletedBeforeCreate: true });
    // Forward: old link deleted, new one created, the route refused. The
    // rollback deletes the new link FIRST (the old one is gone), then
    // re-creates the old one, which AWS would refuse the other way round.
    expect(order).toEqual([
      'delete link-a',
      'create link-b',
      'update route-1',
      'delete link-b',
      'create link-a-2',
    ]);
    expect([...live.keys()]).toEqual(['link-a-2']);
    expect(saved.at(-1)!.resources['Link']!.physicalId).toBe('link-a-2');
  });

  it('a refused re-create: the automatic rollback re-creates the deleted old link and records it', async () => {
    refuseCreates = 1;
    await expect(deploy({ engine: makeEngine({ noRollback: false }) })).rejects.toThrow();

    // Forward: the old link is deleted, the new one refused, so nothing holds
    // the gateway / subnet. The rollback re-creates the old link from its
    // record, as CloudFormation's UPDATE_ROLLBACK does.
    expect(order).toEqual(['delete link-a', 'create link-b refused', 'create link-a-2']);
    expect([...live.keys()]).toEqual(['link-a-2']);
    expect(live.get('link-a-2')).toEqual({ [shape.holder]: 'h-1', [shape.moved]: 'a' });
    const record = saved.at(-1)!.resources['Link']!;
    expect(record.physicalId).toBe('link-a-2');
    expect(record.properties).toEqual({ [shape.holder]: 'h-1', [shape.moved]: 'a' });
    expect(vi.mocked(provider.create).mock.calls[1]?.[3]).toMatchObject({ replayingState: true });
  });

  it.each(['association', 'eip'])(
    'a refused re-create of an %s is rolled back the same way',
    async (name) => {
      shape = SHAPES[name]!;
      live = new Map([['link-a', { [shape.holder]: 'h-1', [shape.moved]: 'a' }]]);
      refuseCreates = 1;
      await expect(deploy({ engine: makeEngine({ noRollback: false }) })).rejects.toThrow();
      expect(order).toEqual(['delete link-a', 'create link-b refused', 'create link-a-2']);
      expect(live.get('link-a-2')).toEqual({ [shape.holder]: 'h-1', [shape.moved]: 'a' });
      expect(saved.at(-1)!.resources['Link']!.physicalId).toBe('link-a-2');
    }
  );

  it('a failed re-create journals that the old link is already gone', async () => {
    provider.create = vi.fn(async () => {
      order.push('create refused');
      throw new Error('InvalidParameterValue: bad route table');
    }) as unknown as ResourceProvider['create'];

    const error: unknown = await deploy().then(
      () => undefined,
      (e: unknown) => e
    );
    const chain: string[] = [];
    for (let e = error; e instanceof Error; e = e.cause) chain.push(e.message);
    expect(chain.join('\n')).toContain(
      'Failed to re-create Link after the delete-first replacement already deleted the old resource (link-a)'
    );
    expect(order).toEqual(['delete link-a', 'create refused']);
    const failedLink = journaledFailed[0]!.find((o) => o.logicalId === 'Link')!;
    expect(failedLink).toMatchObject({ oldDeletedBeforeCreate: true });
    // `cdkd rollback --revert-failed` plans the same re-create.
    const records = saved.at(-1)!.resources;
    expect(classifyFailedOp(failedLink, records, journaledFailed[0]!)).toBe(
      'recreate-failed-replaced-deleted'
    );
    // A type the deploy replaces delete-first only on request keeps its plan.
    const optIn = {
      ...failedLink,
      resourceType: ACL_ASSOCIATION,
      previousState: { ...failedLink.previousState!, resourceType: ACL_ASSOCIATION },
    };
    expect(classifyFailedOp(optIn, records, [optIn])).not.toBe('recreate-failed-replaced-deleted');
  });
});

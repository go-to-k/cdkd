/**
 * go-to-k/cdkd#4705 (review R5-1): a deploy's AUTOMATIC rollback asks who else
 * holds a resource the failed deploy created before deleting it. A create can
 * adopt a resource that already existed under its name (an SQS queue, an SNS
 * topic), so the same stack recorded under another state prefix may own it.
 * Only that question is asked (review R6-1): the same-prefix scan, which fails
 * closed on any unreadable record, is the settle's alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import type { ForeignHolding } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import { createCrossPrefixHolder } from '../../../src/cli/commands/cross-prefix-gate.js';
import {
  CrossPrefixScanCache,
  type CrossPrefixScanResult,
} from '../../../src/state/cross-prefix-stack-scan.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const warned = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => warned.push(String(message))),
    error: vi.fn(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const STACK = 'App';
const QUEUE = 'AWS::SQS::Queue';

describe('the automatic rollback asks who else holds a created resource (go-to-k/cdkd#4705)', () => {
  let deleteCalls: string[];
  let journalDeletes: number;
  let lastBackend: { listStacks: ReturnType<typeof vi.fn> } | undefined;

  beforeEach(() => {
    warned.length = 0;
    deleteCalls = [];
    journalDeletes = 0;
  });

  // Queue (created, maybe adopted) succeeds; FailLater fails after it.
  const template: CloudFormationTemplate = {
    Resources: {
      Queue: { Type: QUEUE, Properties: {} },
      FailLater: { Type: QUEUE, Properties: {}, DependsOn: ['Queue'] },
    },
  };
  const create = (logicalId: string): ResourceChange => ({
    logicalId,
    changeType: 'CREATE',
    resourceType: QUEUE,
    desiredProperties: {},
    propertyChanges: [],
  });

  function buildEngine(opts: {
    crossPrefixHolder?: (stackName: string) => Promise<ForeignHolding>;
    otherStacks?: Record<string, Record<string, ResourceState>>;
    /** A region-less legacy record under this prefix: the same-prefix scan's fail-closed case. */
    legacyRef?: boolean;
    /** Deploy as a nested CHILD engine (review R6-2). */
    parentStackInfo?: { parentStack: string; parentLogicalId: string; parentRegion: string };
    /** Two created queues before FailLater (review R6-8). */
    twoQueues?: boolean;
    refusalRecovery?: { profile?: string; stateBucket?: string };
  }): DeployEngine {
    const provider = {
      create: vi.fn(async (logicalId: string) => {
        if (logicalId === 'FailLater') throw new Error('create failed: FailLater');
        return { physicalId: `https://sqs/${logicalId}`, attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn(async (logicalId: string) => {
        deleteCalls.push(logicalId);
      }),
    };
    const ownState: StackState = {
      version: 1,
      stackName: STACK,
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: Date.now(),
    };
    const others = opts.otherStacks ?? {};
    const stateBackend = {
      getState: vi.fn(async (name: string) => {
        if (name === STACK) return { state: ownState, etag: 'etag-0' };
        const resources = others[name];
        return resources === undefined
          ? null
          : {
              state: { ...ownState, stackName: name, resources },
              etag: 'etag-x',
            };
      }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
      listStacks: vi.fn(async () => [
        { stackName: STACK, region: 'us-east-1' },
        ...Object.keys(others).map((stackName) => ({ stackName, region: 'us-east-1' })),
        ...(opts.legacyRef === true ? [{ stackName: 'Legacy' }] : []),
      ]),
      deleteRollbackJournal: vi.fn(async () => {
        journalDeletes++;
      }),
    };
    lastBackend = stateBackend;
    const deps: Record<string, string[]> = opts.twoQueues
      ? { Queue: [], Queue2: [], FailLater: ['Queue', 'Queue2'] }
      : { Queue: [], FailLater: ['Queue'] };
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi
          .fn()
          .mockReturnValue(opts.twoQueues ? [['Queue', 'Queue2'], ['FailLater']] : [['Queue'], ['FailLater']]),
        getDirectDependencies: vi.fn((_dag: unknown, id: string) => deps[id] ?? []),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(
          new Map([
            ['Queue', create('Queue')],
            ...(opts.twoQueues ? ([['Queue2', create('Queue2')]] as const) : []),
            ['FailLater', create('FailLater')],
          ])
        ),
        hasChanges: vi.fn().mockReturnValue(true),
        filterByType: vi.fn((changes: Map<string, ResourceChange>, type: string) =>
          [...changes.values()].filter((c) => c.changeType === type)
        ),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        getCloudControlProvider: vi.fn(),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      {
        concurrency: 4,
        ...(opts.crossPrefixHolder !== undefined && { crossPrefixHolder: opts.crossPrefixHolder }),
        ...(opts.parentStackInfo !== undefined && { parentStackInfo: opts.parentStackInfo }),
        ...(opts.refusalRecovery !== undefined && { refusalRecovery: opts.refusalRecovery }),
      },
      'us-east-1'
    );
  }

  const keptLines = (): string[] => warned.filter((l) => l.includes('Keeping created resource'));
  const skipSummary = (): string[] =>
    warned.filter((l) => l.includes('The automatic rollback could not revert 1 operation(s)'));

  it('keeps a created resource the stack under another state prefix may hold: no delete, a warning naming the prefix, counted as a skip', async () => {
    const crossPrefixHolder = vi.fn(
      async (): Promise<ForeignHolding> => ({
        kind: 'unreadable',
        what: 'bucket b also records this stack under another state prefix (team-a), whose record may hold it',
      })
    );
    await expect(buildEngine({ crossPrefixHolder }).deploy(STACK, template)).rejects.toThrow(
      /FailLater/
    );
    expect(deleteCalls).toEqual([]);
    expect(crossPrefixHolder).toHaveBeenCalledWith(STACK);
    expect(keptLines()).toHaveLength(1);
    expect(keptLines()[0]).toContain('Queue');
    expect(keptLines()[0]).toContain('(team-a)');
    // The skip keeps the journal segment and is summarized (exit-2 class).
    expect(skipSummary()).toHaveLength(1);
    expect(journalDeletes).toBe(0);
  });

  // Review R6-1: this case used to KEEP the queue (the same-prefix scan ran
  // first). Another stack of this prefix has other generated names, so a
  // create cannot have been handed its resource; only the other prefixes are
  // asked, and on their clear answer the queue is deleted.
  it('a same-prefix sibling recording the id does not stop the delete: only the other prefixes are asked', async () => {
    const crossPrefixHolder = vi.fn(async (): Promise<ForeignHolding> => undefined);
    await expect(
      buildEngine({
        crossPrefixHolder,
        otherStacks: {
          Sibling: {
            Q: {
              physicalId: 'https://sqs/Queue',
              resourceType: QUEUE,
              properties: {},
            } as ResourceState,
          },
        },
      }).deploy(STACK, template)
    ).rejects.toThrow(/FailLater/);
    expect(deleteCalls).toEqual(['Queue']);
    expect(keptLines()).toEqual([]);
    expect(crossPrefixHolder).toHaveBeenCalledWith(STACK);
  });

  // The regression guard (review R6-1): a record the same-prefix scan cannot
  // read (a region-less legacy key; a peer's newer-schema record) made that
  // scan answer `unreadable` for every id, so every rollback in the prefix
  // kept everything it created.
  it('an unreadable record under the same prefix does not stop the delete, and the bucket is not listed', async () => {
    const crossPrefixHolder = vi.fn(async (): Promise<ForeignHolding> => undefined);
    await expect(
      buildEngine({ crossPrefixHolder, legacyRef: true }).deploy(STACK, template)
    ).rejects.toThrow(/FailLater/);
    expect(deleteCalls).toEqual(['Queue']);
    expect(keptLines()).toEqual([]);
    expect(skipSummary()).toEqual([]);
    expect(lastBackend!.listStacks).not.toHaveBeenCalled();
  });

  it('without a cross-prefix holder (a nested child, a library caller) it deletes, asking nothing', async () => {
    await expect(buildEngine({ legacyRef: true }).deploy(STACK, template)).rejects.toThrow(
      /FailLater/
    );
    expect(deleteCalls).toEqual(['Queue']);
    expect(lastBackend!.listStacks).not.toHaveBeenCalled();
  });

  it('a nested CHILD engine asks by its own stack name and keeps on found (review R6-2)', async () => {
    const child = 'App~Child';
    const crossPrefixHolder = vi.fn(
      async (): Promise<ForeignHolding> => ({
        kind: 'unreadable',
        what: 'bucket b also records this stack under another state prefix (team-a), whose record may hold it',
      })
    );
    await expect(
      buildEngine({
        crossPrefixHolder,
        parentStackInfo: { parentStack: STACK, parentLogicalId: 'Child', parentRegion: 'us-east-1' },
      }).deploy(child, template)
    ).rejects.toThrow(/FailLater/);
    expect(crossPrefixHolder).toHaveBeenCalledWith(child);
    expect(deleteCalls).toEqual([]);
    expect(keptLines()).toHaveLength(1);
    expect(keptLines()[0]).toContain('(team-a)');
  });

  it('asks the other prefixes ONCE however many created resources it would delete (review R6-8)', async () => {
    const crossPrefixHolder = vi.fn(async (): Promise<ForeignHolding> => undefined);
    await expect(
      buildEngine({ crossPrefixHolder, twoQueues: true }).deploy(STACK, template)
    ).rejects.toThrow(/FailLater/);
    expect(deleteCalls.sort()).toEqual(['Queue', 'Queue2']);
    expect(crossPrefixHolder).toHaveBeenCalledTimes(1);
  });

  // Review R6-6: a keep because the check FAILED names how to finish the job.
  const holderOver = (scan: CrossPrefixScanResult) => {
    const cache = new CrossPrefixScanCache({
      prefix: 'cdkd',
      ownRecordExists: vi.fn(),
      listTopLevelPrefixes: vi.fn(),
      recordUnderPrefix: vi.fn(),
    });
    vi.spyOn(cache, 'full').mockResolvedValue(scan);
    return createCrossPrefixHolder({ region: 'us-east-1', bucket: 'my-bucket', cache });
  };

  it('a check that failed keeps the resource and names the cdkd rollback, with the run\'s flags, that finishes it', async () => {
    await expect(
      buildEngine({
        crossPrefixHolder: holderOver({ kind: 'failed', error: new Error('boom') }),
        refusalRecovery: { profile: 'prod', stateBucket: 'my-bucket' },
      }).deploy(STACK, template)
    ).rejects.toThrow(/FailLater/);
    expect(deleteCalls).toEqual([]);
    expect(keptLines()).toHaveLength(1);
    expect(keptLines()[0]).toMatch(
      /Once S3 can be read, finish the rollback with: cdkd rollback App .*--profile prod.*--state-bucket my-bucket/
    );
  });

  it('a found holder keeps the resource without that retry line (re-running cannot settle it)', async () => {
    await expect(
      buildEngine({
        crossPrefixHolder: holderOver({ kind: 'found', prefixes: ['team-a'] }),
        refusalRecovery: { profile: 'prod', stateBucket: 'my-bucket' },
      }).deploy(STACK, template)
    ).rejects.toThrow(/FailLater/);
    expect(keptLines()).toHaveLength(1);
    expect(keptLines()[0]).toContain('(team-a)');
    expect(keptLines()[0]).not.toContain('finish the rollback');
  });

  it('clear: deletes the created resource as before', async () => {
    const crossPrefixHolder = vi.fn(async (): Promise<ForeignHolding> => undefined);
    await expect(buildEngine({ crossPrefixHolder }).deploy(STACK, template)).rejects.toThrow(
      /FailLater/
    );
    expect(deleteCalls).toEqual(['Queue']);
    expect(keptLines()).toEqual([]);
    expect(skipSummary()).toEqual([]);
  });

  it('denied (403): warns and deletes, as the settle does', async () => {
    const cache = new CrossPrefixScanCache({
      prefix: 'cdkd',
      ownRecordExists: vi.fn(),
      listTopLevelPrefixes: vi.fn(),
      recordUnderPrefix: vi.fn(),
    });
    const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    vi.spyOn(cache, 'full').mockResolvedValue({ kind: 'denied', error: denied, stage: 'list' });
    const crossPrefixHolder = createCrossPrefixHolder({ region: 'us-east-1', bucket: 'b', cache });
    await expect(buildEngine({ crossPrefixHolder }).deploy(STACK, template)).rejects.toThrow(
      /FailLater/
    );
    expect(deleteCalls).toEqual(['Queue']);
    expect(keptLines()).toEqual([]);
    expect(warned.some((l) => /AccessDenied|403|denied/i.test(l))).toBe(true);
  });

  it('a holder check that throws keeps the resource (fail closed)', async () => {
    const crossPrefixHolder = vi.fn(async (): Promise<ForeignHolding> => {
      throw new Error('boom');
    });
    await expect(buildEngine({ crossPrefixHolder }).deploy(STACK, template)).rejects.toThrow(
      /FailLater/
    );
    expect(deleteCalls).toEqual([]);
    expect(keptLines()).toHaveLength(1);
  });
});

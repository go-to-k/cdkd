/**
 * `AWS::StackId` tail on the deploy path (go-to-k/cdkd#6170).
 *
 * A stack whose FIRST state write happens here is marked
 * `stackIdFromInstance`, and every resource it creates resolves `AWS::StackId`
 * with a UUID derived from its instance id -- so the common CDK unique-suffix
 * idiom (`Fn.select(4, Fn.split('-', Fn.select(2, Fn.split('/', STACK_ID)))`)
 * yields a value, not an out-of-bounds placeholder. A record WITHOUT the
 * marker (every stack deployed before v16, instance id or not) keeps the
 * `cdkd` tail it was deployed with, so nothing named from it changes.
 *
 * The REAL resolver runs; only the diff, DAG and provider are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { stackIdTailFromInstanceId } from '../../../src/state/stack-id-tail.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// The CloudFormation client is inert (see _inert-cloudformation-client.ts); STS
// answers a fixed account so the resolver can build the stack id.
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const inert = await (
    await import('./_inert-cloudformation-client.js')
  ).withInertCloudFormationClient(importOriginal);
  return {
    ...inert,
    getAwsClients: (...args: Parameters<typeof inert.getAwsClients>) =>
      new Proxy(inert.getAwsClients(...args), {
        get: (target, key) =>
          key === 'sts'
            ? {
                send: vi.fn().mockResolvedValue({
                  Account: '123456789012',
                  Arn: 'arn:aws:iam::123456789012:user/test',
                }),
              }
            : (Reflect.get(target, key) as unknown),
      }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const stackName = 'stack-id-stack';
const INSTANCE_ID = '00000000-0000-4000-8000-000000000000';
const DERIVED = stackIdTailFromInstanceId(INSTANCE_ID);

const stackIdSegment = (index: number) => ({
  'Fn::Select': [index, { 'Fn::Split': ['/', { Ref: 'AWS::StackId' }] }],
});
// The idiom's last UUID group, and the whole tail segment.
const template: CloudFormationTemplate = {
  Resources: {
    A: {
      Type: 'AWS::S3::Bucket',
      Properties: {
        Suffix: { 'Fn::Select': [4, { 'Fn::Split': ['-', stackIdSegment(2)] }] },
        Tail: stackIdSegment(2),
      },
    },
  },
};

// The diff hands provisioning the TEMPLATE's properties, which the create arm
// resolves against its own context.
function makeChange(properties: Record<string, unknown>): Map<string, ResourceChange> {
  return new Map<string, ResourceChange>([
    [
      'A',
      {
        logicalId: 'A',
        changeType: 'CREATE',
        resourceType: 'AWS::S3::Bucket',
        desiredProperties: properties,
        propertyChanges: [],
      } as unknown as ResourceChange,
    ],
  ]);
}

interface Harness {
  engine: DeployEngine;
  order: string[];
  provider: { create: ReturnType<typeof vi.fn> };
  stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    listStacks: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    stackInstanceIdForFirstWrite: ReturnType<typeof vi.fn>;
    peekStackInstanceSibling?: ReturnType<typeof vi.fn>;
    deleteRollbackJournal: ReturnType<typeof vi.fn>;
    loadRollbackJournal: ReturnType<typeof vi.fn>;
    purgeRollbackJournalVersions: ReturnType<typeof vi.fn>;
    rollbackJournalReadAbsent: ReturnType<typeof vi.fn>;
    warmConnections: ReturnType<typeof vi.fn>;
  };
  exportIndexStore: { prefetch: ReturnType<typeof vi.fn>; updateForStack: ReturnType<typeof vi.fn> };
  lockManager: { releaseLock: ReturnType<typeof vi.fn> };
}

function buildHarness(opts: {
  /** Resolve the journal delete / exports update only when released. */
  gate?: { journal?: Promise<void>; exports?: Promise<void> };
  onCurrentStateLoaded?: (stackName: string, state: StackState | undefined) => Promise<void>;
  currentState?: StackState;
  /** Merged into the engine's options. */
  engineOptions?: Record<string, unknown>;
  /**
   * A backend that offers `peekStackInstanceSibling` (the S3 backend does):
   * the identity a sibling holds (null: none), and the id the write-ahead
   * returns (default: the candidate it was handed, as the real backend does
   * when no sibling exists).
   */
  peek?: { identity: { stackInstanceId: string; stackIdFromInstance: boolean } | null; writeId?: string };
} = {}): Harness {
  const order: string[] = [];

  const provider = {
    create: vi.fn().mockImplementation(() => {
      order.push('create');
      return Promise.resolve({ physicalId: 'phys-A', attributes: {} });
    }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };

  const stateBackend = {
    peekStackInstanceSibling: undefined as ReturnType<typeof vi.fn> | undefined,
    listStacks: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockImplementation(() => {
      order.push('getState');
      // The real backend returns `null` (not a record with a null state)
      // when the stack has no state at all.
      return Promise.resolve(opts.currentState ? { state: opts.currentState, etag: 'e0' } : null);
    }),
    saveState: vi.fn().mockImplementation(async () => {
      order.push('saveState');
      return 'etag-1';
    }),
    stackInstanceIdForFirstWrite: vi.fn().mockResolvedValue(INSTANCE_ID),
    deleteRollbackJournal: vi.fn().mockImplementation(async () => {
      order.push('journal:start');
      await opts.gate?.journal;
      order.push('journal:end');
    }),
    loadRollbackJournal: vi.fn().mockResolvedValue(null),
    purgeRollbackJournalVersions: vi.fn().mockImplementation(async () => {
      order.push('journal:purge');
    }),
    rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
    warmConnections: vi.fn().mockResolvedValue(undefined),
    appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
  };

  if (opts.peek !== undefined) {
    const peek = opts.peek;
    stateBackend.peekStackInstanceSibling = vi.fn().mockResolvedValue(peek.identity);
    stateBackend.stackInstanceIdForFirstWrite.mockImplementation(
      (_stack: string, _region: string, options: { candidate?: { stackInstanceId: string } }) =>
        Promise.resolve(peek.writeId ?? peek.identity?.stackInstanceId ?? options.candidate!.stackInstanceId)
    );
  }

  const exportIndexStore = {
    prefetch: vi.fn().mockResolvedValue(undefined),
    updateForStack: vi.fn().mockImplementation(async () => {
      order.push('exports:start');
      await opts.gate?.exports;
      order.push('exports:end');
    }),
  };

  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockImplementation(async () => {
      order.push('releaseLock');
    }),
  };

  const dagBuilder = {
    buildGraph: vi.fn().mockReturnValue({}),
    getExecutionLevels: vi.fn().mockReturnValue([['A']]),
    getDirectDependencies: vi.fn().mockReturnValue([]),
  };
  const diffCalculator = {
    calculateDiff: vi
      .fn()
      .mockImplementation((_state: unknown, t: CloudFormationTemplate) =>
        // A condition-pruned A is absent from the template the engine diffs.
        Promise.resolve(
          t.Resources['A'] === undefined
            ? new Map<string, ResourceChange>()
            : makeChange(t.Resources['A'].Properties ?? {})
        )
      ),
    hasChanges: vi.fn().mockReturnValue(true),
    filterByType: vi
      .fn()
      .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
        [...changes.values()].filter((c) => c.changeType === type)
      ),
  };
  const providerRegistry = {
    getProvider: vi.fn().mockReturnValue(provider),
    getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
    getRegisteredTypes: vi.fn().mockReturnValue([]),
    getCloudControlProvider: vi.fn(),
    validateResourceTypes: vi.fn(),
    validateResourceProperties: vi.fn(),
  };

  const engine = new DeployEngine(
    stateBackend as never,
    lockManager as never,
    dagBuilder as never,
    diffCalculator as never,
    providerRegistry as never,
    {
      concurrency: 4,
      ...(opts.onCurrentStateLoaded && { onCurrentStateLoaded: opts.onCurrentStateLoaded }),
      ...opts.engineOptions,
    },
    'us-east-1',
    exportIndexStore as never
  );

  return { engine, order, provider, stateBackend, exportIndexStore, lockManager };
}


function savedStates(h: Harness): StackState[] {
  return h.stateBackend.saveState.mock.calls.map((call) => call[2] as StackState);
}

function createdProperties(h: Harness): Record<string, unknown> {
  return h.provider.create.mock.calls[0]![2] as Record<string, unknown>;
}

describe('DeployEngine — AWS::StackId tail (go-to-k/cdkd#6170)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAccountInfoCache();
  });

  it("a stack's first deploy marks the record and resolves the derived UUID", async () => {
    const h = buildHarness();
    await h.engine.deploy(stackName, template);

    expect(DERIVED).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(DERIVED).not.toBe(INSTANCE_ID);
    expect(createdProperties(h)).toEqual({ Suffix: DERIVED.split('-')[4], Tail: DERIVED });
    const saved = savedStates(h);
    expect(saved.length).toBeGreaterThan(0);
    for (const state of saved) {
      expect(state.stackInstanceId).toBe(INSTANCE_ID);
      expect(state.stackIdFromInstance).toBe(true);
    }
  });

  it('a record without the marker keeps the cdkd tail, instance id or not', async () => {
    for (const legacy of [{ stackInstanceId: INSTANCE_ID }, {}]) {
      vi.clearAllMocks();
      resetAccountInfoCache();
      const legacyTemplate: CloudFormationTemplate = {
        Resources: { A: { Type: 'AWS::S3::Bucket', Properties: { Tail: stackIdSegment(2) } } },
      };
      const h = buildHarness({
        currentState: {
          version: 15,
          stackName,
          region: 'us-east-1',
          resources: {},
          outputs: {},
          lastModified: 0,
          ...legacy,
        } as StackState,
      });
      await h.engine.deploy(stackName, legacyTemplate);

      expect(createdProperties(h)).toEqual({ Tail: 'cdkd' });
      expect(savedStates(h).length).toBeGreaterThan(0);
      for (const state of savedStates(h)) expect(state.stackIdFromInstance).toBeUndefined();
      expect(h.stateBackend.stackInstanceIdForFirstWrite).not.toHaveBeenCalled();
    }
  });

  it('a marked record resolves the derived UUID on a later deploy and keeps the marker', async () => {
    const h = buildHarness({
      currentState: {
        version: 16,
        stackName,
        region: 'us-east-1',
        resources: {},
        outputs: {},
        lastModified: 0,
        stackInstanceId: INSTANCE_ID,
        stackIdFromInstance: true,
      },
    });
    await h.engine.deploy(stackName, template);

    expect(createdProperties(h)).toEqual({ Suffix: DERIVED.split('-')[4], Tail: DERIVED });
    expect(savedStates(h).length).toBeGreaterThan(0);
    for (const state of savedStates(h)) expect(state.stackIdFromInstance).toBe(true);
    expect(h.stateBackend.stackInstanceIdForFirstWrite).not.toHaveBeenCalled();
  });

  describe('a first deploy settles its identity before its conditions (peekStackInstanceSibling)', () => {
    const tailIsDerived = {
      'Fn::Not': [{ 'Fn::Equals': [stackIdSegment(2), 'cdkd'] }],
    };
    const conditioned = (outputs?: CloudFormationTemplate['Outputs']): CloudFormationTemplate => ({
      Conditions: { IsDerived: tailIsDerived },
      Resources: {
        A: {
          Type: 'AWS::S3::Bucket',
          Condition: 'IsDerived',
          Properties: { Tail: stackIdSegment(2) },
        },
      },
      ...(outputs && { Outputs: outputs }),
    });

    it('no sibling: the candidate id the write-ahead is handed derives the tail the plan used', async () => {
      const h = buildHarness({ peek: { identity: null } });
      await h.engine.deploy(stackName, conditioned());

      expect(h.stateBackend.peekStackInstanceSibling).toHaveBeenCalledTimes(1);
      const [, , options] = h.stateBackend.stackInstanceIdForFirstWrite.mock.calls[0]!;
      const candidate = (options as { candidate: { stackInstanceId: string; stackIdFromInstance: boolean } })
        .candidate;
      expect(candidate.stackIdFromInstance).toBe(true);
      expect(candidate.stackInstanceId).toMatch(/^[0-9a-f-]{36}$/);
      // The condition saw the derived tail (so A was created), and A got it.
      expect(h.provider.create).toHaveBeenCalledTimes(1);
      expect(createdProperties(h)).toEqual({ Tail: stackIdTailFromInstanceId(candidate.stackInstanceId) });
      expect(savedStates(h).length).toBeGreaterThan(0);
      for (const state of savedStates(h)) {
        expect(state.stackInstanceId).toBe(candidate.stackInstanceId);
        expect(state.stackIdFromInstance).toBe(true);
      }
    });

    it('no sibling: an output Ref AWS::StackId ends in the candidate id\'s derived tail', async () => {
      const h = buildHarness({ peek: { identity: null } });
      await h.engine.deploy(stackName, conditioned({ Id: { Value: { Ref: 'AWS::StackId' } } }));

      const candidate = (
        h.stateBackend.stackInstanceIdForFirstWrite.mock.calls[0]![2] as {
          candidate: { stackInstanceId: string };
        }
      ).candidate;
      const states = savedStates(h);
      expect(states.length).toBeGreaterThan(0);
      const last = states[states.length - 1]!;
      expect(last.outputs['Id']).toMatch(
        new RegExp(`/${stackIdTailFromInstanceId(candidate.stackInstanceId)}$`)
      );
    });

    it('a version 1 sibling (an older binary\'s crashed first deploy) keeps the cdkd tail and no marker', async () => {
      const h = buildHarness({ peek: { identity: { stackInstanceId: INSTANCE_ID, stackIdFromInstance: false } } });
      const t = conditioned();
      t.Resources['A']!.Properties = { Tail: stackIdSegment(2) };
      // The condition is false under cdkd, so A is pruned; use an ungated copy.
      delete t.Resources['A']!.Condition;
      await h.engine.deploy(stackName, t);

      expect(createdProperties(h)).toEqual({ Tail: 'cdkd' });
      expect(savedStates(h).length).toBeGreaterThan(0);
      for (const state of savedStates(h)) {
        expect(state.stackInstanceId).toBe(INSTANCE_ID);
        expect(state.stackIdFromInstance).toBeUndefined();
      }
    });

    it('a version 1 sibling prunes a resource gated on the tail being derived', async () => {
      const h = buildHarness({ peek: { identity: { stackInstanceId: INSTANCE_ID, stackIdFromInstance: false } } });
      await h.engine.deploy(stackName, conditioned());
      expect(h.provider.create).not.toHaveBeenCalled();
    });

    it('a version 2 sibling derives the tail of its id and marks the record', async () => {
      const h = buildHarness({ peek: { identity: { stackInstanceId: INSTANCE_ID, stackIdFromInstance: true } } });
      await h.engine.deploy(stackName, conditioned());

      expect(h.provider.create).toHaveBeenCalledTimes(1);
      expect(createdProperties(h)).toEqual({ Tail: DERIVED });
      expect(savedStates(h).length).toBeGreaterThan(0);
      for (const state of savedStates(h)) {
        expect(state.stackInstanceId).toBe(INSTANCE_ID);
        expect(state.stackIdFromInstance).toBe(true);
      }
    });

    it('refuses, creating nothing, when the write-ahead returns an id other than the planned one', async () => {
      const h = buildHarness({
        peek: { identity: null, writeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      });
      await expect(h.engine.deploy(stackName, conditioned())).rejects.toThrow(
        /changed while this deploy was planning/
      );
      expect(h.provider.create).not.toHaveBeenCalled();
    });

    it('--dry-run reads no sibling and writes nothing', async () => {
      const h = buildHarness({ peek: { identity: null }, engineOptions: { dryRun: true } });
      await h.engine.deploy(stackName, conditioned());
      const backend = h.stateBackend as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(backend['peekStackInstanceSibling']).not.toHaveBeenCalled();
      expect(backend['stackInstanceIdForFirstWrite']).not.toHaveBeenCalled();
      expect(h.provider.create).not.toHaveBeenCalled();
    });
  });
});

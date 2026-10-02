/**
 * The deploy engine binds this stack's rollback-journal evidence around a
 * resource's CREATE and UPDATE dispatch, for a provider that cannot tell its
 * own leftover from another owner's identical resource (go-to-k/cdkd#4355).
 *
 * The observation seam is the one `EC2Provider`'s duplicate-ingress arm uses:
 * `getPriorAttempts(logicalId)` read from INSIDE the provider call.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  getPriorAttempts,
  isRefusedBeforeApplying,
  markRefusedBeforeApplying,
  priorAttemptsInJournal,
} from '../../../src/deployment/prior-attempt-scope.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';
import type { RollbackJournal } from '../../../src/types/rollback-journal.js';

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

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

const TYPE = 'AWS::EC2::SecurityGroupIngress';
const RULE = { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432 };

const TEMPLATE: CloudFormationTemplate = {
  Resources: { Rule: { Type: TYPE, Properties: { ...RULE, CidrIp: '10.0.0.0/16' } } },
} as unknown as CloudFormationTemplate;

const JOURNAL: RollbackJournal = {
  journalVersion: 1,
  stackName: 'MyStack',
  region: 'us-east-1',
  segments: [
    {
      timestamp: 1,
      reason: 'auto-rollback-clean',
      initialDeploy: false,
      operations: [],
      failedOperations: [
        {
          logicalId: 'Rule',
          changeType: 'CREATE',
          resourceType: TYPE,
          attemptedProperties: { ...RULE, CidrIp: '10.0.0.0/16' },
        },
      ],
    },
  ],
} as unknown as RollbackJournal;

describe('the deploy engine binds prior-attempt evidence per resource (#4355)', () => {
  let seen: { own: unknown; other: unknown };
  let loadRollbackJournal: ReturnType<typeof vi.fn>;
  let readEvidence: boolean;

  const observe = async (): Promise<void> => {
    const own = getPriorAttempts('Rule');
    seen = {
      own: own && readEvidence ? await own.attempts() : own,
      other: getPriorAttempts('OtherRule'),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    seen = { own: 'unobserved', other: 'unobserved' };
    readEvidence = true;
    loadRollbackJournal = vi.fn().mockResolvedValue(JOURNAL);
  });

  function engineWith(provider: ResourceProvider): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      {
        getState: vi.fn(),
        saveState: vi.fn().mockResolvedValue('etag'),
        loadRollbackJournal,
      } as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      {},
      'us-east-1'
    );
  }

  const provider = (): ResourceProvider => ({
    create: vi.fn(async () => {
      await observe();
      return { physicalId: 'sg-1|tcp|5432|5432', attributes: {} };
    }),
    update: vi.fn(async () => {
      await observe();
      return { physicalId: 'sg-1|tcp|5432|5432', wasReplaced: false, attributes: {} };
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  });

  async function provision(
    engine: InstanceType<typeof DeployEngine>,
    change: ResourceChange,
    stateResources: Record<string, ResourceState>
  ): Promise<void> {
    await (
      engine as unknown as {
        provisionResource: (
          id: string,
          c: ResourceChange,
          s: Record<string, ResourceState>,
          stack: string,
          t: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource('Rule', change, stateResources, 'MyStack', TEMPLATE);
  }

  const createChange = {
    logicalId: 'Rule',
    changeType: 'CREATE',
    resourceType: TYPE,
    desiredProperties: { ...RULE, CidrIp: '10.0.0.0/16' },
  } as unknown as ResourceChange;

  it('a CREATE sees this stack journal bags for its own logical id, and none for another', async () => {
    await provision(engineWith(provider()), createChange, {});

    expect(seen.own).toEqual([{ ...RULE, CidrIp: '10.0.0.0/16' }]);
    expect(seen.other).toBeUndefined();
    expect(loadRollbackJournal).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('two concurrent dispatches each see only their own evidence and possibly-landed flag (only Rule notes one)', async () => {
    const seenByRule: Record<string, unknown> = {};
    const p: ResourceProvider = {
      create: vi.fn(async (logicalId: string) => {
        const own = getPriorAttempts(logicalId)!;
        // Only ONE dispatch notes: a flag shared across dispatches would let
        // Rule's ambiguity unmark Other's refusal.
        if (logicalId === 'Rule') own.notePossiblyLanded();
        // Interleave: let the other dispatch run between bind and read.
        await new Promise((r) => setTimeout(r, logicalId === 'Rule' ? 5 : 0));
        await Promise.resolve();
        seenByRule[logicalId] = {
          bags: await own.attempts(),
          other: getPriorAttempts(logicalId === 'Rule' ? 'Other' : 'Rule'),
          landed: own.possiblyLanded(),
        };
        return { physicalId: `phys-${logicalId}`, attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
    };
    loadRollbackJournal.mockResolvedValue({
      ...JOURNAL,
      segments: [
        {
          ...JOURNAL.segments[0]!,
          failedOperations: [
            { logicalId: 'Rule', changeType: 'CREATE', resourceType: TYPE, attemptedProperties: { tag: 'rule' } },
            { logicalId: 'Other', changeType: 'CREATE', resourceType: TYPE, attemptedProperties: { tag: 'other' } },
          ],
        },
      ],
    });
    const engine = engineWith(p);
    const change = (id: string) => ({ ...createChange, logicalId: id }) as unknown as ResourceChange;
    const run = (id: string) =>
      (
        engine as unknown as {
          provisionResource: (
            i: string,
            c: ResourceChange,
            s: Record<string, ResourceState>,
            stack: string,
            t: CloudFormationTemplate
          ) => Promise<void>;
        }
      ).provisionResource(id, change(id), {}, 'MyStack', {
        Resources: { Rule: TEMPLATE.Resources!['Rule']!, Other: TEMPLATE.Resources!['Rule']! },
      } as unknown as CloudFormationTemplate);

    await Promise.all([run('Rule'), run('Other')]);

    expect(seenByRule['Rule']).toEqual({ bags: [{ tag: 'rule' }], other: undefined, landed: true });
    expect(seenByRule['Other']).toEqual({ bags: [{ tag: 'other' }], other: undefined, landed: false });
  });

  it('a fresh dispatch of the same logical id starts with no possibly-landed flag', async () => {
    const flags: boolean[] = [];
    const p = provider();
    p.create = vi.fn(async () => {
      const own = getPriorAttempts('Rule')!;
      flags.push(own.possiblyLanded());
      own.notePossiblyLanded();
      return { physicalId: 'sg-1|tcp|5432|5432', attributes: {} };
    });
    const engine = engineWith(p);

    await provision(engine, createChange, {});
    await provision(engine, createChange, {});

    expect(flags).toEqual([false, false]);
  });

  it('an UPDATE sees the same evidence', async () => {
    const change = {
      logicalId: 'Rule',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { ...RULE, CidrIp: '10.0.0.0/8' },
      desiredProperties: { ...RULE, CidrIp: '10.0.0.0/16' },
      propertyChanges: [
        { path: 'CidrIp', oldValue: '10.0.0.0/8', newValue: '10.0.0.0/16', requiresReplacement: false },
      ],
    } as unknown as ResourceChange;
    const state: Record<string, ResourceState> = {
      Rule: {
        physicalId: 'sg-1|tcp|5432|5432',
        resourceType: TYPE,
        properties: { ...RULE, CidrIp: '10.0.0.0/8' },
        attributes: {},
        dependencies: [],
      },
    };

    await provision(engineWith(provider()), change, state);

    expect(seen.own).toEqual([{ ...RULE, CidrIp: '10.0.0.0/16' }]);
    expect(seen.other).toBeUndefined();
  });

  it('reads the journal only when a provider asks, so an ordinary create makes no extra call', async () => {
    readEvidence = false;

    await provision(engineWith(provider()), createChange, {});

    expect(seen.own).toBeDefined();
    expect(loadRollbackJournal).not.toHaveBeenCalled();
  });

  it('surfaces a journal read failure to the reader instead of answering "no attempts"', async () => {
    loadRollbackJournal.mockRejectedValue(new Error('AccessDenied'));
    readEvidence = false;
    let read: Promise<unknown> | undefined;
    const p = provider();
    p.create = vi.fn(async () => {
      read = getPriorAttempts('Rule')!.attempts();
      await read.catch(() => undefined);
      return { physicalId: 'sg-1|tcp|5432|5432', attributes: {} };
    });

    await provision(engineWith(p), createChange, {});

    await expect(read).rejects.toThrow('AccessDenied');
  });
});

describe('priorAttemptsInJournal (#4355, #4402)', () => {
  const bag = (cidr: string) => ({ ...RULE, CidrIp: cidr });
  const journal = (segments: unknown[]): RollbackJournal =>
    ({ journalVersion: 1, stackName: 'S', region: 'r', segments }) as unknown as RollbackJournal;
  const failed = (cidr: string, changeType = 'CREATE', extra: Record<string, unknown> = {}) => ({
    logicalId: 'Rule',
    changeType,
    resourceType: TYPE,
    attemptedProperties: bag(cidr),
    ...extra,
  });
  const completed = (changeType: string, cidr = '9.0.0.0/8', resourceType = TYPE) => ({
    logicalId: 'Rule',
    changeType,
    resourceType,
    properties: bag(cidr),
  });

  it('collects the attempted bags of FAILED CREATE / UPDATE ops from every segment', () => {
    const found = priorAttemptsInJournal(
      journal([
        { operations: [], failedOperations: [failed('1.0.0.0/8')] },
        // The real shape of a failed in-place UPDATE: execute.ts stamps its
        // previous record, and its physical id falls back to that record's.
        {
          operations: [],
          failedOperations: [
            failed('3.0.0.0/8', 'UPDATE', {
              physicalId: 'sg-1|tcp|5432|5432',
              previousState: { physicalId: 'sg-1|tcp|5432|5432' },
            }),
          ],
        },
      ]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([bag('1.0.0.0/8'), bag('3.0.0.0/8')]);
  });

  // go-to-k/cdkd#4402: a completed op's resource was recorded in state by the
  // failed deploy's partial save, so a later CREATE of that id means the
  // record is gone — reverted, destroyed or superseded — and its bag is stale.
  it.each([
    ['an auto-rollback segment whose pop failed', 'auto-rollback-started'],
    ['a segment a `cdkd rollback` per-op failure kept', 'no-rollback-failure'],
    ['an unsettled nested-pending-parent segment', 'nested-pending-parent'],
    ['a segment a partial `cdkd destroy` left behind', 'interrupted'],
  ])('a COMPLETED op is never evidence: %s', (_shape, reason) => {
    const found = priorAttemptsInJournal(
      journal([
        {
          reason,
          operations: [completed('CREATE', '1.0.0.0/8'), completed('UPDATE', '2.0.0.0/8')],
        },
      ]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([]);
  });

  it.each([
    ['a completed CREATE', 'CREATE'],
    ['a completed UPDATE', 'UPDATE'],
    ['a completed DELETE', 'DELETE'],
  ])('%s of the logical id in a LATER segment supersedes the failed attempts before it', (_what, changeType) => {
    const found = priorAttemptsInJournal(
      journal([
        { operations: [], failedOperations: [failed('1.0.0.0/8')] },
        { operations: [completed(changeType)] },
      ]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([]);
  });

  it('a completed op of the id supersedes a failed attempt in an EARLIER segment, not a later one', () => {
    const found = priorAttemptsInJournal(
      journal([
        { operations: [], failedOperations: [failed('1.0.0.0/8')] },
        { operations: [completed('DELETE')], failedOperations: [failed('2.0.0.0/8')] },
      ]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([bag('2.0.0.0/8')]);
  });

  it('a completed op recorded under another type (a Type change) still supersedes the logical id', () => {
    const found = priorAttemptsInJournal(
      journal([
        { operations: [], failedOperations: [failed('1.0.0.0/8')] },
        { operations: [completed('DELETE', '9.0.0.0/8', 'AWS::EC2::SecurityGroupEgress')] },
      ]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([]);
  });

  it("another logical id's completed op supersedes nothing", () => {
    const found = priorAttemptsInJournal(
      journal([
        { operations: [], failedOperations: [failed('1.0.0.0/8')] },
        { operations: [{ ...completed('DELETE'), logicalId: 'Other' }] },
      ]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([bag('1.0.0.0/8')]);
  });

  it('a failed CREATE that carries a physical id was recorded in state: not evidence', () => {
    const found = priorAttemptsInJournal(
      journal([{ operations: [], failedOperations: [failed('1.0.0.0/8', 'CREATE', { physicalId: 'sg-1|tcp|5432|5432' })] }]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([]);
  });

  it('ignores a failed DELETE, another logical id, another type, and an op with no bag', () => {
    const found = priorAttemptsInJournal(
      journal([
        {
          operations: [],
          failedOperations: [
            { logicalId: 'Rule', changeType: 'DELETE', resourceType: TYPE, attemptedProperties: bag('4.0.0.0/8') },
            { ...failed('2.0.0.0/8'), logicalId: 'Other' },
            { ...failed('3.0.0.0/8'), resourceType: 'AWS::EC2::SecurityGroupEgress' },
            { logicalId: 'Rule', changeType: 'CREATE', resourceType: TYPE },
            { ...failed('5.0.0.0/8'), attemptedProperties: [bag('5.0.0.0/8')] },
          ],
        },
      ]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([]);
  });

  // The spec review's shape: deploy 1's failed attempt is adopted by deploy 2
  // (a completed CREATE), deploy 2's clean rollback reverts it and pops its
  // segment. The backend leaves the id on the remaining segment, so the
  // attempt the reverted adoption consumed does not count again.
  it('a removed superseding segment\'s marker clears the attempts up to the end of its segment', () => {
    expect(
      priorAttemptsInJournal(
        journal([{ operations: [], failedOperations: [failed('1.0.0.0/8')], supersededLogicalIds: ['Rule'] }]),
        'Rule',
        TYPE
      )
    ).toEqual([]);
    expect(
      priorAttemptsInJournal(
        journal([
          { operations: [], failedOperations: [failed('1.0.0.0/8')], supersededLogicalIds: ['Rule'] },
          { operations: [], failedOperations: [failed('2.0.0.0/8')] },
        ]),
        'Rule',
        TYPE
      )
    ).toEqual([bag('2.0.0.0/8')]);
    expect(
      priorAttemptsInJournal(
        journal([{ operations: [], failedOperations: [failed('1.0.0.0/8')], supersededLogicalIds: ['Other'] }]),
        'Rule',
        TYPE
      )
    ).toEqual([bag('1.0.0.0/8')]);
  });

  // G1: a real segment holds every op the deploy completed, of many resources.
  it('a completed op of the id anywhere in a MIXED segment supersedes', () => {
    const found = priorAttemptsInJournal(
      journal([
        { operations: [], failedOperations: [failed('1.0.0.0/8')] },
        {
          operations: [
            { ...completed('CREATE'), logicalId: 'Other' },
            completed('CREATE'),
            { ...completed('UPDATE'), logicalId: 'Other2' },
          ],
        },
      ]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([]);
  });

  it('a failed UPDATE with no previous record is still evidence', () => {
    const found = priorAttemptsInJournal(
      journal([{ operations: [], failedOperations: [failed('1.0.0.0/8', 'UPDATE', { physicalId: 'sg-1|tcp|5432|5432' })] }]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([bag('1.0.0.0/8')]);
  });

  it('a failed CREATE with an EMPTY physical id identifies nothing: still evidence', () => {
    const found = priorAttemptsInJournal(
      journal([{ operations: [], failedOperations: [failed('1.0.0.0/8', 'CREATE', { physicalId: '' })] }]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([bag('1.0.0.0/8')]);
  });

  it("a failed UPDATE whose physical id differs from its previous record's was recorded as a NEW resource: not evidence", () => {
    const found = priorAttemptsInJournal(
      journal([
        {
          operations: [],
          failedOperations: [
            failed('1.0.0.0/8', 'UPDATE', {
              physicalId: 'sg-1|tcp|5433|5433',
              previousState: { physicalId: 'sg-1|tcp|5432|5432' },
            }),
          ],
        },
      ]),
      'Rule',
      TYPE
    );

    expect(found).toEqual([]);
  });

  it('answers no attempts when the stack has no journal', () => {
    expect(priorAttemptsInJournal(null, 'Rule', TYPE)).toEqual([]);
  });
});

describe('markRefusedBeforeApplying (#4355)', () => {
  it('marks an error so the walk finds it one cause deep', () => {
    const inner = markRefusedBeforeApplying(new Error('refused'));
    expect(isRefusedBeforeApplying(new Error('outer', { cause: inner }), 'X')).toBe(true);
    expect(isRefusedBeforeApplying(new Error('plain'), 'X')).toBe(false);
  });

  it("stops at a link naming another logical id: a nested child's refusal is not the parent row's", () => {
    const child = Object.assign(markRefusedBeforeApplying(new Error('child refused')), { logicalId: 'ChildRule' });
    const parent = Object.assign(new Error('nested stack failed', { cause: child }), { logicalId: 'Nested' });

    expect(isRefusedBeforeApplying(parent, 'Nested')).toBe(false);
    expect(isRefusedBeforeApplying(child, 'ChildRule')).toBe(true);
  });

  it('is bounded: a cyclic cause chain ends, and a mark past the depth bound is not found', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(isRefusedBeforeApplying(a, 'X')).toBe(false);

    let deep: Error = markRefusedBeforeApplying(new Error('deep'));
    for (let i = 0; i < 10; i++) deep = new Error(`wrap ${i}`, { cause: deep });
    expect(isRefusedBeforeApplying(deep, 'X')).toBe(false);
  });

  it('returns a frozen error unmarked rather than throwing over the refusal', () => {
    const frozen = Object.freeze(new Error('frozen'));
    expect(markRefusedBeforeApplying(frozen)).toBe(frozen);
    expect(isRefusedBeforeApplying(frozen, 'X')).toBe(false);
  });
});

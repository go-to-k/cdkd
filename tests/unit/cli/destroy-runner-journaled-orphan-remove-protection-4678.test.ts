import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { JournaledOrphans } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import { isTerminalDeleteFailure } from '../../../src/provisioning/providers/deletion-protection-compensation.js';

// go-to-k/cdkd#4678: `cdkd destroy --remove-protection` (and `cdkd state
// destroy --remove-protection`, the same runner) hands the flag to the delete
// of a resource only the rollback journal records, as it does to the stack's
// own deletes; without the flag neither delete may strip a protection.

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

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

const readlineQuestion = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: readlineQuestion, close: vi.fn() }),
}));

import {
  countProtectedJournaledOrphans,
  runDestroyForStack,
} from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/o/1';

const orphanOp = {
  logicalId: 'OrphanLb',
  changeType: 'CREATE',
  resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
  physicalId: LB_ARN,
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  attemptedProperties: {
    LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
  },
};

function res(): ResourceState {
  return {
    physicalId: 'phys-r',
    resourceType: 'AWS::SSM::Parameter',
    properties: {},
    attributes: {},
    dependencies: [],
  };
}

function makeState(resources: Record<string, ResourceState>): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
  };
}

function journalOf(failedOperations: unknown[]) {
  return {
    journalVersion: 1,
    stackName: 'TestStack',
    region: REGION,
    segments: [
      {
        timestamp: 1,
        reason: 'no-rollback-failure',
        initialDeploy: false,
        skipPrefix: false,
        operations: [],
        failedOperations,
      },
    ],
  };
}

function throttle(): Error {
  return Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
}

describe('runDestroyForStack: --remove-protection reaches a journaled orphan (go-to-k/cdkd#4678)', () => {
  const mockDeleteState = vi.fn();
  const mockLoadJournal = vi.fn();
  const seen = new Map<string, { context: Record<string, unknown>; throttleTerminal: boolean }>();
  const mockProviderDelete = vi.fn(async (...args: unknown[]) => {
    seen.set(String(args[0]), {
      context: args[4] as Record<string, unknown>,
      throttleTerminal: isTerminalDeleteFailure(throttle()),
    });
  });

  const mockListStacks = vi.fn();
  const mockGetState = vi.fn();

  function makeCtx(extra: { removeProtection?: boolean; skipConfirmation?: boolean } = {}) {
    return {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: mockDeleteState,
        getState: mockGetState,
        loadRollbackJournal: mockLoadJournal,
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(0),
        listStacks: mockListStacks,
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete }, provisionedBy: 'sdk' }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: extra.skipConfirmation ?? true,
      ...(extra.removeProtection !== undefined && { removeProtection: extra.removeProtection }),
    };
  }

  beforeEach(() => {
    seen.clear();
    mockProviderDelete.mockClear();
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockLoadJournal.mockReset().mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    readlineQuestion.mockReset();
    mockListStacks.mockReset().mockResolvedValue([]);
    mockGetState.mockReset().mockResolvedValue(null);
    infoSpy.mockReset();
    warnSpy.mockReset();
  });

  it('hands removeProtection to the orphan delete, as its final attempt', async () => {
    const result = await runDestroyForStack(
      'TestStack',
      makeState({ R: res() }),
      makeCtx({ removeProtection: true })
    );
    expect(result.errorCount).toBe(0);
    expect(seen.get('OrphanLb')?.context['removeProtection']).toBe(true);
    expect(seen.get('OrphanLb')?.throttleTerminal).toBe(true);
    // Control: the stack's own delete takes it too, as before.
    expect(seen.get('R')?.context['removeProtection']).toBe(true);
    expect(mockDeleteState).toHaveBeenCalledOnce();
  });

  // E.g. a later `cdkd import` adopted the load balancer into stack B.
  it("keeps the protection of an orphan another stack's record holds", async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'B', region: REGION }]);
    mockGetState.mockImplementation(async (name: string) =>
      name === 'B'
        ? {
            state: {
              ...makeState({
                Adopted: {
                  physicalId: LB_ARN,
                  resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
                  properties: {},
                  attributes: {},
                  dependencies: [],
                },
              }),
              stackName: 'B',
            },
          }
        : null
    );
    await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx({ removeProtection: true }));
    expect(seen.has('OrphanLb')).toBe(true);
    expect(seen.get('OrphanLb')?.context).not.toHaveProperty('removeProtection');
    expect(seen.get('R')?.context['removeProtection']).toBe(true);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'the state record of stack B (us-east-1) holds it now'
    );
  });

  it('strips nothing without the flag', async () => {
    await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(seen.has('OrphanLb')).toBe(true);
    expect(seen.has('R')).toBe(true);
    expect(seen.get('OrphanLb')?.context).not.toHaveProperty('removeProtection');
    expect(seen.get('R')?.context).not.toHaveProperty('removeProtection');
  });

  it("counts a journaled orphan's protection in the --remove-protection prompt", async () => {
    readlineQuestion.mockResolvedValue('n');
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    let result: Awaited<ReturnType<typeof runDestroyForStack>>;
    try {
      result = await runDestroyForStack(
        'TestStack',
        makeState({ R: res() }),
        makeCtx({ removeProtection: true, skipConfirmation: false })
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
    expect(result.cancelled).toBe(true);
    expect(String(readlineQuestion.mock.calls[0]![0])).toContain(
      'REMOVING DELETION PROTECTION on 1 of them'
    );
    expect(mockProviderDelete).not.toHaveBeenCalled();
  });
});

describe('countProtectedJournaledOrphans (go-to-k/cdkd#4678)', () => {
  const orphansOf = (ops: Array<Record<string, unknown>>): Pick<JournaledOrphans, 'segments'> =>
    ({ segments: [{ segment: {}, ops }] }) as unknown as Pick<JournaledOrphans, 'segments'>;
  const instance = (extra: Record<string, unknown> = {}) => ({
    logicalId: 'I',
    resourceType: 'AWS::EC2::Instance',
    physicalIdRecoveredFromError: true,
    attemptedProperties: { DisableApiTermination: true },
    ...extra,
  });
  const table = (extra: Record<string, unknown> = {}) => ({
    logicalId: 'T',
    resourceType: 'AWS::DynamoDB::Table',
    physicalIdRecoveredFromError: true,
    attemptedProperties: { DeletionProtectionEnabled: true },
    ...extra,
  });

  it('reads each type through its protection locator in the attempted properties', () => {
    expect(countProtectedJournaledOrphans(orphansOf([orphanOp, instance()]), REGION)).toBe(2);
  });

  it('counts a name-keyed orphan only with a journaled identity to prove', () => {
    expect(countProtectedJournaledOrphans(orphansOf([table()]), REGION)).toBe(0);
    expect(
      countProtectedJournaledOrphans(orphansOf([table({ createdResourceIdentity: 'tok' })]), REGION)
    ).toBe(1);
  });

  it('counts none the sweep leaves alone, nor protection off, absent, or of a type with no flag', () => {
    expect(
      countProtectedJournaledOrphans(
        orphansOf([
          instance({ physicalIdRecoveredFromError: false }),
          instance({ deletionPolicy: 'Retain' }),
          instance({ attemptedProperties: { DisableApiTermination: false } }),
          instance({ attemptedProperties: undefined }),
          instance({ resourceType: 'AWS::SQS::Queue' }),
        ]),
        REGION
      )
    ).toBe(0);
  });
});

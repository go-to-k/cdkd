/**
 * go-to-k/cdkd#4705: `cdkd rollback` refuses, under the lock and before any
 * replay, a stack the state bucket also records under ANOTHER state prefix:
 * the replay deletes what the failed deploy created, and for such a pair a
 * create could have been handed the other deployment's resource (the repro's
 * deleted SQS queue).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
const provider = vi.hoisted(() => ({ delete: vi.fn() }));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
const question = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question, close: vi.fn() }),
}));
const setupMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';

const REGION = 'us-east-1';
const LB_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/o/1';

const record = (physicalId: string, resourceType: string) => ({
  physicalId,
  resourceType,
  properties: {},
  attributes: {},
  dependencies: [],
  provisionedBy: 'sdk',
});

const stateOf = (stackName: string, resources: Record<string, unknown>) => ({
  version: 8,
  stackName,
  region: REGION,
  resources,
  outputs: {},
  lastModified: 1,
});

/** Stack `S` journals OrphanLb's failed CREATE; `others` are more stacks' records. */
function install(
  failedOp: Record<string, unknown>,
  ownResources: Record<string, unknown>,
  others: Record<string, Record<string, unknown>> = {},
  prefixes: { listed?: string[] | Error; holders?: string[] } = {}
): void {
  const states: Record<string, unknown> = {
    S: stateOf('S', ownResources),
    ...Object.fromEntries(Object.entries(others).map(([n, r]) => [n, stateOf(n, r)])),
  };
  setupMock.mockResolvedValue({
    stateBackend: {
      prefix: 'cdkd',
      // No registry marker yet (a record that predates it): the one-time
      // scan of the other prefixes answers, then a clear answer claims it.
      getRegistryMarker: vi.fn().mockResolvedValue(null),
      claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
      lockUnderPrefix: vi.fn().mockResolvedValue(false),
      listTopLevelPrefixes: vi.fn(async () => {
        if (prefixes.listed instanceof Error) throw prefixes.listed;
        return prefixes.listed ?? [];
      }),
      recordUnderPrefix: vi.fn(async (p: string) =>
        (prefixes.holders ?? []).includes(p) ? 'holder' : 'absent'
      ),
      listStacks: vi
        .fn()
        .mockResolvedValue(Object.keys(states).map((stackName) => ({ stackName, region: REGION }))),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn(async (name: string) =>
        states[name] === undefined ? null : { state: structuredClone(states[name]), etag: 'e0' }
      ),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: REGION,
        segments: [
          {
            timestamp: 1,
            reason: 'no-rollback-failure',
            initialDeploy: false,
            operations: [],
            failedOperations: [failedOp],
          },
        ],
      }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      getLockInfo: vi.fn().mockResolvedValue(null),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

// A KMS key: its physical id is never reused, so deleting the orphan needs
// no identity proof (go-to-k/cdkd#4729), and these cases test only the
// cross-prefix check.
const orphanOp = {
  logicalId: 'Key',
  changeType: 'CREATE',
  resourceType: 'AWS::KMS::Key',
  provisionedBy: 'sdk',
  physicalId: '1234abcd-12ab-34cd-56ef-1234567890ab',
  physicalIdRecoveredFromError: true,
};

const BASE = { statePrefix: 'cdkd', verbose: false, force: true };

describe('cdkd rollback and another state prefix (go-to-k/cdkd#4705)', () => {
  beforeEach(() => {
    warnSpy.mockReset();
    provider.delete.mockReset().mockResolvedValue(undefined);
  });

  it('refuses before any replay when another prefix records the stack, and releases the lock', async () => {
    install(structuredClone(orphanOp), {}, {}, { listed: ['cdkd', 'team-b'], holders: ['cdkd', 'team-b'] });
    const setup = (await setupMock())!;
    await expect(rollbackCommand('S', { ...BASE })).rejects.toThrow(
      /Refusing to roll back stack S \(us-east-1\): it is also recorded under another state prefix of bucket b \(team-b\)/
    );
    expect(provider.delete).not.toHaveBeenCalled();
    expect(setup.stateBackend.saveState).not.toHaveBeenCalled();
    expect(setup.stateBackend.popRollbackJournalSegment).not.toHaveBeenCalled();
    expect(setup.lockManager.releaseLock).toHaveBeenCalledWith('S', REGION);
    // Its own prefix is never probed as "another".
    const probed = setup.stateBackend.recordUnderPrefix.mock.calls.map((c: unknown[]) => c[0]);
    expect(probed).toContain('team-b');
    expect(probed).not.toContain('cdkd');
    // Review R5-8: the command's teardown disposes ITS backend (whose client
    // `setupStateBackend`'s dispose destroys), refused or not.
    expect(setup.dispose).toHaveBeenCalledTimes(1);
  });

  it('replays as before when no other prefix records the stack', async () => {
    install(structuredClone(orphanOp), {}, {}, { listed: ['cdkd', 'team-b'] });
    const setup = (await setupMock())!;
    await rollbackCommand('S', { ...BASE });
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(setup.dispose).toHaveBeenCalledTimes(1);
  });

  it('warns and replays when S3 denies the LISTING', async () => {
    install(structuredClone(orphanOp), {}, {}, {
      listed: Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    });
    await rollbackCommand('S', { ...BASE });
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'S3 refused to list bucket'
    );
  });

  it('warns and replays when S3 denies a READ under a listed prefix', async () => {
    install(structuredClone(orphanOp), {}, {}, { listed: ['cdkd', 'team-b'] });
    const setup = (await setupMock())!;
    setup.stateBackend.recordUnderPrefix.mockImplementation(async () => {
      throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    });
    await rollbackCommand('S', { ...BASE });
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'S3 refused a read under another state prefix'
    );
  });

  it('refuses before the confirmation prompt (no --force), under the lock, and releases it', async () => {
    install(structuredClone(orphanOp), {}, {}, { listed: ['cdkd', 'team-b'], holders: ['team-b'] });
    const setup = (await setupMock())!;
    question.mockReset().mockResolvedValue('y');
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await expect(rollbackCommand('S', { ...BASE, force: false })).rejects.toThrow(
        /Refusing to roll back stack S/
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
    expect(question).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    const acquire = setup.lockManager.acquireLockWithRetry.mock.invocationCallOrder[0]!;
    const release = setup.lockManager.releaseLock.mock.invocationCallOrder[0]!;
    expect(acquire).toBeLessThan(release);
  });
});

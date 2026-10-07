/**
 * go-to-k/cdkd#4678: `cdkd rollback --remove-protection` hands the flag to the
 * delete of a resource a failed CREATE left behind (a journaled orphan, or
 * under `--revert-failed` the failed CREATE state recorded), with the same
 * guards as `cdkd destroy`: one final attempt (the compensation puts the guard
 * back on a failed delete), and never on an orphan another stack holds.
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
const setupMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { createRollbackCommand, rollbackCommand } from '../../../src/cli/commands/rollback.js';
import { isTerminalDeleteFailure } from '../../../src/provisioning/providers/deletion-protection-compensation.js';

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
  others: Record<string, Record<string, unknown>> = {}
): void {
  const states: Record<string, unknown> = {
    S: stateOf('S', ownResources),
    ...Object.fromEntries(Object.entries(others).map(([n, r]) => [n, stateOf(n, r)])),
  };
  setupMock.mockResolvedValue({
    stateBackend: {
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

const orphanOp = {
  logicalId: 'OrphanLb',
  changeType: 'CREATE',
  resourceType: LB_TYPE,
  provisionedBy: 'sdk',
  physicalId: LB_ARN,
  physicalIdRecoveredFromError: true,
  attemptedProperties: {
    LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
  },
};

const BASE = { statePrefix: 'cdkd', verbose: false, force: true };

describe('cdkd rollback --remove-protection (go-to-k/cdkd#4678)', () => {
  const seen: Array<{ logicalId: string; context: Record<string, unknown>; final: boolean }> = [];
  beforeEach(() => {
    seen.length = 0;
    warnSpy.mockReset();
    provider.delete.mockReset().mockImplementation(async (...args: unknown[]) => {
      seen.push({
        logicalId: String(args[0]),
        context: args[4] as Record<string, unknown>,
        final: isTerminalDeleteFailure(
          Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
        ),
      });
    });
  });

  it('registers the option, off by default', () => {
    const opt = createRollbackCommand().options.find((o) => o.long === '--remove-protection');
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe(false);
  });

  it("hands it to a journaled orphan's delete, as its final attempt", async () => {
    install(structuredClone(orphanOp), { R: record('r-1', 'AWS::SSM::Parameter') });
    await rollbackCommand('S', { ...BASE, removeProtection: true });
    expect(seen.map((s) => s.logicalId)).toEqual(['OrphanLb']);
    expect(seen[0]!.context['removeProtection']).toBe(true);
    expect(seen[0]!.final).toBe(true);
  });

  it('strips nothing without the flag', async () => {
    install(structuredClone(orphanOp), { R: record('r-1', 'AWS::SSM::Parameter') });
    await rollbackCommand('S', { ...BASE });
    expect(seen.map((s) => s.logicalId)).toEqual(['OrphanLb']);
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(seen[0]!.final).toBe(false);
  });

  // E.g. a later `cdkd import` adopted the load balancer into stack B.
  it("keeps the protection of an orphan another stack's record holds", async () => {
    install(
      structuredClone(orphanOp),
      { R: record('r-1', 'AWS::SSM::Parameter') },
      { B: { Adopted: record(LB_ARN, LB_TYPE) } }
    );
    await rollbackCommand('S', { ...BASE, removeProtection: true }).catch(() => undefined);
    expect(seen.map((s) => s.logicalId)).toEqual(['OrphanLb']);
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'stack B (us-east-1) holds it now'
    );
  });

  // `--revert-failed` deletes a failed CREATE state recorded through the same
  // arm: the record is the stack's own, so no proof or scan is needed.
  it('hands it to a state-recorded failed CREATE under --revert-failed', async () => {
    const { physicalIdRecoveredFromError: _drop, ...recorded } = structuredClone(orphanOp);
    install(recorded, { OrphanLb: record(LB_ARN, LB_TYPE) });
    await rollbackCommand('S', { ...BASE, revertFailed: true, removeProtection: true });
    expect(seen.map((s) => s.logicalId)).toEqual(['OrphanLb']);
    expect(seen[0]!.context['removeProtection']).toBe(true);
  });
});

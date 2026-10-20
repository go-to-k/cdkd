/**
 * go-to-k/cdkd#5111: an UNCHANGED deploy still retries the delete of a
 * superseded resource an earlier deploy recorded, and saves the record
 * without it once it is gone; `--dry-run` sends nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK_NAME = 'MyStack';
const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const OLD = 'arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/Tg-gen1/aaa';
const NEW = 'arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/Tg-gen2/bbb';

describe('an unchanged deploy retries a recorded superseded delete (#5111)', () => {
  const del = vi.fn();
  const saveState = vi.fn();
  const getState = vi.fn();

  function makeEngine(dryRun = false) {
    const provider = { create: vi.fn(), update: vi.fn(), delete: del, getAttribute: vi.fn() };
    return new DeployEngine(
      {
        getState,
        saveState,
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
        deleteRollbackJournal: vi.fn().mockResolvedValue(true),
      } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(
          new Map<string, ResourceChange>([
            [
              'Tg',
              {
                logicalId: 'Tg',
                changeType: 'NO_CHANGE',
                resourceType: TG,
                currentProperties: { Port: 9090 },
                desiredProperties: { Port: 9090 },
              },
            ],
          ])
        ),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const record = (physicalId: string): ResourceState => ({
    physicalId,
    resourceType: TG,
    properties: { Port: physicalId === OLD ? 8080 : 9090 },
    attributes: {},
    dependencies: [],
  });
  const template = {
    Resources: { Tg: { Type: TG, Properties: { Port: 9090 } } },
  } as unknown as CloudFormationTemplate;

  beforeEach(() => {
    vi.clearAllMocks();
    del.mockReset().mockResolvedValue(undefined);
    saveState.mockReset().mockResolvedValue('etag-new');
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK_NAME,
      resources: { Tg: record(NEW) },
      supersededResources: [{ logicalId: 'Tg', supersededAt: 1, state: record(OLD) }],
      outputs: {},
      lastModified: 0,
    };
    getState.mockReset().mockResolvedValue({ state, etag: 'etag-old' });
  });

  it('deletes it and saves the record without it', async () => {
    await makeEngine().deploy(STACK_NAME, template);

    expect(del.mock.calls.map((c) => c[1])).toEqual([OLD]);
    const last = saveState.mock.calls.at(-1)?.[2] as StackState | undefined;
    expect(last).toBeDefined();
    expect(last!.supersededResources).toBeUndefined();
    expect(last!.resources['Tg']!.physicalId).toBe(NEW);
  });

  it('--dry-run sends nothing', async () => {
    await makeEngine(true).deploy(STACK_NAME, template);

    expect(del).not.toHaveBeenCalled();
  });
});

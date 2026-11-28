/**
 * go-to-k/cdkd#7191: an UNCHANGED deploy saves a carried superseded record
 * that a pre-v11 binary left holding a `NoEcho` value in plaintext at a
 * position today's template names, so the save masks it and keeps the record;
 * a repaired record (or one no position reaches) triggers no save. A kept
 * rollback orphan takes the same trigger; this harness's adoption pre-pass
 * consumes one whose logical id the live record holds, so it exercises the
 * superseded record.
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
  IntrinsicFunctionResolver: vi.fn(() => ({
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

const STACK_NAME = 'MyStack7191';
const TYPE = 'AWS::Test::Db7191';
/** Under the needle floor: only a position masks it. */
const SHORT = 'q7';

describe('an unchanged deploy repairs a carried pre-v11 NoEcho plaintext (#7191)', () => {
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
              'Db',
              {
                logicalId: 'Db',
                changeType: 'NO_CHANGE',
                resourceType: TYPE,
                currentProperties: { Password: '***', Name: 'public' },
                desiredProperties: { Password: '***', Name: 'public' },
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

  const live = (): ResourceState => ({
    physicalId: 'db-live',
    resourceType: TYPE,
    // No mask of its own: a masked property with no fingerprint is a save
    // trigger of its own (go-to-k/cdkd#4451), which would hide this one.
    properties: { Name: 'public' },
    attributes: {},
    dependencies: [],
  });
  const preV11 = (physicalId: string, password = SHORT): ResourceState => ({
    physicalId,
    resourceType: TYPE,
    properties: { Password: password, Name: 'public' },
    attributes: {},
    dependencies: [],
  });
  const template = {
    Parameters: { Pw: { Type: 'String', NoEcho: true } },
    Resources: { Db: { Type: TYPE, Properties: { Password: { Ref: 'Pw' }, Name: 'public' } } },
  } as unknown as CloudFormationTemplate;

  function load(extra: Partial<StackState>): void {
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK_NAME,
      resources: { Db: live() },
      outputs: {},
      lastModified: 0,
      ...extra,
    };
    getState.mockReset().mockResolvedValue({ state, etag: 'etag-old' });
  }
  const lastSaved = (): StackState | undefined =>
    saveState.mock.calls.at(-1)?.[2] as StackState | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // The superseded delete fails, so its record is carried.
    del.mockReset().mockRejectedValue(new Error('still in use'));
    saveState.mockReset().mockResolvedValue('etag-new');
  });

  it('saves a pre-v11 superseded record masked, and keeps it', async () => {
    load({ supersededResources: [{ logicalId: 'Db', supersededAt: 1, state: preV11('db-old') }] });
    await makeEngine().deploy(STACK_NAME, template);
    const saved = lastSaved()?.supersededResources;
    expect(saved?.map((e) => e.state.physicalId)).toEqual(['db-old']);
    expect(saved?.[0]?.state.properties).toEqual({ Password: '***', Name: 'public' });
  });

  it('saves nothing for a carried record no NoEcho position reaches', async () => {
    const masked = { ...preV11('db-old'), resourceType: 'AWS::Test::Other7191' };
    load({ supersededResources: [{ logicalId: 'Db', supersededAt: 1, state: masked }] });
    await makeEngine().deploy(STACK_NAME, template);
    expect(saveState).not.toHaveBeenCalled();
  });

  it('a second unchanged deploy over the repaired state saves nothing', async () => {
    load({ supersededResources: [{ logicalId: 'Db', supersededAt: 1, state: preV11('db-old') }] });
    await makeEngine().deploy(STACK_NAME, template);
    const repaired = lastSaved()!;
    saveState.mockClear();
    getState.mockReset().mockResolvedValue({ state: repaired, etag: 'etag-new' });
    await makeEngine().deploy(STACK_NAME, template);
    expect(saveState).not.toHaveBeenCalled();
  });

  it('--dry-run saves nothing', async () => {
    load({ supersededResources: [{ logicalId: 'Db', supersededAt: 1, state: preV11('db-old') }] });
    await makeEngine(true).deploy(STACK_NAME, template);
    expect(saveState).not.toHaveBeenCalled();
  });
});

/**
 * State schema v13 (go-to-k/cdkd#5064): the deploy mints the stack instance
 * id at a stack's FIRST state write, through `DeployEngine.deploy` with the
 * REAL `DiffCalculator` and `DagBuilder`.
 *
 * - a first deploy resolves the id (write-ahead) once, before any create, and
 *   every save it makes -- the final one, and on a failure the partial and
 *   post-rollback saves -- carries it;
 * - a deploy over an existing record never asks for one: a v12 (legacy)
 *   record stays legacy, a v13 record keeps its id;
 * - `--dry-run` asks for nothing and writes nothing;
 * - a failed write-ahead stops the deploy before any create.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { stackInstanceIdOf } from '../../../src/state/stack-instance-id.js';

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

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: vi.fn(() =>
        Promise.reject(
          Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        )
      ),
    },
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'stack-instance-id-5064';
const REGION = 'us-east-1';
const ID = '3d1f2e4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';

const template = (names: string[]): CloudFormationTemplate =>
  ({
    Resources: Object.fromEntries(
      names.map((n) => [n, { Type: 'AWS::SNS::Topic', Properties: { DisplayName: n } }])
    ),
  }) as unknown as CloudFormationTemplate;

const record = (stackInstanceId: string | undefined, version: number): StackState =>
  ({
    version,
    region: REGION,
    stackName: STACK,
    resources: {
      A: {
        physicalId: 'arn:aws:sns:us-east-1:123456789012:A',
        resourceType: 'AWS::SNS::Topic',
        properties: { DisplayName: 'A' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    ...(stackInstanceId !== undefined && { stackInstanceId }),
    lastModified: 0,
  }) as StackState;

describe('DeployEngine and the stack instance id (go-to-k/cdkd#5064)', () => {
  let order: string[];
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    stackInstanceIdForFirstWrite: ReturnType<typeof vi.fn>;
    appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    order = [];
    provider = {
      create: vi.fn((logicalId: string) => {
        order.push(`create ${logicalId}`);
        return Promise.resolve({ physicalId: `arn:aws:sns:us-east-1:123456789012:${logicalId}` });
      }),
      update: vi.fn((_logicalId: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('"etag-new"'),
      stackInstanceIdForFirstWrite: vi.fn(() => {
        order.push('stack instance id');
        return Promise.resolve(ID);
      }),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, captureObservedState: false, ...options },
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const savedStates = (): StackState[] =>
    stateBackend.saveState.mock.calls.map((c) => c[2] as StackState);

  it('a first deploy resolves the id once, written ahead, BEFORE the first create, and saves it', async () => {
    stateBackend.getState.mockResolvedValue(null);
    // Resolved LATE: a create that did not wait for it would come first.
    stateBackend.stackInstanceIdForFirstWrite.mockImplementation(async () => {
      order.push('stack instance id asked');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('stack instance id');
      return ID;
    });
    await makeEngine().deploy(STACK, template(['A', 'B']));
    expect(order.slice(0, 2)).toEqual(['stack instance id asked', 'stack instance id']);
    expect(stateBackend.stackInstanceIdForFirstWrite).toHaveBeenCalledTimes(1);
    expect(stateBackend.stackInstanceIdForFirstWrite).toHaveBeenCalledWith(STACK, REGION, {
      writeAhead: true,
    });
    expect(order.filter((o) => o.startsWith('create'))).toHaveLength(2);
    const saves = savedStates();
    expect(saves.length).toBeGreaterThan(0);
    for (const saved of saves) expect(stackInstanceIdOf(saved, STACK)).toBe(ID);
  });

  it('a failed first deploy carries the id on its partial and post-rollback saves', async () => {
    stateBackend.getState.mockResolvedValue(null);
    provider.create.mockImplementation((logicalId: string) => {
      order.push(`create ${logicalId}`);
      return logicalId === 'B'
        ? Promise.reject(new Error('B failed'))
        : Promise.resolve({ physicalId: `arn:aws:sns:us-east-1:123456789012:${logicalId}` });
    });
    await expect(makeEngine().deploy(STACK, template(['A', 'B']))).rejects.toThrow();
    const saves = savedStates();
    // The partial save before the rollback, and the save after it.
    expect(saves.length).toBeGreaterThanOrEqual(2);
    for (const saved of saves) expect(saved.stackInstanceId).toBe(ID);
  });

  it('a failed first deploy under --no-rollback carries the id on its partial save', async () => {
    stateBackend.getState.mockResolvedValue(null);
    provider.create.mockImplementation((logicalId: string) =>
      logicalId === 'B'
        ? Promise.reject(new Error('B failed'))
        : Promise.resolve({ physicalId: `arn:aws:sns:us-east-1:123456789012:${logicalId}` })
    );
    await expect(makeEngine({ noRollback: true }).deploy(STACK, template(['A', 'B']))).rejects.toThrow();
    const saves = savedStates();
    expect(saves.length).toBeGreaterThan(0);
    expect(saves[0]!.resources['A']).toBeDefined();
    for (const saved of saves) expect(saved.stackInstanceId).toBe(ID);
  });

  it('a deploy over a v12 (legacy) record asks for no id and stays legacy', async () => {
    stateBackend.getState.mockResolvedValue({ state: record(undefined, 12), etag: '"e0"' });
    await makeEngine().deploy(STACK, template(['A', 'B']));
    expect(stateBackend.stackInstanceIdForFirstWrite).not.toHaveBeenCalled();
    const saves = savedStates();
    expect(saves.length).toBeGreaterThan(0);
    for (const saved of saves) expect(Object.hasOwn(saved, 'stackInstanceId')).toBe(false);
  });

  it('a deploy over a v13 record keeps its id and asks for none', async () => {
    stateBackend.getState.mockResolvedValue({ state: record(OTHER_ID, 13), etag: '"e0"' });
    await makeEngine().deploy(STACK, template(['A', 'B']));
    expect(stateBackend.stackInstanceIdForFirstWrite).not.toHaveBeenCalled();
    const saves = savedStates();
    expect(saves.length).toBeGreaterThan(0);
    for (const saved of saves) expect(saved.stackInstanceId).toBe(OTHER_ID);
  });

  it('a failed deploy over a v13 record keeps its id on every save', async () => {
    stateBackend.getState.mockResolvedValue({ state: record(OTHER_ID, 13), etag: '"e0"' });
    provider.create.mockRejectedValue(new Error('B failed'));
    await expect(makeEngine().deploy(STACK, template(['A', 'B']))).rejects.toThrow();
    const saves = savedStates();
    expect(saves.length).toBeGreaterThan(0);
    for (const saved of saves) expect(saved.stackInstanceId).toBe(OTHER_ID);
  });

  it('a first deploy with nothing to create writes its record (outputs only) with the id', async () => {
    stateBackend.getState.mockResolvedValue(null);
    const outputsOnly = {
      Resources: {},
      Outputs: { O: { Value: 'x' } },
    } as unknown as CloudFormationTemplate;
    await makeEngine().deploy(STACK, outputsOnly);
    expect(stateBackend.stackInstanceIdForFirstWrite).toHaveBeenCalledTimes(1);
    const saves = savedStates();
    expect(saves.length).toBe(1);
    expect(saves[0]!.stackInstanceId).toBe(ID);
  });

  it('a first deploy with nothing to create stops before its save when the write-ahead fails', async () => {
    stateBackend.getState.mockResolvedValue(null);
    stateBackend.stackInstanceIdForFirstWrite.mockRejectedValue(new Error('sibling write denied'));
    const outputsOnly = {
      Resources: {},
      Outputs: { O: { Value: 'x' } },
    } as unknown as CloudFormationTemplate;
    await expect(makeEngine().deploy(STACK, outputsOnly)).rejects.toThrow('sibling write denied');
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('a first deploy declined at --require-approval writes no id ahead', async () => {
    stateBackend.getState.mockResolvedValue(null);
    const engine = makeEngine({
      requireApproval: 'any-change',
      approveDeployment: vi.fn().mockResolvedValue(false),
    });
    await expect(engine.deploy(STACK, template(['A']))).rejects.toThrow('was not approved');
    expect(stateBackend.stackInstanceIdForFirstWrite).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('--dry-run of a first deploy asks for no id and writes nothing', async () => {
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine({ dryRun: true }).deploy(STACK, template(['A']));
    expect(stateBackend.stackInstanceIdForFirstWrite).not.toHaveBeenCalled();
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('a write-ahead that fails stops the first deploy before any create or save', async () => {
    stateBackend.getState.mockResolvedValue(null);
    stateBackend.stackInstanceIdForFirstWrite.mockRejectedValue(new Error('sibling write denied'));
    await expect(makeEngine().deploy(STACK, template(['A']))).rejects.toThrow(
      'sibling write denied'
    );
    expect(provider.create).not.toHaveBeenCalled();
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });
});

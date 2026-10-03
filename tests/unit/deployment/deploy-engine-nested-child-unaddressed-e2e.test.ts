/**
 * A nested child's skipped DELETE reaches the parent's `DeployResult`
 * (issue https://github.com/go-to-k/cdkd/issues/1989), driven through the
 * REAL parent `DeployEngine`, the REAL `NestedStackProvider` and the REAL
 * child `DeployEngine` it builds, with the real `DagBuilder` and
 * `DiffCalculator`.
 *
 * The sibling suites each fake one side of the channel
 * (`deploy-engine-nested-child-unaddressed.test.ts` fakes the provider's
 * write, `nested-stack-provider.test.ts` mocks the child engine); this one
 * runs both ends, so a mismatch between where the provider writes and where
 * the engine reads cannot pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import {
  NestedStackProvider,
  PENDING_CHILD_DELETES_KEY,
} from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  type NestedStackProviderContext,
  withNestedStackContext,
} from '../../../src/provisioning/nested-stack-context.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

// The calculator's create-only lookup (`DescribeType`) fails fast:
// registry-only classification, as in the other real-calculator suites.
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

const PARENT = 'Parent1989';
const CHILD = `${PARENT}~Child`;
const REGION = 'us-east-1';
const CHILD_ARN = `arn:cdkd-local:${REGION}:123456789012:nested-stack/${PARENT}/Child`;

const param = (name: string, value: string) => ({
  physicalId: name,
  resourceType: 'AWS::SSM::Parameter',
  properties: { Name: name, Type: 'String', Value: value },
  observedProperties: { Name: name, Type: 'String', Value: value },
  attributes: {},
  dependencies: [],
});

function childTemplatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-1989-e2e-'));
  const path = join(dir, 'child.nested.template.json');
  const child: CloudFormationTemplate = {
    Resources: {
      // Changed, so the child deploy has an ordinary UPDATE beside the skip.
      Keep: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/c/keep', Type: 'String', Value: 'v2' },
      },
      // `Gone` is in the child's state but not here: a template-removal DELETE.
    },
  };
  writeFileSync(path, JSON.stringify(child));
  return path;
}

describe('a nested child skipped DELETE through the real engine and provider (#1989)', () => {
  let states: Map<string, StackState>;
  let leaf: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    states = new Map<string, StackState>([
      [
        PARENT,
        {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: REGION,
          stackName: PARENT,
          resources: {
            Child: {
              physicalId: CHILD_ARN,
              resourceType: 'AWS::CloudFormation::Stack',
              properties: { TemplateURL: 'https://s3.amazonaws.com/a/child-v1.json' },
              observedProperties: { TemplateURL: 'https://s3.amazonaws.com/a/child-v1.json' },
              attributes: {},
              dependencies: [],
            },
          },
          outputs: {},
          lastModified: 0,
        },
      ],
      [
        CHILD,
        {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: REGION,
          stackName: CHILD,
          resources: {
            Keep: param('/c/keep', 'v1'),
            Gone: param('/c/gone', 'x'),
          },
          outputs: {},
          lastModified: 0,
        },
      ],
    ]);
    leaf = {
      create: vi.fn(),
      update: vi.fn((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      // The child's template-removal DELETE: not addressed.
      delete: vi.fn().mockResolvedValue({ outcome: 'skipped', reason: 'test skip' }),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    } as unknown as ResourceProvider;
  });

  function run(): Promise<Awaited<ReturnType<DeployEngine['deploy']>>> {
    vi.clearAllMocks();
    const nested = new NestedStackProvider();
    const pick = (type: string) =>
      type === 'AWS::CloudFormation::Stack' ? (nested as unknown as ResourceProvider) : leaf;
    const providerRegistry = {
      getProvider: vi.fn((type: string) => pick(type)),
      getProviderFor: vi.fn((input: { resourceType: string }) => ({
        provider: pick(input.resourceType),
        provisionedBy: 'sdk',
      })),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    const stateBackend = {
      getState: vi.fn(async (name: string) => {
        const state = states.get(name);
        return state ? { state: structuredClone(state), etag: `etag-${name}` } : null;
      }),
      saveState: vi.fn(async (name: string, _region: string, state: StackState) => {
        states.set(name, structuredClone(state));
        return `etag-${name}`;
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
    const lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const exportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
    const dagBuilder = new DagBuilder();
    const diffCalculator = new DiffCalculator();
    const options = { dryRun: false, concurrency: 1 };
    const engine = new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder,
      diffCalculator,
      providerRegistry as never,
      options,
      REGION,
      exportIndexStore as never
    );
    const ctx: NestedStackProviderContext = {
      stateBackend: stateBackend as never,
      lockManager: lockManager as never,
      providerRegistry: providerRegistry as never,
      parentStackName: PARENT,
      parentRegion: REGION,
      accountId: '123456789012',
      awsClients: {} as never,
      stateBucket: 'cdkd-state-test',
      exportIndexStore: exportIndexStore as never,
      nestedTemplates: { Child: childTemplatePath() },
      dagBuilder,
      diffCalculator,
      options,
    };
    const parentTemplate: CloudFormationTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://s3.amazonaws.com/a/child-v2.json' },
        },
      },
    };
    return withNestedStackContext(ctx, () => engine.deploy(PARENT, parentTemplate));
  }

  it("the child's skipped DELETE is the parent's deleteSkipped, and the child keeps the record", async () => {
    const result = await run();

    // Premise: the child deploy ran its DELETE and its ordinary UPDATE.
    expect(vi.mocked(leaf.delete)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(leaf.update).mock.calls.map((c) => c[0])).toEqual(['Keep']);
    expect(states.get(CHILD)!.resources['Gone']).toBeDefined();

    // The subject: the parent's own result counts it.
    expect(result.updated).toBe(1);
    expect(result.deleteSkipped).toBe(1);
    expect(result.updatePartial).toBe(0);
    expect(result.nestedUpdatePartial).toBe(0);
  });

  it("a child's partial UPDATE is the parent's updatePartial, marked as a descendant's", async () => {
    vi.mocked(leaf.update).mockImplementationOnce(async (_id: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      outcome: 'partial' as const,
      reason: 'the old resource survived',
    }));

    const result = await run();

    expect(vi.mocked(leaf.update).mock.calls.map((c) => c[0])).toEqual(['Keep']);
    // `updated` is the parent's own nested-stack row; the child's partial is
    // in `updatePartial` (the exit code reads it) and in `nestedUpdatePartial`
    // (the summary keeps it out of the parent's `Updated:` total).
    expect(result.updated).toBe(1);
    expect(result.updatePartial).toBe(1);
    expect(result.nestedUpdatePartial).toBe(1);
  });

  it('a plain re-deploy with NO template change re-attempts the child\'s kept DELETE (#4453)', async () => {
    await run();
    // The row records the pending count, a key no template can declare.
    expect(states.get(PARENT)!.resources['Child']!.properties[PENDING_CHILD_DELETES_KEY]).toBe(1);

    // Same template again. Without the marker the row diffs NO_CHANGE, the
    // child never deploys, and the run reports nothing left unaddressed.
    const second = await run();
    expect(vi.mocked(leaf.delete)).toHaveBeenCalledTimes(1);
    // The marker alone drove this run: `Keep` is unchanged, and the row is
    // updated in place, never replaced.
    expect(vi.mocked(leaf.update)).not.toHaveBeenCalled();
    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);
    expect(second.deleteSkipped).toBe(1);
    expect(states.get(CHILD)!.resources['Gone']).toBeDefined();
    expect(states.get(PARENT)!.resources['Child']!.properties[PENDING_CHILD_DELETES_KEY]).toBe(1);
  });

  it('once the re-attempted DELETE lands the marker clears, and the deploy after that changes nothing', async () => {
    await run();
    vi.mocked(leaf.delete).mockResolvedValue(undefined);

    const landed = await run();
    expect(vi.mocked(leaf.delete)).toHaveBeenCalledTimes(1);
    expect(landed.deleteSkipped).toBe(0);
    expect(states.get(CHILD)!.resources['Gone']).toBeUndefined();
    const record = states.get(PARENT)!.resources['Child']!.properties;
    expect(Object.hasOwn(record, PENDING_CHILD_DELETES_KEY)).toBe(false);
    expect(record).toEqual({ TemplateURL: 'https://s3.amazonaws.com/a/child-v2.json' });

    // Negative control: no marker, no template change, no child run.
    const quiet = await run();
    expect(vi.mocked(leaf.delete)).not.toHaveBeenCalled();
    expect(vi.mocked(leaf.update)).not.toHaveBeenCalled();
    expect(quiet.updated).toBe(0);
    expect(quiet.deleteSkipped).toBe(0);
  });
});

/**
 * Three levels (#4453): the skipped DELETE lives in the GRANDCHILD. The root
 * row's marker comes from the child's `deleteSkipped`, which carries the
 * grandchild's (#1989), and on the unchanged re-run the CHILD engine's diff
 * must see its own `Grandchild` row's marker to re-run the level below.
 */
describe('a grandchild skipped DELETE through two real nested levels (#4453)', () => {
  const ROOT = 'Root4453';
  const MID = `${ROOT}~Child`;
  const LEAF_STACK = `${MID}~Grandchild`;
  const MID_ARN = `arn:cdkd-local:${REGION}:123456789012:nested-stack/${ROOT}/Child`;
  const LEAF_ARN = `arn:cdkd-local:${REGION}:123456789012:nested-stack/${MID}/Grandchild`;
  let states: Map<string, StackState>;
  let leaf: ResourceProvider;
  let childPath: string;

  const stackRow = (physicalId: string, url: string) => ({
    physicalId,
    resourceType: 'AWS::CloudFormation::Stack',
    properties: { TemplateURL: url },
    observedProperties: { TemplateURL: url },
    attributes: {},
    dependencies: [],
  });
  const stateOf = (stackName: string, resources: StackState['resources']): StackState => ({
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName,
    resources,
    outputs: {},
    lastModified: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-4453-e2e-'));
    childPath = join(dir, 'child.nested.template.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Resources: {
          Grandchild: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://s3.amazonaws.com/a/gc-v2.json' },
            Metadata: { 'aws:asset:path': 'grandchild.nested.template.json' },
          },
        },
      })
    );
    writeFileSync(
      join(dir, 'grandchild.nested.template.json'),
      JSON.stringify({
        Resources: {
          Keep: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: '/g/keep', Type: 'String', Value: 'v1' },
          },
        },
      })
    );
    states = new Map<string, StackState>([
      [ROOT, stateOf(ROOT, { Child: stackRow(MID_ARN, 'https://s3.amazonaws.com/a/child-v1.json') })],
      [MID, stateOf(MID, { Grandchild: stackRow(LEAF_ARN, 'https://s3.amazonaws.com/a/gc-v1.json') })],
      [LEAF_STACK, stateOf(LEAF_STACK, { Keep: param('/g/keep', 'v1'), Gone: param('/g/gone', 'x') })],
    ]);
    leaf = {
      create: vi.fn(),
      update: vi.fn((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      delete: vi.fn().mockResolvedValue({ outcome: 'skipped', reason: 'test skip' }),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    } as unknown as ResourceProvider;
  });

  function run(): Promise<Awaited<ReturnType<DeployEngine['deploy']>>> {
    vi.clearAllMocks();
    const nested = new NestedStackProvider();
    const pick = (type: string) =>
      type === 'AWS::CloudFormation::Stack' ? (nested as unknown as ResourceProvider) : leaf;
    const providerRegistry = {
      getProvider: vi.fn((type: string) => pick(type)),
      getProviderFor: vi.fn((input: { resourceType: string }) => ({
        provider: pick(input.resourceType),
        provisionedBy: 'sdk',
      })),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    const stateBackend = {
      getState: vi.fn(async (name: string) => {
        const state = states.get(name);
        return state ? { state: structuredClone(state), etag: `etag-${name}` } : null;
      }),
      saveState: vi.fn(async (name: string, _region: string, state: StackState) => {
        states.set(name, structuredClone(state));
        return `etag-${name}`;
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
    const lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const exportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
    const dagBuilder = new DagBuilder();
    const diffCalculator = new DiffCalculator();
    const options = { dryRun: false, concurrency: 1 };
    const engine = new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder,
      diffCalculator,
      providerRegistry as never,
      options,
      REGION,
      exportIndexStore as never
    );
    const ctx: NestedStackProviderContext = {
      stateBackend: stateBackend as never,
      lockManager: lockManager as never,
      providerRegistry: providerRegistry as never,
      parentStackName: ROOT,
      parentRegion: REGION,
      accountId: '123456789012',
      awsClients: {} as never,
      stateBucket: 'cdkd-state-test',
      exportIndexStore: exportIndexStore as never,
      nestedTemplates: { Child: childPath },
      dagBuilder,
      diffCalculator,
      options,
    };
    const rootTemplate: CloudFormationTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://s3.amazonaws.com/a/child-v2.json' },
        },
      },
    };
    return withNestedStackContext(ctx, () => engine.deploy(ROOT, rootTemplate));
  }

  const marker = (stack: string, row: string): unknown =>
    states.get(stack)!.resources[row]!.properties[PENDING_CHILD_DELETES_KEY];

  it('both nested rows carry the marker, and an unchanged re-run reaches the grandchild again', async () => {
    const first = await run();
    expect(vi.mocked(leaf.delete)).toHaveBeenCalledTimes(1);
    expect(first.deleteSkipped).toBe(1);
    expect(marker(ROOT, 'Child')).toBe(1);
    expect(marker(MID, 'Grandchild')).toBe(1);

    const second = await run();
    expect(vi.mocked(leaf.delete)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(leaf.update)).not.toHaveBeenCalled();
    expect(second.deleteSkipped).toBe(1);
    expect(states.get(LEAF_STACK)!.resources['Gone']).toBeDefined();
    expect(marker(ROOT, 'Child')).toBe(1);
    expect(marker(MID, 'Grandchild')).toBe(1);

    // Landed: both markers clear, and the next unchanged deploy is quiet.
    vi.mocked(leaf.delete).mockResolvedValue(undefined);
    const landed = await run();
    expect(landed.deleteSkipped).toBe(0);
    expect(marker(ROOT, 'Child')).toBeUndefined();
    expect(marker(MID, 'Grandchild')).toBeUndefined();
    const quiet = await run();
    expect(vi.mocked(leaf.delete)).not.toHaveBeenCalled();
    expect(quiet.updated).toBe(0);
  });
});

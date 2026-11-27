/**
 * go-to-k/cdkd#7089: `cdkd diff --replace-resource <logicalId>` previews the
 * plan `cdkd deploy --replace-resource` makes: the target replaced, its
 * readers promoted, and the same refusals.
 *
 * Each parity case runs the REAL `DeployEngine` under `--dry-run` and the
 * REAL `computeStackDiff` over the same state and template, and compares the
 * plans row by row: the deploy's change map is the one its `DiffCalculator`
 * returned, which its plan checks then mutate in place.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { buildDiffTree, computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { createDiffCommand } from '../../../src/cli/commands/diff.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { getLogger } from '../../../src/utils/logger.js';

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

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'replace-resource-stack';
const REGION = 'us-east-1';
const FN_TYPE = 'AWS::Lambda::Function';
const PERMISSION_TYPE = 'AWS::Lambda::Permission';
const PARAM_TYPE = 'AWS::SSM::Parameter';
const OLD_ID = 'stack-Fn-OLD';
const PERMISSION_PROPS = {
  Action: 'lambda:InvokeFunction',
  FunctionName: OLD_ID,
  Principal: 'sns.amazonaws.com',
};

function template(memory = 128): CloudFormationTemplate {
  return {
    Resources: {
      Fn: { Type: FN_TYPE, Properties: { Runtime: 'nodejs22.x', MemorySize: memory } },
      RefParam: {
        Type: PARAM_TYPE,
        Properties: { Name: 'ref', Type: 'String', Value: { Ref: 'Fn' } },
      },
      Perm: {
        Type: PERMISSION_TYPE,
        Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Fn' } },
      },
    },
  };
}

const rec = (
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  dependencies: string[]
): ResourceState =>
  ({
    physicalId,
    resourceType,
    properties,
    observedProperties: properties,
    attributes: {},
    dependencies,
    provisionedBy: 'sdk',
  }) as ResourceState;

function priorState(): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Fn: rec(OLD_ID, FN_TYPE, { Runtime: 'nodejs22.x', MemorySize: 128 }, []),
      RefParam: rec('ref', PARAM_TYPE, { Name: 'ref', Type: 'String', Value: OLD_ID }, ['Fn']),
      Perm: rec('stack-Perm-OLD', PERMISSION_TYPE, PERMISSION_PROPS, ['Fn']),
    },
    outputs: {},
    lastModified: 0,
  };
}

/** `Fn`'s update plus a stateful SSM parameter `Cfg` whose `Value` changes. */
function statefulCase(): { template: CloudFormationTemplate; state: StackState } {
  const t = template(256);
  t.Resources['Cfg'] = { Type: PARAM_TYPE, Properties: { Name: 'cfg', Type: 'String', Value: 'v2' } };
  const state = priorState();
  state.resources['Cfg'] = rec('cfg', PARAM_TYPE, { Name: 'cfg', Type: 'String', Value: 'v1' }, []);
  return { template: t, state };
}

/** What a plan says of each row: the verdict, and whether it replaces. */
function planOf(changes: ReadonlyMap<string, ResourceChange>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, change] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
    const replaces = (change.propertyChanges ?? []).some(
      (pc) => pc.requiresReplacement && pc.inPlacePropagated !== true
    );
    out[id] = `${change.changeType}${replaces ? ' replace' : ''}`;
  }
  return out;
}

const warns = (): string[] =>
  (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

describe('cdkd diff --replace-resource previews cdkd deploy --replace-resource (go-to-k/cdkd#7089)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** The deploy's dry-run plan, or the error its plan checks refused with. */
  async function deployPlan(
    state: StackState,
    t: CloudFormationTemplate,
    ids: string[]
  ): Promise<{ changes?: Map<string, ResourceChange>; error?: unknown }> {
    let changes: Map<string, ResourceChange> | undefined;
    const calculator = new DiffCalculator();
    const real = calculator.calculateDiff.bind(calculator);
    calculator.calculateDiff = (async (...args: Parameters<DiffCalculator['calculateDiff']>) =>
      (changes = await real(...args))) as DiffCalculator['calculateDiff'];
    const sdk = { create: vi.fn(), update: vi.fn(), delete: vi.fn(), getAttribute: vi.fn() };
    const engine = new DeployEngine(
      {
        getState: vi.fn().mockResolvedValue({ state, etag: 'etag-old' }),
        saveState: vi.fn(),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      calculator,
      {
        getProvider: vi.fn().mockReturnValue(sdk),
        getProviderFor: vi.fn().mockReturnValue({ provider: sdk, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      {
        dryRun: true,
        ...(ids.length > 0 && { replaceResources: { stackName: STACK, logicalIds: new Set(ids) } }),
      } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
    try {
      await engine.deploy(STACK, structuredClone(t));
    } catch (error) {
      return { error };
    }
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.update).not.toHaveBeenCalled();
    return { ...(changes && { changes }) };
  }

  function diffPlan(state: StackState, t: CloudFormationTemplate, ids: string[]) {
    const backend = { getState: async () => ({ state, etag: 'fake' }) } as unknown as S3StateBackend;
    return computeStackDiff(
      structuredClone(state),
      structuredClone(t),
      REGION,
      STACK,
      backend,
      new DiffCalculator(),
      ids.length > 0 ? { replaceResources: new Set(ids) } : {}
    );
  }

  it('shows the target replaced and its readers promoted, row for row as the deploy plans', async () => {
    const deploy = await deployPlan(priorState(), template(256), ['Fn']);
    const diff = await diffPlan(priorState(), template(256), ['Fn']);
    expect(deploy.error).toBeUndefined();
    const plan = planOf(diff.changes);
    expect(plan).toEqual(planOf(deploy.changes!));
    // The parameter re-reads the new id in place; the permission's
    // create-only FunctionName replaces it too.
    expect(plan).toEqual({ Fn: 'UPDATE replace', Perm: 'UPDATE replace', RefParam: 'UPDATE' });
    expect(diff.blocking).toEqual([]);
  });

  it('control: without the flag both show the target updated in place', async () => {
    const deploy = await deployPlan(priorState(), template(256), []);
    const diff = await diffPlan(priorState(), template(256), []);
    const plan = planOf(diff.changes);
    expect(plan).toEqual(planOf(deploy.changes!));
    expect(plan['Fn']).toBe('UPDATE');
    expect(plan['Perm']).toBe('NO_CHANGE');
  });

  it('blocks with the deploy refusal for a target the template does not change', async () => {
    const deploy = await deployPlan(priorState(), template(128), ['Fn']);
    const diff = await diffPlan(priorState(), template(128), ['Fn']);
    expect((deploy.error as { code?: string }).code).toBe('REPLACE_RESOURCE_REFUSED');
    expect(diff.blocking).toEqual([(deploy.error as Error).message]);
  });

  it('blocks with the deploy refusal for a nested stack target', async () => {
    const t = template(256);
    t.Resources['Child'] = {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'https://example.com/b.json' },
    };
    const state = priorState();
    state.resources['Child'] = rec(
      'arn:aws:cloudformation:us-east-1:123456789012:stack/c/1',
      'AWS::CloudFormation::Stack',
      { TemplateURL: 'https://example.com/a.json' },
      []
    );
    const deploy = await deployPlan(state, t, ['Child']);
    const diff = await diffPlan(state, t, ['Child']);
    expect((deploy.error as { code?: string }).code).toBe('REPLACE_RESOURCE_REFUSED');
    expect((deploy.error as Error).message).toContain('is a nested stack');
    expect(diff.blocking).toEqual([(deploy.error as Error).message]);
  });

  it('warns as the deploy does for a target this deploy creates, and replaces nothing', async () => {
    const t = template(256);
    t.Resources['NewParam'] = { Type: PARAM_TYPE, Properties: { Name: 'n', Type: 'String', Value: 'v' } };
    await deployPlan(priorState(), t, ['NewParam']);
    const deployWarns = warns().filter((w) => w.includes('--replace-resource'));
    vi.clearAllMocks();
    const diff = await diffPlan(priorState(), t, ['NewParam']);
    expect(deployWarns).toEqual([
      '--replace-resource NewParam: not replaced, this deploy will create it instead.',
    ]);
    expect(warns().filter((w) => w.includes('--replace-resource'))).toEqual(deployWarns);
    expect(diff.blocking).toEqual([]);
    expect(planOf(diff.changes)['Fn']).toBe('UPDATE');
  });

  it('warns, rather than blocks, for a stateful target the deploy refuses without --force-stateful-recreation', async () => {
    const { template: t, state } = statefulCase();
    const deploy = await deployPlan(state, t, ['Cfg']);
    expect((deploy.error as { code?: string }).code).toBe('STATEFUL_REPLACE_BLOCKED');
    vi.clearAllMocks();
    const diff = await diffPlan(state, t, ['Cfg']);
    expect(diff.blocking).toEqual([]);
    expect(planOf(diff.changes)['Cfg']).toBe('UPDATE replace');
    const stateful = warns().filter((w) => w.includes('--force-stateful-recreation'));
    expect(stateful).toHaveLength(1);
    expect(stateful[0]).toContain((deploy.error as Error).message);
  });

  it('warns for a stateful reader the replacement would replace', async () => {
    const t = template(256);
    t.Resources['Reader'] = {
      Type: 'AWS::DynamoDB::Table',
      Properties: { TableName: { Ref: 'Fn' }, KeySchema: [] },
    };
    const state = priorState();
    state.resources['Reader'] = rec('tbl', 'AWS::DynamoDB::Table', { TableName: OLD_ID, KeySchema: [] }, [
      'Fn',
    ]);
    const deploy = await deployPlan(state, t, ['Fn']);
    expect((deploy.error as { code?: string }).code).toBe('STATEFUL_REPLACE_BLOCKED');
    vi.clearAllMocks();
    const diff = await diffPlan(state, t, ['Fn']);
    expect(diff.blocking).toEqual([]);
    const stateful = warns().filter((w) => w.includes('--force-stateful-recreation'));
    expect(stateful).toHaveLength(1);
    expect(stateful[0]).toContain((deploy.error as Error).message);
  });

  it('leaves an earlier target unplanned when a later one is refused', async () => {
    const t = template(256);
    t.Resources['Same'] = { Type: PARAM_TYPE, Properties: { Name: 's', Type: 'String', Value: 'v' } };
    const state = priorState();
    state.resources['Same'] = rec('s', PARAM_TYPE, { Name: 's', Type: 'String', Value: 'v' }, []);
    const deploy = await deployPlan(state, t, ['Fn', 'Same']);
    const diff = await diffPlan(state, t, ['Fn', 'Same']);
    expect((deploy.error as { code?: string }).code).toBe('REPLACE_RESOURCE_REFUSED');
    expect(diff.blocking).toEqual([(deploy.error as Error).message]);
    expect(planOf(diff.changes)['Fn']).toBe('UPDATE');
  });

  it('warns once per target it does not replace', async () => {
    const t = template(256);
    t.Resources['NewA'] = { Type: PARAM_TYPE, Properties: { Name: 'a', Type: 'String', Value: 'v' } };
    t.Resources['NewB'] = { Type: PARAM_TYPE, Properties: { Name: 'b', Type: 'String', Value: 'v' } };
    await diffPlan(priorState(), t, ['NewA', 'NewB']);
    expect(warns().filter((w) => w.includes('--replace-resource'))).toEqual([
      '--replace-resource NewA: not replaced, this deploy will create it instead.',
      '--replace-resource NewB: not replaced, this deploy will create it instead.',
    ]);
  });

  it("reads a stateful reader's Fn::If on the condition verdict the diff knows", async () => {
    const withReader = (cond: string): { template: CloudFormationTemplate; state: StackState } => {
      const t = template(256);
      t.Conditions = { UseFn: { 'Fn::Equals': [cond, 'yes'] } };
      t.Resources['Reader'] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: { TableName: { 'Fn::If': ['UseFn', { Ref: 'Fn' }, 'fixed'] }, KeySchema: [] },
      };
      const state = priorState();
      state.resources['Reader'] = rec(
        'tbl',
        'AWS::DynamoDB::Table',
        { TableName: cond === 'yes' ? OLD_ID : 'fixed', KeySchema: [] },
        cond === 'yes' ? ['Fn'] : []
      );
      return { template: t, state };
    };
    const stateful = (): string[] => warns().filter((w) => w.includes('--force-stateful-recreation'));
    const off = withReader('no');
    await diffPlan(off.state, off.template, ['Fn']);
    expect(stateful()).toEqual([]);
    vi.clearAllMocks();
    const on = withReader('yes');
    await diffPlan(on.state, on.template, ['Fn']);
    expect(stateful()).toHaveLength(1);
  });

  function tree(isNestedChild: boolean) {
    const state = priorState();
    return buildDiffTree({
      stackName: STACK,
      displayName: STACK,
      region: REGION,
      template: template(256),
      nestedTemplates: {},
      recursive: false,
      stateBackend: { getState: async () => ({ state, etag: 'fake' }) } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      isNestedChild,
      replaceResources: new Set(['Fn']),
    });
  }

  it("buildDiffTree hands a top-level stack's targets to its diff", async () => {
    expect(planOf((await tree(false)).changes)['Fn']).toBe('UPDATE replace');
  });

  it('buildDiffTree never hands them to a nested child', async () => {
    expect(planOf((await tree(true)).changes)['Fn']).toBe('UPDATE');
  });

  it('diff --replace-resource parses each flag to one logical id', () => {
    const cmd = createDiffCommand();
    cmd.exitOverride();
    cmd.action(() => {});
    cmd.parse(['--replace-resource', 'Fn', '--replace-resource', 'Perm'], { from: 'user' });
    expect(cmd.opts()['replaceResource']).toEqual(['Fn', 'Perm']);
  });
});

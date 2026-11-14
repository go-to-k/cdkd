/**
 * go-to-k/cdkd#6282: a nested child heals a pre-#6272 SSM parameter name
 * (`/<name>`, go-to-k/cdkd#6274) only when its engine runs. Once per stack
 * record, the deploy reads its nested children's records; a row whose subtree
 * holds such a name is updated so the child's engine runs, and the record then
 * carries `nestedSsmNamesChecked`, so later deploys read nothing extra.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { checkNestedSsmNames } from '../../../src/deployment/nested-ssm-name-check.js';
import { generatedNameFor, withStackScope } from '../../../src/provisioning/resource-name.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { withNestedStackContext } from '../../../src/provisioning/nested-stack-context.js';
import { stackInstanceIdCarriedFrom } from '../../../src/types/state/helpers.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { resetRefactorMarkerReadsForTest } from '../../../src/state/refactor-marker.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const { logged } = vi.hoisted(() => ({ logged: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn((m: string) => logged.push(m)),
    warn: vi.fn((m: string) => logged.push(m)),
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

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

// One case below has the rollback-orphan pre-pass adopt a nested-stack row;
// every other case runs the real pre-pass.
const { adoption } = vi.hoisted(() => ({
  adoption: { fake: undefined as undefined | ((state: StackState) => unknown) },
}));
vi.mock('../../../src/deployment/deploy-engine/rollback.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/deployment/deploy-engine/rollback.js')>();
  return {
    ...real,
    adoptRollbackOrphans: (...args: Parameters<typeof real.adoptRollbackOrphans>) =>
      adoption.fake ? adoption.fake(args[1]) : real.adoptRollbackOrphans(...args),
  };
});

// One case below has the check's masked-value prediction miss: a row it
// would defer is forced instead. Every other case runs the real check.
const { prediction } = vi.hoisted(() => ({ prediction: { misses: false } }));
vi.mock('../../../src/deployment/nested-ssm-name-check.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/deployment/nested-ssm-name-check.js')>();
  return {
    ...real,
    checkNestedSsmNames: async (...args: Parameters<typeof real.checkNestedSsmNames>) => {
      const result = await real.checkNestedSsmNames(...args);
      if (!prediction.misses || result === undefined) return result;
      return {
        ...result,
        forcedRows: new Set([...result.forcedRows, ...result.deferredRows]),
        deferredRows: new Set<string>(),
      };
    },
  };
});

const SSM = 'AWS::SSM::Parameter';
const NESTED = 'AWS::CloudFormation::Stack';
const PARENT = 'P';
const CHILD = 'P~Child';
const GRAND = 'P~Child~Grand';
const REGION = 'us-east-1';
const CHILD_ARN = `arn:cdkd-local:${REGION}:123456789012:nested-stack/${PARENT}/Child`;

/** The name cdkd generates for `logicalId` of a legacy `stackName` (no slash). */
function generated(stackName: string, logicalId: string): string {
  return withStackScope({ stackName, stackInstanceId: undefined, nameGenerations: undefined }, () =>
    generatedNameFor(SSM, logicalId)
  );
}

function stateOf(
  stackName: string,
  resources: Record<string, ResourceState>,
  patch: Partial<StackState> = {}
): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName,
    resources,
    outputs: {},
    lastModified: 0,
    ...patch,
  };
}

const ssmRecord = (physicalId: string): ResourceState => ({
  resourceType: SSM,
  physicalId,
  properties: { Type: 'String', Value: 'v' },
});
const nestedRecord = (): ResourceState => ({
  resourceType: NESTED,
  physicalId: CHILD_ARN,
  properties: { TemplateURL: 'https://s3.amazonaws.com/assets/child.json' },
  attributes: {},
});

/** A template declaring an un-named SSM parameter `Param`, plus `extra`. */
function ssmTemplate(extra: Record<string, unknown> = {}): CloudFormationTemplate {
  return {
    Resources: {
      Param: { Type: SSM, Properties: { Type: 'String', Value: 'v' } },
      ...extra,
    },
  } as CloudFormationTemplate;
}

const parentTemplate: CloudFormationTemplate = {
  Resources: {
    Child: {
      Type: NESTED,
      Properties: { TemplateURL: 'https://s3.amazonaws.com/assets/child.json' },
    },
  },
};

let dir: string;
let nestedTemplates: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  logged.length = 0;
  resetRefactorMarkerReadsForTest();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-6282-'));
  // The child declares a grandchild; both declare an un-named SSM parameter.
  fs.writeFileSync(
    path.join(dir, 'child.json'),
    JSON.stringify(
      ssmTemplate({
        Grand: {
          Type: NESTED,
          Properties: { TemplateURL: 'https://s3.amazonaws.com/assets/grand.json' },
          Metadata: { 'aws:asset:path': 'grand.json' },
        },
      })
    )
  );
  fs.writeFileSync(path.join(dir, 'grand.json'), JSON.stringify(ssmTemplate()));
  nestedTemplates = { Child: path.join(dir, 'child.json') };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A record reader over `records`, by stack name. */
function readerOver(records: Record<string, StackState | Error>) {
  return vi.fn(async (stackName: string) => {
    const found = records[stackName];
    if (found instanceof Error) throw found;
    return found ?? null;
  });
}

const childClean = () =>
  stateOf(CHILD, {
    Param: ssmRecord(generated(CHILD, 'Param')),
    Grand: { ...nestedRecord(), physicalId: `${CHILD_ARN}/Grand` },
  });
const grandClean = () => stateOf(GRAND, { Param: ssmRecord(generated(GRAND, 'Param')) });

describe('checkNestedSsmNames (go-to-k/cdkd#6282)', () => {
  const parentState = (patch: Partial<StackState> = {}) =>
    stateOf(PARENT, { Child: nestedRecord() }, patch);

  const check = (state: StackState, readRecord: ReturnType<typeof readerOver>, index = nestedTemplates) =>
    checkNestedSsmNames({
      state,
      template: parentTemplate,
      stackName: PARENT,
      region: REGION,
      nestedTemplates: index,
      readRecord,
    });

  it('forces the row whose child holds a generated /<name>', async () => {
    const child = childClean();
    child.resources['Param'] = ssmRecord(`/${generated(CHILD, 'Param')}`);
    const readRecord = readerOver({ [CHILD]: child, [GRAND]: grandClean() });
    const result = await check(parentState(), readRecord);
    expect(result).toEqual({ forcedRows: new Set(['Child']), deferredRows: new Set(), complete: true });
    // A child that heals itself checks its own children when its engine runs.
    expect(readRecord.mock.calls.map((c) => c[0])).toEqual([CHILD]);
  });

  it('forces the row above a clean child whose grandchild holds one', async () => {
    const readRecord = readerOver({
      [CHILD]: childClean(),
      [GRAND]: stateOf(GRAND, { Param: ssmRecord(`/${generated(GRAND, 'Param')}`) }),
    });
    expect(await check(parentState(), readRecord)).toEqual({
      forcedRows: new Set(['Child']),
      deferredRows: new Set(),
      complete: true,
    });
  });

  it('forces nothing over a clean tree, and is complete', async () => {
    const readRecord = readerOver({ [CHILD]: childClean(), [GRAND]: grandClean() });
    expect(await check(parentState(), readRecord)).toEqual({ forcedRows: new Set(), deferredRows: new Set(), complete: true });
    expect(readRecord.mock.calls.map((c) => c[0]).sort()).toEqual([CHILD, GRAND]);
  });

  it('does not read below a child that carries the mark', async () => {
    const readRecord = readerOver({
      [CHILD]: { ...childClean(), nestedSsmNamesChecked: true },
      [GRAND]: stateOf(GRAND, { Param: ssmRecord(`/${generated(GRAND, 'Param')}`) }),
    });
    expect(await check(parentState(), readRecord)).toEqual({ forcedRows: new Set(), deferredRows: new Set(), complete: true });
    expect(readRecord.mock.calls.map((c) => c[0])).toEqual([CHILD]);
  });

  it('reads nothing for a marked record or a stack with no nested-stack row', async () => {
    const readRecord = readerOver({});
    expect(await check(parentState({ nestedSsmNamesChecked: true }), readRecord)).toBeUndefined();
    expect(
      await checkNestedSsmNames({
        state: stateOf(PARENT, { Param: ssmRecord('x') }),
        template: ssmTemplate(),
        stackName: PARENT,
        region: REGION,
        nestedTemplates,
        readRecord,
      })
    ).toBeUndefined();
    expect(readRecord).not.toHaveBeenCalled();
  });

  it('is incomplete when a read fails or there is no index', async () => {
    const failing = readerOver({ [CHILD]: new Error('AccessDenied') });
    expect((await check(parentState(), failing))?.complete).toBe(false);
    const grandFails = readerOver({ [CHILD]: childClean(), [GRAND]: new Error('throttled') });
    expect((await check(parentState(), grandFails))?.complete).toBe(false);
    const clean = readerOver({ [CHILD]: childClean(), [GRAND]: grandClean() });
    expect(
      await checkNestedSsmNames({
        state: parentState(),
        template: parentTemplate,
        stackName: PARENT,
        region: REGION,
        nestedTemplates: undefined,
        readRecord: clean,
      })
    ).toEqual({ forcedRows: new Set(), deferredRows: new Set(), complete: false });
  });

  it('treats a row whose template the assembly lacks as clean: no deploy of it can run', async () => {
    const readRecord = readerOver({ [CHILD]: stateOf(CHILD, { Param: ssmRecord(`/${generated(CHILD, 'Param')}`) }) });
    expect(await check(parentState(), readRecord, {})).toEqual({
      forcedRows: new Set(),
      deferredRows: new Set(),
      complete: true,
    });
    expect(readRecord).not.toHaveBeenCalled();
  });

  it('defers, rather than forces, a row whose record holds a masked value', async () => {
    const child = childClean();
    child.resources['Param'] = ssmRecord(`/${generated(CHILD, 'Param')}`);
    const readRecord = readerOver({ [CHILD]: child });
    const state = stateOf(PARENT, {
      Child: { ...nestedRecord(), properties: { Parameters: { In: 'prefix-***' } } },
    });
    expect(await check(state, readRecord)).toEqual({
      forcedRows: new Set(),
      deferredRows: new Set(['Child']),
      complete: true,
    });
  });

  it('defers the row above a clean child whose only deferred row is the grandchild’s', async () => {
    // The grandchild holds the slashed name, but the child's Grand row holds
    // a masked value: the child row is deferred (and named), not dropped.
    const child = childClean();
    child.resources['Grand'] = {
      ...child.resources['Grand']!,
      properties: { Parameters: { In: '***' } },
    };
    const readRecord = readerOver({
      [CHILD]: child,
      [GRAND]: stateOf(GRAND, { Param: ssmRecord(`/${generated(GRAND, 'Param')}`) }),
    });
    expect(await check(parentState(), readRecord)).toEqual({
      forcedRows: new Set(),
      deferredRows: new Set(['Child']),
      complete: true,
    });
  });

  it('treats a child with no record as clean, and a row with no record as unread', async () => {
    const readRecord = readerOver({});
    expect(await check(parentState(), readRecord)).toEqual({ forcedRows: new Set(), deferredRows: new Set(), complete: true });
    const none = readerOver({});
    expect(await check(stateOf(PARENT, {}), none)).toEqual({ forcedRows: new Set(), deferredRows: new Set(), complete: true });
    expect(none).not.toHaveBeenCalled();
  });

  it('stops at a cyclic template tree', async () => {
    fs.writeFileSync(
      path.join(dir, 'grand.json'),
      JSON.stringify(
        ssmTemplate({
          Again: {
            Type: NESTED,
            Properties: {},
            Metadata: { 'aws:asset:path': 'child.json' },
          },
        })
      )
    );
    const grand = stateOf(GRAND, {
      Param: ssmRecord(generated(GRAND, 'Param')),
      Again: { ...nestedRecord(), physicalId: `${CHILD_ARN}/Again` },
    });
    const readRecord = readerOver({ [CHILD]: childClean(), [GRAND]: grand });
    expect((await check(parentState(), readRecord))?.complete).toBe(false);
  });

  it('is carried by every non-deploy writer', () => {
    expect(stackInstanceIdCarriedFrom({ nestedSsmNamesChecked: true })).toEqual({
      nestedSsmNamesChecked: true,
    });
    expect(stackInstanceIdCarriedFrom({})).toEqual({});
  });
});

describe('DeployEngine - nested children checked once (go-to-k/cdkd#6282)', () => {
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let records: Record<string, StackState | Error>;
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };

  let childCheckFinishes: boolean;
  let childHeals: boolean;
  // Set by the depth-2 case: the Child row's update runs a real child engine.
  let runChildEngine: ((physicalId: string) => Promise<unknown>) | undefined;

  beforeEach(() => {
    adoption.fake = undefined;
    prediction.misses = false;
    childCheckFinishes = true;
    childHeals = true;
    runChildEngine = undefined;
    records = {};
    provider = {
      create: vi.fn(),
      // The nested stack's update returns the child's outputs, the way
      // `NestedStackProvider.update` does after the child deploy.
      // Its child's own deploy (not run here) finishes its own check and
      // marks the child record, unless a case says the child's check failed.
      update: vi.fn((logicalId: string, physicalId: string) => {
        if (logicalId === 'Child' && runChildEngine !== undefined) return runChildEngine(physicalId);
        const grand = records[GRAND];
        if (logicalId === 'Grand' && grand && !(grand instanceof Error)) {
          // The grandchild's own deploy re-spells its record (no nested row).
          const healed = structuredClone(grand);
          const param = healed.resources['Param'];
          if (param) param.physicalId = param.physicalId.replace(/^\//, '');
          records[GRAND] = healed;
        }
        const child = records[CHILD];
        if (logicalId === 'Child' && childHeals && child && !(child instanceof Error)) {
          // The child's own heal (go-to-k/cdkd#6274) re-spells its record.
          const healed = structuredClone(child);
          const param = healed.resources['Param'];
          if (param) param.physicalId = param.physicalId.replace(/^\//, '');
          records[CHILD] = { ...healed, ...(childCheckFinishes && { nestedSsmNamesChecked: true }) };
        }
        return Promise.resolve(
          logicalId === 'Child'
            ? { physicalId, wasReplaced: false, attributes: { 'Outputs.ParamName': 'healed' } }
            : { physicalId, wasReplaced: false }
        );
      }),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn(async (stackName: string) => {
        const found = records[stackName];
        if (found instanceof Error) throw found;
        return found === undefined ? null : { state: structuredClone(found), etag: 'etag-old' };
      }),
      // A save is what the next read returns, as on S3.
      saveState: vi.fn(async (stackName: string, _region: string, state: StackState) => {
        records[stackName] = structuredClone(state);
        return 'etag-new';
      }),
    };
  });

  function makeEngine(): DeployEngine {
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
        reportSdkUnwiredDecisions: vi.fn(),
        getEffectivePropertiesFn: vi.fn().mockReturnValue(undefined),
      } as never,
      {},
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const deploy = (template: CloudFormationTemplate = parentTemplate) =>
    withNestedStackContext({ nestedTemplates } as never, () =>
      makeEngine().deploy(PARENT, template)
    );
  const savedStates = () => stateBackend.saveState.mock.calls.map((c) => c[2] as StackState);
  const readNames = () => stateBackend.getState.mock.calls.map((c) => c[0] as string);
  const childUpdates = () => provider.update.mock.calls.filter((c) => c[0] === 'Child');

  it('updates the row of a child holding /<name>, and marks the record once the deploy succeeds', async () => {
    const child = childClean();
    child.resources['Param'] = ssmRecord(`/${generated(CHILD, 'Param')}`);
    records = { [PARENT]: stateOf(PARENT, { Child: nestedRecord() }), [CHILD]: child };
    await deploy();
    expect(childUpdates()).toHaveLength(1);
    expect(logged.some((m) => m.includes('Nested stack Child') && m.includes('#6282'))).toBe(true);
    const final = savedStates().at(-1)!;
    expect(final.nestedSsmNamesChecked).toBe(true);
    expect(final.resources['Child']?.attributes).toEqual({ 'Outputs.ParamName': 'healed' });
  });

  it('does not mark when the updated child could not finish its own check of its children', async () => {
    const child = childClean();
    child.resources['Param'] = ssmRecord(`/${generated(CHILD, 'Param')}`);
    records = { [PARENT]: stateOf(PARENT, { Child: nestedRecord() }), [CHILD]: child };
    // The child deploy succeeded, but a grandchild read failed inside it, so
    // its record carries no mark.
    childCheckFinishes = false;
    await deploy();
    expect(childUpdates()).toHaveLength(1);
    expect(savedStates().some((s) => s.nestedSsmNamesChecked === true)).toBe(false);
  });

  it('marks when the updated child has no nested-stack row of its own', async () => {
    fs.writeFileSync(path.join(dir, 'child.json'), JSON.stringify(ssmTemplate()));
    const child = stateOf(CHILD, { Param: ssmRecord(`/${generated(CHILD, 'Param')}`) });
    records = { [PARENT]: stateOf(PARENT, { Child: nestedRecord() }), [CHILD]: child };
    childCheckFinishes = false;
    await deploy();
    expect(savedStates().at(-1)?.nestedSsmNamesChecked).toBe(true);
  });

  it('heals a slashed grandchild under a clean child: the child deploy forces the grandchild row', async () => {
    records = {
      [PARENT]: stateOf(PARENT, { Child: nestedRecord() }),
      [CHILD]: childClean(),
      [GRAND]: stateOf(GRAND, { Param: ssmRecord(`/${generated(GRAND, 'Param')}`) }),
    };
    const childTemplate = JSON.parse(fs.readFileSync(path.join(dir, 'child.json'), 'utf-8'));
    // What `NestedStackProvider.update` does: the child's own engine, under
    // the grandchild index; the Grand row's update stands in for its deploy.
    runChildEngine = async (physicalId) => {
      await withNestedStackContext({ nestedTemplates: { Grand: path.join(dir, 'grand.json') } } as never, () =>
        makeEngine().deploy(CHILD, childTemplate)
      );
      return { physicalId, wasReplaced: false, attributes: {} };
    };
    await deploy();
    expect(provider.update.mock.calls.map((c) => c[0])).toEqual(['Child', 'Grand']);
    const saved = stateBackend.saveState.mock.calls.map((c) => [c[0], c[2] as StackState] as const);
    expect(saved.filter(([name]) => name === CHILD).at(-1)?.[1].nestedSsmNamesChecked).toBe(true);
    expect(saved.filter(([name]) => name === PARENT).at(-1)?.[1].nestedSsmNamesChecked).toBe(true);
  });

  it('keeps the mark on a change deploy of a marked record', async () => {
    const template: CloudFormationTemplate = {
      Resources: { ...parentTemplate.Resources, Param: ssmTemplate().Resources['Param']! },
    };
    records = {
      [PARENT]: stateOf(
        PARENT,
        {
          Child: nestedRecord(),
          Param: { ...ssmRecord(generated(PARENT, 'Param')), properties: { Type: 'String', Value: 'old' } },
        },
        { nestedSsmNamesChecked: true }
      ),
    };
    await deploy(template);
    expect(provider.update.mock.calls.map((c) => c[0])).toEqual(['Param']);
    expect(savedStates().at(-1)?.nestedSsmNamesChecked).toBe(true);
  });

  const maskedReaderCase = (): CloudFormationTemplate => {
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify(ssmTemplate()));
    nestedTemplates = { ...nestedTemplates, Other: path.join(dir, 'other.json') };
    const child = childClean();
    child.resources['Param'] = ssmRecord(`/${generated(CHILD, 'Param')}`);
    records = {
      [PARENT]: stateOf(PARENT, {
        Other: {
          ...nestedRecord(),
          physicalId: `${CHILD_ARN}-other`,
          properties: { TemplateURL: 'https://s3.amazonaws.com/assets/o.json' },
          attributes: { 'Outputs.Secret': '***' },
          noEchoAttributeNames: ['Outputs.Secret'],
        },
        Child: {
          ...nestedRecord(),
          properties: {
            TemplateURL: 'https://s3.amazonaws.com/assets/child.json',
            Parameters: { In: '***' },
          },
          dependencies: ['Other'],
        },
      }),
      [CHILD]: child,
      [GRAND]: grandClean(),
    };
    return {
      Resources: {
        Other: { Type: NESTED, Properties: { TemplateURL: 'https://s3.amazonaws.com/assets/o.json' } },
        Child: {
          Type: NESTED,
          Properties: {
            TemplateURL: 'https://s3.amazonaws.com/assets/child.json',
            Parameters: { In: { 'Fn::GetAtt': ['Other', 'Outputs.Secret'] } },
          },
        },
      },
    };
  };

  it('skips, warns and does not mark when a forced row reads a masked value the check did not predict', async () => {
    // Without the skip, the #2274 redacted-read refusal would fail a deploy
    // of a stack nobody changed.
    const template = maskedReaderCase();
    prediction.misses = true;
    await deploy(template);
    expect(childUpdates()).toHaveLength(0);
    expect(logged.some((m) => m.includes('Child: the nested stack is not updated') && m.includes('#6282'))).toBe(
      true
    );
    expect(savedStates().some((s) => s.nestedSsmNamesChecked === true)).toBe(false);
  });

  it('defers, names and still marks a row whose Parameters read a masked value', async () => {
    // Updating it would reach the #2274 redacted-read refusal and fail a
    // deploy of a stack nobody changed; CloudFormation deploys it as a no-op.
    const template = maskedReaderCase();
    await deploy(template);
    expect(childUpdates()).toHaveLength(0);
    expect(logged.some((m) => m.includes('Nested stack Child') && m.includes('stores masked'))).toBe(true);
    // The next deploy would only find it again: the record is marked.
    expect(savedStates().at(-1)?.nestedSsmNamesChecked).toBe(true);
  });

  it.each<[string, () => Error | undefined]>([
    ['is gone', () => undefined],
    ['cannot be read', () => new Error('throttled')],
  ])('does not mark when the updated child’s record %s afterwards', async (_label, after) => {
    fs.writeFileSync(path.join(dir, 'child.json'), JSON.stringify(ssmTemplate()));
    const child = stateOf(CHILD, { Param: ssmRecord(`/${generated(CHILD, 'Param')}`) });
    records = { [PARENT]: stateOf(PARENT, { Child: nestedRecord() }), [CHILD]: child };
    runChildEngine = async (physicalId: string): Promise<unknown> => {
      const value = after();
      if (value === undefined) delete records[CHILD];
      else records[CHILD] = value;
      return { physicalId, wasReplaced: false, attributes: {} };
    };
    await deploy();
    expect(childUpdates()).toHaveLength(1);
    expect(savedStates().some((s) => s.nestedSsmNamesChecked === true)).toBe(false);
  });

  it('does not mark when the updated child’s record still holds the name', async () => {
    fs.writeFileSync(path.join(dir, 'child.json'), JSON.stringify(ssmTemplate()));
    const child = stateOf(CHILD, { Param: ssmRecord(`/${generated(CHILD, 'Param')}`) });
    records = { [PARENT]: stateOf(PARENT, { Child: nestedRecord() }), [CHILD]: child };
    childHeals = false;
    await deploy();
    expect(childUpdates()).toHaveLength(1);
    expect(savedStates().some((s) => s.nestedSsmNamesChecked === true)).toBe(false);
  });

  it('promotes a parent reader of the forced row’s outputs', async () => {
    const child = childClean();
    child.resources['Param'] = ssmRecord(`/${generated(CHILD, 'Param')}`);
    const template: CloudFormationTemplate = {
      Resources: {
        ...parentTemplate.Resources,
        Reader: {
          Type: SSM,
          Properties: {
            Name: '/app/reader',
            Type: 'String',
            Value: { 'Fn::GetAtt': ['Child', 'Outputs.ParamName'] },
          },
        },
      },
    };
    const parentChild = { ...nestedRecord(), attributes: { 'Outputs.ParamName': '/old' } };
    records = {
      [PARENT]: stateOf(PARENT, {
        Child: parentChild,
        Reader: {
          resourceType: SSM,
          physicalId: '/app/reader',
          properties: { Name: '/app/reader', Type: 'String', Value: '/old' },
          dependencies: ['Child'],
        },
      }),
      [CHILD]: child,
    };
    await deploy(template);
    const readerUpdate = provider.update.mock.calls.find((c) => c[0] === 'Reader');
    expect(readerUpdate?.[3]).toMatchObject({ Value: 'healed' });
  });

  it('saves only the mark on an unchanged tree whose children are clean', async () => {
    records = {
      [PARENT]: stateOf(PARENT, { Child: nestedRecord() }),
      [CHILD]: childClean(),
      [GRAND]: grandClean(),
    };
    await deploy();
    expect(provider.update).not.toHaveBeenCalled();
    expect(savedStates()).toHaveLength(1);
    expect(savedStates()[0]?.nestedSsmNamesChecked).toBe(true);
  });

  it('reads no child record for the check, and saves nothing, once the record carries the mark', async () => {
    const tree = (patch: Partial<StackState>) => ({
      [PARENT]: stateOf(PARENT, { Child: nestedRecord() }, patch),
      [CHILD]: { ...childClean(), nestedSsmNamesChecked: true as const },
      [GRAND]: grandClean(),
    });
    // The root's success walks every descendant record for its journals
    // (go-to-k/cdkd#3754) whatever the mark says; the check's reads come on top.
    records = tree({});
    await deploy();
    const unmarked = readNames();
    stateBackend.getState.mockClear();
    stateBackend.saveState.mockClear();
    records = tree({ nestedSsmNamesChecked: true });
    await deploy();
    const marked = readNames();
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    const count = (names: string[], name: string) => names.filter((n) => n === name).length;
    // The marked child stops the unmarked check at the child.
    expect(count(unmarked, CHILD) - count(marked, CHILD)).toBe(1);
    expect(count(unmarked, GRAND)).toBe(count(marked, GRAND));
  });

  it('does not mark when a child record cannot be read', async () => {
    records = { [PARENT]: stateOf(PARENT, { Child: nestedRecord() }), [CHILD]: new Error('denied') };
    await deploy();
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('does not mark when the forced child deploy fails', async () => {
    const child = childClean();
    child.resources['Param'] = ssmRecord(`/${generated(CHILD, 'Param')}`);
    records = { [PARENT]: stateOf(PARENT, { Child: nestedRecord() }), [CHILD]: child };
    provider.update.mockRejectedValue(new Error('child deploy failed'));
    await expect(deploy()).rejects.toThrow();
    expect(savedStates().some((s) => s.nestedSsmNamesChecked === true)).toBe(false);
  });

  it('does not mark when the orphan pre-pass adopts a nested-stack row the check never read', async () => {
    const parentTemplate2: CloudFormationTemplate = {
      Resources: {
        ...parentTemplate.Resources,
        Other: { Type: NESTED, Properties: { TemplateURL: 'https://s3.amazonaws.com/assets/o.json' } },
      },
    };
    records = {
      [PARENT]: stateOf(PARENT, { Child: nestedRecord() }),
      [CHILD]: childClean(),
      [GRAND]: grandClean(),
    };
    adoption.fake = (state) => {
      const adopted = { Other: { ...nestedRecord(), physicalId: `${CHILD_ARN}-other` } };
      Object.assign(state.resources, adopted);
      return { adopted, remaining: [], refusals: [], notices: [] };
    };
    await deploy(parentTemplate2);
    expect(savedStates().some((s) => s.nestedSsmNamesChecked === true)).toBe(false);
  });

  it('reads nothing and adds no field for a stack with no nested-stack row', async () => {
    records = { [PARENT]: stateOf(PARENT, { Param: ssmRecord(generated(PARENT, 'Param')) }) };
    await deploy(ssmTemplate());
    expect(readNames()).toEqual([PARENT]);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });
});

describe('DiffCalculator - forced nested child runs (go-to-k/cdkd#6282)', () => {
  it('turns only a nested-stack row into a flagged UPDATE', async () => {
    const template: CloudFormationTemplate = {
      Resources: { ...parentTemplate.Resources, Param: ssmTemplate().Resources['Param']! },
    };
    const state = stateOf(PARENT, { Child: nestedRecord(), Param: ssmRecord('p') });
    const forced = new Set(['Child', 'Param', 'Absent']);
    const calc = new DiffCalculator();
    const run = (f?: ReadonlySet<string>) =>
      calc.calculateDiff(state, template, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, f);
    const changes = await run(forced);
    expect(changes.get('Child')).toMatchObject({ changeType: 'UPDATE', nestedChildHeal: true });
    expect(changes.get('Child')?.propertyChanges).toEqual([]);
    expect(changes.get('Param')?.changeType).toBe('NO_CHANGE');
    expect(changes.has('Absent')).toBe(false);
    // CONTROL: without the set the row is unchanged.
    expect((await run()).get('Child')?.changeType).toBe('NO_CHANGE');
  });
});

/**
 * go-to-k/cdkd#5064 phase 2, through `DeployEngine.deploy` with the REAL
 * `DiffCalculator` and `DagBuilder`: on a stack with an instance id a
 * replacement creates its new resource under the NEXT name generation (so it
 * creates first and needs no `--replace`), a crash re-run derives that same
 * name again, a rollback records the generation the deleted copy reached, a
 * logical id that left the stack comes back under a new name, and a
 * rollback-left orphan is not taken back. A legacy stack (no id) keeps every
 * name and every refusal it had.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import {
  generateResourceName,
  generateResourceNameWithFallback,
  stackInstanceNameSuffix,
  withStackScope,
} from '../../../src/provisioning/resource-name.js';

const logger = vi.hoisted(() => {
  const fns: Record<string, unknown> = {};
  for (const k of ['setLevel', 'debug', 'info', 'warn', 'error']) fns[k] = vi.fn();
  fns['child'] = () => fns;
  return fns as Record<string, ReturnType<typeof vi.fn>> & { child: () => unknown };
});
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => logger }));

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

const STACK = 'NameGen';
const REGION = 'us-east-1';
const ID = '3d1f2e4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const TABLE = 'AWS::DynamoDB::Table';
const ROLE = 'AWS::IAM::Role';
const QUEUE = 'AWS::SQS::Queue';

/** The name cdkd generates for `logicalId` at `generation` on the id stack. */
const genName = (logicalId: string, generation: number): string =>
  `${STACK}-${logicalId}-${stackInstanceNameSuffix(ID, logicalId, generation)}`;

const keySchema = (attr: string) => ({
  KeySchema: [{ AttributeName: attr, KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: attr, AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
});

const tableRecord = (physicalId: string, attr: string, over: Partial<ResourceState> = {}) =>
  ({
    physicalId,
    resourceType: TABLE,
    properties: keySchema(attr),
    attributes: {},
    dependencies: [],
    ...over,
  }) as ResourceState;

const stateOf = (
  resources: Record<string, ResourceState>,
  over: Partial<StackState> = {}
): StackState =>
  ({
    version: 13,
    region: REGION,
    stackName: STACK,
    resources,
    outputs: {},
    stackInstanceId: ID,
    lastModified: 0,
    ...over,
  }) as StackState;

const tableTemplate = (attr: string, extra: Record<string, unknown> = {}): CloudFormationTemplate =>
  ({
    Resources: { Table: { Type: TABLE, Properties: keySchema(attr) }, ...extra },
  }) as unknown as CloudFormationTemplate;

describe('DeployEngine and per-resource name generations (go-to-k/cdkd#5064 phase 2)', () => {
  let events: string[];
  /** Names AWS holds. */
  let held: Set<string>;
  let failCreate: Set<string>;
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    held = new Set();
    failCreate = new Set();
    provider = {
      create: vi.fn(async (logicalId: string, type: string, props: Record<string, unknown>) => {
        const name =
          type === ROLE
            ? generateResourceNameWithFallback(
                props['RoleName'] as string | undefined,
                logicalId,
                { maxLength: 64 }
              )
            : generateResourceName(logicalId, { maxLength: 255 });
        if (failCreate.has(logicalId)) {
          events.push(`fail ${name}`);
          throw new Error(`${logicalId} failed`);
        }
        if (held.has(name)) {
          events.push(`collide ${name}`);
          throw Object.assign(new Error(`Resource ${name} already exists`), {
            name: 'AlreadyExistsException',
            $metadata: { httpStatusCode: 400 },
          });
        }
        held.add(name);
        events.push(`create ${name}`);
        return { physicalId: name, attributes: {} };
      }),
      update: vi.fn(async (_l: string, physicalId: string) => ({
        physicalId,
        wasReplaced: false,
      })),
      delete: vi.fn(async (_l: string, physicalId: string) => {
        held.delete(physicalId);
        events.push(`delete ${physicalId}`);
      }),
      getAttribute: vi.fn(),
      import: vi.fn(async () => null),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('"etag-new"'),
      stackInstanceIdForFirstWrite: vi.fn().mockResolvedValue(ID),
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
      // DynamoDB is stateful: its replacement needs the consent flag.
      { dryRun: false, captureObservedState: false, forceStatefulRecreation: true, ...options },
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const load = (state: StackState) => {
    for (const r of Object.values(state.resources)) held.add(r.physicalId);
    stateBackend['getState']!.mockResolvedValue({ state, etag: '"e0"' });
  };
  const lastSaved = (): StackState => stateBackend['saveState']!.mock.calls.at(-1)![2] as StackState;

  it('a replacement creates the next generation FIRST, deletes the old one, needs no --replace', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    await makeEngine().deploy(STACK, tableTemplate('id'));
    expect(events).toEqual([`create ${genName('Table', 1)}`, `delete ${genName('Table', 0)}`]);
    const saved = lastSaved().resources['Table']!;
    expect(saved.physicalId).toBe(genName('Table', 1));
    expect(saved.nameGeneration).toBe(1);
  });

  it('an un-named IAM role whose Path changes is replaced create-first at generation 1, no --replace', async () => {
    const roleName = (g: number) => genName('Role', g);
    const role = (path: string) => ({
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
      Path: path,
    });
    load(
      stateOf({
        Role: {
          physicalId: roleName(0),
          resourceType: ROLE,
          properties: role('/a/'),
          attributes: {},
          dependencies: [],
        },
      })
    );
    await makeEngine().deploy(STACK, {
      Resources: { Role: { Type: ROLE, Properties: role('/b/') } },
    } as unknown as CloudFormationTemplate);
    expect(events).toEqual([`create ${roleName(1)}`, `delete ${roleName(0)}`]);
    expect(lastSaved().resources['Role']!.nameGeneration).toBe(1);
  });

  it('the update-not-supported fallback also creates the next generation FIRST', async () => {
    const TOPIC = 'AWS::SNS::Topic';
    load(
      stateOf({
        Topic: {
          physicalId: genName('Topic', 0),
          resourceType: TOPIC,
          properties: { DisplayName: 'a' },
          attributes: {},
          dependencies: [],
        },
      })
    );
    provider['update']!.mockRejectedValueOnce(
      Object.assign(new Error('update is not supported for this type'), {
        name: 'UnsupportedActionException',
      })
    );
    await makeEngine().deploy(STACK, {
      Resources: { Topic: { Type: TOPIC, Properties: { DisplayName: 'b' } } },
    } as unknown as CloudFormationTemplate);
    expect(events).toEqual([`create ${genName('Topic', 1)}`, `delete ${genName('Topic', 0)}`]);
    expect(lastSaved().resources['Topic']!.nameGeneration).toBe(1);
  });

  it('a name-adopting replacement is looked up by the generated-name guard at its next-generation name, not probed', async () => {
    const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
    const tgName = (g: number) =>
      withStackScope(
        { stackName: STACK, stackInstanceId: ID, nameGenerations: new Map([['Tg', g]]) },
        () => generateResourceNameWithFallback(undefined, 'Tg', { maxLength: 32 })
      );
    const arnOf = (n: string) => `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${n}/0123456789abcdef`;
    const looked: string[] = [];
    provider['generatedCreateName'] = vi.fn((_t: string, logicalId: string) =>
      generateResourceNameWithFallback(undefined, logicalId, { maxLength: 32 })
    );
    provider['lookupNames'] = vi.fn(async (_t: string, names: readonly string[]) => {
      looked.push(...names);
      return new Map();
    });
    provider['create'] = vi.fn(async (logicalId: string) => {
      const n = generateResourceNameWithFallback(undefined, logicalId, { maxLength: 32 });
      events.push(`create ${n}`);
      return { physicalId: arnOf(n), attributes: {} };
    });
    Object.assign(stateBackend, {
      loadRollbackJournal: vi.fn(async () => null),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn(async () => undefined),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn(async () => []),
      loadRetainedRecord: vi.fn(async () => null),
      loadCreateTokenLedger: vi.fn(async () => null),
      saveCreateTokenLedger: vi.fn(async () => undefined),
    });
    const tg = (port: number) => ({ Port: port, Protocol: 'HTTP', TargetType: 'ip', VpcId: 'vpc-1' });
    load(
      stateOf({
        Tg: {
          physicalId: arnOf(tgName(0)),
          resourceType: TG,
          properties: tg(80),
          attributes: {},
          dependencies: [],
        },
      })
    );
    await makeEngine().deploy(STACK, {
      Resources: { Tg: { Type: TG, Properties: tg(8080) } },
    } as unknown as CloudFormationTemplate);
    expect(looked).toEqual([tgName(1)]);
    expect(provider['import']).not.toHaveBeenCalled();
    expect(events[0]).toBe(`create ${tgName(1)}`);
    expect(lastSaved().resources['Tg']!.nameGeneration).toBe(1);
  });

  it("a replacement the generated-name guard refuses (another holder of its next name) keeps the generation", async () => {
    const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
    const tgName = (g: number) =>
      withStackScope(
        { stackName: STACK, stackInstanceId: ID, nameGenerations: new Map([['Tg', g]]) },
        () => generateResourceNameWithFallback(undefined, 'Tg', { maxLength: 32 })
      );
    const arnOf = (n: string) => `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${n}/0123456789abcdef`;
    provider['generatedCreateName'] = vi.fn((_t: string, logicalId: string) =>
      generateResourceNameWithFallback(undefined, logicalId, { maxLength: 32 })
    );
    // Someone else holds generation 1's name.
    provider['lookupNames'] = vi.fn(async (_t: string, names: readonly string[]) =>
      new Map(names.map((n) => [n, `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${n}/fedcba9876543210`]))
    );
    Object.assign(stateBackend, {
      loadRollbackJournal: vi.fn(async () => null),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn(async () => undefined),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn(async () => []),
      loadRetainedRecord: vi.fn(async () => null),
      loadCreateTokenLedger: vi.fn(async () => null),
      saveCreateTokenLedger: vi.fn(async () => undefined),
    });
    const tg = (port: number) => ({ Port: port, Protocol: 'HTTP', TargetType: 'ip', VpcId: 'vpc-1' });
    load(
      stateOf({
        Tg: { physicalId: arnOf(tgName(0)), resourceType: TG, properties: tg(80), attributes: {}, dependencies: [] },
      })
    );
    const error = await makeEngine({ noRollback: true })
      .deploy(STACK, { Resources: { Tg: { Type: TG, Properties: tg(8080) } } } as unknown as CloudFormationTemplate)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    // The guard's own refusal, not an early failure of the stubs.
    const codes: unknown[] = [];
    for (let c: unknown = error; c != null; c = (c as { cause?: unknown }).cause)
      codes.push((c as { code?: unknown }).code);
    expect(codes).toContain('GENERATED_NAME_HELD');
    expect(provider['create']).not.toHaveBeenCalled();
    const saved = lastSaved().resources['Tg']!;
    expect(saved.physicalId).toBe(arnOf(tgName(0)));
    expect(saved.nameGeneration).toBeUndefined();
    expect(saved.nameGenerationHigh).toBeUndefined();
    const segment = stateBackend['appendRollbackJournalSegment']!.mock.calls.at(-1)![2] as {
      failedOperations?: Array<{ logicalId: string; nameGeneration?: number }>;
    };
    const failed = segment.failedOperations?.find((o) => o.logicalId === 'Tg');
    expect(failed).toBeDefined();
    expect(failed).not.toHaveProperty('nameGeneration');
  });

  it('an in-place update of a later generation keeps its fields; the next replacement goes past them', async () => {
    load(
      stateOf({
        Table: tableRecord(genName('Table', 2), 'pk', { nameGeneration: 2, nameGenerationHigh: 3 }),
      })
    );
    await makeEngine().deploy(STACK, {
      Resources: {
        Table: { Type: TABLE, Properties: { ...keySchema('pk'), TableClass: 'STANDARD_INFREQUENT_ACCESS' } },
      },
    } as unknown as CloudFormationTemplate);
    expect(events).toEqual([]);
    const kept = lastSaved().resources['Table']!;
    expect(kept.nameGeneration).toBe(2);
    expect(kept.nameGenerationHigh).toBe(3);
    events = [];
    load(stateOf({ Table: kept }));
    await makeEngine().deploy(STACK, tableTemplate('id'));
    expect(events[0]).toBe(`create ${genName('Table', 4)}`);
  });

  it('a FAILED replacement raises the record past the generation it asked for, whatever the rollback', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    failCreate.add('Table');
    await expect(makeEngine().deploy(STACK, tableTemplate('id'))).rejects.toThrow();
    const saved = lastSaved().resources['Table']!;
    expect(saved.physicalId).toBe(genName('Table', 0));
    expect(saved.nameGenerationHigh).toBe(1);
  });

  it('a replacement REFUSED on a squatter of its next name keeps the generation: the retry, plain or --replace, asks for the same name and refuses again', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    held.add(genName('Table', 1));
    for (const options of [{}, { replace: true }, { noRollback: true }]) {
      events = [];
      await expect(makeEngine(options).deploy(STACK, tableTemplate('id'))).rejects.toThrow(
        'Failed to update resource Table'
      );
      // The same next-generation name each time, and nothing deleted.
      expect(events).toEqual([`collide ${genName('Table', 1)}`]);
      const saved = lastSaved().resources['Table']!;
      expect(saved.physicalId).toBe(genName('Table', 0));
      expect(saved.nameGeneration).toBeUndefined();
      expect(saved.nameGenerationHigh).toBeUndefined();
      load(lastSaved());
    }
    // Nothing reached generation 1, so the journal claims none.
    const segment = stateBackend['appendRollbackJournalSegment']!.mock.calls.at(-1)![2] as {
      failedOperations?: Array<{ logicalId: string; nameGeneration?: number }>;
    };
    const failed = segment.failedOperations?.find((o) => o.logicalId === 'Table');
    expect(failed).toBeDefined();
    expect(failed).not.toHaveProperty('nameGeneration');
  });

  it('a failed CREATE of a re-added logical id journals the generation its name took', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }, { retiredNameGenerations: { Old: 0 } }));
    failCreate.add('Old');
    await expect(
      makeEngine({ noRollback: true }).deploy(STACK, {
        Resources: {
          Table: { Type: TABLE, Properties: keySchema('pk') },
          Old: { Type: QUEUE, Properties: {} },
        },
      } as unknown as CloudFormationTemplate)
    ).rejects.toThrow();
    expect(events).toEqual([`fail ${genName('Old', 1)}`]);
    const segment = stateBackend['appendRollbackJournalSegment']!.mock.calls.at(-1)![2] as {
      failedOperations?: Array<{ logicalId: string; nameGeneration?: number }>;
    };
    expect(segment.failedOperations?.find((o) => o.logicalId === 'Old')?.nameGeneration).toBe(1);
  });

  it("a rollback that leaves a Retain create in AWS retires its logical id at the orphan's generation", async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    failCreate.add('Fail');
    await expect(
      makeEngine().deploy(STACK, {
        Resources: {
          Table: { Type: TABLE, Properties: keySchema('pk') },
          Kept: { Type: QUEUE, Properties: {}, DeletionPolicy: 'Retain' },
          Fail: { Type: QUEUE, Properties: {}, DependsOn: ['Kept'] },
        },
      } as unknown as CloudFormationTemplate)
    ).rejects.toThrow();
    const saved = lastSaved();
    expect(saved.orphans?.map((o) => o.logicalId)).toEqual(['Kept']);
    expect(saved.retiredNameGenerations).toEqual({ Kept: 0 });
    expect(held.has(genName('Kept', 0))).toBe(true);
  });

  // go-to-k/cdkd#5064: a CREATE the rollback deletes retires its generation,
  // so the next create asks for a new name (an SQS queue or a secret refuses
  // a just-deleted one), as CloudFormation names a re-create anew.
  const madeThenFailed = {
    Resources: {
      Table: { Type: TABLE, Properties: keySchema('pk') },
      Made: { Type: QUEUE, Properties: {} },
      Fail: { Type: QUEUE, Properties: {}, DependsOn: ['Made'] },
    },
  } as unknown as CloudFormationTemplate;

  it('a CREATE the rollback deletes retires its generation; the next create takes the next name', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    failCreate.add('Fail');
    await expect(makeEngine().deploy(STACK, madeThenFailed)).rejects.toThrow();
    expect(events).toContain(`delete ${genName('Made', 0)}`);
    const saved = lastSaved();
    expect(saved.resources['Made']).toBeUndefined();
    expect(saved.retiredNameGenerations).toEqual({ Made: 0 });

    events = [];
    failCreate.clear();
    load(saved);
    await makeEngine().deploy(STACK, madeThenFailed);
    expect(events).toContain(`create ${genName('Made', 1)}`);
    expect(events).not.toContain(`create ${genName('Made', 0)}`);
  });

  it('a re-added id created at retired + 1 and rolled back retires at that generation', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }, { retiredNameGenerations: { Made: 2 } }));
    failCreate.add('Fail');
    await expect(makeEngine().deploy(STACK, madeThenFailed)).rejects.toThrow();
    expect(events).toContain(`delete ${genName('Made', 3)}`);
    expect(lastSaved().retiredNameGenerations).toEqual({ Made: 3 });
  });

  it('a legacy stack retires nothing when the rollback deletes a CREATE', async () => {
    load(stateOf({ Table: tableRecord(`${STACK}-Table`, 'pk') }, { stackInstanceId: undefined }));
    failCreate.add('Fail');
    await expect(makeEngine().deploy(STACK, madeThenFailed)).rejects.toThrow();
    expect(events).toContain(`delete ${STACK}-Made`);
    expect(Object.hasOwn(lastSaved(), 'retiredNameGenerations')).toBe(false);
  });

  it('a --recreate-via-* target of a name-adopting type is looked up at its next-generation name', async () => {
    const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
    const tgName = (g: number) =>
      withStackScope(
        { stackName: STACK, stackInstanceId: ID, nameGenerations: new Map([['Tg', g]]) },
        () => generateResourceNameWithFallback(undefined, 'Tg', { maxLength: 32 })
      );
    const looked: string[] = [];
    provider['generatedCreateName'] = vi.fn((_t: string, logicalId: string) =>
      generateResourceNameWithFallback(undefined, logicalId, { maxLength: 32 })
    );
    provider['lookupNames'] = vi.fn(async (_t: string, names: readonly string[]) => {
      looked.push(...names);
      return new Map();
    });
    Object.assign(stateBackend, {
      loadRollbackJournal: vi.fn(async () => null),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn(async () => undefined),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn(async () => []),
      loadRetainedRecord: vi.fn(async () => null),
      loadCreateTokenLedger: vi.fn(async () => null),
      saveCreateTokenLedger: vi.fn(async () => undefined),
    });
    const tg = { Port: 80, Protocol: 'HTTP', TargetType: 'ip', VpcId: 'vpc-1' };
    load(
      stateOf({
        Tg: { physicalId: `arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/${tgName(0)}/1`, resourceType: TG, properties: tg, attributes: {}, dependencies: [], provisionedBy: 'cc-api' },
      })
    );
    await makeEngine({
      recreateTargets: { stackName: STACK, viaCcApi: new Set(), viaSdkProvider: new Set(['Tg']) },
    })
      .deploy(STACK, { Resources: { Tg: { Type: TG, Properties: tg } } } as unknown as CloudFormationTemplate)
      .catch(() => undefined);
    expect(looked).toEqual([tgName(1)]);
  });

  it("the post-rollback save's ETag retry retires the orphan's generation too", async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    failCreate.add('Fail');
    let refused = false;
    stateBackend['saveState']!.mockImplementation(async (_n: string, _r: string, st: StackState) => {
      if (!refused && st.orphans !== undefined) {
        refused = true;
        throw new Error('PreconditionFailed');
      }
      return '"etag-new"';
    });
    await expect(
      makeEngine().deploy(STACK, {
        Resources: {
          Table: { Type: TABLE, Properties: keySchema('pk') },
          Kept: { Type: QUEUE, Properties: {}, DeletionPolicy: 'Retain' },
          Fail: { Type: QUEUE, Properties: {}, DependsOn: ['Kept'] },
        },
      } as unknown as CloudFormationTemplate)
    ).rejects.toThrow();
    expect(refused).toBe(true);
    const retried = lastSaved();
    expect(retried.orphans?.map((o) => o.logicalId)).toEqual(['Kept']);
    expect(retried.retiredNameGenerations).toEqual({ Kept: 0 });
  });

  it('an in-place update of a name-adopting type is not looked up by the generated-name guard', async () => {
    const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
    provider['generatedCreateName'] = vi.fn((_t: string, logicalId: string) =>
      generateResourceNameWithFallback(undefined, logicalId, { maxLength: 32 })
    );
    provider['lookupNames'] = vi.fn(async () => new Map());
    const tg = (path: string) => ({
      Port: 80,
      Protocol: 'HTTP',
      TargetType: 'ip',
      VpcId: 'vpc-1',
      HealthCheckPath: path,
    });
    load(
      stateOf({
        Tg: { physicalId: 'arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/x/1', resourceType: TG, properties: tg('/a'), attributes: {}, dependencies: [] },
      })
    );
    await makeEngine().deploy(STACK, {
      Resources: { Tg: { Type: TG, Properties: tg('/b') } },
    } as unknown as CloudFormationTemplate);
    expect(provider['update']).toHaveBeenCalled();
    expect(provider['lookupNames']).not.toHaveBeenCalled();
  });

  it('a crash re-run derives the SAME next-generation name (a pure function of the record)', async () => {
    const state = stateOf({ Table: tableRecord(genName('Table', 0), 'pk') });
    failCreate.add('Table');
    load(state);
    await expect(makeEngine().deploy(STACK, tableTemplate('id'))).rejects.toThrow();
    failCreate.clear();
    load(state);
    await makeEngine().deploy(STACK, tableTemplate('id'));
    expect(events).toEqual([
      `fail ${genName('Table', 1)}`,
      `create ${genName('Table', 1)}`,
      `delete ${genName('Table', 0)}`,
    ]);
    // The second run took generation 1, never 2.
    expect(events.some((e) => e.includes(genName('Table', 2)))).toBe(false);
  });

  it('a rolled-back replacement records the generation it reached; the retry goes past it', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    failCreate.add('After');
    await expect(
      makeEngine().deploy(
        STACK,
        tableTemplate('id', {
          After: { Type: QUEUE, Properties: {}, DependsOn: ['Table'] },
        })
      )
    ).rejects.toThrow();
    const restored = lastSaved().resources['Table']!;
    expect(restored.physicalId).toBe(genName('Table', 0));
    expect(restored.nameGeneration).toBeUndefined();
    expect(restored.nameGenerationHigh).toBe(1);
    expect(held.has(genName('Table', 1))).toBe(false);
    // The retry asks for generation 2, never the rolled-back copy's name.
    events = [];
    failCreate.clear();
    load(stateOf({ Table: restored }));
    await makeEngine().deploy(STACK, tableTemplate('id'));
    expect(events[0]).toBe(`create ${genName('Table', 2)}`);
    expect(lastSaved().resources['Table']!.nameGeneration).toBe(2);
  });

  it('a rollback that RE-ADOPTS a retained old resource records the generation too', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    failCreate.add('After');
    await expect(
      makeEngine().deploy(STACK, {
        Resources: {
          Table: { Type: TABLE, Properties: keySchema('id'), UpdateReplacePolicy: 'Retain' },
          After: { Type: QUEUE, Properties: {}, DependsOn: ['Table'] },
        },
      } as unknown as CloudFormationTemplate)
    ).rejects.toThrow();
    // The new copy is Retain-pinned too, so it survives (CloudFormation's
    // DELETE_SKIPPED): the next replacement must not ask for its name.
    expect(events).toEqual([`create ${genName('Table', 1)}`, `fail ${genName('After', 0)}`]);
    const restored = lastSaved().resources['Table']!;
    expect(restored.physicalId).toBe(genName('Table', 0));
    expect(restored.nameGenerationHigh).toBe(1);
  });

  it('--no-rollback journals the generation on the completed and the failed replacement', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    failCreate.add('After');
    await expect(
      makeEngine({ noRollback: true }).deploy(
        STACK,
        tableTemplate('id', { After: { Type: QUEUE, Properties: {}, DependsOn: ['Table'] } })
      )
    ).rejects.toThrow();
    const segment = stateBackend['appendRollbackJournalSegment']!.mock.calls.at(-1)![2] as {
      operations: Array<{ logicalId: string; nameGeneration?: number }>;
      failedOperations?: Array<{ logicalId: string; nameGeneration?: number }>;
    };
    expect(segment.operations.find((o) => o.logicalId === 'Table')?.nameGeneration).toBe(1);
    // A CREATE journals the generation its name was derived at.
    expect(segment.failedOperations?.find((o) => o.logicalId === 'After')?.nameGeneration).toBe(0);
  });

  it('a failed replacement create journals the generation it asked for', async () => {
    load(stateOf({ Table: tableRecord(genName('Table', 0), 'pk') }));
    failCreate.add('Table');
    await expect(makeEngine({ noRollback: true }).deploy(STACK, tableTemplate('id'))).rejects.toThrow();
    const segment = stateBackend['appendRollbackJournalSegment']!.mock.calls.at(-1)![2] as {
      failedOperations?: Array<{ logicalId: string; nameGeneration?: number }>;
    };
    expect(segment.failedOperations?.find((o) => o.logicalId === 'Table')?.nameGeneration).toBe(1);
  });

  for (const policy of ['Delete', 'Retain'] as const) {
    it(`a record that leaves the stack (DeletionPolicy ${policy}) retires its generation; a re-add takes the next`, async () => {
      load(
        stateOf({
          Table: tableRecord(genName('Table', 0), 'pk'),
          Old: tableRecord(genName('Old', 0), 'pk', { deletionPolicy: policy }),
        })
      );
      await makeEngine().deploy(STACK, tableTemplate('pk'));
      const afterRemove = lastSaved();
      expect(afterRemove.resources['Old']).toBeUndefined();
      expect(afterRemove.retiredNameGenerations).toEqual({ Old: 0 });
      // Re-added: a new name, and the record says which generation.
      events = [];
      held.clear();
      if (policy === 'Retain') held.add(genName('Old', 0));
      load(afterRemove);
      await makeEngine().deploy(STACK, {
        Resources: {
          Table: { Type: TABLE, Properties: keySchema('pk') },
          Old: { Type: TABLE, Properties: keySchema('pk') },
        },
      } as unknown as CloudFormationTemplate);
      expect(events).toEqual([`create ${genName('Old', 1)}`]);
      const saved = lastSaved();
      expect(saved.resources['Old']!.nameGeneration).toBe(1);
      expect(saved.retiredNameGenerations).toEqual({ Old: 0 });
    });
  }

  it('a rollback-left Retain orphan is not taken back on an id stack: a new name, a warning naming cdkd import', async () => {
    const orphan = tableRecord(genName('Kept', 0), 'pk', { deletionPolicy: 'Retain' });
    load(
      stateOf(
        { Table: tableRecord(genName('Table', 0), 'pk') },
        {
          orphans: [{ logicalId: 'Kept', orphanedAt: 1, state: orphan }],
          retiredNameGenerations: { Kept: 0 },
        }
      )
    );
    held.add(genName('Kept', 0));
    await makeEngine().deploy(STACK, {
      Resources: {
        Table: { Type: TABLE, Properties: keySchema('pk') },
        Kept: { Type: TABLE, Properties: keySchema('pk') },
      },
    } as unknown as CloudFormationTemplate);
    expect(provider['import']).not.toHaveBeenCalled();
    expect(events).toEqual([`create ${genName('Kept', 1)}`]);
    expect(held.has(genName('Kept', 0))).toBe(true);
    const warned = logger['warn']!.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes('Kept') && w.includes("'cdkd import'"))).toBe(true);
  });

  describe('a legacy stack (no stack instance id) is unchanged', () => {
    it('a replacement asks for the same legacy name, collides, and deletes nothing', async () => {
      load(stateOf({ Table: tableRecord(`${STACK}-Table`, 'pk') }, { stackInstanceId: undefined }));
      const error = await makeEngine()
        .deploy(STACK, tableTemplate('id'))
        .then(
          () => undefined,
          (e: unknown) => e as Error & { cause?: Error }
        );
      expect(error?.cause?.message).toMatch(/requires replacement/);
      expect(events).toEqual([`collide ${STACK}-Table`]);
      expect(provider['delete']).not.toHaveBeenCalled();
    });

    it('--replace keeps the legacy delete-first order and the name, and writes no generation', async () => {
      load(stateOf({ Table: tableRecord(`${STACK}-Table`, 'pk') }, { stackInstanceId: undefined }));
      await makeEngine({ replace: true }).deploy(STACK, tableTemplate('id'));
      expect(events).toEqual([
        `collide ${STACK}-Table`,
        `delete ${STACK}-Table`,
        `create ${STACK}-Table`,
      ]);
      const saved = lastSaved();
      expect(saved.resources['Table']!.physicalId).toBe(`${STACK}-Table`);
      expect(Object.hasOwn(saved.resources['Table']!, 'nameGeneration')).toBe(false);
    });

    it('a removal retires nothing', async () => {
      load(
        stateOf(
          {
            Table: tableRecord(`${STACK}-Table`, 'pk'),
            Old: tableRecord(`${STACK}-Old`, 'pk'),
          },
          { stackInstanceId: undefined }
        )
      );
      await makeEngine().deploy(STACK, tableTemplate('pk'));
      expect(Object.hasOwn(lastSaved(), 'retiredNameGenerations')).toBe(false);
    });
  });
});

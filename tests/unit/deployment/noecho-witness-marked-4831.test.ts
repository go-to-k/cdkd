/**
 * go-to-k/cdkd#4831: the migration witness covers a MARKED record too. A
 * record another `NoEcho` source already marked (`noEchoLeaves`) can still
 * hold a plaintext where today's template masks: a parameter declared `NoEcho`
 * only now, with its value unchanged. That stored plaintext is an exact
 * witness: equal reads as unchanged (no replacement of a create-only name, and
 * the next save stores `***`), different reads as a change. Driven through
 * `DeployEngine.deploy` with the REAL `DiffCalculator`, `DagBuilder` and
 * `IntrinsicFunctionResolver`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';

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

// Per-test DescribeType knobs (review round 8): a type's write-only list, and
// a lookup that fails outright (the snapshot fallback then answers).
const describeType = vi.hoisted(() => ({
  writeOnly: new Map<string, string[]>(),
  fail: false,
}));

vi.mock('../../../src/utils/aws-clients.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getAwsClients: () => ({
      cloudFormation: {
        send: vi.fn((command: { input?: { TypeName?: string } }) => {
          const paths = CREATE_ONLY_PATHS_SNAPSHOT.get(command.input?.TypeName ?? '');
          if (paths === undefined || describeType.fail) {
            return Promise.reject(
              Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
                name: 'AccessDeniedException',
                $metadata: { httpStatusCode: 403 },
              })
            );
          }
          return Promise.resolve({
            Schema: JSON.stringify({
              createOnlyProperties: paths.map((path) => `/properties/${path.join('/')}`),
              writeOnlyProperties: (describeType.writeOnly.get(command.input?.TypeName ?? '') ?? []).map(
                (name) => `/properties/${name}`
              ),
            }),
          });
        }),
      },
      sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
      secretsManager: {
        send: vi
          .fn()
          .mockResolvedValue({ SecretString: JSON.stringify({ pw: 'sm-secret-plaintext-value' }) }),
      },
    }),
  };
});

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'noecho-witness-marked-stack';
const REGION = 'us-east-1';
const TOKEN = 'tok-4831-distinctive-0001';
const TOPIC = 'topic-4831-distinctive';
const TOPIC_ARN = `arn:aws:sns:us-east-1:123456789012:${TOPIC}`;

describe('DeployEngine - the migration witness on a MARKED record (go-to-k/cdkd#4831)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    describeType.writeOnly.clear();
    describeType.fail = false;
    clearCreateOnlyPropertiesCache();
    clearWriteOnlyPropertiesCache();
    vi.clearAllMocks();
    provider = {
      create: vi.fn((logicalId: string) =>
        Promise.resolve({ physicalId: `${logicalId}-new-arn`, attributes: {} })
      ),
      update: vi.fn((_logicalId: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(() => Promise.resolve({ TopicName: TOPIC, DisplayName: TOKEN })),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    } as never;
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
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, captureObservedState: false },
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const topicCalls = (fn: ReturnType<typeof vi.fn>): number =>
    fn.mock.calls.filter((c) => c[0] === 'Topic').length;

  /** What a binary before the change wrote: a marked record, `TopicName` stored as `stored`. */
  const markedState = (topicName: unknown, displayName: unknown, leaves: string[][]): StackState => ({
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Topic: {
        physicalId: TOPIC_ARN,
        resourceType: 'AWS::SNS::Topic',
        properties: { TopicName: topicName, DisplayName: displayName },
        attributes: {},
        dependencies: [],
        noEchoLeaves: leaves,
      } as ResourceState,
    },
    outputs: {},
    lastModified: 0,
  });

  /** `TopicName` now reads a parameter declared `NoEcho` only today; `DisplayName` an old one. */
  const template = (topicParameterValue: string): CloudFormationTemplate =>
    ({
      Parameters: {
        Token: { Type: 'String', NoEcho: true, Default: TOKEN },
        TopicName: { Type: 'String', NoEcho: true, Default: topicParameterValue },
      },
      Resources: {
        Topic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { Ref: 'TopicName' }, DisplayName: { Ref: 'Token' } },
        },
      },
    }) as unknown as CloudFormationTemplate;

  /** Written while `TopicName` was an ordinary parameter: stored in plaintext, unmarked. */
  const before = (): StackState => markedState(TOPIC, '***', [['DisplayName']]);

  it('an unchanged value newly declared NoEcho is not replaced, and is then stored as the mask', async () => {
    stateBackend.getState.mockResolvedValue({ state: before(), etag: 'etag-old' });
    await makeEngine().deploy(STACK, template(TOPIC));
    expect(topicCalls(provider.create)).toBe(0);
    expect(topicCalls(provider.delete)).toBe(0);
    const saved = stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState | undefined;
    const topic = saved?.resources['Topic'];
    expect(topic?.properties).toMatchObject({ TopicName: '***', DisplayName: '***' });
    // The physical id (the ARN) keeps the name, as AWS publishes it; no
    // property or other field of the record does.
    expect(JSON.stringify({ ...topic, physicalId: undefined })).not.toContain(TOPIC);
    expect(topic?.noEchoLeaves).toEqual([['DisplayName'], ['TopicName']]);
  });

  it('a value that DIFFERS from the stored plaintext is still a create-only change (replaced)', async () => {
    stateBackend.getState.mockResolvedValue({ state: before(), etag: 'etag-old' });
    await makeEngine().deploy(STACK, template('topic-4831-renamed'));
    expect(topicCalls(provider.create)).toBe(1);
    expect(topicCalls(provider.delete)).toBe(1);
  });
  it('records the echo fidelity of a migrated create-only leaf, so a later change of its value is not kept back', async () => {
    stateBackend.getState.mockResolvedValue({ state: before(), etag: 'etag-old' });
    await makeEngine().deploy(STACK, template(TOPIC));
    const saved = stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState | undefined;
    // The readback was handed the mask there (#4656 rule 1), and the provider
    // reported the deployed name exactly.
    const handedTopicNames = provider.readCurrentState.mock.calls.flatMap((call) =>
      call
        .filter((arg): arg is Record<string, unknown> => arg !== null && typeof arg === 'object')
        .filter((arg) => Object.hasOwn(arg, 'TopicName'))
        .map((arg) => arg['TopicName'])
    );
    expect(handedTopicNames.length).toBeGreaterThan(0);
    expect(handedTopicNames.every((name) => name === '***')).toBe(true);
    expect(saved?.resources['Topic']?.noEchoExactEchoLeaves).toEqual([['TopicName']]);
  });

  it('takes the migration readback when the witness confirms a mutable leaf no other block reads', async () => {
    // DisplayName is NOT create-only, so no ceiling reads; the migration
    // readback runs anyway and records the create-only TopicName's fidelity.
    const t = {
      Parameters: {
        Name: { Type: 'String', NoEcho: true, Default: TOPIC },
        Disp: { Type: 'String', NoEcho: true, Default: TOKEN },
      },
      Resources: {
        Topic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { Ref: 'Name' }, DisplayName: { Ref: 'Disp' } },
        },
      },
    } as unknown as CloudFormationTemplate;
    // Marked at TopicName; DisplayName read an ordinary parameter until now.
    stateBackend.getState.mockResolvedValue({
      state: markedState('***', TOKEN, [['TopicName']]),
      etag: 'etag-old',
    });
    await makeEngine().deploy(STACK, t);
    expect(topicCalls(provider.update)).toBe(0);
    const saved = (stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState).resources['Topic'];
    expect(saved?.noEchoLeaves).toEqual([['DisplayName'], ['TopicName']]);
    expect(saved?.noEchoExactEchoLeaves).toEqual([['TopicName']]);
  });

  it("takes the migration readback when the record's earlier mark is a held producer's NoEcho attribute", async () => {
    // DisplayName reads a custom resource's NoEcho attribute; the producer is
    // not updated, so nothing is supplied fresh and no other block reads.
    const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:h';
    const t = {
      Parameters: { Name: { Type: 'String', NoEcho: true, Default: TOPIC } },
      Resources: {
        Cr: { Type: 'Custom::Seed', Properties: { ServiceToken: SERVICE_TOKEN } },
        Topic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { Ref: 'Name' }, DisplayName: { 'Fn::GetAtt': ['Cr', 'Secret'] } },
        },
      },
    } as unknown as CloudFormationTemplate;
    const state = markedState(TOPIC, '***', [['DisplayName']]);
    state.resources['Topic']!.dependencies = ['Cr'];
    state.resources['Cr'] = {
      physicalId: 'cr-id',
      resourceType: 'Custom::Seed',
      properties: { ServiceToken: SERVICE_TOKEN },
      attributes: { Secret: '***' },
      dependencies: [],
      noEchoAttributeNames: ['Secret'],
    } as ResourceState;
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    await makeEngine().deploy(STACK, t);
    expect(topicCalls(provider.create)).toBe(0);
    expect(topicCalls(provider.update)).toBe(0);
    const handedTopicNames = provider.readCurrentState.mock.calls.flatMap((call) =>
      call
        .filter((arg): arg is Record<string, unknown> => arg !== null && typeof arg === 'object')
        .filter((arg) => Object.hasOwn(arg, 'TopicName'))
        .map((arg) => arg['TopicName'])
    );
    expect(handedTopicNames).toEqual(['***']);
    const saved = (stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState).resources['Topic'];
    expect(saved?.noEchoLeaves).toEqual([['DisplayName'], ['TopicName']]);
    expect(saved?.noEchoExactEchoLeaves).toEqual([['TopicName']]);
  });

  it.each([
    ['a marked record', true],
    ['an unmarked (pre-v11) record', false],
  ])("hands the provider the confirmed create-only leaf's value, not the mask, when another property changes: %s", async (_l, marked) => {
    // The same deploy edits Tags: an in-place update, whose provider diffs
    // the previous side. `***` there would read as a TopicName change.
    const t = template(TOPIC);
    t.Resources['Topic']!.Properties = {
      ...(t.Resources['Topic']!.Properties as Record<string, unknown>),
      Tags: [{ Key: 'k', Value: 'v2' }],
    };
    const state = marked ? before() : markedState(TOPIC, TOKEN, []);
    if (!marked) delete (state.resources['Topic'] as { noEchoLeaves?: unknown }).noEchoLeaves;
    state.resources['Topic']!.properties['Tags'] = [{ Key: 'k', Value: 'v1' }];
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    await makeEngine().deploy(STACK, t);
    expect(topicCalls(provider.create)).toBe(0);
    expect(topicCalls(provider.delete)).toBe(0);
    const updates = provider.update.mock.calls.filter((c) => c[0] === 'Topic');
    expect(updates).toHaveLength(1);
    const [, , , sent, previous] = updates[0] as [string, string, string, Record<string, unknown>, Record<string, unknown>];
    expect(sent['TopicName']).toBe(TOPIC);
    expect(previous['TopicName']).toBe(TOPIC);
    // The saved record still masks and names it.
    const saved = (stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState).resources['Topic'];
    expect(saved?.properties['TopicName']).toBe('***');
  });

  it('a mixed record: the confirmed leaf is masked and named, a differing one stays as stored and unnamed', async () => {
    // Two parameters newly declared NoEcho: TopicName unchanged (confirmed),
    // a Tags value changed (differing). The Tags change is an in-place
    // update, which fails here, so the old record is saved back.
    const t = template(TOPIC);
    t.Parameters!['TagValue'] = { Type: 'String', NoEcho: true, Default: 'tag-4831-new' } as never;
    t.Resources['Topic']!.Properties = {
      ...(t.Resources['Topic']!.Properties as Record<string, unknown>),
      Tags: [{ Key: 'k', Value: { Ref: 'TagValue' } }],
    };
    const state = before();
    state.resources['Topic']!.properties['Tags'] = [{ Key: 'k', Value: 'tag-4831-old' }];
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    provider.update.mockRejectedValue(new Error('update refused in this test'));
    await makeEngine().deploy(STACK, t).catch(() => undefined);
    const saved = (stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState | undefined)?.resources['Topic'];
    expect(saved).toBeDefined();
    expect(saved?.properties['TopicName']).toBe('***');
    expect(saved?.noEchoLeaves).toEqual([['DisplayName'], ['TopicName']]);
    // The differing leaf keeps what the record held, and is not named.
    expect(saved?.properties['Tags']).toEqual([{ Key: 'k', Value: 'tag-4831-old' }]);
  });

  it.each([
    ['an array element (Tags[0].Value)', { Tags: [{ Key: 'k', Value: { Ref: 'TopicName' } }] }, { Tags: [{ Key: 'k', Value: TOPIC }] }, ['Tags', 0, 'Value']],
    ['a nested object leaf (ArchivePolicy.Name)', { ArchivePolicy: { Name: { Ref: 'TopicName' } } }, { ArchivePolicy: { Name: TOPIC } }, ['ArchivePolicy', 'Name']],
  ])('a nested leaf newly declared NoEcho, value unchanged: %s', async (_l, templateProps, stored, coordinate) => {
    const t = template(TOPIC);
    const topicProps = (t.Resources['Topic']!.Properties ?? {}) as Record<string, unknown>;
    t.Resources['Topic']!.Properties = { DisplayName: topicProps['DisplayName'], TopicName: 'literal-topic-4831', ...templateProps };
    const state = markedState('literal-topic-4831', '***', [['DisplayName']]);
    Object.assign(state.resources['Topic']!.properties, stored);
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    await makeEngine().deploy(STACK, t);
    expect(topicCalls(provider.create)).toBe(0);
    expect(topicCalls(provider.update)).toBe(0);
    const saved = (stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState).resources['Topic'];
    expect(JSON.stringify(saved?.properties)).not.toContain(TOPIC);
    expect(saved?.noEchoLeaves).toEqual(expect.arrayContaining([['DisplayName'], coordinate]));
  });

  it('negative control: a marked record already masked everywhere today masks reads as before', async () => {
    stateBackend.getState.mockResolvedValue({
      state: markedState('***', '***', [['DisplayName'], ['TopicName']]),
      etag: 'etag-old',
    });
    await makeEngine().deploy(STACK, template(TOPIC));
    expect(topicCalls(provider.create)).toBe(0);
    expect(topicCalls(provider.update)).toBe(0);
    const saved = (stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState | undefined)?.resources['Topic'];
    expect(saved).toBeDefined();
    expect(saved?.noEchoLeaves).toEqual([['DisplayName'], ['TopicName']]);
  });

  it("an engine reused for a second deploy carries no confirmed leaf over (reset per deploy)", async () => {
    const engine = makeEngine();
    stateBackend.getState.mockResolvedValue({ state: before(), etag: 'etag-old' });
    await engine.deploy(STACK, template(TOPIC));
    // Second deploy: the parameter is ordinary again, the record as before
    // the first; nothing confirmed THIS deploy may mark TopicName.
    stateBackend.saveState.mockClear();
    const plainTemplate = template(TOPIC);
    (plainTemplate.Parameters!['TopicName'] as { NoEcho?: unknown }).NoEcho = false;
    stateBackend.getState.mockResolvedValue({ state: before(), etag: 'etag-2' });
    await engine.deploy(STACK, plainTemplate);
    const saved = (stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState | undefined)?.resources['Topic'];
    expect(saved?.noEchoLeaves).toEqual([['DisplayName']]);
    expect(saved?.properties['TopicName']).toBe(TOPIC);
  });
});

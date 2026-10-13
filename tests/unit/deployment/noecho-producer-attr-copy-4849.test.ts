/**
 * go-to-k/cdkd#4849: a resource NAMED from a `NoEcho` parameter keeps its own
 * physical id in state as AWS returns it, and so must every copy of that id:
 * its own ARN-type attribute (`TopicArn`) and a stack output or export holding
 * it. They were stored as `***` (the value arm's containment), so the next
 * deploy re-resolving a `Fn::GetAtt` reader of the attribute failed. A value
 * equal WHOLE to the parameter (the `TopicName` attribute, a `!Ref Name`
 * output) stays masked. Driven through `DeployEngine.deploy` with the REAL
 * `DiffCalculator`, `DagBuilder` and `IntrinsicFunctionResolver`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { isMaskedOwnIdCopy } from '../../../src/deployment/intrinsic-resolver/getatt-heal.js';
import { recordNoEchoParameterFreshValue } from '../../../src/deployment/secret-redaction.js';
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

vi.mock('../../../src/utils/aws-clients.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getAwsClients: () => ({
      cloudFormation: {
        send: vi.fn((command: { input?: { TypeName?: string } }) => {
          const paths = CREATE_ONLY_PATHS_SNAPSHOT.get(command.input?.TypeName ?? '');
          if (paths === undefined) {
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

const STACK = 'noecho-producer-attr-stack';
const REGION = 'us-east-1';
const TOPIC = 'topic-4849-distinctive-name';
const TOPIC_ARN = `arn:aws:sns:us-east-1:123456789012:${TOPIC}`;

describe('DeployEngine - a NoEcho-named resource keeps copies of its own id (go-to-k/cdkd#4849)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
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
      readCurrentState: vi.fn(() => Promise.resolve({ TopicName: TOPIC })),
      // The #1852 heal's read: what AWS reports for the topic.
      import: vi.fn(),
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

  const template = (endpoint: string, outputs = false): CloudFormationTemplate =>
    ({
      Parameters: { Name: { Type: 'String', NoEcho: true, Default: TOPIC } },
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Name' } } },
        Sub: {
          Type: 'AWS::SNS::Subscription',
          Properties: {
            TopicArn: { 'Fn::GetAtt': ['Topic', 'TopicArn'] },
            Protocol: 'email',
            Endpoint: endpoint,
          },
        },
      },
      ...(outputs && {
        Outputs: {
          ArnOut: { Value: { Ref: 'Topic' }, Export: { Name: 'arn-export-4849' } },
          NameOut: { Value: { Ref: 'Name' } },
        },
      }),
    }) as unknown as CloudFormationTemplate;

  beforeEach(() => {
    let created = 0;
    provider.create.mockImplementation((logicalId: string) =>
      Promise.resolve(
        logicalId === 'Topic'
          ? { physicalId: TOPIC_ARN, attributes: { TopicArn: TOPIC_ARN, TopicName: TOPIC } }
          : { physicalId: `${logicalId}-arn-${++created}`, attributes: {} }
      )
    );
    provider.getAttribute.mockImplementation((_physicalId: string, _type: string, attribute: string) =>
      Promise.resolve(attribute === 'TopicArn' ? TOPIC_ARN : TOPIC)
    );
    provider.readCurrentState.mockImplementation(() => Promise.resolve({ TopicName: TOPIC }));
    // The #1852 heal's read, and the create's name-holder check: AWS knows the
    // topic once a deploy has created it (a later deploy here).
    provider.import.mockImplementation((input: { knownPhysicalId?: string }) =>
      Promise.resolve(
        stateBackend.saveState.mock.calls.length > 0 && input.knownPhysicalId === TOPIC_ARN
          ? { physicalId: TOPIC_ARN, attributes: { TopicArn: TOPIC_ARN, TopicName: TOPIC } }
          : null
      )
    );
  });

  const lastSaved = (): StackState => stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState;

  it("stores the producer's own ARN attribute as AWS returns it; the name attribute stays masked", async () => {
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine().deploy(STACK, template('a@example.com'));
    const topic = lastSaved().resources['Topic'];
    expect(topic?.physicalId).toBe(TOPIC_ARN);
    expect(topic?.attributes?.['TopicArn']).toBe(TOPIC_ARN);
    expect(topic?.attributes?.['TopicName']).toBe('***');
    expect(topic?.properties['TopicName']).toBe('***');
  });

  it('a later deploy editing a Fn::GetAtt reader of that attribute succeeds', async () => {
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine().deploy(STACK, template('a@example.com'));
    const first = JSON.parse(JSON.stringify(lastSaved())) as StackState;
    provider.create.mockClear();
    stateBackend.getState.mockResolvedValue({ state: first, etag: 'etag-2' });
    await makeEngine().deploy(STACK, template('b@example.com'));
    // The subscription's Endpoint is create-only: replaced, reading the ARN.
    const created = provider.create.mock.calls.filter((c) => c[0] === 'Sub');
    expect(created).toHaveLength(1);
    expect((created[0]![2] as Record<string, unknown>)['TopicArn']).toBe(TOPIC_ARN);
  });

  it('a record an earlier cdkd wrote, holding *** at the ARN attribute, is repaired by the reader edit', async () => {
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine().deploy(STACK, template('a@example.com'));
    const first = JSON.parse(JSON.stringify(lastSaved())) as StackState;
    // What the persist wrote before the change.
    first.resources['Topic']!.attributes = { TopicArn: '***', TopicName: '***' };
    provider.create.mockClear();
    stateBackend.getState.mockResolvedValue({ state: first, etag: 'etag-2' });
    await makeEngine().deploy(STACK, template('b@example.com'));
    const created = provider.create.mock.calls.filter((c) => c[0] === 'Sub');
    expect(created).toHaveLength(1);
    expect((created[0]![2] as Record<string, unknown>)['TopicArn']).toBe(TOPIC_ARN);
    // The heal's read replaced the mask over the id copy only; the name stays masked.
    expect(lastSaved().resources['Topic']?.attributes).toEqual({
      TopicArn: TOPIC_ARN,
      TopicName: '***',
    });
  });

  it('a record whose physical id IS the name: its masked ARN, which carries the id, is repaired', async () => {
    // A name-identified resource (a function, a role, a table): the ARN
    // CONTAINS the physical id rather than equalling it.
    provider.create.mockImplementation((logicalId: string) =>
      Promise.resolve(
        logicalId === 'Topic'
          ? { physicalId: TOPIC, attributes: { TopicArn: TOPIC_ARN } }
          : { physicalId: `${logicalId}-arn-${provider.create.mock.calls.length}`, attributes: {} }
      )
    );
    provider.import.mockImplementation((input: { knownPhysicalId?: string }) =>
      Promise.resolve(
        stateBackend.saveState.mock.calls.length > 0 && input.knownPhysicalId === TOPIC
          ? { physicalId: TOPIC, attributes: { TopicArn: TOPIC_ARN } }
          : null
      )
    );
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine().deploy(STACK, template('a@example.com'));
    const first = JSON.parse(JSON.stringify(lastSaved())) as StackState;
    expect(first.resources['Topic']?.attributes?.['TopicArn']).toBe(TOPIC_ARN);
    first.resources['Topic']!.attributes = { TopicArn: '***' };
    provider.create.mockClear();
    stateBackend.getState.mockResolvedValue({ state: first, etag: 'etag-2' });
    await makeEngine().deploy(STACK, template('b@example.com'));
    const created = provider.create.mock.calls.filter((c) => c[0] === 'Sub');
    expect((created[0]![2] as Record<string, unknown>)['TopicArn']).toBe(TOPIC_ARN);
    expect(lastSaved().resources['Topic']?.attributes).toEqual({ TopicArn: TOPIC_ARN });
  });

  it('a key the record lacks, which the same re-read returns holding the value, lands masked', async () => {
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine().deploy(STACK, template('a@example.com'));
    const first = JSON.parse(JSON.stringify(lastSaved())) as StackState;
    first.resources['Topic']!.attributes = { TopicArn: '***' };
    stateBackend.getState.mockResolvedValue({ state: first, etag: 'etag-2' });
    await makeEngine().deploy(STACK, template('b@example.com'));
    expect(lastSaved().resources['Topic']?.attributes).toEqual({
      TopicArn: TOPIC_ARN,
      TopicName: '***',
    });
  });

  it('a masked attribute the producer declared NoEcho is not re-read into the record', async () => {
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine().deploy(STACK, template('a@example.com'));
    const first = JSON.parse(JSON.stringify(lastSaved())) as StackState;
    first.resources['Topic']!.attributes = { TopicArn: '***', TopicName: '***' };
    first.resources['Topic']!.noEchoAttributeNames = ['TopicArn'];
    stateBackend.getState.mockResolvedValue({ state: first, etag: 'etag-2' });
    await makeEngine().deploy(STACK, template('b@example.com'));
    // A declared attribute is served per resolution by its own arm (#4043),
    // never re-read into the record: the mask stays.
    expect(lastSaved().resources['Topic']?.attributes).toEqual({
      TopicArn: '***',
      TopicName: '***',
    });
  });

  it('an output and an export holding the id keep it; an output of the value itself stays masked', async () => {
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine().deploy(STACK, template('a@example.com', true));
    const outputs = lastSaved().outputs as Record<string, unknown>;
    expect(outputs['ArnOut']).toBe(TOPIC_ARN);
    expect(outputs['arn-export-4849']).toBe(TOPIC_ARN);
    expect(outputs['NameOut']).toBe('***');
  });

  it('negative control: an ARN that embeds the value with no record holding it as an id stays masked', async () => {
    // A LITERAL string, not a physical id: nothing vouches for its spelling.
    stateBackend.getState.mockResolvedValue(null);
    const t = template('a@example.com');
    t.Resources['Note'] = {
      Type: 'AWS::SSM::Parameter',
      Properties: { Type: 'String', Value: `arn:aws:sns:us-east-1:123456789012:${TOPIC}`, Description: { Ref: 'Name' } },
    } as never;
    await makeEngine().deploy(STACK, t);
    expect(lastSaved().resources['Note']?.properties['Value']).toBe('***');
  });
});

describe('isMaskedOwnIdCopy (go-to-k/cdkd#4849)', () => {
  const record = (extra: Record<string, unknown> = {}): ResourceState =>
    ({
      physicalId: TOPIC_ARN,
      resourceType: 'AWS::SNS::Topic',
      properties: {},
      attributes: { TopicArn: '***' },
      ...extra,
    }) as ResourceState;

  /** The producer's bag: the NoEcho value its name came from. */
  const producerBag = (): Map<string, string> => {
    const bag = new Map<string, string>();
    recordNoEchoParameterFreshValue(TOPIC, bag);
    return bag;
  };

  it('replaces a mask with the physical id, or a value carrying it and no other secret', () => {
    expect(isMaskedOwnIdCopy(record(), 'TopicArn', '***', TOPIC_ARN)).toBe(true);
    expect(isMaskedOwnIdCopy(record(), 'TopicName', '***', TOPIC)).toBe(false);
    expect(isMaskedOwnIdCopy(record(), 'TopicName', '***', TOPIC, producerBag())).toBe(false);
    // An ARN ending in a name-identified record's id: only with the producer's
    // bag proving nothing else is secret, and only in the ARN shape.
    const named = record({ physicalId: TOPIC });
    expect(isMaskedOwnIdCopy(named, 'TopicArn', '***', TOPIC_ARN)).toBe(false);
    expect(isMaskedOwnIdCopy(named, 'TopicArn', '***', TOPIC_ARN, new Map())).toBe(false);
    expect(isMaskedOwnIdCopy(named, 'TopicArn', '***', TOPIC_ARN, producerBag())).toBe(true);
    expect(
      isMaskedOwnIdCopy(named, 'Arn', '***', `arn:aws:iam::123456789012:role/${TOPIC}`, producerBag())
    ).toBe(true);
    expect(isMaskedOwnIdCopy(named, 'Arn', '***', `arn:aws:s3:::${TOPIC}`, producerBag())).toBe(true);
    // Anything beside the id outside the ARN's public fields is refused, even
    // where today's bag records nothing there (an earlier generation's secret).
    for (const shape of [
      `${TOPIC_ARN}/x`,
      `arn:aws:iam::123456789012:role/some-path/${TOPIC}`,
      `arn:aws:sns:us-east-1:123456789012:extra-${TOPIC}`,
      `prefix-${TOPIC}`,
      `arn:aws:sns:us-east-1:12345:${TOPIC}`,
    ]) {
      expect(isMaskedOwnIdCopy(named, 'Arn', '***', shape, producerBag())).toBe(false);
    }
    // An id occurring EARLIER than the end: the slice before the last
    // `id.length` characters can still read as an ARN prefix.
    expect(
      isMaskedOwnIdCopy(
        record({ physicalId: '123456789012' }),
        'Arn',
        '***',
        'arn:aws:sns:us-east-1:123456789012:QQQQQQQQQQQQ',
        producerBag()
      )
    ).toBe(false);
    // The value again OUTSIDE the id: refused.
    expect(
      isMaskedOwnIdCopy(record(), 'TopicArn', '***', `${TOPIC_ARN}/${TOPIC}`, producerBag())
    ).toBe(false);
    expect(isMaskedOwnIdCopy(record(), 'TopicArn', '***', 42, producerBag())).toBe(false);
    expect(isMaskedOwnIdCopy(record(), 'TopicArn', 'plain', TOPIC_ARN)).toBe(false);
    expect(isMaskedOwnIdCopy(record({ physicalId: '' }), 'TopicArn', '***', '')).toBe(false);
  });

  it('never for a declared NoEcho attribute, and a malformed declaration reads as declared', () => {
    expect(
      isMaskedOwnIdCopy(record({ noEchoAttributeNames: ['TopicArn'] }), 'TopicArn', '***', TOPIC_ARN)
    ).toBe(false);
    expect(
      isMaskedOwnIdCopy(record({ noEchoAttributeNames: ['Other'] }), 'TopicArn', '***', TOPIC_ARN)
    ).toBe(true);
    expect(
      isMaskedOwnIdCopy(record({ noEchoAttributeNames: 'TopicArn' }), 'TopicArn', '***', TOPIC_ARN)
    ).toBe(false);
    expect(
      isMaskedOwnIdCopy(record({ noEchoAttributeNames: [7] }), 'TopicArn', '***', TOPIC_ARN)
    ).toBe(false);
  });
});

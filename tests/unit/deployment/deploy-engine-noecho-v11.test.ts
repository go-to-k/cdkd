/**
 * Schema v11 (go-to-k/cdkd#4043 Phase B, go-to-k/cdkd#2449): a `NoEcho: true`
 * template parameter's value is persisted as `***` by value AND by position,
 * the record names each masked coordinate in `noEchoLeaves`, and every reader
 * that needs the value gets it from AWS (a readback) or from the record a
 * pre-v11 binary wrote (the migration witness). Driven through
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
              writeOnlyProperties: [],
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

const STACK = 'noecho-v11-stack';
const REGION = 'us-east-1';
const TOKEN = 'tok-v11-distinctive-0001';
const TOKEN2 = 'tok-v11-distinctive-0002';
const TOPIC = 'topic-v11-distinctive';
const PARAM_ARN = 'arn:aws:ssm:us-east-1:123456789012:parameter/app/p';
const TOPIC_ARN = `arn:aws:sns:us-east-1:123456789012:${TOPIC}`;

function template(
  token = TOKEN,
  extra: Record<string, unknown> = {},
  outputs?: Record<string, unknown>
): CloudFormationTemplate {
  return {
    Parameters: {
      Token: { Type: 'String', NoEcho: true, Default: token },
      TopicName: { Type: 'String', NoEcho: true, Default: TOPIC },
      Short: { Type: 'String', NoEcho: true, Default: 'abc' },
      Plain: { Type: 'String', Default: 'plain-value' },
    },
    Resources: {
      Param: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/app/p', Type: 'String', Value: { Ref: 'Token' } },
      },
      Topic: {
        Type: 'AWS::SNS::Topic',
        Properties: { TopicName: { Ref: 'TopicName' }, DisplayName: 'd' },
      },
      ...extra,
    },
    ...(outputs !== undefined && { Outputs: outputs }),
  } as CloudFormationTemplate;
}

function v11State(overrides: Record<string, Partial<ResourceState>> = {}): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Param: {
        physicalId: '/app/p',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/p', Type: 'String', Value: '***' },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['Value']],
        ...overrides['Param'],
      },
      Topic: {
        physicalId: TOPIC_ARN,
        resourceType: 'AWS::SNS::Topic',
        properties: { TopicName: '***', DisplayName: 'd' },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['TopicName']],
        ...overrides['Topic'],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

/** The same stack as a pre-v11 binary wrote it: plaintext, no marker. */
function v10State(paramValue = TOKEN, topicName = TOPIC): StackState {
  const state = v11State();
  state.version = 10 as never;
  state.resources['Param'] = {
    ...state.resources['Param']!,
    properties: { Name: '/app/p', Type: 'String', Value: paramValue },
  };
  delete state.resources['Param']!.noEchoLeaves;
  state.resources['Topic'] = {
    ...state.resources['Topic']!,
    properties: { TopicName: topicName, DisplayName: 'd' },
  };
  delete state.resources['Topic']!.noEchoLeaves;
  return state;
}

describe('DeployEngine - NoEcho parameter persistence under schema v11', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  };
  const logger = getLogger() as unknown as Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn((logicalId: string) =>
        Promise.resolve({
          physicalId: logicalId === 'Topic' ? TOPIC_ARN : `${logicalId}-phys`,
          attributes: {},
        })
      ),
      update: vi.fn((_logicalId: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN
            ? { TopicName: TOPIC, DisplayName: 'd' }
            : { Name: '/app/p', Type: 'String', Value: TOKEN }
        )
      ),
    };
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: v11State(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    } as never;
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

  const callsFor = (fn: ReturnType<typeof vi.fn>, id: string): unknown[][] =>
    fn.mock.calls.filter((c) => c[0] === id);
  const lastSaved = (): StackState =>
    stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
  const allSaved = (): string => JSON.stringify(stateBackend.saveState.mock.calls);
  const lines = (fn: ReturnType<typeof vi.fn>): string[] => fn.mock.calls.map((c) => String(c[0]));

  describe('the two arms', () => {
    it('persists *** by position for a Ref, a Number, a list and a 3-character value, names each coordinate, and leaves a same-valued literal alone', async () => {
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      const tpl = template(TOKEN, {
        Queue: {
          Type: 'AWS::SQS::Queue',
          Properties: { DelaySeconds: { Ref: 'Port' }, QueueName: 'q' },
        },
        Short1: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/short',
            Type: 'StringList',
            Value: { Ref: 'Short' },
            Description: 'abc',
          },
        },
        Sub: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/sub', Type: 'String', Value: { 'Fn::Sub': 'pre-${Token}' } },
        },
        List: {
          Type: 'AWS::EC2::SecurityGroup',
          Properties: { GroupDescription: 'g', SecurityGroupIngress: { Ref: 'Ingress' } },
        },
      });
      tpl.Parameters!['Port'] = { Type: 'Number', NoEcho: true, Default: 7 };
      tpl.Parameters!['Ingress'] = { Type: 'CommaDelimitedList', NoEcho: true, Default: 'x,y' };

      await makeEngine().deploy(STACK, tpl);

      const saved = lastSaved();
      expect(saved.version).toBe(11);
      expect(saved.resources['Param']!.properties['Value']).toBe('***');
      expect(saved.resources['Param']!.noEchoLeaves).toEqual([['Value']]);
      expect(saved.resources['Queue']!.properties['DelaySeconds']).toBe('***');
      expect(saved.resources['Queue']!.noEchoLeaves).toEqual([['DelaySeconds']]);
      expect(saved.resources['Short1']!.properties['Value']).toBe('***');
      // The positional arm names the leaf the parameter served, never a
      // literal that happens to equal a 3-character value.
      expect(saved.resources['Short1']!.properties['Description']).toBe('abc');
      expect(saved.resources['Sub']!.properties['Value']).toBe('***');
      expect(saved.resources['List']!.properties['SecurityGroupIngress']).toEqual(['***', '***']);
      expect(saved.resources['Topic']!.properties['TopicName']).toBe('***');
      // The provider got the real values.
      expect((callsFor(provider.create, 'Param')[0]![2] as Record<string, unknown>)['Value']).toBe(
        TOKEN
      );
      expect(allSaved()).not.toContain(TOKEN);
      // The topic's physical id (its ARN) spells the name AWS publishes, and
      // stays as AWS returned it; its properties hold only the mask.
      expect(JSON.stringify(lastSaved().resources['Topic']!.properties)).not.toContain(TOPIC);
    });

    it('masks an output a NoEcho parameter serves, and leaves an ordinary one in the clear', async () => {
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      await makeEngine().deploy(
        STACK,
        template(TOKEN, {}, { Out: { Value: { Ref: 'Token' } }, PlainOut: { Value: { Ref: 'Plain' } } })
      );
      expect(lastSaved().outputs['Out']).toBe('***');
      expect(lastSaved().outputs['PlainOut']).toBe('plain-value');
    });
  });

  describe('readers of a v11 record', () => {
    it('skips an unchanged readable value with ONE readback and no provider write', async () => {
      await makeEngine().deploy(STACK, template());
      expect(callsFor(provider.update, 'Param')).toHaveLength(0);
      expect(callsFor(provider.create, 'Param')).toHaveLength(0);
      expect(provider.readCurrentState.mock.calls.filter((c) => c[1] === 'Param')).toHaveLength(1);
      // Review MEDIUM-4 (1): the readback is handed the MASKED record, never
      // the resolved bag, so an echoing provider cannot confirm the value.
      expect(provider.readCurrentState).toHaveBeenCalledWith(
        '/app/p',
        'Param',
        'AWS::SSM::Parameter',
        { Name: '/app/p', Type: 'String', Value: '***' }
      );
    });

    it('UPDATES when AWS holds a different value', async () => {
      await makeEngine().deploy(STACK, template(TOKEN2));
      const updates = callsFor(provider.update, 'Param');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['Value']).toBe(TOKEN2);
      expect(lastSaved().resources['Param']!.properties['Value']).toBe('***');
      expect(allSaved()).not.toContain(TOKEN2);
    });

    it('re-sends a value AWS does not report, with one info line (maintainer decision 4)', async () => {
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN ? { TopicName: TOPIC, DisplayName: 'd' } : { Name: '/app/p' }
        )
      );
      await makeEngine().deploy(STACK, template());
      expect(callsFor(provider.update, 'Param')).toHaveLength(1);
      expect(lines(logger.info).filter((l) => l.includes('re-sending Value'))).toHaveLength(1);
    });

    it('never replaces a create-only property on a readback that differs, and names --recreate-via-* (maintainer decision 1)', async () => {
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN
            ? { TopicName: 'something-else', DisplayName: 'd' }
            : { Name: '/app/p', Type: 'String', Value: TOKEN }
        )
      );
      await makeEngine().deploy(STACK, template());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.update, 'Topic')).toHaveLength(0);
      const warned = lines(logger.warn).filter((l) => l.includes('Topic.TopicName'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('--recreate-via-cc-api Topic');
      expect(warned[0]).not.toContain(TOPIC);
    });

    it('never replaces a create-only property AWS cannot report either', async () => {
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN ? { DisplayName: 'd' } : { Name: '/app/p', Value: TOKEN }
        )
      );
      await makeEngine().deploy(STACK, template());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
      expect(lines(logger.warn).some((l) => l.includes('not-readable'))).toBe(true);
    });

    it('fails the resource, without a replacement, when the readback of a create-only property FAILS', async () => {
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        physicalId === TOPIC_ARN
          ? Promise.reject(new Error('throttled'))
          : Promise.resolve({ Name: '/app/p', Value: TOKEN })
      );
      const error = await makeEngine()
        .deploy(STACK, template())
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(error).toBeDefined();
      const text = String(error) + JSON.stringify(stateBackend.saveState.mock.calls) + lines(logger.error).join('\n');
      expect(text).toContain('reading the resource back from AWS to compare it failed');
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.update, 'Topic')).toHaveLength(0);
    });

    it('UPDATES a Number value that rotated, which no needle can key', async () => {
      const state = v11State();
      state.resources['Queue'] = {
        physicalId: 'https://sqs/q',
        resourceType: 'AWS::SQS::Queue',
        properties: { DelaySeconds: '***', QueueName: 'q' },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['DelaySeconds']],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === 'https://sqs/q'
            ? { DelaySeconds: 7, QueueName: 'q' }
            : physicalId === TOPIC_ARN
              ? { TopicName: TOPIC, DisplayName: 'd' }
              : { Name: '/app/p', Value: TOKEN }
        )
      );
      const tpl = template(TOKEN, {
        Queue: { Type: 'AWS::SQS::Queue', Properties: { DelaySeconds: { Ref: 'Port' }, QueueName: 'q' } },
      });
      tpl.Parameters!['Port'] = { Type: 'Number', NoEcho: true, Default: 9 };
      await makeEngine().deploy(STACK, tpl);
      const updates = callsFor(provider.update, 'Queue');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['DelaySeconds']).toBe(9);
      expect(lastSaved().resources['Queue']!.properties['DelaySeconds']).toBe('***');
    });
  });

  describe('the migration witness (a record a pre-v11 binary wrote)', () => {
    it('skips an unchanged value with NO readback, and the save migrates the record', async () => {
      stateBackend.getState.mockResolvedValue({ state: v10State(), etag: 'etag-old' });
      await makeEngine().deploy(STACK, template());
      expect(provider.readCurrentState).not.toHaveBeenCalled();
      expect(callsFor(provider.update, 'Param')).toHaveLength(0);
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
      const saved = lastSaved();
      expect(saved.version).toBe(11);
      expect(saved.resources['Param']!.properties['Value']).toBe('***');
      expect(saved.resources['Param']!.noEchoLeaves).toEqual([['Value']]);
      expect(saved.resources['Topic']!.properties['TopicName']).toBe('***');
      expect(allSaved()).not.toContain(TOKEN);
      expect(JSON.stringify(saved.resources['Topic']!.properties)).not.toContain(TOPIC);
    });

    it('UPDATES when the stored plaintext differs from the value this deploy binds', async () => {
      stateBackend.getState.mockResolvedValue({ state: v10State(TOKEN2), etag: 'etag-old' });
      await makeEngine().deploy(STACK, template());
      const updates = callsFor(provider.update, 'Param');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['Value']).toBe(TOKEN);
      expect(allSaved()).not.toContain(TOKEN);
      expect(allSaved()).not.toContain(TOKEN2);
    });

    it('masks a pre-v11 observed baseline of an UNTOUCHED record at its marked coordinates (review B4)', async () => {
      const state = v10State();
      state.resources['Param']!.observedProperties = { Name: '/app/p', Value: TOKEN };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      await makeEngine().deploy(STACK, template());
      expect(lastSaved().resources['Param']!.observedProperties).toEqual({
        Name: '/app/p',
        Value: '***',
      });
    });
  });

  describe('declared NoEcho attributes (go-to-k/cdkd#2449)', () => {
    it('persists a custom resource whole-bag declaration as names, masking a short and a Number value too', async () => {
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      provider.create.mockImplementation((logicalId: string) =>
        Promise.resolve(
          logicalId === 'Cr'
            ? { physicalId: 'cr-1', attributes: { Secret: 'cr-secret-value', Pin: 'ab', Count: 7 }, noEchoAttributes: true }
            : { physicalId: `${logicalId}-phys`, attributes: {} }
        )
      );
      await makeEngine().deploy(
        STACK,
        template(TOKEN, {
          Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:1:function:h' } },
        })
      );
      const cr = lastSaved().resources['Cr']!;
      expect(cr.noEchoAttributeNames).toEqual(['Count', 'Pin', 'Secret']);
      expect(cr.attributes).toEqual({ Secret: '***', Pin: '***', Count: '***' });
    });

    it('declares and masks an attribute that ECHOES a NoEcho parameter value, in the producer and its same-run reader', async () => {
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      provider.create.mockImplementation((logicalId: string) =>
        Promise.resolve(
          logicalId === 'Param'
            ? { physicalId: '/app/p', attributes: { Value: TOKEN, Type: 'String' } }
            : { physicalId: `${logicalId}-phys`, attributes: {} }
        )
      );
      await makeEngine().deploy(
        STACK,
        template(TOKEN, {
          Reader: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: '/app/r', Type: 'String', Value: { 'Fn::GetAtt': ['Param', 'Value'] } },
          },
        })
      );
      const saved = lastSaved();
      expect(saved.resources['Param']!.noEchoAttributeNames).toEqual(['Value']);
      expect(saved.resources['Param']!.attributes?.['Value']).toBe('***');
      expect(saved.resources['Param']!.attributes?.['Type']).toBe('String');
      expect(saved.resources['Reader']!.properties['Value']).toBe('***');
      expect(saved.resources['Reader']!.noEchoLeaves).toEqual([['Value']]);
      expect(allSaved()).not.toContain(TOKEN);
    });

    it('never declares an ARN attribute that merely names the resource with the value (review round 6)', async () => {
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      provider.create.mockImplementation((logicalId: string) =>
        Promise.resolve(
          logicalId === 'Param'
            ? {
                physicalId: '/app/p',
                attributes: {
                  Value: TOKEN,
                  Arn: `arn:aws:ssm:us-east-1:123456789012:parameter/${TOKEN}`,
                },
              }
            : { physicalId: `${logicalId}-phys`, attributes: {} }
        )
      );
      await makeEngine().deploy(STACK, template());
      const param = lastSaved().resources['Param']!;
      expect(param.noEchoAttributeNames).toEqual(['Value']);
      expect(param.attributes?.['Value']).toBe('***');
    });

    it('refuses a later-added reader of a declared attribute with the exact remedy, and never re-runs the producer', async () => {
      const state = v11State();
      state.resources['Cr'] = {
        physicalId: 'cr-1',
        resourceType: 'Custom::Thing',
        properties: { ServiceToken: 'arn:aws:lambda:us-east-1:1:function:h' },
        attributes: { Secret: '***' },
        dependencies: [],
        noEchoAttributeNames: ['Secret'],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      const error = await makeEngine()
        .deploy(
          STACK,
          template(TOKEN, {
            Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:1:function:h' } },
            Dep: {
              Type: 'AWS::SSM::Parameter',
              Properties: { Name: '/app/d', Type: 'String', Value: { 'Fn::GetAtt': ['Cr', 'Secret'] } },
            },
          })
        )
        .then(
          () => undefined,
          (e: unknown) => e
        );
      const text = JSON.stringify(stateBackend.saveState.mock.calls) + String(error) + lines(logger.error).join('\n');
      expect(text).toContain('declared that attribute NoEcho');
      expect(callsFor(provider.update, 'Cr')).toHaveLength(0);
      expect(callsFor(provider.create, 'Dep')).toHaveLength(0);
    });
  });

  describe('the rollback journal (review B3)', () => {
    it('writes no NoEcho plaintext when a migration deploy fails: neither the attempted bag nor a pre-v11 previous record', async () => {
      stateBackend.getState.mockResolvedValue({ state: v10State(TOKEN), etag: 'etag-old' });
      provider.update.mockImplementation((logicalId: string, physicalId: string) =>
        logicalId === 'Param'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ physicalId, wasReplaced: false })
      );
      await expect(
        makeEngine({ noRollback: true }).deploy(STACK, template(TOKEN2))
      ).rejects.toThrow();
      expect(stateBackend.appendRollbackJournalSegment).toHaveBeenCalled();
      const journal = JSON.stringify(stateBackend.appendRollbackJournalSegment.mock.calls);
      // Vacuity guard: the failed op really was journaled with both bags.
      expect(journal).toContain('attemptedProperties');
      expect(journal).toContain('previousState');
      expect(journal).not.toContain(TOKEN);
      expect(journal).not.toContain(TOKEN2);
      expect(allSaved()).not.toContain(TOKEN);
    });
  });

  it('masks a Number value in the journaled attempted bag and the previous record by POSITION', async () => {
    const state = v10State();
    state.resources['Queue'] = {
      physicalId: 'https://sqs/q',
      resourceType: 'AWS::SQS::Queue',
      properties: { DelaySeconds: 731, QueueName: 'q' },
      attributes: {},
      dependencies: [],
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    provider.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Queue'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const tpl = template(TOKEN, {
      Queue: { Type: 'AWS::SQS::Queue', Properties: { DelaySeconds: { Ref: 'Port' }, QueueName: 'q' } },
    });
    tpl.Parameters!['Port'] = { Type: 'Number', NoEcho: true, Default: 846 };
    await expect(makeEngine({ noRollback: true }).deploy(STACK, tpl)).rejects.toThrow();
    // By coordinate, not by substring: the segment's timestamp can hold any
    // three digits.
    const segment = stateBackend.appendRollbackJournalSegment.mock.calls.at(-1)![2] as {
      failedOperations?: Array<{
        logicalId: string;
        attemptedProperties?: Record<string, unknown>;
        previousState?: { properties: Record<string, unknown> };
      }>;
    };
    const failed = segment.failedOperations?.find((op) => op.logicalId === 'Queue');
    expect(failed?.attemptedProperties?.['DelaySeconds']).toBe('***');
    expect(failed?.previousState?.properties['DelaySeconds']).toBe('***');
  });

  describe('a HELD producer serves its declared attribute to a changed reader (design 3.3)', () => {
    it('reads the attribute back, serves it only because it equals a value the producer was given, and persists nothing of it', async () => {
      const state = v11State({
        Param: { attributes: { Value: '***', Type: 'String' }, noEchoAttributeNames: ['Value'] },
      });
      state.resources['Reader'] = {
        physicalId: '/app/r',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/r', Type: 'String', Value: '***', Description: 'old' },
        attributes: {},
        dependencies: ['Param'],
        noEchoLeaves: [['Value']],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.import = vi.fn().mockResolvedValue({
        physicalId: '/app/p',
        attributes: { Value: TOKEN, Type: 'String' },
      });
      await makeEngine().deploy(
        STACK,
        template(TOKEN, {
          Reader: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Name: '/app/r',
              Type: 'String',
              Value: { 'Fn::GetAtt': ['Param', 'Value'] },
              Description: 'new',
            },
          },
        })
      );
      const updates = callsFor(provider.update, 'Reader');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['Value']).toBe(TOKEN);
      expect(callsFor(provider.update, 'Param')).toHaveLength(0);
      expect(lastSaved().resources['Param']!.attributes?.['Value']).toBe('***');
      expect(lastSaved().resources['Reader']!.properties['Value']).toBe('***');
      expect(allSaved()).not.toContain(TOKEN);
    });

    it('does not serve a read-back value that matches nothing the producer was given', async () => {
      const state = v11State({
        Param: { attributes: { Value: '***' }, noEchoAttributeNames: ['Value'] },
      });
      state.resources['Reader'] = {
        physicalId: '/app/r',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/r', Type: 'String', Value: '***', Description: 'old' },
        attributes: {},
        dependencies: ['Param'],
        noEchoLeaves: [['Value']],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.import = vi.fn().mockResolvedValue({
        physicalId: '/app/p',
        attributes: { Value: 'some-other-value' },
      });
      const outcome = await makeEngine()
        .deploy(
          STACK,
          template(TOKEN, {
            Reader: {
              Type: 'AWS::SSM::Parameter',
              Properties: {
                Name: '/app/r',
                Type: 'String',
                Value: { 'Fn::GetAtt': ['Param', 'Value'] },
                Description: 'new',
              },
            },
          })
        )
        .then(
          () => 'ok',
          (e: unknown) => String(e)
        );
      expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
      expect(outcome).not.toBe('ok');
      const text = outcome + JSON.stringify(stateBackend.saveState.mock.calls) + lines(logger.error).join('\n');
      expect(text).toContain('declared that attribute NoEcho');
      expect(JSON.stringify(stateBackend.saveState.mock.calls)).not.toContain('some-other-value');
      expect(outcome).not.toContain('some-other-value');
      for (const channel of [logger.debug, logger.info, logger.warn, logger.error]) {
        expect(lines(channel!).join('\n')).not.toContain('some-other-value');
      }
    });

    it('refuses the reader when the producer cannot report the attribute (not readable)', async () => {
      const state = v11State({
        Param: { attributes: { Value: '***' }, noEchoAttributeNames: ['Value'] },
      });
      state.resources['Reader'] = {
        physicalId: '/app/r',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/r', Type: 'String', Value: '***', Description: 'old' },
        attributes: {},
        dependencies: ['Param'],
        noEchoLeaves: [['Value']],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.import = vi.fn().mockResolvedValue({ physicalId: '/app/p', attributes: {} });
      const outcome = await makeEngine()
        .deploy(
          STACK,
          template(TOKEN, {
            Reader: {
              Type: 'AWS::SSM::Parameter',
              Properties: {
                Name: '/app/r',
                Type: 'String',
                Value: { 'Fn::GetAtt': ['Param', 'Value'] },
                Description: 'new',
              },
            },
          })
        )
        .then(
          () => 'ok',
          (e: unknown) => String(e)
        );
      expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
      expect(outcome).not.toBe('ok');
      expect(outcome + lines(logger.error).join('\n')).toContain('declared that attribute NoEcho');
    });
  });

  describe('review round 1', () => {
    it('UPDATES a 3-character value that rotated, which no needle can key', async () => {
      const state = v11State();
      state.resources['Short1'] = {
        physicalId: '/app/short',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/short', Type: 'String', Value: '***' },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['Value']],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === '/app/short'
            ? { Name: '/app/short', Value: 'abc' }
            : physicalId === TOPIC_ARN
              ? { TopicName: TOPIC, DisplayName: 'd' }
              : { Name: '/app/p', Value: TOKEN }
        )
      );
      const tpl = template(TOKEN, {
        Short1: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/short', Type: 'String', Value: { Ref: 'Short' } },
        },
      });
      (tpl.Parameters!['Short'] as unknown as Record<string, unknown>)['Default'] = 'xyz';
      await makeEngine().deploy(STACK, tpl);
      const updates = callsFor(provider.update, 'Short1');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['Value']).toBe('xyz');
      expect(lastSaved().resources['Short1']!.properties['Value']).toBe('***');
    });

    it('keeps the REPLACEMENT for a create-only property whose pre-v11 witness differs (an exact change)', async () => {
      provider.create.mockImplementation((logicalId: string) =>
        Promise.resolve({ physicalId: `${logicalId}-new-arn`, attributes: {} })
      );
      stateBackend.getState.mockResolvedValue({ state: v10State(TOKEN, 'old-topic-name'), etag: 'etag-old' });
      await makeEngine().deploy(STACK, template());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(1);
      expect(lines(logger.warn).some((l) => l.includes('Topic.TopicName'))).toBe(false);
    });

    it('counts a replacement whose old resource could not be deleted (delete address is ***) as a partial update (review MEDIUM-3)', async () => {
      stateBackend.getState.mockResolvedValue({ state: v10State(TOKEN, 'old-topic-name'), etag: 'etag-old' });
      provider.create.mockImplementation((logicalId: string) =>
        Promise.resolve({ physicalId: `${logicalId}-new-arn`, attributes: {} })
      );
      provider.delete.mockImplementation((logicalId: string) =>
        logicalId === 'Topic'
          ? Promise.resolve({ outcome: 'skipped', reason: 'its delete address is redacted' })
          : Promise.resolve(undefined)
      );
      const result = await makeEngine().deploy(STACK, template());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      expect(result.updatePartial).toBe(1);
    });

    it('hands the provider the SENT value as the previous side of a held create-only path when another property changed (review: no *** to a provider)', async () => {
      const tpl = template();
      (tpl.Resources['Topic']!.Properties as Record<string, unknown>)['DisplayName'] = 'd2';
      await makeEngine().deploy(STACK, tpl);
      const updates = callsFor(provider.update, 'Topic');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['TopicName']).toBe(TOPIC);
      expect((updates[0]![4] as Record<string, unknown>)['TopicName']).toBe(TOPIC);
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
    });

    it('never replaces on a marked *** once NoEcho is removed from the parameter (value unchanged)', async () => {
      const tpl = template();
      (tpl.Parameters!['TopicName'] as unknown as Record<string, unknown>)['NoEcho'] = false;
      await makeEngine().deploy(STACK, tpl);
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
      expect(provider.readCurrentState.mock.calls.some((c) => c[1] === 'Topic')).toBe(true);
    });

    it('migrates a held producer echoing the value and its untouched same-stack reader (spec review)', async () => {
      const state = v10State();
      state.resources['Param']!.attributes = { Value: TOKEN, Type: 'String' };
      state.resources['Consumer'] = {
        physicalId: '/app/c',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/c', Type: 'String', Value: TOKEN },
        attributes: { Value: TOKEN },
        dependencies: ['Param'],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      await makeEngine().deploy(
        STACK,
        template(TOKEN, {
          Consumer: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: '/app/c', Type: 'String', Value: { 'Fn::GetAtt': ['Param', 'Value'] } },
          },
        })
      );
      const saved = lastSaved();
      expect(saved.resources['Param']!.noEchoAttributeNames).toEqual(['Value']);
      expect(saved.resources['Param']!.attributes?.['Value']).toBe('***');
      expect(saved.resources['Consumer']!.properties['Value']).toBe('***');
      expect(saved.resources['Consumer']!.attributes?.['Value']).toBe('***');
      expect(allSaved()).not.toContain(TOKEN);
      // The migration sends nothing to an unchanged producer or reader.
      expect(callsFor(provider.update, 'Param')).toHaveLength(0);
      expect(callsFor(provider.update, 'Consumer')).toHaveLength(0);
    });

    it('migrates a record the failed deploy never reached, by today\'s template positions', async () => {
      const state = v10State();
      state.resources['Later'] = {
        physicalId: '/app/later',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/later', Type: 'String', Value: 'xy' },
        attributes: {},
        dependencies: ['Param'],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.update.mockImplementation((logicalId: string) =>
        logicalId === 'Param' ? Promise.reject(new Error('boom')) : Promise.resolve({ physicalId: 'x' })
      );
      const tpl = template(TOKEN2, {
        Later: {
          Type: 'AWS::SSM::Parameter',
          DependsOn: 'Param',
          Properties: { Name: '/app/later', Type: 'String', Value: { Ref: 'Short' } },
        },
      });
      (tpl.Parameters!['Short'] as unknown as Record<string, unknown>)['Default'] = 'xy';
      await expect(makeEngine({ noRollback: true }).deploy(STACK, tpl)).rejects.toThrow(
        'Param'
      );
      // The premise: the deploy never reached `Later`.
      expect(callsFor(provider.update, 'Later')).toHaveLength(0);
      expect(callsFor(provider.create, 'Later')).toHaveLength(0);
      const saved = lastSaved();
      expect(saved.resources['Later']!.properties['Value']).toBe('***');
      expect(saved.resources['Later']!.noEchoLeaves).toEqual([['Value']]);
    });
  });

  describe('review MEDIUM-4', () => {
    const SM = '{{resolve:secretsmanager:app/db:SecretString:pw}}';
    const mixed = (token: string) =>
      template(token, {
        Mixed: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/mixed',
            Type: 'String',
            Value: { 'Fn::Join': ['', [{ Ref: 'Token' }, '-', SM]] },
          },
        },
      });
    const mixedState = (stored: string) => {
      const state = v10State();
      state.resources['Mixed'] = {
        physicalId: '/app/mixed',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/mixed', Type: 'String', Value: stored },
        attributes: {},
        dependencies: [],
      };
      return state;
    };

    it('(2) the witness confirms an unchanged leaf mixing a NoEcho Ref with a secret reference', async () => {
      stateBackend.getState.mockResolvedValue({ state: mixedState(`${TOKEN}-${SM}`), etag: 'e' });
      await makeEngine().deploy(STACK, mixed(TOKEN));
      expect(callsFor(provider.update, 'Mixed')).toHaveLength(0);
      expect(provider.readCurrentState.mock.calls.some((c) => c[1] === 'Mixed')).toBe(false);
      expect(lastSaved().resources['Mixed']!.properties['Value']).toBe('***');
      expect(allSaved()).not.toContain(TOKEN);
      expect(allSaved()).not.toContain('sm-secret-plaintext-value');
    });

    it('(2) a changed NoEcho part of the same mixed leaf is sent', async () => {
      stateBackend.getState.mockResolvedValue({ state: mixedState(`${TOKEN}-${SM}`), etag: 'e' });
      await makeEngine().deploy(STACK, mixed(TOKEN2));
      const updates = callsFor(provider.update, 'Mixed');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['Value']).toBe(
        `${TOKEN2}-sm-secret-plaintext-value`
      );
      expect(allSaved()).not.toContain(TOKEN2);
    });

    it('(3) a nested segment\'s previousOutputs are masked by position in the journal', async () => {
      const engine = makeEngine() as unknown as Record<string, unknown> & {
        writeRollbackJournalSegment: (...args: unknown[]) => Promise<boolean>;
      };
      engine['constructPathTemplate'] = template();
      engine['outputsTemplateSource'] = Object.assign(Object.create(null), {
        Out: { Ref: 'Token' },
        Plain: { Ref: 'Plain' },
      });
      engine['outputsSourceUsable'] = true;
      await engine.writeRollbackJournalSegment(STACK, [], [], 'nested-pending-parent', false, {
        previousOutputs: { outputs: { Out: TOKEN, Plain: 'plain-value' } },
      });
      const segment = stateBackend.appendRollbackJournalSegment.mock.calls.at(-1)![2] as {
        previousOutputs: { outputs: Record<string, unknown> };
      };
      expect(segment.previousOutputs.outputs).toEqual({ Out: '***', Plain: 'plain-value' });
    });

    it('(3) an orphan record is masked by today\'s template positions', () => {
      const engine = makeEngine() as unknown as Record<string, unknown> & {
        redactStateForPersist: (state: StackState) => StackState;
      };
      engine['constructPathTemplate'] = template();
      const state = v11State();
      state.orphans = [
        {
          logicalId: 'Param',
          state: {
            physicalId: '/app/p-old',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Name: '/app/p', Type: 'String', Value: TOKEN },
            attributes: {},
          },
        },
      ] as unknown as StackState['orphans'];
      const saved = engine.redactStateForPersist(state);
      expect(saved.orphans![0]!.state.properties['Value']).toBe('***');
      expect(saved.orphans![0]!.state.noEchoLeaves).toEqual([['Value']]);
    });

    it('(3) noEchoAttributeNames keeps a prior name still masked, drops one now public, and adds this run\'s', () => {
      const engine = makeEngine() as unknown as Record<string, unknown> & {
        applyNoEchoPersist: (...args: unknown[]) => ResourceState;
        noEchoAttributeResources: Map<string, true | ReadonlySet<string>>;
      };
      engine['constructPathTemplate'] = template();
      engine.noEchoAttributeResources.set('Cr', new Set(['Fresh']));
      const record: ResourceState = {
        physicalId: 'cr-1',
        resourceType: 'Custom::Thing',
        properties: {},
        attributes: { Kept: '***', Public: 'now-public', Fresh: 'fresh-value-1234' },
        noEchoAttributeNames: ['Kept', 'Public'],
      };
      const out = engine.applyNoEchoPersist('Cr', record, record, undefined, {});
      expect(out.noEchoAttributeNames).toEqual(['Fresh', 'Kept']);
      expect(out.attributes).toEqual({ Kept: '***', Public: 'now-public', Fresh: '***' });
    });
  });
});

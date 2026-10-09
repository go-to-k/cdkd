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
import { GeneratedNameGuard } from '../../../src/deployment/generated-name-guard.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import {
  CrossPrefixScanCache,
  type CrossPrefixScanResult,
} from '../../../src/state/cross-prefix-stack-scan.js';
import { createCrossPrefixDestructiveGate } from '../../../src/cli/commands/cross-prefix-gate.js';
import { maskedPropertyFingerprint } from '../../../src/deployment/masked-property-fingerprints.js';
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

// A knob for the lost-child arm (go-to-k/cdkd#4656 review): when set, the
// named resource reads as a child whose parent this deploy re-created.
const lostChildKnob = vi.hoisted(() => ({
  forType: undefined as string | undefined,
}));
vi.mock('../../../src/deployment/child-of-recreated-parent.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/deployment/child-of-recreated-parent.js')>();
  return {
    ...original,
    childLostWithRecreatedParent: (
      input: Parameters<typeof original.childLostWithRecreatedParent>[0]
    ) =>
      lostChildKnob.forType === input.resourceType
        ? { parent: 'Param', property: 'DisplayName', mode: 'recreate' as const }
        : original.childLostWithRecreatedParent(input),
  };
});

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
    lostChildKnob.forType = undefined;
    describeType.writeOnly.clear();
    describeType.fail = false;
    clearCreateOnlyPropertiesCache();
    clearWriteOnlyPropertiesCache();
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

    it.each(['any-change', 'destructive'] as const)(
      'does not ask --require-approval=%s for an unchanged stack reading a NoEcho parameter (review round 8 code B1)',
      async (level) => {
        const approveDeployment = vi.fn(async () => false);
        await makeEngine({ requireApproval: level, approveDeployment }).deploy(STACK, template());
        expect(approveDeployment).not.toHaveBeenCalled();
        expect(callsFor(provider.update, 'Param')).toHaveLength(0);
        expect(lines(logger.info).some((l) => l.includes('No changes detected in the template'))).toBe(
          true
        );
      }
    );

    it.each(['any-change', 'destructive'] as const)(
      'does not ask --require-approval=%s for a Ref reader of a create-only NoEcho-fed resource (review round 9 code B1)',
      async (level) => {
        const sub = {
          Sub: {
            Type: 'AWS::SNS::Subscription',
            Properties: { TopicArn: { Ref: 'Topic' }, Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:1:q' },
          },
        };
        const state = v11State();
        state.resources['Sub'] = {
          physicalId: `${TOPIC_ARN}:sub-1`,
          resourceType: 'AWS::SNS::Subscription',
          properties: { TopicArn: TOPIC_ARN, Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:1:q' },
          attributes: {},
          dependencies: ['Topic'],
        };
        stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
        const approveDeployment = vi.fn(async () => false);
        await makeEngine({ requireApproval: level, approveDeployment }).deploy(STACK, template(TOKEN, sub));
        expect(approveDeployment).not.toHaveBeenCalled();
        expect(callsFor(provider.create, 'Sub')).toHaveLength(0);
        expect(callsFor(provider.delete, 'Sub')).toHaveLength(0);
        expect(lines(logger.info).some((l) => l.includes('No changes detected in the template'))).toBe(
          true
        );
      }
    );

    it('still asks --require-approval=any-change when the template really changed beside it', async () => {
      const approveDeployment = vi.fn(async () => true);
      const tpl = template();
      (tpl.Resources['Topic']!.Properties as Record<string, unknown>)['DisplayName'] = 'd2';
      await makeEngine({ requireApproval: 'any-change', approveDeployment }).deploy(STACK, tpl);
      expect(approveDeployment).toHaveBeenCalledTimes(1);
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

    it('hands a custom resource reading a NoEcho parameter the plaintext as ResourceProperties and *** as OldResourceProperties, never reversed (maintainer decision 4)', async () => {
      const cr = {
        Cr: {
          Type: 'Custom::Thing',
          Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:1:function:h', Value: { Ref: 'Token' } },
        },
      };
      const state = v11State();
      state.resources['Cr'] = {
        physicalId: 'cr-1',
        resourceType: 'Custom::Thing',
        properties: { ServiceToken: 'arn:aws:lambda:us-east-1:1:function:h', Value: '***' },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['Value']],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN
            ? { TopicName: TOPIC, DisplayName: 'd' }
            : physicalId === 'cr-1'
              ? {}
              : { Name: '/app/p', Type: 'String', Value: TOKEN }
        )
      );
      await makeEngine().deploy(STACK, template(TOKEN, cr));
      const updates = callsFor(provider.update, 'Cr');
      expect(updates).toHaveLength(1);
      // provider.update(logicalId, physicalId, type, properties, previousProperties)
      expect((updates[0]![3] as Record<string, unknown>)['Value']).toBe(TOKEN);
      expect((updates[0]![4] as Record<string, unknown>)['Value']).toBe('***');
      expect(lines(logger.info).filter((l) => l.includes('re-sending Value'))).toHaveLength(1);
      expect(allSaved()).not.toContain(TOKEN);
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

    // A type the replacement-rules registry does not classify, so the diff's
    // ceiling comes from the schema alone (review round 8 B1).
    const ALIAS = 'alias/noecho-alias-v11';
    const aliasSetup = (readback: Record<string, unknown>) => {
      const state = v11State();
      state.resources['Alias'] = {
        physicalId: ALIAS,
        resourceType: 'AWS::KMS::Alias',
        properties: { AliasName: '***', TargetKeyId: 'key-1' },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['AliasName']],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === ALIAS
            ? readback
            : physicalId === TOPIC_ARN
              ? { TopicName: TOPIC, DisplayName: 'd' }
              : { Name: '/app/p', Value: TOKEN }
        )
      );
      const tpl = template(TOKEN, {
        Alias: {
          Type: 'AWS::KMS::Alias',
          Properties: { AliasName: { Ref: 'AliasParam' }, TargetKeyId: 'key-1' },
        },
      });
      tpl.Parameters!['AliasParam'] = { Type: 'String', NoEcho: true, Default: ALIAS };
      return tpl;
    };

    it('never sends an in-place update to a WRITE-ONLY create-only property (decision 1; review round 8 B1)', async () => {
      describeType.writeOnly.set('AWS::KMS::Alias', ['AliasName']);
      const tpl = aliasSetup({ TargetKeyId: 'key-1' });
      await makeEngine().deploy(STACK, tpl);
      expect(callsFor(provider.update, 'Alias')).toHaveLength(0);
      expect(callsFor(provider.create, 'Alias')).toHaveLength(0);
      expect(lines(logger.warn).some((l) => l.includes('--recreate-via-cc-api Alias'))).toBe(true);
      expect(lines(logger.info).some((l) => l.includes('re-sending AliasName'))).toBe(false);
    });

    it('classifies a create-only property from the schema snapshot when DescribeType fails (review round 8 B1)', async () => {
      describeType.fail = true;
      const tpl = aliasSetup({ AliasName: 'alias/other', TargetKeyId: 'key-1' });
      await makeEngine().deploy(STACK, tpl);
      expect(callsFor(provider.update, 'Alias')).toHaveLength(0);
      expect(callsFor(provider.create, 'Alias')).toHaveLength(0);
      expect(lines(logger.warn).some((l) => l.includes('--recreate-via-cc-api Alias'))).toBe(true);
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
    it('skips an unchanged value with no comparison readback, and the save migrates the record', async () => {
      stateBackend.getState.mockResolvedValue({ state: v10State(), etag: 'etag-old' });
      await makeEngine().deploy(STACK, template());
      // The witness settles both values. The only read is the create-only
      // topic's echo-fidelity readback (go-to-k/cdkd#4656), handed a copy of
      // the record with the stored plaintext pre-masked.
      expect(provider.readCurrentState.mock.calls).toEqual([
        [TOPIC_ARN, 'Topic', 'AWS::SNS::Topic', { TopicName: '***', DisplayName: 'd' }],
      ]);
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

    it('never writes a pre-v11 output plaintext in ANY save of the migration deploy, the per-resource saves before the outputs pass included (P9 leak)', async () => {
      const state = v10State();
      state.outputs = { TokenOut: TOKEN, ExportedAlias: TOKEN, PlainOut: 'plain-value' };
      state.exportNames = ['ExportedAlias'];
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      await makeEngine().deploy(
        STACK,
        template(
          TOKEN2,
          {},
          {
            TokenOut: { Value: { Ref: 'Token' }, Export: { Name: 'ExportedAlias' } },
            PlainOut: { Value: { Ref: 'Plain' } },
          }
        )
      );
      // More than one save: the per-resource saves ran before the final one.
      expect(stateBackend.saveState.mock.calls.length).toBeGreaterThan(1);
      for (const [index, call] of stateBackend.saveState.mock.calls.entries()) {
        const saved = JSON.stringify(call[2]);
        expect(saved, `save #${index}`).not.toContain(TOKEN);
        expect(saved, `save #${index}`).not.toContain(TOKEN2);
      }
      expect(lastSaved().outputs['PlainOut']).toBe('plain-value');
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

    it('declares an ARN attribute that IS a NoEcho value (only one merely containing it names the resource)', async () => {
      const ARN_TOKEN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:noecho-arn-value';
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      provider.create.mockImplementation((logicalId: string) =>
        Promise.resolve(
          logicalId === 'Param'
            ? { physicalId: '/app/p', attributes: { SecretArn: ARN_TOKEN } }
            : { physicalId: `${logicalId}-phys`, attributes: {} }
        )
      );
      await makeEngine().deploy(STACK, template(ARN_TOKEN));
      const param = lastSaved().resources['Param']!;
      expect(param.noEchoAttributeNames).toEqual(['SecretArn']);
      expect(allSaved()).not.toContain(ARN_TOKEN);
    });

    it('never declares an attribute equal to the physical id, even when the id IS the NoEcho value', async () => {
      const state = v10State();
      state.resources['Param']!.physicalId = TOKEN;
      state.resources['Param']!.attributes = { Name: TOKEN };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      await makeEngine().deploy(STACK, template());
      // An attribute equal to the physical id (which AWS publishes) is not
      // DECLARED; the value arm still masks it in this record.
      expect(lastSaved().resources['Param']!.noEchoAttributeNames).toBeUndefined();
      expect(lastSaved().resources['Param']!.physicalId).toBe(TOKEN);
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
      // Maintainer decision (design §9 item 6): the replacement names its
      // cause, and never the value on either side.
      const cause = lines(logger.warn).filter((l) => l.includes('Topic.TopicName'));
      expect(cause).toEqual([
        "Topic.TopicName is a create-only property, and a NoEcho parameter's value changed since the last deploy: Topic is replaced.",
      ]);
    });

    it('names the POSITION, not the parameter, when only the template text around an unchanged value moved (review round 9 m4)', async () => {
      provider.create.mockImplementation((logicalId: string) =>
        Promise.resolve({ physicalId: `${logicalId}-new-arn`, attributes: {} })
      );
      // Stored `a-<value>`; today's template spells `b-${TopicName}` with the
      // same parameter value.
      stateBackend.getState.mockResolvedValue({ state: v10State(TOKEN, `a-${TOPIC}`), etag: 'etag-old' });
      const tpl = template();
      (tpl.Resources['Topic']!.Properties as Record<string, unknown>)['TopicName'] = {
        'Fn::Sub': 'b-${TopicName}',
      };
      await makeEngine().deploy(STACK, tpl);
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      expect(lines(logger.warn).filter((l) => l.includes('Topic.TopicName'))).toEqual([
        'Topic.TopicName is a create-only property, and the value at its NoEcho position changed since the last deploy: Topic is replaced.',
      ]);
    });

    it('names no NoEcho cause when the pre-v11 witness CONFIRMS the value (no replacement)', async () => {
      stateBackend.getState.mockResolvedValue({ state: v10State(TOKEN, TOPIC), etag: 'etag-old' });
      await makeEngine().deploy(STACK, template());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(lines(logger.warn).some((l) => l.includes('changed since the last deploy'))).toBe(false);
    });

    describe('names a replacement only where one happens (go-to-k/cdkd#4737)', () => {
      // `NotificationsWithSubscribers` is create-only in the Budget schema,
      // while the registry updates it in place (the provider reconciles it).
      const notifications = (address: unknown): unknown[] => [
        {
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 80,
          },
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: address }],
        },
      ];
      const budgetState = (version: number): StackState => {
        const state = version >= STATE_SCHEMA_VERSION_CURRENT ? v11State() : v10State();
        state.version = version as never;
        state.resources['Bud'] = {
          physicalId: 'budget-phys',
          resourceType: 'AWS::Budgets::Budget',
          properties: {
            Budget: { BudgetName: 'b' },
            NotificationsWithSubscribers: notifications('old-addr@example.com'),
          },
          attributes: {},
          dependencies: [],
        };
        return state;
      };
      const budgetTemplate = (address: unknown): CloudFormationTemplate => {
        const tpl = template(TOKEN, {
          Bud: {
            Type: 'AWS::Budgets::Budget',
            Properties: {
              Budget: { BudgetName: 'b' },
              NotificationsWithSubscribers: notifications(address),
            },
          },
        });
        tpl.Parameters!['Mail'] = { Type: 'String', NoEcho: true, Default: 'new-addr@example.com' };
        return tpl;
      };

      // A bare `Ref` names the parameter as the cause, an `Fn::Sub` around it
      // the position; neither is printed for an update.
      it.each([
        ['a bare Ref, schema v11', { Ref: 'Mail' }, STATE_SCHEMA_VERSION_CURRENT],
        ['a bare Ref, pre-v11 (the migration witness)', { Ref: 'Mail' }, 10],
        ['an Fn::Sub around it, schema v11', { 'Fn::Sub': 'ops+${Mail}' }, STATE_SCHEMA_VERSION_CURRENT],
        ['an Fn::Sub around it, pre-v11 (the migration witness)', { 'Fn::Sub': 'ops+${Mail}' }, 10],
      ])(
        'updates a registry-updatable create-only path in place, with no "is replaced" line: %s',
        async (_label, address, version) => {
          stateBackend.getState.mockResolvedValue({ state: budgetState(version), etag: 'etag-old' });
          await makeEngine().deploy(STACK, budgetTemplate(address));
          const updates = callsFor(provider.update, 'Bud');
          expect(updates).toHaveLength(1);
          // The new value is sent.
          expect(JSON.stringify(updates[0]![3])).toContain('new-addr@example.com');
          expect(callsFor(provider.create, 'Bud')).toHaveLength(0);
          expect(callsFor(provider.delete, 'Bud')).toHaveLength(0);
          expect(lines(logger.warn).filter((l) => l.includes('Bud'))).toEqual([]);
          const saved = lastSaved().resources['Bud']!;
          expect(saved.noEchoLeaves).toEqual([
            ['NotificationsWithSubscribers', 0, 'Subscribers', 0, 'Address'],
          ]);
          // The value reaches neither state nor any log line.
          expect(allSaved()).not.toContain('new-addr@example.com');
          for (const fn of [logger.debug, logger.info, logger.warn, logger.error]) {
            // Every argument, not only the message.
            expect(JSON.stringify(fn!.mock.calls)).not.toContain('new-addr@example.com');
          }
        }
      );

      it('still names the cause when a create-only literal becomes a NoEcho Ref with another value and the resource IS replaced (schema v11)', async () => {
        provider.create.mockImplementation((logicalId: string) =>
          Promise.resolve({ physicalId: `${logicalId}-new-arn`, attributes: {} })
        );
        const state = v11State();
        state.resources['Topic'] = {
          ...state.resources['Topic']!,
          properties: { TopicName: 'old-topic-name', DisplayName: 'd' },
        };
        delete state.resources['Topic']!.noEchoLeaves;
        stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
        await makeEngine().deploy(STACK, template());
        expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
        expect(callsFor(provider.delete, 'Topic')).toHaveLength(1);
        expect(provider.create.mock.invocationCallOrder[0]!).toBeLessThan(
          provider.delete.mock.invocationCallOrder[0]!
        );
        expect(lines(logger.warn).filter((l) => l.includes('Topic.TopicName'))).toEqual([
          "Topic.TopicName is a create-only property, and a NoEcho parameter's value changed since the last deploy: Topic is replaced.",
        ]);
      });
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
      // Review round 8 m2: AWS confirmed the value, so the record is rewritten
      // with it and unmarked (no phantom `***` vs value diff on every run).
      const topic = lastSaved().resources['Topic']!;
      expect(topic.properties['TopicName']).toBe(TOPIC);
      expect(topic.noEchoLeaves).toBeUndefined();
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

    // go-to-k/cdkd#4043 Phase C: a nested child's success journals its
    // PRE-deploy outputs for the parent's revert. An alias an older binary
    // published that spells a NoEcho value must not ride along, or the revert
    // re-persists it and republishes it to the exports index.
    describe.each([
      ['with Outputs', { Plain: { Value: { Ref: 'Plain' }, Export: { Name: 'Kept' } } }],
      ['with no Outputs', undefined],
    ])('(Phase C) a nested child\'s pending snapshot, template %s', (_label, outputs) => {
      it('leaves out a previous alias the export-name verdict refuses, keeps a clean one', async () => {
        const state = v11State();
        state.outputs = { Plain: 'plain-value', Kept: 'plain-value', [`alias-${TOKEN}`]: 'v' };
        state.exportNames = ['Kept', `alias-${TOKEN}`];
        stateBackend.getState.mockResolvedValue({ state, etag: 'e' });
        await makeEngine({
          parentStackInfo: { parentStack: 'Root', parentLogicalId: 'Child', parentRegion: REGION },
        }).deploy(STACK, template(TOKEN, {}, outputs));
        const segment = stateBackend.appendRollbackJournalSegment.mock.calls
          .map((c) => c[2] as { reason?: string; previousOutputs?: { outputs: object; exportNames?: string[] } })
          .find((s) => s.reason === 'nested-pending-parent');
        expect(segment?.previousOutputs?.exportNames).toEqual(['Kept']);
        expect(Object.keys(segment!.previousOutputs!.outputs).sort()).toEqual(['Kept', 'Plain']);
        expect(JSON.stringify(stateBackend.appendRollbackJournalSegment.mock.calls)).not.toContain(
          TOKEN
        );
      });
    });

    // Phase C: with no export-name verdict (no outputs pass ran), the
    // nested child's snapshot keeps no previous export, and says so.
    it('(Phase C) a nested pending snapshot with NO verdict refuses every previous export name, with a warning', async () => {
      const engine = makeEngine({
        parentStackInfo: { parentStack: 'Root', parentLogicalId: 'Child', parentRegion: REGION },
      }) as unknown as Record<string, unknown> & {
        settleJournalAfterSuccess: (...args: unknown[]) => Promise<number>;
      };
      engine['carriedExportAliasRefusal'] = undefined;
      const state = v11State();
      state.outputs = { Kept: 'v' };
      state.exportNames = ['Kept'];
      await engine.settleJournalAfterSuccess(STACK, [], state, state.resources, false);
      const segment = stateBackend.appendRollbackJournalSegment.mock.calls.at(-1)![2] as {
        previousOutputs: { outputs: object; exportNames?: string[] };
      };
      expect(segment.previousOutputs).toEqual({ outputs: {}, exportNames: [] });
      expect(lines(logger.warn).some((l) => l.includes('no export-name verdict is available'))).toBe(true);
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

  describe('echo fidelity of a create-only NoEcho value (go-to-k/cdkd#4656)', () => {
    const ROTATED = 'topic-v11-rotated-0002';
    const rotatedTemplate = (): CloudFormationTemplate => {
      const tpl = template();
      tpl.Parameters!['TopicName'] = { Type: 'String', NoEcho: true, Default: ROTATED };
      return tpl;
    };
    const exactState = (): StackState =>
      v11State({ Topic: { noEchoExactEchoLeaves: [['TopicName']] } });
    const topicReads = (): unknown[][] =>
      provider.readCurrentState.mock.calls.filter((c) => c[1] === 'Topic');
    beforeEach(() => {
      // A replacement gets the ARN of the name it was created under.
      provider.create.mockImplementation(
        (logicalId: string, _type: string, props: Record<string, unknown>) =>
          Promise.resolve({
            physicalId:
              logicalId === 'Topic'
                ? `arn:aws:sns:us-east-1:123456789012:${String(props['TopicName'])}`
                : `${logicalId}-phys`,
            attributes: {},
          })
      );
      // An SNS readback reports the name as its ARN's tail, as the provider does.
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId.startsWith('arn:aws:sns:')
            ? { TopicName: physicalId.split(':').pop(), DisplayName: 'd' }
            : { Name: '/app/p', Type: 'String', Value: TOKEN }
        )
      );
    });

    it('sets the flag when the create readback, handed the masked record, reports the value exactly', async () => {
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      await makeEngine().deploy(STACK, template());
      expect(topicReads()).toEqual([
        [TOPIC_ARN, 'Topic', 'AWS::SNS::Topic', { TopicName: '***', DisplayName: 'd' }],
      ]);
      const saved = lastSaved();
      expect(saved.resources['Topic']!.noEchoExactEchoLeaves).toEqual([['TopicName']]);
      // An updatable property is never judged (no create-only path).
      expect(saved.resources['Param']!.noEchoExactEchoLeaves).toBeUndefined();
      expect(provider.readCurrentState.mock.calls.some((c) => c[1] === 'Param')).toBe(false);
    });

    it('never sets it for a provider that echoes the record it was handed', async () => {
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      provider.readCurrentState.mockImplementation(
        (_p: string, _l: string, _t: string, props: Record<string, unknown>) =>
          Promise.resolve({ ...props })
      );
      await makeEngine().deploy(STACK, template());
      expect(topicReads()).toHaveLength(1);
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toBeUndefined();
    });

    it('never sets it for a provider that normalizes what it reports', async () => {
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN
            ? { TopicName: TOPIC.toUpperCase(), DisplayName: 'd' }
            : { Name: '/app/p', Value: TOKEN }
        )
      );
      await makeEngine().deploy(STACK, template());
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toBeUndefined();
    });

    it('leaves it absent on a failed create readback, and sets it on the next readback that holds', async () => {
      stateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        physicalId === TOPIC_ARN
          ? Promise.reject(new Error('throttled'))
          : Promise.resolve({ Name: '/app/p', Value: TOKEN })
      );
      await makeEngine().deploy(STACK, template());
      const first = lastSaved();
      expect(first.resources['Topic']!.noEchoLeaves).toEqual([['TopicName']]);
      expect(first.resources['Topic']!.noEchoExactEchoLeaves).toBeUndefined();

      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN
            ? { TopicName: TOPIC, DisplayName: 'd' }
            : { Name: '/app/p', Value: TOKEN }
        )
      );
      stateBackend.getState.mockResolvedValue({ state: first, etag: 'etag-1' });
      await makeEngine().deploy(STACK, template());
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toEqual([['TopicName']]);
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
    });

    it('computes it at the migration deploy against a PRE-MASKED copy: an echoing provider sets nothing', async () => {
      stateBackend.getState.mockResolvedValue({ state: v10State(), etag: 'etag-old' });
      provider.readCurrentState.mockImplementation(
        (_p: string, _l: string, _t: string, props: Record<string, unknown>) =>
          Promise.resolve({ ...props })
      );
      await makeEngine().deploy(STACK, template());
      // The record held the plaintext; the provider was handed the mask.
      expect(topicReads()).toEqual([
        [TOPIC_ARN, 'Topic', 'AWS::SNS::Topic', { TopicName: '***', DisplayName: 'd' }],
      ]);
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toBeUndefined();
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
    });

    it('computes it at the migration deploy when AWS reports the value exactly', async () => {
      stateBackend.getState.mockResolvedValue({ state: v10State(), etag: 'etag-old' });
      await makeEngine().deploy(STACK, template());
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toEqual([['TopicName']]);
    });

    it('REPLACES a rotated value through the create-first path when the flag is set', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      await makeEngine().deploy(STACK, rotatedTemplate());
      const creates = callsFor(provider.create, 'Topic');
      expect(creates).toHaveLength(1);
      expect((creates[0]![2] as Record<string, unknown>)['TopicName']).toBe(ROTATED);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(1);
      expect(provider.create.mock.invocationCallOrder[0]!).toBeLessThan(
        provider.delete.mock.invocationCallOrder[0]!
      );
      expect(lines(logger.warn).filter((l) => l.includes('Topic.TopicName'))).toEqual([
        'Topic.TopicName is a create-only property fed by a NoEcho parameter, and AWS, which reports it exactly, holds a different value: Topic is replaced.',
      ]);
      const saved = lastSaved().resources['Topic']!;
      expect(saved.properties['TopicName']).toBe('***');
      // The NEW resource's own readback set the flag again.
      expect(saved.noEchoExactEchoLeaves).toEqual([['TopicName']]);
      expect(allSaved()).not.toContain(`"${ROTATED}"`);
    });

    it('a replacement reads its echo fidelity afresh: the old flag is not carried onto it', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN
            ? { TopicName: TOPIC, DisplayName: 'd' }
            : physicalId.startsWith('arn:aws:sns:')
              ? { TopicName: ROTATED.toUpperCase(), DisplayName: 'd' }
              : { Name: '/app/p', Type: 'String', Value: TOKEN }
        )
      );
      await makeEngine().deploy(STACK, rotatedTemplate());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toBeUndefined();
    });

    it('replaces under --require-approval when nothing can be asked (no approver)', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      await makeEngine({ requireApproval: 'destructive' }).deploy(STACK, rotatedTemplate());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
    });

    it('never replaces without the flag, and the warning names why', async () => {
      stateBackend.getState.mockResolvedValue({ state: v11State(), etag: 'etag-old' });
      await makeEngine().deploy(STACK, rotatedTemplate());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
      const warned = lines(logger.warn).filter((l) => l.includes('Topic.TopicName'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain(
        '(differs; the provider is not known to report this property exactly, so the difference may be its normalization)'
      );
      // A differing read never sets the flag.
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toBeUndefined();
    });

    it('never replaces on a coordinate the flag does not name', async () => {
      stateBackend.getState.mockResolvedValue({
        state: v11State({ Topic: { noEchoExactEchoLeaves: [['DisplayName']] } }),
        etag: 'etag-old',
      });
      await makeEngine().deploy(STACK, rotatedTemplate());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
    });

    it('a create or replacement verdict REPLACES what the deploy noted of the old resource', () => {
      const engine = makeEngine() as unknown as {
        noteNoEchoExactEchoes: (...args: unknown[]) => void;
        noEchoExactEchoes: Map<string, { physicalId: string; coordinates: string[][] }>;
      };
      const candidates = [{ coordinate: ['TopicName'], plaintext: TOPIC }];
      const handed = { TopicName: '***' };
      const ok = { live: { TopicName: TOPIC } };
      const failed = { failure: 'read-failed' };
      engine.noteNoEchoExactEchoes('Topic', TOPIC_ARN, ok, handed, candidates, 'add');
      expect(engine.noEchoExactEchoes.get('Topic')!.coordinates).toEqual([['TopicName']]);
      engine.noteNoEchoExactEchoes('Topic', TOPIC_ARN, failed, handed, candidates, 'add');
      expect(engine.noEchoExactEchoes.get('Topic')!.coordinates).toEqual([['TopicName']]);
      engine.noteNoEchoExactEchoes('Topic', TOPIC_ARN, failed, handed, candidates, 'set');
      expect(engine.noEchoExactEchoes.get('Topic')!.coordinates).toEqual([]);
    });

    it('never replaces on a report that is the mask itself (a projected read), flag or not', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      provider.readCurrentState.mockImplementation(
        (_p: string, _l: string, _t: string, props: Record<string, unknown>) =>
          Promise.resolve({ ...props })
      );
      await makeEngine().deploy(STACK, rotatedTemplate());
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
      // `differs` keeps the flag it had.
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toEqual([['TopicName']]);
    });

    it.each(['destructive', 'any-change'] as const)(
      'asks again under --require-approval=%s, whose up-front prompt saw no replacement; a "no" keeps the resource and the flag',
      async (level) => {
        stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
        const approveDeployment = vi.fn(async (_request: unknown) => false);
        const tpl = rotatedTemplate();
        tpl.Resources['Topic']!.Metadata = { 'aws:cdk:path': 'Stack/NamedTopic/Resource' };
        await makeEngine({ requireApproval: level, approveDeployment }).deploy(STACK, tpl);
        // The up-front prompt saw a promotion only; the late one names the replacement.
        expect(approveDeployment).toHaveBeenCalledTimes(1);
        const request = approveDeployment.mock.calls[0]![0] as {
          level: string;
          destructiveChanges: { logicalId: string }[];
        };
        expect(request.level).toBe(level);
        expect(request.destructiveChanges.map((c) => c.logicalId)).toEqual(['Topic']);
        // Rendered from the deploy's template, as the up-front prompt is.
        expect(
          (request.destructiveChanges[0] as { constructPath?: string }).constructPath
        ).toBe('Stack/NamedTopic/Resource');
        expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
        expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
        const warned = lines(logger.warn).filter((l) => l.includes('Topic.TopicName'));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain(
          `(differs; the replacement was not approved (--require-approval=${level}))`
        );
        expect(warned[0]).not.toContain(ROTATED);
        expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toEqual([['TopicName']]);
      }
    );

    describe('the cross-prefix check of a late replacement (go-to-k/cdkd#4705)', () => {
      it('asks onDestructivePlan with stage late, which the plan never called, then replaces', async () => {
        stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
        const onDestructivePlan = vi.fn(async (..._args: unknown[]) => undefined);
        await makeEngine({ onDestructivePlan }).deploy(STACK, rotatedTemplate());
        // The plan saw a promotion only, so the ONE call is the late one.
        expect(onDestructivePlan).toHaveBeenCalledTimes(1);
        const [stackName, destructive, stage] = onDestructivePlan.mock.calls[0]!;
        expect(stackName).toBe(STACK);
        expect((destructive as { logicalId: string }[]).map((c) => c.logicalId)).toEqual([
          'Topic',
        ]);
        expect(stage).toBe('late');
        expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      });

      // The real gate over a scan of each kind (review R5-2).
      const gateOver = (result: CrossPrefixScanResult) => {
        const cache = new CrossPrefixScanCache({
          prefix: 'cdkd',
          listTopLevelPrefixes: vi.fn(),
          recordUnderPrefix: vi.fn(),
        });
        vi.spyOn(cache, 'full').mockResolvedValue(result);
        return vi.fn(createCrossPrefixDestructiveGate({ region: 'us-east-1', bucket: 'b', cache }));
      };

      it.each([
        ['found', { kind: 'found', prefixes: ['team-b'] }, /recorded under another state prefix/],
        [
          'failed',
          { kind: 'failed', error: new Error('boom') },
          /could not check whether the bucket/,
        ],
      ] as const)(
        'a %s refusal keeps the resource, warns it in full, and counts as unaddressed (exit 2)',
        async (_kind, scan, needle) => {
          stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
          const onDestructivePlan = gateOver(scan as CrossPrefixScanResult);
          const approveDeployment = vi.fn(async () => true);
          const result = await makeEngine({
            onDestructivePlan,
            requireApproval: 'destructive',
            approveDeployment,
          }).deploy(STACK, rotatedTemplate());
          expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
          expect(callsFor(provider.delete, 'Topic')).toHaveLength(0);
          // Refused before the late approval prompt.
          expect(approveDeployment).not.toHaveBeenCalled();
          // Its own counter (review R6-5): the CLI exits 2 on it (unless
          // --allow-unaddressed), and it is not a skipped DELETE.
          expect(result.crossPrefixKept).toBe(1);
          expect(result.deleteSkipped).toBe(0);
          const warned = lines(logger.warn);
          expect(
            warned.filter((l) => l.startsWith('Refusing to replace a resource of stack'))
          ).toHaveLength(1);
          expect(warned.join('\n')).toMatch(needle);
          const topic = warned.filter((l) => l.includes('Topic.TopicName'));
          expect(topic).toHaveLength(1);
          expect(topic[0]).toContain(
            '(differs; the replacement was refused: see the state-prefix warning above)'
          );
          expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toEqual([['TopicName']]);
        }
      );

      it('denied (403): warns and the replacement proceeds, counting nothing', async () => {
        stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
        const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
        const result = await makeEngine({
          onDestructivePlan: gateOver({ kind: 'denied', error: denied, stage: 'list' }),
        }).deploy(STACK, rotatedTemplate());
        expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
        expect(result.crossPrefixKept).toBeUndefined();
      });

      it('an unrelated CdkdError from the hook fails the deploy (review R5-3)', async () => {
        stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
        const onDestructivePlan = vi.fn(async () => {
          throw new CdkdError('something else', 'SOME_OTHER_CODE');
        });
        await expect(
          makeEngine({ onDestructivePlan }).deploy(STACK, rotatedTemplate())
        ).rejects.toThrow(/Failed to update resource Topic/);
        expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      });

      it('an error that is not a refusal still fails the deploy', async () => {
        stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
        const onDestructivePlan = vi.fn(async () => {
          throw new TypeError('boom');
        });
        await expect(
          makeEngine({ onDestructivePlan }).deploy(STACK, rotatedTemplate())
        ).rejects.toThrow();
        expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      });
    });

    it('asks nothing under --require-approval=never, even with an approver', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      const approveDeployment = vi.fn(async () => false);
      await makeEngine({ requireApproval: 'never', approveDeployment }).deploy(
        STACK,
        rotatedTemplate()
      );
      expect(approveDeployment).not.toHaveBeenCalled();
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
    });

    it('an `add` verdict on another physical resource replaces, never unions, and a create readback starts afresh', async () => {
      const engine = makeEngine() as unknown as {
        noteNoEchoExactEchoes: (...args: unknown[]) => void;
        establishNoEchoEchoFidelity: (...args: unknown[]) => Promise<void>;
        noEchoExactEchoes: Map<string, { physicalId: string; coordinates: string[][] }>;
      };
      const handed = { TopicName: '***', DisplayName: '***' };
      const both = [
        { coordinate: ['TopicName'], plaintext: TOPIC },
        { coordinate: ['DisplayName'], plaintext: 'd' },
      ];
      engine.noteNoEchoExactEchoes('Topic', 'old', { live: { TopicName: TOPIC } }, handed, both, 'add');
      engine.noteNoEchoExactEchoes('Topic', 'new', { live: { DisplayName: 'd' } }, handed, both, 'add');
      expect(engine.noEchoExactEchoes.get('Topic')).toEqual({
        physicalId: 'new',
        coordinates: [['DisplayName']],
      });
      // No template bag for the id: nothing to judge, and nothing noted survives.
      await engine.establishNoEchoEchoFidelity('Topic', v11State().resources['Topic'], {}, {}, new Map());
      expect(engine.noEchoExactEchoes.has('Topic')).toBe(false);
    });

    it('asks ONCE per resource, however many of its paths proved a change, and one "no" keeps all of them', async () => {
      const state = v11State();
      state.resources['Role'] = {
        physicalId: 'old-role',
        resourceType: 'AWS::IAM::Role',
        properties: { RoleName: '***', Path: '***', AssumeRolePolicyDocument: {} },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['Path'], ['RoleName']],
        noEchoExactEchoLeaves: [['Path'], ['RoleName']],
        constructPath: 'Stack/Role/Resource',
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === 'old-role'
            ? { RoleName: 'old-role', Path: '/old/', AssumeRolePolicyDocument: {} }
            : physicalId === TOPIC_ARN
              ? { TopicName: TOPIC, DisplayName: 'd' }
              : { Name: '/app/p', Type: 'String', Value: TOKEN }
        )
      );
      const tpl = template(TOKEN, {
        Role: {
          Type: 'AWS::IAM::Role',
          Properties: {
            RoleName: { Ref: 'RName' },
            Path: { Ref: 'RPath' },
            AssumeRolePolicyDocument: {},
          },
        },
      });
      tpl.Parameters!['RName'] = { Type: 'String', NoEcho: true, Default: 'new-role-name' };
      tpl.Parameters!['RPath'] = { Type: 'String', NoEcho: true, Default: '/new-path/' };
      const approveDeployment = vi.fn(async () => false);
      await makeEngine({ requireApproval: 'destructive', approveDeployment }).deploy(STACK, tpl);
      expect(approveDeployment).toHaveBeenCalledTimes(1);
      // No template metadata: the prompt names the RECORD's construct path.
      const asked = (approveDeployment.mock.calls[0] as unknown[])[0] as {
        destructiveChanges: { constructPath?: string }[];
      };
      expect(asked.destructiveChanges[0]?.constructPath).toBe('Stack/Role/Resource');
      expect(callsFor(provider.create, 'Role')).toHaveLength(0);
      const warned = lines(logger.warn).filter((l) => l.startsWith('Role.'));
      expect(warned).toHaveLength(2);
      for (const line of warned) expect(line).toContain('the replacement was not approved');
    });

    it('asks nothing more when another path replaces the resource anyway, and says nothing is kept', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      // Yes to the up-front prompt (it covers the template's create-only edit),
      // no to anything after it.
      let asked = 0;
      const approveDeployment = vi.fn(async () => ++asked === 1);
      const tpl = rotatedTemplate();
      (tpl.Resources['Topic']!.Properties as Record<string, unknown>)['FifoTopic'] = true;
      await makeEngine({ requireApproval: 'destructive', approveDeployment }).deploy(STACK, tpl);
      expect(approveDeployment).toHaveBeenCalledTimes(1);
      const creates = callsFor(provider.create, 'Topic');
      expect(creates).toHaveLength(1);
      // The rotated value reaches the new resource.
      expect((creates[0]![2] as Record<string, unknown>)['TopicName']).toBe(ROTATED);
      expect(lines(logger.warn).some((l) => l.includes('the replacement was not approved'))).toBe(
        false
      );
    });

    it('asks nothing for a --recreate-via-cc-api target, which is replaced anyway', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      // The flag's own question is never reached, so a "no" changes nothing.
      const approveDeployment = vi.fn(async () => false);
      await makeEngine({
        requireApproval: 'destructive',
        approveDeployment,
        recreateTargets: { stackName: STACK, viaCcApi: new Set(['Topic']), viaSdkProvider: new Set() },
      }).deploy(STACK, rotatedTemplate());
      expect(approveDeployment).not.toHaveBeenCalled();
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      expect(lines(logger.warn).some((l) => l.includes('the replacement was not approved'))).toBe(
        false
      );
    });

    it('asks nothing for a child whose re-created parent took it, which is re-created anyway', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      lostChildKnob.forType = 'AWS::SNS::Topic';
      const approveDeployment = vi.fn(async () => false);
      await makeEngine({ requireApproval: 'destructive', approveDeployment }).deploy(
        STACK,
        rotatedTemplate()
      );
      expect(approveDeployment).not.toHaveBeenCalled();
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      expect(lines(logger.warn).some((l) => l.includes('the replacement was not approved'))).toBe(
        false
      );
    });

    it('asks nothing more when another NoEcho create-only path MOVED under a replacement ceiling, which replaces anyway', async () => {
      // FifoTopic reads Dep, which this deploy replaces (its create-only name
      // changed), so the diff raises a replacement ceiling on it; its template
      // text also moved around the NoEcho value (its recorded fingerprint,
      // #4451), so the ceiling stands. TopicName's readback proves a change
      // through the flag.
      const state = exactState();
      state.resources['Topic'] = {
        ...state.resources['Topic']!,
        properties: { TopicName: '***', DisplayName: 'd', FifoTopic: '***' },
        dependencies: ['Dep'],
        noEchoLeaves: [['FifoTopic'], ['TopicName']],
        maskedPropertyFingerprints: {
          FifoTopic: maskedPropertyFingerprint({ 'Fn::Sub': '${Fifo}+${Dep}' }),
        },
      };
      state.resources['Dep'] = {
        physicalId: 'dep-old-phys',
        resourceType: 'AWS::SNS::Topic',
        properties: { TopicName: 'dep-old' },
        attributes: {},
        dependencies: [],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      const tpl = rotatedTemplate();
      tpl.Parameters!['Fifo'] = { Type: 'String', NoEcho: true, Default: 'fifo-flag-value' };
      tpl.Resources['Dep'] = { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'dep-new' } };
      (tpl.Resources['Topic']!.Properties as Record<string, unknown>)['FifoTopic'] = {
        'Fn::Sub': '${Fifo}-${Dep}',
      };
      // Yes to the up-front prompt (it covers Dep's replacement), no after it.
      let asked = 0;
      const approveDeployment = vi.fn(async () => ++asked === 1);
      await makeEngine({ requireApproval: 'destructive', approveDeployment }).deploy(STACK, tpl);
      expect(approveDeployment).toHaveBeenCalledTimes(1);
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      expect(lines(logger.warn).some((l) => l.includes('the replacement was not approved'))).toBe(
        false
      );
    });

    it('replaces once the late prompt approves (what --yes answers)', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      const approveDeployment = vi.fn(async () => true);
      await makeEngine({ requireApproval: 'any-change', approveDeployment }).deploy(
        STACK,
        rotatedTemplate()
      );
      expect(approveDeployment).toHaveBeenCalledTimes(1);
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      expect(callsFor(provider.delete, 'Topic')).toHaveLength(1);
    });

    it('F-2 (go-to-k/cdkd#4705): an answered late prompt tells the generated-name guard, as the up-front one does', async () => {
      const noteApprovalPrompted = vi.fn();
      const fakeGuard = {
        size: 0,
        noteApprovalPrompted,
        settle: vi.fn(async () => undefined),
        readoptedFromRetained: vi.fn(async () => []),
        candidate: () => undefined,
        admit: vi.fn(async () => undefined),
        noteSent: vi.fn(),
        noteReturned: vi.fn(),
        noteFailed: vi.fn(),
      };
      const start = vi
        .spyOn(GeneratedNameGuard, 'start')
        .mockReturnValue(fakeGuard as unknown as GeneratedNameGuard);
      try {
        stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
        const approveDeployment = vi.fn(async () => true);
        await makeEngine({ requireApproval: 'any-change', approveDeployment }).deploy(
          STACK,
          rotatedTemplate()
        );
        // The one question asked was the late one (the diff showed no change).
        expect(approveDeployment).toHaveBeenCalledTimes(1);
        expect(noteApprovalPrompted).toHaveBeenCalledTimes(1);
      } finally {
        start.mockRestore();
      }
    });

    it('keeps the resource when the late prompt cannot be asked (no terminal), and the deploy goes on', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      const approveDeployment = vi.fn(async () => {
        throw new Error('stdin is not interactive');
      });
      await makeEngine({ requireApproval: 'destructive', approveDeployment }).deploy(
        STACK,
        rotatedTemplate()
      );
      expect(callsFor(provider.create, 'Topic')).toHaveLength(0);
      expect(lines(logger.warn).some((l) => l.includes('the replacement was not approved'))).toBe(
        true
      );
    });

    it('never applies a verdict on one physical resource to a record of another (a rollback restoring the old record)', () => {
      const engine = makeEngine() as unknown as {
        noteNoEchoExactEchoes: (...args: unknown[]) => void;
        withNoEchoExactEchoes: (id: string, record: ResourceState) => ResourceState;
      };
      engine.noteNoEchoExactEchoes(
        'Topic',
        `${TOPIC_ARN}-new`,
        { live: { TopicName: TOPIC } },
        { TopicName: '***' },
        [{ coordinate: ['TopicName'], plaintext: TOPIC }],
        'set'
      );
      const old = v11State().resources['Topic']!;
      expect(engine.withNoEchoExactEchoes('Topic', old).noEchoExactEchoLeaves).toBeUndefined();
      expect(
        engine.withNoEchoExactEchoes('Topic', { ...old, physicalId: `${TOPIC_ARN}-new` })
          .noEchoExactEchoLeaves
      ).toEqual([['TopicName']]);
    });

    it('a replacement whose own readback fails keeps no flag, though the migration read of the old resource was exact', async () => {
      const state = v10State();
      state.resources['Topic']!.properties['FifoTopic'] = false;
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      let topicRead = 0;
      provider.readCurrentState.mockImplementation((physicalId: string) => {
        if (!physicalId.startsWith('arn:aws:sns:')) {
          return Promise.resolve({ Name: '/app/p', Type: 'String', Value: TOKEN });
        }
        topicRead++;
        return topicRead === 1
          ? Promise.resolve({ TopicName: TOPIC, DisplayName: 'd' })
          : Promise.reject(new Error('throttled'));
      });
      provider.create.mockImplementation((logicalId: string) =>
        Promise.resolve({
          physicalId: logicalId === 'Topic' ? `${TOPIC_ARN}-v2` : `${logicalId}-phys`,
          attributes: {},
        })
      );
      const tpl = template();
      (tpl.Resources['Topic']!.Properties as Record<string, unknown>)['FifoTopic'] = true;
      await makeEngine().deploy(STACK, tpl);
      expect(callsFor(provider.create, 'Topic')).toHaveLength(1);
      expect(topicRead).toBe(2);
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toBeUndefined();
    });

    it('a replacement the flag proves still meets the stateful guard', async () => {
      const state = v11State();
      state.resources['Named'] = {
        physicalId: '/app/old-name',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '***', Type: 'String', Value: 'v' },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['Name']],
        noEchoExactEchoLeaves: [['Name']],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN
            ? { TopicName: TOPIC, DisplayName: 'd' }
            : physicalId === '/app/old-name'
              ? { Name: '/app/old-name', Type: 'String', Value: 'v' }
              : { Name: '/app/p', Type: 'String', Value: TOKEN }
        )
      );
      const tpl = template(TOKEN, {
        Named: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: { Ref: 'PName' }, Type: 'String', Value: 'v' },
        },
      });
      tpl.Parameters!['PName'] = { Type: 'String', NoEcho: true, Default: '/app/new-name' };
      const error = await makeEngine()
        .deploy(STACK, tpl)
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(error).toBeDefined();
      const text = String(error) + lines(logger.error).join('\n');
      expect(text).toContain('it is a stateful resource');
      expect(callsFor(provider.create, 'Named')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Named')).toHaveLength(0);
    });

    it('a readback that cannot report the property leaves the flag as it was, carried through an in-place update', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      provider.readCurrentState.mockImplementation((physicalId: string) =>
        Promise.resolve(
          physicalId === TOPIC_ARN ? { DisplayName: 'd' } : { Name: '/app/p', Value: TOKEN }
        )
      );
      const tpl = template();
      (tpl.Resources['Topic']!.Properties as Record<string, unknown>)['DisplayName'] = 'd2';
      await makeEngine().deploy(STACK, tpl);
      expect(callsFor(provider.update, 'Topic')).toHaveLength(1);
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toEqual([['TopicName']]);
    });

    it('an update the provider turned into a replacement keeps no flag', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      provider.update.mockImplementation((logicalId: string, physicalId: string) =>
        Promise.resolve(
          logicalId === 'Topic'
            ? { physicalId: `${TOPIC_ARN}-new`, wasReplaced: true }
            : { physicalId, wasReplaced: false }
        )
      );
      const tpl = template();
      (tpl.Resources['Topic']!.Properties as Record<string, unknown>)['DisplayName'] = 'd2';
      await makeEngine().deploy(STACK, tpl);
      expect(callsFor(provider.update, 'Topic')).toHaveLength(1);
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toBeUndefined();
    });

    it('an in-place update of the same resource keeps the flag; the save drops an entry no longer marked', async () => {
      stateBackend.getState.mockResolvedValue({ state: exactState(), etag: 'etag-old' });
      const tpl = template();
      (tpl.Resources['Topic']!.Properties as Record<string, unknown>)['DisplayName'] = 'd2';
      await makeEngine().deploy(STACK, tpl);
      expect(callsFor(provider.update, 'Topic')).toHaveLength(1);
      expect(lastSaved().resources['Topic']!.noEchoExactEchoLeaves).toEqual([['TopicName']]);

      // The save keeps only entries the record still marks.
      const engine = makeEngine() as unknown as Record<string, unknown> & {
        applyNoEchoPersist: (...args: unknown[]) => ResourceState;
      };
      engine['constructPathTemplate'] = template();
      const record: ResourceState = {
        physicalId: TOPIC_ARN,
        resourceType: 'AWS::SNS::Topic',
        properties: { TopicName: '***', DisplayName: 'd' },
        noEchoLeaves: [['TopicName']],
        noEchoExactEchoLeaves: [['TopicName'], ['DisplayName']],
      };
      expect(
        engine.applyNoEchoPersist('Topic', record, record, undefined, {}).noEchoExactEchoLeaves
      ).toEqual([['TopicName']]);
      const unmarked = { ...record, noEchoLeaves: [['Other']] };
      expect(
        engine.applyNoEchoPersist('Topic', unmarked, unmarked, undefined, {}).noEchoExactEchoLeaves
      ).toBeUndefined();
    });

    it('reads a malformed field as absent, and judges only whole string leaves under a create-only path by object keys', async () => {
      const { noEchoExactEchoLeavesOf, echoFidelityCandidates, echoesExactlyAt, provesEchoChangeAt } =
        await import('../../../src/deployment/deploy-engine/noecho.js');
      // Only a readback HANDED the mask at the coordinate reports anything: one
      // handed a plaintext (or anything else) may have projected it.
      const candidate = { coordinate: ['A', 'B'], plaintext: 'v-1234' };
      const masked = { A: { B: '***' } };
      expect(echoesExactlyAt({ A: { B: 'v-1234' } }, masked, candidate)).toBe(true);
      expect(echoesExactlyAt({ A: { B: 'v-1234' } }, { A: { B: 'v-1234' } }, candidate)).toBe(false);
      expect(echoesExactlyAt({ A: { B: 'V-1234' } }, masked, candidate)).toBe(false);
      expect(provesEchoChangeAt({ A: { B: 'w-1234' } }, masked, candidate)).toBe(true);
      expect(provesEchoChangeAt({ A: { B: 'w-1234' } }, { A: { B: 'x' } }, candidate)).toBe(false);
      expect(provesEchoChangeAt({ A: { B: '***' } }, masked, candidate)).toBe(false);
      expect(provesEchoChangeAt({ A: { B: 7 } }, masked, candidate)).toBe(false);
      expect(provesEchoChangeAt({ A: {} }, masked, candidate)).toBe(false);
      expect(noEchoExactEchoLeavesOf({ noEchoExactEchoLeaves: [['A'], ['B', 0]] })).toBeUndefined();
      expect(noEchoExactEchoLeavesOf({ noEchoExactEchoLeaves: [[]] })).toBeUndefined();
      expect(noEchoExactEchoLeavesOf({ noEchoExactEchoLeaves: 'A' })).toBeUndefined();
      expect(noEchoExactEchoLeavesOf({ noEchoExactEchoLeaves: [['A', 'b']] })).toEqual([['A', 'b']]);
      const resolved = {
        Name: 'n-1234',
        List: ['a-1234', 'b-1234'],
        Nested: { Key: 'k-1234' },
        Port: 7,
        Masked: '***',
        Updatable: 'u-1234',
      };
      const createOnly = [['Name'], ['List'], ['Nested'], ['Port'], ['Masked']];
      expect(
        echoFidelityCandidates(
          [['Name'], ['List'], ['List', 0], ['Nested', 'Key'], ['Port'], ['Masked'], ['Updatable']],
          resolved,
          createOnly
        )
      ).toEqual([
        { coordinate: ['Name'], plaintext: 'n-1234' },
        { coordinate: ['Nested', 'Key'], plaintext: 'k-1234' },
      ]);
    });
  });
});

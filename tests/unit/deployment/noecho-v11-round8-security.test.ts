/**
 * PR #4661 round 8, security items 1 and 3 (go-to-k/cdkd#4043).
 *
 * 1. A NoEcho value that itself starts with `arn:`, echoed by an attribute
 *    (SSM `Value`), is DECLARED and its same-stack `Fn::GetAtt` reader masked.
 * 3. A NoEcho output recovered cross-stack in the same run is masked in the
 *    consumer's bag by the VALUE arm only: from 4 characters (pinned below);
 *    a shorter or numeric value is a documented bound.
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

import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  clearRecoverableMaskedOutputs,
  recordRecoverableMaskedOutput,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../../src/utils/ambient-client-defaults.js';

const ARN_TOKEN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod-db-AbCdEf';

describe('round 8 SECURITY 1: a NoEcho value that is an ARN, echoed by an attribute', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn((logicalId: string, _type: string, properties: Record<string, unknown>) =>
        Promise.resolve(
          logicalId === 'Param'
            ? { physicalId: '/app/p', attributes: { Value: properties['Value'], Type: 'String' } }
            : { physicalId: `/app/${logicalId}`, attributes: {} }
        )
      ),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('declares the echoed attribute and masks the same-stack GetAtt reader', async () => {
    const engine = new DeployEngine(
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
      { dryRun: false, captureObservedState: false },
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
    await engine.deploy(STACK, {
      Parameters: { Token: { Type: 'String', NoEcho: true, Default: ARN_TOKEN } },
      Resources: {
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/p', Type: 'String', Value: { Ref: 'Token' } },
        },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/r', Type: 'String', Value: { 'Fn::GetAtt': ['Param', 'Value'] } },
        },
      },
    } as CloudFormationTemplate);

    // The reader really received the ARN on the wire.
    const readerCreate = provider.create.mock.calls.find((c) => c[0] === 'Reader');
    expect((readerCreate![2] as Record<string, unknown>)['Value']).toBe(ARN_TOKEN);
    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Param']!.noEchoAttributeNames).toEqual(['Value']);
    expect(saved.resources['Param']!.attributes?.['Value']).toBe('***');
    expect(saved.resources['Reader']!.properties['Value']).toBe('***');
    expect(saved.resources['Reader']!.noEchoLeaves).toEqual([['Value']]);
    expect(JSON.stringify(stateBackend.saveState.mock.calls)).not.toContain(ARN_TOKEN);
  });
});

describe('round 8 SECURITY 3: a NoEcho output recovered cross-stack in the same run', () => {
  const identity = (): string => credentialFingerprint(ambientCredentialConfig());
  function backend(): S3StateBackend {
    return {
      listStacks: vi.fn(async () => [{ stackName: 'Producer', region: 'us-east-1' }]),
      getState: vi.fn(async () => ({
        state: {
          version: 11,
          stackName: 'Producer',
          region: 'us-east-1',
          resources: {},
          outputs: { Token: '***' },
          lastModified: 1,
        },
        etag: 'e',
      })),
    } as unknown as S3StateBackend;
  }
  async function recover(plaintext: unknown): Promise<{ value: unknown; bag: RecordedSecretValues }> {
    clearRecoverableMaskedOutputs();
    recordRecoverableMaskedOutput(identity(), 'Producer', 'us-east-1', 'Token', plaintext);
    const bag: RecordedSecretValues = new Map();
    const value = await new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::ImportValue': 'Token' },
      {
        template: { Resources: {} },
        resources: {},
        stackName: 'Consumer',
        stateBackend: backend(),
        recordedImports: [],
        redactedAttributeReads: [],
        recordedSecretValues: bag,
      } as unknown as ResolverContext
    );
    clearRecoverableMaskedOutputs();
    return { value, bag };
  }

  it('masks a recovered value of 4 or more characters in the consumer record', async () => {
    const { value, bag } = await recover('recovered-noecho-1234');
    expect(value).toBe('recovered-noecho-1234');
    expect(redactSecretsForState({ Value: value }, bag)).toEqual({ Value: '***' });
  });

  it('PINS the bound: a 1-3 character or numeric recovered value is not masked by value (no position names an import)', async () => {
    const short = await recover('abc');
    expect(redactSecretsForState({ Value: short.value }, short.bag)).toEqual({ Value: 'abc' });
    const numeric = await recover(4321);
    expect(redactSecretsForState({ Value: numeric.value }, numeric.bag)).toEqual({ Value: 4321 });
  });
});

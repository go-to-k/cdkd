/**
 * go-to-k/cdkd#4824 (security review of PR #4830): honouring `NoEcho: "true"`
 * at every reader must not REPLACE a create-only resource on the first deploy
 * after the upgrade, with nothing changed. A record written before the change
 * is MARKED (`noEchoLeaves` from a boolean NoEcho parameter), so the migration
 * witness that reconciles a stored plaintext with `***` does not run for it.
 * Driven through `DeployEngine.deploy` with the REAL `DiffCalculator`,
 * `DagBuilder` and `IntrinsicFunctionResolver`.
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

const STACK = 'noecho-string-form-stack';
const REGION = 'us-east-1';
const TOKEN = 'tok-4824-distinctive-0001';
const TOPIC = 'topic-4824-distinctive';
const TOPIC_ARN = `arn:aws:sns:us-east-1:123456789012:${TOPIC}`;

describe('DeployEngine - honouring NoEcho "true" replaces nothing on an unchanged redeploy (go-to-k/cdkd#4824)', () => {
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
        prefetch: vi.fn().mockResolvedValue(undefined),
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

  it.each([
    // A case variant the persist arm never marked: it stays out of every arm.
    ['a case variant ("True") feeding the create-only TopicName', 'True'],
    // A control: the exact string, which the positional arm always marked.
    ['control: the exact string ("true") feeding the create-only TopicName', 'true'],
  ])('%s', async (_l, spelling) => {
    const template = {
      Parameters: {
        Token: { Type: 'String', NoEcho: true, Default: TOKEN },
        TopicName: { Type: 'String', NoEcho: spelling, Default: TOPIC },
      },
      Resources: {
        Topic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { Ref: 'TopicName' }, DisplayName: { Ref: 'Token' } },
        },
      },
    } as unknown as CloudFormationTemplate;
    stateBackend.getState.mockResolvedValue({
      state:
        spelling === 'true'
          ? markedState('***', '***', [['TopicName'], ['DisplayName']])
          : markedState(TOPIC, '***', [['DisplayName']]),
      etag: 'etag-old',
    });
    await makeEngine().deploy(STACK, template);
    expect(topicCalls(provider.create)).toBe(0);
    expect(topicCalls(provider.delete)).toBe(0);
  });

  it.each([
    // The value arm masks the string form too (#4831 lifted the boolean-only
    // gate), so the literal is a mask today and plaintext in the record. The
    // migration witness confirms it (#4836): disabled at BOTH its sites (the
    // diff's comparison and the update's skip check; either alone is covered
    // by the other), the topic is replaced.
    ['marked (another leaf already in noEchoLeaves): the witness confirms the literal (#4831)', true],
    // A record no v11 binary wrote: the same witness confirms every leaf.
    ['unmarked (no noEchoLeaves at all): the witness confirms a pre-v11 record', false],
  ])('a create-only literal EQUAL to an exact-string NoEcho value is not replaced, %s', async (_l, marked) => {
    const template = {
      Parameters: {
        Token: { Type: 'String', NoEcho: 'true', Default: TOPIC },
      },
      Resources: {
        Topic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: TOPIC, DisplayName: { Ref: 'Token' } },
        },
      },
    } as unknown as CloudFormationTemplate;
    provider.readCurrentState.mockImplementation(() =>
      Promise.resolve({ TopicName: TOPIC, DisplayName: TOPIC })
    );
    // Before the change only the positional arm marked DisplayName; the
    // literal TopicName was stored in plaintext. Unmarked: a record no v11
    // binary wrote, every leaf in plaintext and no `noEchoLeaves`.
    const state = marked
      ? markedState(TOPIC, '***', [['DisplayName']])
      : markedState(TOPIC, TOPIC, []);
    if (!marked) delete (state.resources['Topic'] as { noEchoLeaves?: unknown }).noEchoLeaves;
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    await makeEngine().deploy(STACK, template);
    expect(topicCalls(provider.create)).toBe(0);
    expect(topicCalls(provider.delete)).toBe(0);
  });
});

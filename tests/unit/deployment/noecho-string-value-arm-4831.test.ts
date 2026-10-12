/**
 * go-to-k/cdkd#4831: the VALUE arm (a fresh mask-only needle) covers a
 * parameter declared `NoEcho: "true"` (the string) as it does the boolean, so
 * a leaf that holds the value without reading the parameter by position (a
 * literal, a copy) is persisted as `***`. #4836 made the migration witness
 * cover a MARKED record, so lifting #4830's boolean-only gate replaces
 * nothing on an unchanged redeploy. Driven through `DeployEngine.deploy` with
 * the REAL `DiffCalculator`, `DagBuilder` and `IntrinsicFunctionResolver`.
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
    }),
  };
});

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'noecho-string-value-arm-stack';
const REGION = 'us-east-1';
const TOPIC = 'topic-4831-arm-distinctive';
const TOPIC_ARN = `arn:aws:sns:us-east-1:123456789012:${TOPIC}`;

describe('DeployEngine - the value arm for a string-declared NoEcho (go-to-k/cdkd#4831)', () => {
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
      readCurrentState: vi.fn(() => Promise.resolve({ TopicName: TOPIC, DisplayName: TOPIC })),
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

  /**
   * `TopicName` is a LITERAL equal to `Name`'s value: no template position
   * reads the parameter there. The resource reads `Name` elsewhere
   * (`DisplayName`), so the value is a needle of this resource's pass.
   */
  const template = (noEcho: unknown): CloudFormationTemplate =>
    ({
      Parameters: { Name: { Type: 'String', NoEcho: noEcho, Default: TOPIC } },
      Resources: {
        Topic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: TOPIC, DisplayName: { Ref: 'Name' } },
        },
      },
    }) as unknown as CloudFormationTemplate;

  const savedTopic = (): ResourceState | undefined =>
    (stateBackend.saveState.mock.calls.at(-1)?.[2] as StackState | undefined)?.resources['Topic'];

  it.each([
    ['the boolean', true],
    ['the string', 'true'],
  ])('a fresh create stores a literal copy of the value masked (%s)', async (_l, noEcho) => {
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine().deploy(STACK, template(noEcho));
    const saved = savedTopic();
    expect(saved?.properties['TopicName']).toBe('***');
    expect(JSON.stringify(saved)).not.toContain(TOPIC);
  });

  it('negative control: an ordinary parameter leaves the literal as it is', async () => {
    stateBackend.getState.mockResolvedValue(null);
    await makeEngine().deploy(STACK, template(false));
    expect(savedTopic()?.properties['TopicName']).toBe(TOPIC);
  });

  it('an unchanged redeploy of a record written before (MARKED, literal in plaintext) replaces nothing, then masks it', async () => {
    // What #4830's binary wrote for the string form: DisplayName (positional)
    // masked and marked, the literal copy left in plaintext.
    stateBackend.getState.mockResolvedValue({
      state: markedState(TOPIC, '***', [['DisplayName']]),
      etag: 'etag-old',
    });
    provider.readCurrentState.mockImplementation(() =>
      Promise.resolve({ TopicName: TOPIC, DisplayName: TOPIC })
    );
    await makeEngine().deploy(STACK, template('true'));
    expect(topicCalls(provider.create)).toBe(0);
    expect(topicCalls(provider.delete)).toBe(0);
    expect(topicCalls(provider.update)).toBe(0);
    const saved = savedTopic();
    expect(saved?.properties['TopicName']).toBe('***');
    expect(saved?.noEchoLeaves).toEqual([['DisplayName'], ['TopicName']]);
  });
});

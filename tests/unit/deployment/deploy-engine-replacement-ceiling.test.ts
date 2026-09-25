/**
 * A synthetic change's `requiresReplacement` is a CEILING (go-to-k/cdkd#3662
 * review round): the diff promotes every reader of an in-place-updated custom
 * resource (its handler's `Data` may move), and a create-only reading property
 * asks for a replacement whatever the value turns out to be. The engine lowers
 * the ceiling when the resolved value equals the record, so an unmoved value
 * never destroys and re-creates a reader that ANOTHER edit sent to the
 * provider. Driven through `DeployEngine.deploy` with the REAL `DiffCalculator`,
 * `DagBuilder` and `IntrinsicFunctionResolver`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

const STACK = 'replacement-ceiling-stack';
const REGION = 'us-east-1';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:h';

/**
 * `Reader.TopicName` (create-only for a topic, which is not a stateful type)
 * reads the CR's `Data`.
 */
function template(description: string): CloudFormationTemplate {
  return {
    Resources: {
      Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: TOKEN, Seed: 'b' } },
      Reader: {
        Type: 'AWS::SNS::Topic',
        Properties: {
          TopicName: { 'Fn::GetAtt': ['Cr', 'TopicName'] },
          DisplayName: description,
        },
      },
    },
  };
}

function priorState(): StackState {
  const reader = { TopicName: 'topic-a', DisplayName: 'd1' };
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Cr: {
        physicalId: 'cr-1',
        resourceType: 'Custom::Thing',
        properties: { ServiceToken: TOKEN, Seed: 'a' },
        attributes: { TopicName: 'topic-a' },
        dependencies: [],
      },
      Reader: {
        physicalId: 'arn:aws:sns:us-east-1:123456789012:topic-a',
        resourceType: 'AWS::SNS::Topic',
        properties: reader,
        observedProperties: reader,
        attributes: {},
        dependencies: ['Cr'],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

describe('DeployEngine - a synthetic replacement is a ceiling the resolved value can lower', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn((logicalId: string) => Promise.resolve({ physicalId: `${logicalId}-new` })),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: priorState(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function crReturns(topicName: string): void {
    provider.update.mockImplementation((logicalId: string, physicalId: string) =>
      Promise.resolve(
        logicalId === 'Cr'
          ? { physicalId, wasReplaced: false, attributes: { TopicName: topicName } }
          : { physicalId, wasReplaced: false }
      )
    );
  }

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
      } as never,
      { dryRun: false },
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

  /**
   * Every live-progress label the resource was given, in order: the one
   * `provisionResource` added, then any re-label (the slow-resource warning
   * never fires here).
   */
  const labelsFor = (id: string): string[] => [
    ...callsFor(renderer.addTask, id).map((c) => c[1] as string),
    ...callsFor(renderer.updateTaskLabel, id).map((c) => c[1] as string),
  ];

  it('updates the reader IN PLACE when the handler returned the same value and another property changed', async () => {
    crReturns('topic-a');

    await makeEngine().deploy(STACK, template('d2'));

    const updates = callsFor(provider.update, 'Reader');
    expect(updates).toHaveLength(1);
    // (logicalId, physicalId, resourceType, properties, previousProperties)
    expect((updates[0]![3] as Record<string, unknown>)['DisplayName']).toBe('d2');
    expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
    expect(callsFor(provider.delete, 'Reader')).toHaveLength(0);
    // The label narrates the in-place update, never a replacement that did
    // not happen.
    expect(labelsFor('Reader')).toEqual(['Updating Reader (AWS::SNS::Topic)']);
  });

  it('still REPLACES the reader when the handler returned a different value (the control)', async () => {
    crReturns('topic-b');

    await makeEngine().deploy(STACK, template('d2'));

    const creates = callsFor(provider.create, 'Reader');
    expect(creates).toHaveLength(1);
    expect((creates[0]![2] as Record<string, unknown>)['TopicName']).toBe('topic-b');
    expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
    // Labelled before resolution as an update, re-labelled once the moved
    // value made the ceiling stand.
    expect(labelsFor('Reader')).toEqual([
      'Updating Reader (AWS::SNS::Topic)',
      'Replacing Reader (AWS::SNS::Topic)',
    ]);
  });

  it('keeps the replacement for a fresh NoEcho value, which the masked record cannot be compared with', async () => {
    // The handler returns the SAME name, but NoEcho: the record holds `***`,
    // so "unchanged" is unknowable, and lowering would send a possibly new
    // create-only value to an in-place update the provider cannot apply.
    const state = priorState();
    state.resources['Cr']!.attributes = { TopicName: '***' };
    state.resources['Reader']!.properties = { TopicName: '***', DisplayName: 'd1' };
    state.resources['Reader']!.observedProperties = { TopicName: '***', DisplayName: 'd1' };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    provider.update.mockImplementation((logicalId: string, physicalId: string) =>
      Promise.resolve(
        logicalId === 'Cr'
          ? {
              physicalId,
              wasReplaced: false,
              attributes: { TopicName: 'topic-a' },
              noEchoAttributes: true,
            }
          : { physicalId, wasReplaced: false }
      )
    );

    await makeEngine().deploy(STACK, template('d2'));

    const creates = callsFor(provider.create, 'Reader');
    expect(creates).toHaveLength(1);
    expect((creates[0]![2] as Record<string, unknown>)['TopicName']).toBe('topic-a');
    expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
  });

  describe('a replacement-propagated change is a ceiling too', () => {
    // `Up` is REPLACED (its create-only `QueueName` changed); the reader's
    // create-only `TopicName` reads `Up.Label`, so the diff propagates the
    // replacement to it. Whether the reader must go too depends on what the
    // new `Up` reports, which only the deploy learns.
    function replacedUpstreamTemplate(): CloudFormationTemplate {
      return {
        Resources: {
          Up: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q-2' } },
          Reader: {
            Type: 'AWS::SNS::Topic',
            Properties: {
              TopicName: { 'Fn::GetAtt': ['Up', 'Label'] },
              DisplayName: 'd2',
            },
          },
        },
      };
    }

    function replacedUpstreamState(): StackState {
      const reader = { TopicName: 'label-1', DisplayName: 'd1' };
      return {
        ...priorState(),
        resources: {
          Up: {
            physicalId: 'https://sqs/q-1',
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: 'q-1' },
            attributes: { Label: 'label-1' },
            dependencies: [],
          },
          Reader: {
            physicalId: 'arn:aws:sns:us-east-1:123456789012:label-1',
            resourceType: 'AWS::SNS::Topic',
            properties: reader,
            observedProperties: reader,
            attributes: {},
            dependencies: ['Up'],
          },
        },
      };
    }

    function upCreates(label: string): void {
      provider.create.mockImplementation((logicalId: string) =>
        Promise.resolve(
          logicalId === 'Up'
            ? { physicalId: 'https://sqs/q-2', attributes: { Label: label } }
            : { physicalId: `${logicalId}-new` }
        )
      );
      provider.update.mockImplementation((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      );
    }

    it('updates the reader in place when the new upstream reports the same value', async () => {
      stateBackend.getState.mockResolvedValue({ state: replacedUpstreamState(), etag: 'e' });
      upCreates('label-1');

      await makeEngine().deploy(STACK, replacedUpstreamTemplate());

      expect(callsFor(provider.create, 'Up')).toHaveLength(1);
      expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
      const updates = callsFor(provider.update, 'Reader');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['DisplayName']).toBe('d2');
    });

    it('replaces the reader when the new upstream reports a different value', async () => {
      stateBackend.getState.mockResolvedValue({ state: replacedUpstreamState(), etag: 'e' });
      upCreates('label-2');

      await makeEngine().deploy(STACK, replacedUpstreamTemplate());

      const creates = callsFor(provider.create, 'Reader');
      expect(creates).toHaveLength(1);
      expect((creates[0]![2] as Record<string, unknown>)['TopicName']).toBe('label-2');
    });
  });

  it('skips the reader entirely when nothing else changed and the value did not move', async () => {
    crReturns('topic-a');

    await makeEngine().deploy(STACK, template('d1'));

    expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
    expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
  });
});

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
import { getLogger } from '../../../src/utils/logger.js';
import {
  clearRecoverableMaskedOutputs,
  recordRecoverableMaskedOutput,
} from '../../../src/deployment/secret-redaction.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../../src/utils/ambient-client-defaults.js';

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
      { dryRun: false, ...options },
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
  /**
   * go-to-k/cdkd#3729: a create-only path holding a `NoEcho` value supplied in
   * THIS deploy. Its record is `***`, so the record cannot say whether the value
   * moved; the engine reads the reader back from AWS and lowers the ceiling
   * only when AWS holds exactly this value there.
   */
  describe('a fresh NoEcho value in a create-only path is settled by reading the reader back', () => {
    const SECRET = 'noecho-topic-token';
    const RECORD = { TopicName: '***', DisplayName: 'd1' };
    const logger = getLogger() as unknown as Record<string, ReturnType<typeof vi.fn>>;

    function noEchoState(): StackState {
      const state = priorState();
      state.resources['Cr']!.attributes = { TopicName: '***' };
      state.resources['Reader']!.properties = { ...RECORD };
      state.resources['Reader']!.observedProperties = { ...RECORD };
      return state;
    }

    beforeEach(() => {
      stateBackend.getState.mockResolvedValue({ state: noEchoState(), etag: 'etag-old' });
      provider.update.mockImplementation((logicalId: string, physicalId: string) =>
        Promise.resolve(
          logicalId === 'Cr'
            ? {
                physicalId,
                wasReplaced: false,
                attributes: { TopicName: SECRET },
                noEchoAttributes: true,
              }
            : { physicalId, wasReplaced: false }
        )
      );
    });

    // `captureObservedState: false` throughout: the post-update capture would
    // call `readCurrentState` too, and this read must not depend on that flag.
    const deploy = (description: string): Promise<unknown> =>
      makeEngine({ captureObservedState: false }).deploy(STACK, template(description));

    const debugLines = (): string[] => logger['debug']!.mock.calls.map((c) => String(c[0]));
    const everyLogArg = (): string =>
      JSON.stringify(
        ['debug', 'info', 'warn', 'error'].flatMap((level) => logger[level]!.mock.calls)
      );

    function expectReplaced(reason: string): void {
      const creates = callsFor(provider.create, 'Reader');
      expect(creates).toHaveLength(1);
      expect((creates[0]![2] as Record<string, unknown>)['TopicName']).toBe(SECRET);
      expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
      expect(debugLines()).toContain(
        `Reader.TopicName carries a NoEcho value that AWS could not confirm unchanged (${reason}): replacement kept.`
      );
    }

    it('updates the reader IN PLACE when AWS already holds the value', async () => {
      provider.readCurrentState.mockResolvedValue({ TopicName: SECRET, DisplayName: 'd1' });

      await deploy('d2');

      const updates = callsFor(provider.update, 'Reader');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['TopicName']).toBe(SECRET);
      // The previous side carries the confirmed value, not the record's `***`:
      // a provider diffing `***` against it would see a create-only change and
      // re-create inside its own update() (ACM, IAM ManagedPolicy).
      expect(updates[0]![4]).toEqual({ TopicName: SECRET, DisplayName: 'd1' });
      expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Reader')).toHaveLength(0);
      expect(labelsFor('Reader')).toEqual(['Updating Reader (AWS::SNS::Topic)']);
      expect(debugLines()).toContain(
        'Reader.TopicName carries a NoEcho value AWS already holds: not replaced.'
      );
      // Once, and routed by the RECORD.
      expect(provider.readCurrentState).toHaveBeenCalledTimes(1);
      expect(provider.readCurrentState.mock.calls[0]!.slice(0, 3)).toEqual([
        'arn:aws:sns:us-east-1:123456789012:topic-a',
        'Reader',
        'AWS::SNS::Topic',
      ]);
      // The record is persisted masked as before.
      const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
      expect(saved.resources['Reader']?.properties['TopicName']).toBe('***');
      expect(JSON.stringify(saved)).not.toContain(SECRET);
    });

    it('still REPLACES the reader when AWS holds a different value (the control)', async () => {
      provider.readCurrentState.mockResolvedValue({ TopicName: 'noecho-topic-old', DisplayName: 'd1' });

      await deploy('d2');

      expectReplaced('differs');
      expect(labelsFor('Reader')).toEqual([
        'Updating Reader (AWS::SNS::Topic)',
        'Replacing Reader (AWS::SNS::Topic)',
      ]);
    });

    it('hands the provider the MASKED record, so an echoing readback can never confirm', async () => {
      // A provider that returns its `properties` argument for what AWS does
      // not report. Given the resolved bag it would echo the plaintext and
      // "confirm" a value AWS was never asked about.
      provider.readCurrentState.mockImplementation(
        (_p: string, _l: string, _t: string, properties: Record<string, unknown>) =>
          Promise.resolve({ ...properties })
      );

      await deploy('d2');

      expect(provider.readCurrentState).toHaveBeenCalledTimes(1);
      expect(provider.readCurrentState.mock.calls[0]![3]).toEqual(RECORD);
      expectReplaced('differs');
    });

    it.each([
      ['the provider has no readCurrentState', () => delete (provider as Record<string, unknown>)['readCurrentState']],
      ['the readback is undefined', () => provider.readCurrentState.mockResolvedValue(undefined)],
      ['the readback omits the property', () => provider.readCurrentState.mockResolvedValue({ DisplayName: 'd1' })],
    ])('keeps the replacement when %s (not-readable)', async (_name, arrange) => {
      arrange();

      await deploy('d2');

      expectReplaced('not-readable');
    });

    it.each([
      ['a non-string', { TopicName: 42 }],
      ['a container', { TopicName: [SECRET] }],
    ])('keeps the replacement when the readback holds %s there (differs)', async (_name, live) => {
      provider.readCurrentState.mockResolvedValue(live);

      await deploy('d2');

      expectReplaced('differs');
    });

    it.each([
      [
        'rejects with an Error echoing the value',
        () =>
          provider.readCurrentState.mockRejectedValue(
            Object.assign(new Error(`topic ${SECRET} is unreadable`), { name: 'ThrottlingException' })
          ),
      ],
      [
        'rejects with an Error whose getters throw',
        () => {
          const hostile = new Error('x');
          Object.defineProperty(hostile, 'message', {
            get: () => {
              throw new Error(`getter ${SECRET}`);
            },
          });
          Object.defineProperty(hostile, 'name', {
            get: () => {
              throw new Error(`getter ${SECRET}`);
            },
          });
          provider.readCurrentState.mockRejectedValue(hostile);
        },
      ],
      [
        'throws a non-Error synchronously',
        () =>
          provider.readCurrentState.mockImplementation(() => {
            throw `raw ${SECRET}`;
          }),
      ],
    ])('keeps the replacement when the readback %s (read-failed), and logs no value', async (_name, arrange) => {
      arrange();

      await deploy('d2');

      expectReplaced('read-failed');
      expect(everyLogArg()).not.toContain(SECRET);
    });

    it('keeps the replacement when the readback outlives its cap (read-failed)', async () => {
      provider.readCurrentState.mockImplementation(() => new Promise(() => undefined));
      const engine = makeEngine({ captureObservedState: false });
      (engine as unknown as { noEchoCeilingReadbackTimeoutMs: number }).noEchoCeilingReadbackTimeoutMs = 20;

      await engine.deploy(STACK, template('d2'));

      expectReplaced('read-failed');
    });

    it('does not read at all for a ceiling over a plain value', async () => {
      stateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      crReturns('topic-a');

      await deploy('d2');

      expect(provider.readCurrentState).not.toHaveBeenCalled();
      expect(callsFor(provider.update, 'Reader')).toHaveLength(1);
    });

    it('does not read at all when the reader changed only by its own edit (no ceiling)', async () => {
      stateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      const same = template('d2');
      (same.Resources['Cr']!.Properties as Record<string, unknown>)['Seed'] = 'a';

      await makeEngine({ captureObservedState: false }).deploy(STACK, same);

      expect(provider.readCurrentState).not.toHaveBeenCalled();
      expect(callsFor(provider.update, 'Reader')).toHaveLength(1);
    });

    it('SKIPS the reader when AWS holds the value and nothing else changed', async () => {
      // Nothing is left to send; an update would be redundant, and for a type
      // with no update API it would come back as the replacement avoided here.
      provider.readCurrentState.mockResolvedValue({ TopicName: SECRET, DisplayName: 'd1' });

      await deploy('d1');

      expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
      expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
      expect(callsFor(provider.delete, 'Reader')).toHaveLength(0);
      expect(debugLines()).toContain(
        'Skipping Reader: AWS already holds every NoEcho value it carries, and nothing else changed'
      );
    });

    it('still UPDATES a reader whose updatable property carries a fresh value AWS was not asked about', async () => {
      // The create-only path is confirmed, but `DisplayName` holds the same
      // fresh value and no readback vouches for it: skipping would leave AWS on
      // the old value under a green deploy (the go-to-k/cdkd#3662 class).
      const state = noEchoState();
      state.resources['Reader']!.properties = { TopicName: '***', DisplayName: '***' };
      state.resources['Reader']!.observedProperties = { TopicName: '***', DisplayName: '***' };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.readCurrentState.mockResolvedValue({ TopicName: SECRET, DisplayName: SECRET });
      const tpl = template('unused');
      (tpl.Resources['Reader']!.Properties as Record<string, unknown>)['DisplayName'] = {
        'Fn::GetAtt': ['Cr', 'TopicName'],
      };

      await makeEngine({ captureObservedState: false }).deploy(STACK, tpl);

      const updates = callsFor(provider.update, 'Reader');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['DisplayName']).toBe(SECRET);
      expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
      expect(debugLines().some((l) => l.startsWith('Skipping Reader'))).toBe(false);
    });

    it('refreshes only the metadata when a DeletionPolicy flip rides along, with no provider call', async () => {
      provider.readCurrentState.mockResolvedValue({ TopicName: SECRET, DisplayName: 'd1' });
      const tpl = template('d1');
      tpl.Resources['Reader']!.DeletionPolicy = 'Retain';

      await makeEngine({ captureObservedState: false }).deploy(STACK, tpl);

      expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
      expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
      const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
      expect(saved.resources['Reader']?.deletionPolicy).toBe('Retain');
      expect(saved.resources['Reader']?.properties['TopicName']).toBe('***');
    });

    it('never skips a --recreate-via-* target, even when AWS holds the value', async () => {
      provider.readCurrentState.mockResolvedValue({ TopicName: SECRET, DisplayName: 'd1' });

      await makeEngine({
        captureObservedState: false,
        recreateTargets: {
          stackName: STACK,
          viaCcApi: new Set<string>(),
          viaSdkProvider: new Set(['Reader']),
        },
      })
        .deploy(STACK, template('d1'))
        .catch(() => undefined);

      expect(debugLines().some((l) => l.startsWith('Skipping Reader'))).toBe(false);
      expect(callsFor(provider.create, 'Reader')).toHaveLength(1);
    });

    /**
     * A stateful reader (`AWS::DynamoDB::Table`) whose create-only
     * `KeySchema` is an array of objects: one leaf reads the NoEcho `Server`,
     * the other the ordinary `Other` (the per-attribute NoEcho arm), so a
     * masked and a plain leaf share one top-level path.
     */
    describe('a stateful reader with an object path', () => {
      function tableTemplate(): CloudFormationTemplate {
        return {
          Resources: {
            Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: TOKEN, Seed: 'b' } },
            Reader: {
              Type: 'AWS::DynamoDB::Table',
              Properties: {
                TableName: 'orders',
                BillingMode: 'PAY_PER_REQUEST',
                KeySchema: [
                  {
                    AttributeName: { 'Fn::GetAtt': ['Cr', 'Server'] },
                    KeyType: { 'Fn::GetAtt': ['Cr', 'Other'] },
                  },
                ],
              },
            },
          },
        };
      }
      const RECORDED = {
        TableName: 'orders',
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: '***', KeyType: 'HASH' }],
      };

      function arrange(keyType: string, liveName: string): void {
        const state = priorState();
        state.resources['Cr']!.attributes = { Server: '***', Other: 'HASH' };
        state.resources['Reader'] = {
          physicalId: 'orders',
          resourceType: 'AWS::DynamoDB::Table',
          properties: RECORDED,
          observedProperties: RECORDED,
          attributes: {},
          dependencies: ['Cr'],
        };
        stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
        provider.update.mockImplementation((logicalId: string, physicalId: string) =>
          Promise.resolve(
            logicalId === 'Cr'
              ? {
                  physicalId,
                  wasReplaced: false,
                  attributes: { Server: 'partition-key-secret', Other: keyType },
                  noEchoAttributeNames: ['Server'],
                }
              : { physicalId, wasReplaced: false }
          )
        );
        provider.readCurrentState.mockResolvedValue({
          TableName: 'orders',
          KeySchema: [{ AttributeName: liveName, KeyType: 'HASH' }],
        });
      }

      function expectStatefulBlock(error: unknown): void {
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        expect(cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
        expect(cause?.message).toContain('immutable property changed: KeySchema');
      }

      const run = (): Promise<unknown> =>
        makeEngine({ captureObservedState: false }).deploy(STACK, tableTemplate());

      it('is not replaced, and no STATEFUL_REPLACE_BLOCKED, when AWS holds the masked leaf', async () => {
        arrange('HASH', 'partition-key-secret');

        await run();

        expect(provider.readCurrentState).toHaveBeenCalledTimes(1);
        expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
        expect(callsFor(provider.delete, 'Reader')).toHaveLength(0);
      });

      it('stops at STATEFUL_REPLACE_BLOCKED when AWS holds a different value at the masked leaf', async () => {
        arrange('HASH', 'another-key-name');

        expectStatefulBlock(await run().then(() => undefined, (e: unknown) => e));
        expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
        expect(callsFor(provider.delete, 'Reader')).toHaveLength(0);
      });

      it('stops at STATEFUL_REPLACE_BLOCKED when the plain sibling moved, without reading AWS', async () => {
        arrange('RANGE', 'partition-key-secret');

        expectStatefulBlock(await run().then(() => undefined, (e: unknown) => e));
        // Decided by the record alone.
        expect(provider.readCurrentState).not.toHaveBeenCalled();
      });
    });
  });
});

/**
 * go-to-k/cdkd#3729, the CROSS-STACK route: a consumer's create-only
 * `Fn::ImportValue` of a masked output this process recovered. The diff calls
 * it changed only because it compares the recovered plaintext with the
 * recorded `***`, so it is not a ceiling; the engine settles it with the same
 * readback.
 */
describe('DeployEngine - a create-only consumer of a recovered NoEcho output', () => {
  const VALUE = 'recovered-token-value-3729';

  function run(live: Record<string, unknown>): Promise<Record<string, ReturnType<typeof vi.fn>>> {
    clearRecoverableMaskedOutputs();
    recordRecoverableMaskedOutput(
      credentialFingerprint(ambientCredentialConfig()),
      'Producer',
      REGION,
      'Token',
      VALUE
    );
    const reader = { TopicName: '***', DisplayName: 'd1' };
    const consumer: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: 'Consumer',
      outputs: {},
      lastModified: 0,
      resources: {
        Reader: {
          physicalId: 'arn:aws:sns:us-east-1:123456789012:t',
          resourceType: 'AWS::SNS::Topic',
          properties: reader,
          observedProperties: reader,
          attributes: {},
          dependencies: [],
        },
      },
    };
    const producer: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: 'Producer',
      outputs: { Token: '***' },
      exportNames: ['Token'],
      lastModified: 0,
      resources: {},
    };
    const provider = {
      create: vi.fn((logicalId: string) => Promise.resolve({ physicalId: `${logicalId}-new` })),
      update: vi.fn((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(live),
    };
    const backend = {
      getState: vi.fn((name: string) =>
        Promise.resolve(
          name === 'Consumer'
            ? { state: consumer, etag: 'e' }
            : name === 'Producer'
              ? { state: producer, etag: 'p' }
              : null
        )
      ),
      listStacks: vi.fn().mockResolvedValue([
        { stackName: 'Producer', region: REGION },
        { stackName: 'Consumer', region: REGION },
      ]),
      saveState: vi.fn().mockResolvedValue('e2'),
    };
    const engine = new DeployEngine(
      backend as never,
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
        lookup: vi
          .fn()
          .mockResolvedValue({ value: '***', producerStack: 'Producer', producerRegion: REGION }),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
    return engine
      .deploy('Consumer', {
        Resources: {
          Reader: {
            Type: 'AWS::SNS::Topic',
            Properties: { TopicName: { 'Fn::ImportValue': 'Token' }, DisplayName: 'd2' },
          },
        },
      })
      .then(() => provider)
      .finally(() => clearRecoverableMaskedOutputs());
  }

  const callsFor = (fn: ReturnType<typeof vi.fn>, id: string): unknown[][] =>
    fn.mock.calls.filter((c) => c[0] === id);

  beforeEach(() => vi.clearAllMocks());

  it('updates the consumer in place when AWS already holds the recovered value', async () => {
    const provider = await run({ TopicName: VALUE, DisplayName: 'd1' });

    expect(provider.readCurrentState).toHaveBeenCalledTimes(1);
    expect(callsFor(provider.update, 'Reader')).toHaveLength(1);
    expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
  });

  it('replaces the consumer when AWS holds a different value (the control)', async () => {
    const provider = await run({ TopicName: 'recovered-token-value-old', DisplayName: 'd1' });

    const creates = callsFor(provider.create, 'Reader');
    expect(creates).toHaveLength(1);
    expect((creates[0]![2] as Record<string, unknown>)['TopicName']).toBe(VALUE);
  });
});

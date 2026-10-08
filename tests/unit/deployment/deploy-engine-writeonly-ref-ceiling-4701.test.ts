/**
 * go-to-k/cdkd#4701, end to end through `DeployEngine.deploy` with the REAL
 * `DiffCalculator`, `DagBuilder` and resolver: a reader holding a REPLACED
 * resource as a plain `Ref` in a create-only property the schema also lists
 * WRITE-ONLY (`AWS::ApplicationAutoScaling::ScalingPolicy.ScalingTargetId`)
 * gets a replacement ceiling, and the engine settles it by comparing the
 * resolved value with the record, never by reading the write-only property
 * back: replaced when the value moved, updated in place when it did not.
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

vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

// The live schemas, trimmed to the top-level keys this file reads.
vi.mock('../../../src/utils/aws-clients.js', () => {
  const live: Record<string, { createOnly: string[]; writeOnly: string[] }> = {
    'AWS::ApplicationAutoScaling::ScalingPolicy': {
      createOnly: ['PolicyName', 'ScalingTargetId'],
      writeOnly: ['ScalingTargetId'],
    },
    'AWS::ApplicationAutoScaling::ScalableTarget': {
      createOnly: ['ResourceId', 'ScalableDimension', 'ServiceNamespace'],
      writeOnly: ['RoleARN'],
    },
    'AWS::DataSync::LocationS3': {
      createOnly: ['S3BucketArn', 'Subdirectory'],
      writeOnly: ['S3BucketArn'],
    },
  };
  return {
    getAwsClients: () => ({
      cloudFormation: {
        send: vi.fn((command: { input?: { TypeName?: string } }) => {
          const schema = live[command.input?.TypeName ?? ''];
          if (schema === undefined) {
            return Promise.reject(
              Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
                name: 'AccessDeniedException',
                $metadata: { httpStatusCode: 403 },
              })
            );
          }
          return Promise.resolve({
            Schema: JSON.stringify({
              createOnlyProperties: schema.createOnly.map((key) => `/properties/${key}`),
              writeOnlyProperties: schema.writeOnly.map((key) => `/properties/${key}`),
            }),
          });
        }),
      },
      sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    }),
  };
});

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'writeonly-ref-ceiling-stack';
const REGION = 'us-east-1';
const DIMENSION = 'dynamodb:table:ReadCapacityUnits';
const OLD_TARGET = `table/t-a|${DIMENSION}|dynamodb`;
const NEW_TARGET = `table/t-b|${DIMENSION}|dynamodb`;

/** The target's create-only `ResourceId` changes, so the target is replaced. */
function template(): CloudFormationTemplate {
  return {
    Resources: {
      Target: {
        Type: 'AWS::ApplicationAutoScaling::ScalableTarget',
        Properties: {
          ResourceId: 'table/t-b',
          ScalableDimension: DIMENSION,
          ServiceNamespace: 'dynamodb',
          MinCapacity: 5,
          MaxCapacity: 10,
        },
      },
      Policy: {
        Type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
        Properties: {
          PolicyName: 'p',
          PolicyType: 'TargetTrackingScaling',
          ScalingTargetId: { Ref: 'Target' },
          TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
        },
      },
    },
  };
}

function priorState(): StackState {
  const policy = {
    PolicyName: 'p',
    PolicyType: 'TargetTrackingScaling',
    ScalingTargetId: OLD_TARGET,
    TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
  };
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Target: {
        physicalId: OLD_TARGET,
        resourceType: 'AWS::ApplicationAutoScaling::ScalableTarget',
        properties: {
          ResourceId: 'table/t-a',
          ScalableDimension: DIMENSION,
          ServiceNamespace: 'dynamodb',
          MinCapacity: 5,
          MaxCapacity: 10,
        },
        attributes: {},
        dependencies: [],
      },
      Policy: {
        physicalId: `arn:aws:autoscaling:us-east-1:123456789012:scalingPolicy:x|${DIMENSION}`,
        resourceType: 'AWS::ApplicationAutoScaling::ScalingPolicy',
        properties: policy,
        observedProperties: policy,
        attributes: {},
        dependencies: ['Target'],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

describe('DeployEngine - a write-only create-only plain reference to a replaced resource (go-to-k/cdkd#4701)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn(),
      update: vi.fn((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: priorState(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  /** The new target comes back under `targetId`. */
  function targetCreatesAs(targetId: string): void {
    provider.create.mockImplementation((logicalId: string) =>
      Promise.resolve({ physicalId: logicalId === 'Target' ? targetId : `${logicalId}-new` })
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
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' }),
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

  it('REPLACES the policy onto the new target when the target id moved', async () => {
    targetCreatesAs(NEW_TARGET);

    await makeEngine().deploy(STACK, template());

    const creates = callsFor(provider.create, 'Policy');
    expect(creates).toHaveLength(1);
    // (logicalId, resourceType, properties)
    expect((creates[0]![2] as Record<string, unknown>)['ScalingTargetId']).toBe(NEW_TARGET);
    expect(callsFor(provider.update, 'Policy')).toHaveLength(0);
  });

  /**
   * The lowering itself, on a write-only key: `Up` is replaced (its
   * create-only `QueueName` changed), and the location reads `Up.Label`
   * through a plain `Fn::GetAtt`. Whether the location must go too depends on
   * what the new `Up` reports.
   */
  describe('a plain Fn::GetAtt whose value the new upstream may or may not move', () => {
    const LOCATION_S3 = 'AWS::DataSync::LocationS3';
    function locationTemplate(): CloudFormationTemplate {
      return {
        Resources: {
          Up: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q-2' } },
          Location: {
            Type: LOCATION_S3,
            Properties: {
              S3BucketArn: { 'Fn::GetAtt': ['Up', 'Label'] },
              S3Config: { BucketAccessRoleArn: 'arn:role' },
              Tags: [{ Key: 'k', Value: 'v2' }],
            },
          },
        },
      };
    }
    function locationState(): StackState {
      const location = {
        S3BucketArn: 'label-1',
        S3Config: { BucketAccessRoleArn: 'arn:role' },
        Tags: [{ Key: 'k', Value: 'v1' }],
      };
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
          Location: {
            physicalId: 'arn:aws:datasync:us-east-1:123456789012:location/loc-1',
            resourceType: LOCATION_S3,
            properties: location,
            observedProperties: location,
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
    }

    it('updates the location IN PLACE when the new upstream reports the same value', async () => {
      stateBackend.getState.mockResolvedValue({ state: locationState(), etag: 'e' });
      upCreates('label-1');

      await makeEngine().deploy(STACK, locationTemplate());

      expect(callsFor(provider.create, 'Up')).toHaveLength(1);
      expect(callsFor(provider.create, 'Location')).toHaveLength(0);
      const updates = callsFor(provider.update, 'Location');
      expect(updates).toHaveLength(1);
      expect((updates[0]![3] as Record<string, unknown>)['Tags']).toEqual([
        { Key: 'k', Value: 'v2' },
      ]);
    });

    it('REPLACES it when the new upstream reports a different value (the control)', async () => {
      stateBackend.getState.mockResolvedValue({ state: locationState(), etag: 'e' });
      upCreates('label-2');

      await makeEngine().deploy(STACK, locationTemplate());

      const creates = callsFor(provider.create, 'Location');
      expect(creates).toHaveLength(1);
      expect((creates[0]![2] as Record<string, unknown>)['S3BucketArn']).toBe('label-2');
      expect(callsFor(provider.update, 'Location')).toHaveLength(0);
    });
  });
});

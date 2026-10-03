import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreatePipeCommand,
  UpdatePipeCommand,
  DeletePipeCommand,
  DescribePipeCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
} from '@aws-sdk/client-pipes';

const mockSend = vi.fn();
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));

vi.mock('@aws-sdk/client-pipes', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-pipes')>('@aws-sdk/client-pipes');
  return {
    ...actual,
    PipesClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    })),
  };
});

const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));
childLogger.child.mockReturnValue(childLogger);

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// The #4275 masker arm reads create-only paths; serve the committed snapshot
// rather than a DescribeType call.
vi.mock('../../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/provisioning/create-only-properties.js')
  >('../../../../src/provisioning/create-only-properties.js');
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    ...actual,
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

import {
  PipesPipeProvider,
  toUpdateSourceParameters,
} from '../../../../src/provisioning/providers/pipes-provider.js';
import { withStackName } from '../../../../src/provisioning/resource-name.js';
import {
  ProviderRegistry,
  STICKY_CC_MIGRATION_EXEMPT,
} from '../../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../../src/provisioning/register-providers.js';
import { ResourceUpdateNotSupportedError } from '../../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';
import { RESOURCE_NOT_FOUND } from '../../../../src/types/resource.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../../src/provisioning/interrupt-watch.js';
import {
  clearResolvedResourceTimeouts,
  setResolvedResourceTimeouts,
} from '../../../../src/provisioning/resource-timeout-registry.js';

const TYPE = 'AWS::Pipes::Pipe';
const NAME = 'my-pipe';
const ARN = `arn:aws:pipes:us-east-1:123456789012:pipe/${NAME}`;
const CREATED = new Date('2026-10-01T00:00:00.000Z');
const MODIFIED = new Date('2026-10-02T00:00:00.000Z');

/** A settled DescribePipe answer. */
function described(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Name: NAME,
    Arn: ARN,
    CurrentState: 'RUNNING',
    DesiredState: 'RUNNING',
    CreationTime: CREATED,
    LastModifiedTime: MODIFIED,
    Source: 'arn:aws:kinesis:us-east-1:123456789012:stream/src',
    Target: 'arn:aws:sqs:us-east-1:123456789012:tgt',
    RoleArn: 'arn:aws:iam::123456789012:role/r',
    ...overrides,
  };
}

/** Route each command class to a handler; anything else fails the test. */
function route(handlers: Partial<Record<string, (input: any) => unknown>>): void {
  mockSend.mockImplementation(async (command: { constructor: { name: string }; input: any }) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw new Error(`unexpected ${command.constructor.name}`);
    return handler(command.input);
  });
}

function sent<T>(cls: new (...args: any[]) => T): Array<{ input: any }> {
  return mockSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof cls);
}

const noSleep = (): Promise<void> => Promise.resolve();

const KINESIS_PREVIOUS = {
  Name: NAME,
  RoleArn: 'arn:aws:iam::123456789012:role/r',
  Source: 'arn:aws:kinesis:us-east-1:123456789012:stream/src',
  Target: 'arn:aws:sqs:us-east-1:123456789012:tgt',
  DesiredState: 'STOPPED',
  Description: 'v1',
  SourceParameters: { KinesisStreamParameters: { StartingPosition: 'LATEST', BatchSize: 10 } },
};

beforeEach(() => {
  mockSend.mockReset();
  childLogger.warn.mockReset();
  clientRegion.value = 'us-east-1';
});

describe('toUpdateSourceParameters (issue #4423)', () => {
  it('keeps a Kinesis block’s mutable members and drops the create-only StartingPosition', () => {
    expect(
      toUpdateSourceParameters(
        {
          KinesisStreamParameters: {
            StartingPosition: 'AT_TIMESTAMP',
            StartingPositionTimestamp: '2026-01-01T00:00:00Z',
            BatchSize: 20,
            MaximumRetryAttempts: 3,
          },
        },
        { KinesisStreamParameters: { StartingPosition: 'AT_TIMESTAMP', BatchSize: 10 } }
      )
    ).toEqual({ KinesisStreamParameters: { BatchSize: 20, MaximumRetryAttempts: 3 } });
  });

  // Every create-only path the CFn schema lists under SourceParameters, by block.
  const CREATE_ONLY: Record<string, string[]> = {
    DynamoDBStreamParameters: ['StartingPosition'],
    KinesisStreamParameters: ['StartingPosition', 'StartingPositionTimestamp'],
    ActiveMQBrokerParameters: ['QueueName'],
    RabbitMQBrokerParameters: ['QueueName', 'VirtualHost'],
    ManagedStreamingKafkaParameters: ['TopicName', 'StartingPosition', 'ConsumerGroupID'],
    SelfManagedKafkaParameters: [
      'TopicName',
      'StartingPosition',
      'AdditionalBootstrapServers',
      'ConsumerGroupID',
    ],
  };
  for (const [block, createOnly] of Object.entries(CREATE_ONLY)) {
    it(`${block}: sends BatchSize and none of ${createOnly.join(', ')}`, () => {
      const desired = { [block]: { BatchSize: 7, ...Object.fromEntries(createOnly.map((k) => [k, 'x'])) } };
      expect(toUpdateSourceParameters(desired, desired)).toEqual({ [block]: { BatchSize: 7 } });
    });
  }

  it('sends a block the template dropped EMPTY, so AWS resets it to the system defaults', () => {
    expect(
      toUpdateSourceParameters(undefined, { SqsQueueParameters: { BatchSize: 5 } })
    ).toEqual({ SqsQueueParameters: {} });
  });

  it('removes a dropped FilterCriteria with the documented empty filter list', () => {
    const filter = { Filters: [{ Pattern: '{"a":[1]}' }] };
    expect(
      toUpdateSourceParameters({ SqsQueueParameters: { BatchSize: 1 } }, { FilterCriteria: filter })
    ).toEqual({ FilterCriteria: { Filters: [] }, SqsQueueParameters: { BatchSize: 1 } });
    expect(toUpdateSourceParameters({ FilterCriteria: filter }, {})).toEqual({
      FilterCriteria: filter,
    });
  });

  it('is undefined when neither side declares SourceParameters', () => {
    expect(toUpdateSourceParameters(undefined, undefined)).toBeUndefined();
  });
});

describe('PipesPipeProvider.update', () => {
  it('changes a Kinesis BatchSize in place through UpdatePipe, without StartingPosition (issue #4423)', async () => {
    const states = ['UPDATING', 'STOPPED'];
    route({
      UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }),
      DescribePipeCommand: () => described({ CurrentState: states.shift() ?? 'STOPPED' }),
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const desired = {
      ...KINESIS_PREVIOUS,
      SourceParameters: { KinesisStreamParameters: { StartingPosition: 'LATEST', BatchSize: 20 } },
    };

    const result = await provider.update('Pipe', NAME, TYPE, desired, KINESIS_PREVIOUS);

    const [update] = sent(UpdatePipeCommand);
    expect(update!.input.Name).toBe(NAME);
    expect(update!.input.SourceParameters).toEqual({ KinesisStreamParameters: { BatchSize: 20 } });
    expect(update!.input.DesiredState).toBe('STOPPED');
    expect(sent(DescribePipeCommand)).toHaveLength(2);
    expect(result).toEqual({
      physicalId: NAME,
      wasReplaced: false,
      attributes: {
        Arn: ARN,
        CurrentState: 'STOPPED',
        CreationTime: CREATED.toISOString(),
        LastModifiedTime: MODIFIED.toISOString(),
      },
    });
  });

  it('does not take a pre-update RUNNING read for the settled state', async () => {
    const accepted = new Date('2026-10-03T00:00:10.000Z');
    const reads = [
      described({ CurrentState: 'RUNNING', LastModifiedTime: MODIFIED }),
      described({ CurrentState: 'RUNNING', LastModifiedTime: accepted }),
    ];
    route({
      UpdatePipeCommand: () => ({ CurrentState: 'UPDATING', LastModifiedTime: accepted }),
      DescribePipeCommand: () => reads.shift(),
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const result = await provider.update(
      'Pipe',
      NAME,
      TYPE,
      { ...KINESIS_PREVIOUS, Description: 'v2' },
      KINESIS_PREVIOUS
    );
    expect(sent(DescribePipeCommand)).toHaveLength(2);
    expect(result.attributes?.['LastModifiedTime']).toBe(accepted.toISOString());
  });

  it('clears a removed Description, Enrichment and key, and turns a removed LogConfiguration OFF', async () => {
    route({ UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }), DescribePipeCommand: () => described() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const previous = {
      ...KINESIS_PREVIOUS,
      Enrichment: 'arn:aws:lambda:us-east-1:123456789012:function:f',
      KmsKeyIdentifier: 'alias/k',
      LogConfiguration: { Level: 'ERROR', CloudwatchLogsLogDestination: { LogGroupArn: 'arn:x' } },
    };
    const { Description: _d, ...desired } = KINESIS_PREVIOUS;

    await provider.update('Pipe', NAME, TYPE, desired, previous);

    const input = sent(UpdatePipeCommand)[0]!.input;
    expect(input.Description).toBe('');
    expect(input.Enrichment).toBe('');
    expect(input.KmsKeyIdentifier).toBe('');
    expect(input.LogConfiguration).toEqual({ Level: 'OFF' });
  });

  it('a Tags-only change tags through the pipe ARN and sends no UpdatePipe', async () => {
    route({
      DescribePipeCommand: () => described(),
      TagResourceCommand: () => ({}),
      UntagResourceCommand: () => ({}),
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });

    await provider.update(
      'Pipe',
      NAME,
      TYPE,
      { ...KINESIS_PREVIOUS, Tags: { keep: '1', changed: 'new' } },
      { ...KINESIS_PREVIOUS, Tags: { keep: '1', changed: 'old', gone: 'x' } }
    );

    expect(sent(UpdatePipeCommand)).toHaveLength(0);
    expect(sent(UntagResourceCommand)[0]!.input).toEqual({ resourceArn: ARN, tagKeys: ['gone'] });
    expect(sent(TagResourceCommand)[0]!.input).toEqual({
      resourceArn: ARN,
      tags: { changed: 'new' },
    });
  });

  it('refuses a malformed desired Tags before any call', async () => {
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Tags: 'x' }, KINESIS_PREVIOUS)
    ).rejects.toThrow(/Tags of AWS::Pipes::Pipe Pipe is not a map/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a Source change instead of updating the old pipe', async () => {
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.update(
        'Pipe',
        NAME,
        TYPE,
        { ...KINESIS_PREVIOUS, Source: 'arn:aws:kinesis:us-east-1:123456789012:stream/other' },
        KINESIS_PREVIOUS
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('fails on UPDATE_FAILED with AWS’s StateReason', async () => {
    route({
      UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }),
      DescribePipeCommand: () =>
        described({ CurrentState: 'UPDATE_FAILED', StateReason: 'role cannot read stream' }),
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS)
    ).rejects.toThrow(/AWS reports UPDATE_FAILED: role cannot read stream/);
  });

  it('refuses before UpdatePipe when the client region differs from the recorded one', async () => {
    clientRegion.value = 'us-west-2';
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS, {
        expectedRegion: 'us-east-1',
      })
    ).rejects.toThrow(/us-east-1/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('gives up at the settle cap rather than polling forever', async () => {
    let clock = 0;
    route({
      UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }),
      DescribePipeCommand: () => described({ CurrentState: 'UPDATING' }),
    });
    const provider = new PipesPipeProvider({
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS)
    ).rejects.toThrow(/did not settle within 900s of its update \(last state: UPDATING\)/);
  });
});

describe('PipesPipeProvider.create', () => {
  it('maps the ECS target islands and the Kinesis timestamp, then waits for the pipe to settle', async () => {
    const states = ['CREATING', 'RUNNING'];
    route({
      CreatePipeCommand: () => ({ Name: NAME, Arn: ARN }),
      DescribePipeCommand: () => described({ CurrentState: states.shift() ?? 'RUNNING' }),
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });

    const result = await provider.create('Pipe', TYPE, {
      Name: NAME,
      RoleArn: 'arn:aws:iam::123456789012:role/r',
      Source: 'arn:aws:kinesis:us-east-1:123456789012:stream/src',
      Target: 'arn:aws:ecs:us-east-1:123456789012:cluster/c',
      SourceParameters: {
        KinesisStreamParameters: {
          StartingPosition: 'AT_TIMESTAMP',
          StartingPositionTimestamp: '2026-01-01T00:00:00.000Z',
        },
      },
      TargetParameters: {
        EcsTaskParameters: {
          TaskDefinitionArn: 'arn:td',
          NetworkConfiguration: { AwsvpcConfiguration: { Subnets: ['subnet-1'] } },
          CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1, Base: 0 }],
          PlacementConstraints: [{ Type: 'memberOf', Expression: 'x' }],
          PlacementStrategy: [{ Type: 'spread', Field: 'az' }],
          Overrides: {
            ContainerOverrides: [
              {
                Name: 'app',
                Environment: [{ Name: 'K', Value: 'V' }],
                EnvironmentFiles: [{ Type: 's3', Value: 'arn:f' }],
                ResourceRequirements: [{ Type: 'GPU', Value: '1' }],
              },
            ],
            EphemeralStorage: { SizeInGiB: 30 },
            InferenceAcceleratorOverrides: [{ DeviceName: 'd', DeviceType: 't' }],
          },
        },
      },
      Tags: { team: 'a' },
    });

    const input = sent(CreatePipeCommand)[0]!.input;
    expect(input.SourceParameters.KinesisStreamParameters.StartingPositionTimestamp).toEqual(
      new Date('2026-01-01T00:00:00.000Z')
    );
    expect(input.TargetParameters.EcsTaskParameters).toEqual({
      TaskDefinitionArn: 'arn:td',
      NetworkConfiguration: { awsvpcConfiguration: { Subnets: ['subnet-1'] } },
      CapacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1, base: 0 }],
      PlacementConstraints: [{ type: 'memberOf', expression: 'x' }],
      PlacementStrategy: [{ type: 'spread', field: 'az' }],
      Overrides: {
        ContainerOverrides: [
          {
            Name: 'app',
            Environment: [{ name: 'K', value: 'V' }],
            EnvironmentFiles: [{ type: 's3', value: 'arn:f' }],
            ResourceRequirements: [{ type: 'GPU', value: '1' }],
          },
        ],
        EphemeralStorage: { sizeInGiB: 30 },
        InferenceAcceleratorOverrides: [{ deviceName: 'd', deviceType: 't' }],
      },
    });
    expect(input.Tags).toEqual({ team: 'a' });
    expect(result.physicalId).toBe(NAME);
    expect(result.attributes?.['Arn']).toBe(ARN);
    expect(result.attributes?.['CurrentState']).toBe('RUNNING');
  });

  it('generates a stack-prefixed name when the template gives none', async () => {
    route({ CreatePipeCommand: () => ({}), DescribePipeCommand: () => described() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const result = await withStackName('MyStack', () =>
      provider.create('Pipe', TYPE, { RoleArn: 'r', Source: 's', Target: 't' })
    );
    expect(result.physicalId).toBe('MyStack-Pipe');
    expect(sent(CreatePipeCommand)[0]!.input.Name).toBe('MyStack-Pipe');
  });

  it('keeps polling through a read-after-create not-found', async () => {
    const answers: Array<() => unknown> = [
      () => {
        throw new NotFoundException({ message: 'not found', $metadata: {} });
      },
      () => described(),
    ];
    route({
      CreatePipeCommand: () => ({}),
      DescribePipeCommand: () => answers.shift()!(),
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
    ).resolves.toMatchObject({ physicalId: NAME });
  });

  it('deletes a pipe that reached CREATE_FAILED and reports AWS’s reason', async () => {
    let deleted = false;
    route({
      CreatePipeCommand: () => ({}),
      DescribePipeCommand: () => {
        if (deleted) throw new NotFoundException({ message: 'gone', $metadata: {} });
        return described({ CurrentState: 'CREATE_FAILED', StateReason: 'target unreachable' });
      },
      DeletePipeCommand: () => {
        deleted = true;
        return {};
      },
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const error = await provider
      .create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(error?.message).toMatch(/AWS reports CREATE_FAILED: target unreachable/);
    expect(error?.message).toMatch(/cdkd deleted the pipe it had created/);
    expect(sent(DeletePipeCommand)[0]!.input).toEqual({ Name: NAME });
  });

  it('names the leftover pipe and how to delete it when the cleanup fails too', async () => {
    route({
      CreatePipeCommand: () => ({}),
      DescribePipeCommand: () => described({ CurrentState: 'CREATE_FAILED' }),
      DeletePipeCommand: () => {
        throw Object.assign(new Error('busy'), { name: 'ConflictException' });
      },
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
    ).rejects.toThrow(/could not delete the pipe.*aws pipes delete-pipe --name my-pipe/);
  });

  it('deletes nothing when CreatePipe itself fails', async () => {
    route({
      CreatePipeCommand: () => {
        throw new Error('AccessDenied');
      },
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
    ).rejects.toThrow(/Failed to create Pipe Pipe: AccessDenied/);
    expect(sent(DeletePipeCommand)).toHaveLength(0);
  });
});

describe('PipesPipeProvider.delete', () => {
  it('waits until the DELETING pipe is gone, since it still holds its name', async () => {
    const answers: Array<() => unknown> = [
      () => described({ CurrentState: 'DELETING' }),
      () => {
        throw new NotFoundException({ message: 'gone', $metadata: {} });
      },
    ];
    route({ DeletePipeCommand: () => ({}), DescribePipeCommand: () => answers.shift()!() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(provider.delete('Pipe', NAME, TYPE)).resolves.toBeUndefined();
    expect(sent(DescribePipeCommand)).toHaveLength(2);
  });

  it('treats not-found as already deleted in the recorded region', async () => {
    route({
      DeletePipeCommand: () => {
        throw new NotFoundException({ message: 'gone', $metadata: {} });
      },
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.delete('Pipe', NAME, TYPE, undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
  });

  it('refuses to delete through a client in another region', async () => {
    clientRegion.value = 'us-west-2';
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.delete('Pipe', NAME, TYPE, undefined, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow(/us-east-1/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('PipesPipeProvider read paths', () => {
  it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
    route({
      DescribePipeCommand: () => ({
        Name: NAME,
        Arn: ARN,
        Source: 's',
        Target: 't',
        RoleArn: 'r',
      }),
    });
    const provider = new PipesPipeProvider();
    const result = (await provider.readCurrentState(NAME, 'Pipe', TYPE)) as Record<string, unknown> | undefined;
    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'Description',
        'DesiredState',
        'Enrichment',
        'EnrichmentParameters',
        'KmsKeyIdentifier',
        'LogConfiguration',
        'Name',
        'RoleArn',
        'Source',
        'Tags',
        'Target',
      ].sort()
    );
    expect(result?.['Description']).toBe('');
    expect(result?.['DesiredState']).toBe('RUNNING');
    expect(result?.['LogConfiguration']).toEqual({});
    expect(result?.['Tags']).toEqual({});
    expect(provider.getDriftUnknownPaths()).toEqual(['SourceParameters', 'TargetParameters']);
  });

  it('round-trip: readCurrentState placeholders survive update() without AWS-invalid inputs', async () => {
    route({ DescribePipeCommand: () => ({ Name: NAME, Arn: ARN, Source: 's', Target: 't', RoleArn: 'r' }) });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const observed = (await provider.readCurrentState(NAME, 'Pipe', TYPE)) as Record<string, unknown>;

    mockSend.mockReset();
    route({ UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }), DescribePipeCommand: () => described() });
    await provider.update('Pipe', NAME, TYPE, observed, { ...observed, Description: 'drifted' });

    const input = sent(UpdatePipeCommand)[0]!.input;
    // An empty LogConfiguration is refused by AWS for its missing Level.
    expect(input.LogConfiguration).toEqual({ Level: 'OFF' });
    expect(input.Description).toBe('');
    expect(input.KmsKeyIdentifier).toBe('');
  });

  it('getAttribute serves every documented attribute and undefined for a gone pipe', async () => {
    route({ DescribePipeCommand: () => described({ StateReason: 'ok' }) });
    const provider = new PipesPipeProvider();
    expect(await provider.getAttribute(NAME, TYPE, 'Arn', 'Pipe')).toBe(ARN);
    expect(await provider.getAttribute(NAME, TYPE, 'StateReason', 'Pipe')).toBe('ok');
    expect(await provider.getAttribute(NAME, TYPE, 'CreationTime', 'Pipe')).toBe(
      CREATED.toISOString()
    );
    mockSend.mockReset();
    route({
      DescribePipeCommand: () => {
        throw new NotFoundException({ message: 'gone', $metadata: {} });
      },
    });
    expect(await provider.getAttribute(NAME, TYPE, 'Arn', 'Pipe')).toBeUndefined();
  });

  it('imports by explicit name and returns null for a missing pipe', async () => {
    const input = (properties: Record<string, unknown>) =>
      ({
        logicalId: 'Pipe',
        resourceType: TYPE,
        cdkPath: 'S/Pipe',
        stackName: 'S',
        region: 'us-east-1',
        properties,
      }) as never;
    route({ DescribePipeCommand: () => described() });
    const provider = new PipesPipeProvider();
    expect(await provider.import(input({ Name: NAME }))).toMatchObject({
      physicalId: NAME,
      attributes: { Arn: ARN },
    });
    mockSend.mockReset();
    route({
      DescribePipeCommand: () => {
        throw new NotFoundException({ message: 'gone', $metadata: {} });
      },
    });
    expect(await provider.import(input({ Name: NAME }))).toBeNull();
    // No name to verify: nothing is looked up.
    mockSend.mockReset();
    expect(await provider.import(input({}))).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('readCurrentState leaves out AWS-managed aws: tags', async () => {
    route({ DescribePipeCommand: () => described({ Tags: { team: 'a', 'aws:cdk:path': 'S/P' } }) });
    const result = (await new PipesPipeProvider().readCurrentState(NAME, 'Pipe', TYPE)) as
      | Record<string, unknown>
      | undefined;
    expect(result?.['Tags']).toEqual({ team: 'a' });
  });

  it('getAttribute rethrows a read failure that is not not-found', async () => {
    route({
      DescribePipeCommand: () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      },
    });
    await expect(new PipesPipeProvider().getAttribute(NAME, TYPE, 'Arn', 'Pipe')).rejects.toThrow(
      'denied'
    );
  });
});

describe('existing cc-api records (issue #4423)', () => {
  it('admits AWS::Pipes::Pipe as a cc-broken sticky exemption', () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get(TYPE)?.mode).toBe('cc-broken');
  });

  it('routes a cc-api-recorded pipe to the SDK provider, which updates it in place under the same name', async () => {
    const registry = new ProviderRegistry();
    registerAllProviders(registry);
    const desired = {
      ...KINESIS_PREVIOUS,
      SourceParameters: { KinesisStreamParameters: { StartingPosition: 'LATEST', BatchSize: 20 } },
    };
    const decision = registry.getProviderFor({
      resourceType: TYPE,
      properties: desired,
      previousProperties: KINESIS_PREVIOUS,
      provisionedBy: 'cc-api',
    });
    expect(decision.provider).toBeInstanceOf(PipesPipeProvider);
    expect(decision.provisionedBy).toBe('sdk');
    expect(decision.sdkMigration).toBe(true);

    route({ UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }), DescribePipeCommand: () => described() });
    // The registered instance carries no sleep seam; every answer here is settled.
    const result = await decision.provider.update(
      'Pipe',
      NAME,
      TYPE,
      desired,
      KINESIS_PREVIOUS
    );
    expect(result.physicalId).toBe(NAME);
    expect(result.wasReplaced).toBe(false);
    expect(sent(UpdatePipeCommand)[0]!.input).toMatchObject({
      Name: NAME,
      SourceParameters: { KinesisStreamParameters: { BatchSize: 20 } },
    });
    expect(sent(CreatePipeCommand)).toHaveLength(0);
    expect(sent(DeletePipeCommand)).toHaveLength(0);
  });
});

describe('PipesPipeProvider review-round cases', () => {
  it('sends every member each UpdatePipeSource*Parameters shape takes, and nothing create-only', () => {
    // Every member of the SDK's update shape, per block (models_0.d.ts), plus
    // every create-only member the CFn schema lists. A member missing from
    // UPDATABLE_SOURCE_MEMBERS would silently drop the user's change.
    const UPDATABLE: Record<string, string[]> = {
      KinesisStreamParameters: [
        'BatchSize',
        'DeadLetterConfig',
        'OnPartialBatchItemFailure',
        'MaximumBatchingWindowInSeconds',
        'MaximumRecordAgeInSeconds',
        'MaximumRetryAttempts',
        'ParallelizationFactor',
      ],
      DynamoDBStreamParameters: [
        'BatchSize',
        'DeadLetterConfig',
        'OnPartialBatchItemFailure',
        'MaximumBatchingWindowInSeconds',
        'MaximumRecordAgeInSeconds',
        'MaximumRetryAttempts',
        'ParallelizationFactor',
      ],
      SqsQueueParameters: ['BatchSize', 'MaximumBatchingWindowInSeconds'],
      ActiveMQBrokerParameters: ['Credentials', 'BatchSize', 'MaximumBatchingWindowInSeconds'],
      RabbitMQBrokerParameters: ['Credentials', 'BatchSize', 'MaximumBatchingWindowInSeconds'],
      ManagedStreamingKafkaParameters: ['BatchSize', 'Credentials', 'MaximumBatchingWindowInSeconds'],
      SelfManagedKafkaParameters: [
        'BatchSize',
        'MaximumBatchingWindowInSeconds',
        'Credentials',
        'ServerRootCaCertificate',
        'Vpc',
      ],
    };
    const CREATE_ONLY = [
      'StartingPosition',
      'StartingPositionTimestamp',
      'QueueName',
      'VirtualHost',
      'TopicName',
      'ConsumerGroupID',
      'AdditionalBootstrapServers',
    ];
    for (const [block, members] of Object.entries(UPDATABLE)) {
      const full = Object.fromEntries([...members, ...CREATE_ONLY].map((k) => [k, `v-${k}`]));
      const expected = Object.fromEntries(members.map((k) => [k, `v-${k}`]));
      expect(toUpdateSourceParameters({ [block]: full }, {}), block).toEqual({ [block]: expected });
    }
  });

  it('declares SourceParameters and Tags removals as handled in update()', () => {
    expect([...new PipesPipeProvider().removalHandledInUpdate.get(TYPE)!].sort()).toEqual([
      'SourceParameters',
      'Tags',
    ]);
  });

  it('CreatePipe carries every declared top-level property', async () => {
    route({ CreatePipeCommand: () => ({}), DescribePipeCommand: () => described() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await provider.create('Pipe', TYPE, {
      Name: NAME,
      RoleArn: 'r',
      Source: 's',
      Target: 't',
      Description: 'd',
      DesiredState: 'STOPPED',
      Enrichment: 'e',
      EnrichmentParameters: { InputTemplate: '{}' },
      LogConfiguration: { Level: 'ERROR' },
      KmsKeyIdentifier: 'alias/k',
      SourceParameters: { SqsQueueParameters: { BatchSize: 1 } },
      TargetParameters: { InputTemplate: 'x' },
      Tags: { team: 'a' },
    });
    expect(sent(CreatePipeCommand)[0]!.input).toEqual({
      Name: NAME,
      RoleArn: 'r',
      Source: 's',
      Target: 't',
      Description: 'd',
      DesiredState: 'STOPPED',
      Enrichment: 'e',
      EnrichmentParameters: { InputTemplate: '{}' },
      LogConfiguration: { Level: 'ERROR' },
      KmsKeyIdentifier: 'alias/k',
      SourceParameters: { SqsQueueParameters: { BatchSize: 1 } },
      TargetParameters: { InputTemplate: 'x' },
      Tags: { team: 'a' },
    });
  });

  it('caps a generated name at 64 characters', async () => {
    route({ CreatePipeCommand: () => ({}), DescribePipeCommand: () => described() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const result = await withStackName('S'.repeat(80), () =>
      provider.create('Pipe', TYPE, { RoleArn: 'r', Source: 's', Target: 't' })
    );
    expect(result.physicalId.length).toBeLessThanOrEqual(64);
  });

  it('maps the ECS target islands on update too', async () => {
    route({ UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }), DescribePipeCommand: () => described() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const ecs = { EcsTaskParameters: { TaskDefinitionArn: 'arn:td', PlacementStrategy: [{ Type: 'spread', Field: 'az' }] } };
    await provider.update(
      'Pipe',
      NAME,
      TYPE,
      { ...KINESIS_PREVIOUS, TargetParameters: ecs },
      KINESIS_PREVIOUS
    );
    expect(sent(UpdatePipeCommand)[0]!.input.TargetParameters).toEqual({
      EcsTaskParameters: { TaskDefinitionArn: 'arn:td', PlacementStrategy: [{ type: 'spread', field: 'az' }] },
    });
  });

  it('a removed DesiredState goes back to RUNNING, CloudFormation’s default', async () => {
    route({ UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }), DescribePipeCommand: () => described() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const { DesiredState: _s, ...desired } = KINESIS_PREVIOUS;
    await provider.update('Pipe', NAME, TYPE, desired, KINESIS_PREVIOUS);
    expect(sent(UpdatePipeCommand)[0]!.input.DesiredState).toBe('RUNNING');
  });

  it('refuses a Name change', async () => {
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Name: 'renamed' }, KINESIS_PREVIOUS)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a secret-derived Name recorded as its reference is no change (go-to-k/cdkd#4275)', async () => {
    route({ UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }), DescribePipeCommand: () => described() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const reference = '{{resolve:secretsmanager:pipe-name:SecretString:name}}';
    await provider.update(
      'Pipe',
      NAME,
      TYPE,
      { ...KINESIS_PREVIOUS, Name: NAME, Description: 'v2' },
      { ...KINESIS_PREVIOUS, Name: reference }
    );
    expect(sent(UpdatePipeCommand)[0]!.input.Name).toBe(NAME);
    // A rotated secret names ANOTHER pipe: still refused.
    mockSend.mockReset();
    await expect(
      provider.update(
        'Pipe',
        NAME,
        TYPE,
        { ...KINESIS_PREVIOUS, Name: 'rotated-name', Description: 'v2' },
        { ...KINESIS_PREVIOUS, Name: reference }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a secret-derived Source recorded as its reference is no change only through the masker', async () => {
    const reference = '{{resolve:secretsmanager:pipe-src:SecretString:arn}}';
    const resolved = 'arn:aws:kinesis:us-east-1:123456789012:stream/secret-src';
    const desired = { ...KINESIS_PREVIOUS, Source: resolved, Description: 'v2' };
    const previous = { ...KINESIS_PREVIOUS, Source: reference };
    const maskSecrets = (t: string) => t.replaceAll(resolved, '***');
    route({ UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }), DescribePipeCommand: () => described() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await provider.update('Pipe', NAME, TYPE, desired, previous, { maskSecrets });
    expect(sent(UpdatePipeCommand)).toHaveLength(1);
    // Without a masker nothing shows the desired value came from the secret.
    mockSend.mockReset();
    await expect(provider.update('Pipe', NAME, TYPE, desired, previous)).rejects.toBeInstanceOf(
      ResourceUpdateNotSupportedError
    );
    // A plain recorded Source that differs is a real change.
    await expect(
      provider.update('Pipe', NAME, TYPE, desired, KINESIS_PREVIOUS, { maskSecrets })
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a pipe gone during an update fails instead of polling to the cap', async () => {
    route({
      UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }),
      DescribePipeCommand: () => {
        throw new NotFoundException({ message: 'gone', $metadata: {} });
      },
    });
    // A clock, so a wrongly-retried not-found reaches the cap instead of spinning.
    let clock = 0;
    const provider = new PipesPipeProvider({
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS, {
        expectedRegion: 'us-east-1',
      })
    ).rejects.toThrow(/Failed to update Pipe Pipe/);
    expect(sent(DescribePipeCommand)).toHaveLength(1);
  });

  it('refuses a not-found update through a client in another region', async () => {
    let calls = 0;
    route({
      UpdatePipeCommand: () => {
        throw new NotFoundException({ message: 'gone', $metadata: {} });
      },
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    // The pre-update guard passes (same region); the region then reads differently.
    const original = clientRegion.value;
    mockSend.mockImplementationOnce(async () => {
      calls += 1;
      clientRegion.value = 'us-west-2';
      throw new NotFoundException({ message: 'gone', $metadata: {} });
    });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS, {
        expectedRegion: original,
      })
    ).rejects.toThrow(/us-west-2|Refusing/);
    expect(calls).toBe(1);
  });

  it('keeps polling through a throttled read while settling', async () => {
    const answers: Array<() => unknown> = [
      () => {
        throw Object.assign(new Error('Rate exceeded'), {
          name: 'ThrottlingException',
          $metadata: { httpStatusCode: 429 },
        });
      },
      () => described(),
    ];
    route({ UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }), DescribePipeCommand: () => answers.shift()!() });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS)
    ).resolves.toMatchObject({ physicalId: NAME });
    expect(sent(DescribePipeCommand)).toHaveLength(2);
  });

  it('a stale *_FAILED read from before the update is polled past', async () => {
    const accepted = new Date('2026-10-03T00:00:10.000Z');
    const reads = [
      described({ CurrentState: 'UPDATE_FAILED', LastModifiedTime: MODIFIED }),
      described({ CurrentState: 'RUNNING', LastModifiedTime: accepted }),
    ];
    route({
      UpdatePipeCommand: () => ({ LastModifiedTime: accepted }),
      DescribePipeCommand: () => reads.shift(),
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS)
    ).resolves.toMatchObject({ physicalId: NAME });
  });

  it('a *_FAILED state is final: masked, and marked so no retry repeats it', async () => {
    route({
      UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }),
      DescribePipeCommand: () =>
        described({ CurrentState: 'UPDATE_FAILED', StateReason: 'role s3cr3t-role denied' }),
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const error = await provider
      .update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS, {
        maskSecrets: (t: string) => t.replaceAll('s3cr3t-role', '***'),
      })
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(error?.message).toContain('role *** denied');
    expect(error?.message).not.toContain('s3cr3t-role');
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('tagging refuses when DescribePipe returns no Arn', async () => {
    route({ DescribePipeCommand: () => described({ Arn: undefined }) });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Tags: { a: '1' } }, KINESIS_PREVIOUS)
    ).rejects.toThrow(/no Arn/);
  });

  it('a delete failure that is not not-found keeps the record', async () => {
    route({
      DeletePipeCommand: () => {
        throw Object.assign(new Error('pipe is busy'), { name: 'ConflictException' });
      },
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(provider.delete('Pipe', NAME, TYPE)).rejects.toThrow(/Failed to delete Pipe Pipe/);
  });

  it('a pipe that reaches DELETE_FAILED fails the delete', async () => {
    let clock = 0;
    const answers = [
      described({ CurrentState: 'DELETING' }),
      described({ CurrentState: 'DELETE_FAILED' }),
    ];
    route({ DeletePipeCommand: () => ({}), DescribePipeCommand: () => answers.shift() ?? described({ CurrentState: 'DELETE_FAILED' }) });
    const provider = new PipesPipeProvider({
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    await expect(provider.delete('Pipe', NAME, TYPE)).rejects.toThrow(/DELETE_FAILED/);
  });

  it('a failed create whose pipe is already gone keeps the original error', async () => {
    route({
      CreatePipeCommand: () => ({}),
      DescribePipeCommand: () => described({ CurrentState: 'CREATE_FAILED', StateReason: 'bad target' }),
      DeletePipeCommand: () => {
        throw new NotFoundException({ message: 'gone', $metadata: {} });
      },
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    const error = await provider
      .create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(error?.message).toMatch(/AWS reports CREATE_FAILED: bad target$/);
  });

  it('the cleanup command names the client region', async () => {
    route({
      CreatePipeCommand: () => ({}),
      DescribePipeCommand: () => described({ CurrentState: 'CREATE_FAILED' }),
      DeletePipeCommand: () => {
        throw Object.assign(new Error('busy'), { name: 'ConflictException' });
      },
    });
    const provider = new PipesPipeProvider({ sleep: noSleep });
    await expect(
      provider.create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
    ).rejects.toThrow(/aws pipes delete-pipe --name my-pipe --region us-east-1/);
  });
});

describe('PipesPipeProvider second review round', () => {
  const clocked = () => {
    let clock = 0;
    return new PipesPipeProvider({
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
  };

  for (const terminal of ['DELETE_FAILED', 'DELETE_ROLLBACK_FAILED']) {
    it(`a delete that reaches ${terminal} keeps the record`, async () => {
      const answers = [described({ CurrentState: 'DELETING' }), described({ CurrentState: terminal })];
      route({
        DeletePipeCommand: () => ({}),
        DescribePipeCommand: () => answers.shift() ?? described({ CurrentState: terminal }),
      });
      await expect(clocked().delete('Pipe', NAME, TYPE)).rejects.toThrow(
        new RegExp(`reached ${terminal} after its delete was accepted`)
      );
    });
  }

  for (const settled of ['RUNNING', 'STOPPED']) {
    it(`a delete that rolls back to ${settled} after DELETING keeps the record`, async () => {
      const answers = [described({ CurrentState: 'DELETING' }), described({ CurrentState: settled })];
      route({
        DeletePipeCommand: () => ({}),
        DescribePipeCommand: () => answers.shift() ?? described({ CurrentState: settled }),
      });
      await expect(clocked().delete('Pipe', NAME, TYPE)).rejects.toThrow(
        new RegExp(`reached ${settled} after its delete was accepted`)
      );
    });
  }

  it('a settled read before any DELETING read is not a rollback: the delete may not have started', async () => {
    // Two RUNNING reads, the second a poll interval in: neither may count.
    const answers: Array<() => unknown> = [
      () => described({ CurrentState: 'RUNNING' }),
      () => described({ CurrentState: 'RUNNING' }),
      () => described({ CurrentState: 'DELETING' }),
      () => {
        throw new NotFoundException({ message: 'gone', $metadata: {} });
      },
    ];
    route({ DeletePipeCommand: () => ({}), DescribePipeCommand: () => answers.shift()!() });
    await expect(clocked().delete('Pipe', NAME, TYPE)).resolves.toBeUndefined();
  });

  it('a failed create whose pipe is still DELETING does not claim it is gone', async () => {
    route({
      CreatePipeCommand: () => ({}),
      DescribePipeCommand: (() => {
        let n = 0;
        return () =>
          described({ CurrentState: n++ === 0 ? 'CREATE_FAILED' : 'DELETING' });
      })(),
      DeletePipeCommand: () => ({}),
    });
    const error = await clocked()
      .create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(error?.message).toMatch(/cdkd started deleting the pipe it had created; a re-deploy may report the name in use/);
    expect(error?.message).not.toMatch(/nothing is left behind/);
  });

  it('an update with no LastModifiedTime does not take the first settled read', async () => {
    route({
      UpdatePipeCommand: () => ({}),
      DescribePipeCommand: () => described({ CurrentState: 'RUNNING' }),
    });
    await clocked().update(
      'Pipe',
      NAME,
      TYPE,
      { ...KINESIS_PREVIOUS, Description: 'v2' },
      KINESIS_PREVIOUS
    );
    // The first RUNNING read may predate the update: one poll interval passes first.
    expect(sent(DescribePipeCommand)).toHaveLength(2);
  });

  it('an update with no LastModifiedTime accepts a settled read after a non-settled one', async () => {
    const reads = [described({ CurrentState: 'UPDATING' }), described({ CurrentState: 'RUNNING' })];
    route({ UpdatePipeCommand: () => ({}), DescribePipeCommand: () => reads.shift() });
    const provider = new PipesPipeProvider({ sleep: noSleep, now: () => 0 });
    await provider.update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS);
    expect(sent(DescribePipeCommand)).toHaveLength(2);
  });

  it('START_FAILED is a terminal settle failure too', async () => {
    route({
      UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }),
      DescribePipeCommand: () => described({ CurrentState: 'START_FAILED', StateReason: 'no access' }),
    });
    // A clock, so a mutant that keeps polling ends at the cap with a readable message.
    const error = await clocked()
      .update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, DesiredState: 'RUNNING' }, KINESIS_PREVIOUS)
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(error?.message).toMatch(/update failed: AWS reports START_FAILED: no access/);
    // The settle failure is rethrown as is, not wrapped a second time.
    expect(error?.message).not.toMatch(/Failed to update Pipe/);
  });

  it('CreatePipe carries no Tags when the template has none', async () => {
    route({ CreatePipeCommand: () => ({}), DescribePipeCommand: () => described() });
    await new PipesPipeProvider({ sleep: noSleep }).create('Pipe', TYPE, {
      Name: NAME,
      RoleArn: 'r',
      Source: 's',
      Target: 't',
    });
    expect(sent(CreatePipeCommand)[0]!.input).not.toHaveProperty('Tags');
  });

  it('refuses malformed Tags on create before any call', async () => {
    await expect(
      new PipesPipeProvider({ sleep: noSleep }).create('Pipe', TYPE, {
        Name: NAME,
        RoleArn: 'r',
        Source: 's',
        Target: 't',
        Tags: ['x'],
      })
    ).rejects.toThrow(/Tags of AWS::Pipes::Pipe Pipe is not a map/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a create that never settles hits the cap and retires the pipe', async () => {
    let deleted = false;
    route({
      CreatePipeCommand: () => ({}),
      DescribePipeCommand: () => {
        if (deleted) throw new NotFoundException({ message: 'gone', $metadata: {} });
        return described({ CurrentState: 'CREATING' });
      },
      DeletePipeCommand: () => {
        deleted = true;
        return {};
      },
    });
    const error = await clocked()
      .create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(error?.message).toMatch(/did not settle within 900s of its create/);
    expect(error?.message).toMatch(/cdkd deleted the pipe it had created/);
  });

  it('an explicit --resource-timeout halves the settle cap', async () => {
    setResolvedResourceTimeouts({ globalMs: 60_000 });
    try {
      route({
        UpdatePipeCommand: () => ({ LastModifiedTime: MODIFIED }),
        DescribePipeCommand: () => described({ CurrentState: 'UPDATING' }),
      });
      await expect(
        clocked().update('Pipe', NAME, TYPE, { ...KINESIS_PREVIOUS, Description: 'v2' }, KINESIS_PREVIOUS)
      ).rejects.toThrow(/did not settle within 30s/);
    } finally {
      clearResolvedResourceTimeouts();
    }
  });

  it('readCurrentState answers RESOURCE_NOT_FOUND for a gone pipe and rethrows any other failure', async () => {
    route({
      DescribePipeCommand: () => {
        throw new NotFoundException({ message: 'gone', $metadata: {} });
      },
    });
    const provider = new PipesPipeProvider();
    expect(await provider.readCurrentState(NAME, 'Pipe', TYPE)).toBe(RESOURCE_NOT_FOUND);
    mockSend.mockReset();
    route({
      DescribePipeCommand: () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      },
    });
    await expect(provider.readCurrentState(NAME, 'Pipe', TYPE)).rejects.toThrow('denied');
  });
});

describe('PipesPipeProvider delta round', () => {
  const clocked = () => {
    let clock = 0;
    return new PipesPipeProvider({
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
  };
  const gone = () => {
    throw new NotFoundException({ message: 'gone', $metadata: {} });
  };

  it('destroying a pipe already in UPDATE_FAILED succeeds once it goes DELETING then away', async () => {
    const answers: Array<() => unknown> = [
      () => described({ CurrentState: 'UPDATE_FAILED' }),
      () => described({ CurrentState: 'UPDATE_FAILED' }),
      () => described({ CurrentState: 'DELETING' }),
      gone,
    ];
    route({ DeletePipeCommand: () => ({}), DescribePipeCommand: () => answers.shift()!() });
    await expect(clocked().delete('Pipe', NAME, TYPE)).resolves.toBeUndefined();
  });

  it('a non-delete *_FAILED state after DELETING is terminal', async () => {
    const answers = [described({ CurrentState: 'DELETING' }), described({ CurrentState: 'STOP_FAILED' })];
    route({
      DeletePipeCommand: () => ({}),
      DescribePipeCommand: () => answers.shift() ?? described({ CurrentState: 'STOP_FAILED' }),
    });
    await expect(clocked().delete('Pipe', NAME, TYPE)).rejects.toThrow(
      /reached STOP_FAILED after its delete was accepted/
    );
  });

  it('one settled read between DELETING reads is not yet a rollback', async () => {
    const answers: Array<() => unknown> = [
      () => described({ CurrentState: 'DELETING' }),
      () => described({ CurrentState: 'RUNNING' }),
      () => described({ CurrentState: 'DELETING' }),
      gone,
    ];
    route({ DeletePipeCommand: () => ({}), DescribePipeCommand: () => answers.shift()!() });
    await expect(clocked().delete('Pipe', NAME, TYPE)).resolves.toBeUndefined();
  });

  it('a failed create whose cleanup delete reaches DELETE_FAILED reports the pipe orphaned, with the command', async () => {
    let deleted = false;
    const afterDelete = [described({ CurrentState: 'DELETING' }), described({ CurrentState: 'DELETE_FAILED' })];
    route({
      CreatePipeCommand: () => ({}),
      DescribePipeCommand: () =>
        deleted
          ? (afterDelete.shift() ?? described({ CurrentState: 'DELETE_FAILED' }))
          : described({ CurrentState: 'CREATE_FAILED' }),
      DeletePipeCommand: () => {
        deleted = true;
        return {};
      },
    });
    const error = await clocked()
      .create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(error?.message).toMatch(/cdkd could not delete the pipe it had created: its delete did not complete/);
    expect(error?.message).toMatch(/aws pipes delete-pipe --name my-pipe --region us-east-1/);
    expect(error?.message).not.toMatch(/started deleting/);
  });
});

describe('PipesPipeProvider unconfirmed cleanup wording', () => {
  const clocked = () => {
    let clock = 0;
    return new PipesPipeProvider({
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
  };
  const create = (provider: PipesPipeProvider) =>
    provider
      .create('Pipe', TYPE, { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' })
      .then(
        () => undefined,
        (e: Error) => e
      );
  const UNCONFIRMED =
    /cdkd asked AWS to delete the pipe it had created but could not confirm the delete progressed; if aws pipes describe-pipe --name my-pipe --region us-east-1 still shows it, delete it with: aws pipes delete-pipe --name my-pipe --region us-east-1\)/;

  it('a cap reached with no DELETING read does not claim the delete started', async () => {
    let deleted = false;
    route({
      CreatePipeCommand: () => ({}),
      // CREATE_FAILED throughout: not terminal before a DELETING read.
      DescribePipeCommand: () => described({ CurrentState: 'CREATE_FAILED' }),
      DeletePipeCommand: () => {
        deleted = true;
        return {};
      },
    });
    const error = await create(clocked());
    expect(deleted).toBe(true);
    expect(error?.message).toMatch(UNCONFIRMED);
    expect(error?.message).not.toMatch(/started deleting/);
  });

  it('a status read that fails after the cleanup delete does not claim the delete started', async () => {
    let deleted = false;
    route({
      CreatePipeCommand: () => ({}),
      DescribePipeCommand: () => {
        if (deleted) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        return described({ CurrentState: 'CREATE_FAILED' });
      },
      DeletePipeCommand: () => {
        deleted = true;
        return {};
      },
    });
    const error = await create(clocked());
    expect(error?.message).toMatch(UNCONFIRMED);
  });

  describe('on Ctrl-C', () => {
    let baseline: readonly unknown[] = [];
    beforeEach(() => {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      baseline = process.listeners('SIGINT');
    });
    afterEach(() => {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    });

    it('a Ctrl-C during the create settle retires the pipe with zero cleanup reads and no progress claim', async () => {
      let reads = 0;
      route({
        CreatePipeCommand: () => ({}),
        DescribePipeCommand: () => {
          reads += 1;
          const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
          for (const listener of ours) (listener as unknown as () => void)();
          return described({ CurrentState: 'CREATING' });
        },
        DeletePipeCommand: () => ({}),
      });
      const error = await create(clocked());
      // One settle read; the sticky latch ends the cleanup wait before any read.
      expect(reads).toBe(1);
      expect(sent(DeletePipeCommand)).toHaveLength(1);
      expect(error?.message).toMatch(UNCONFIRMED);
      expect(error?.message).not.toMatch(/started deleting/);
    });
  });
});

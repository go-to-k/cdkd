import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  CreateDeliveryCommand,
  DeleteDeliveryCommand,
  DeleteDeliveryDestinationCommand,
  DeleteDeliveryDestinationPolicyCommand,
  DeleteDeliverySourceCommand,
  DescribeDeliveriesCommand,
  GetDeliveryCommand,
  GetDeliveryDestinationCommand,
  GetDeliveryDestinationPolicyCommand,
  GetDeliverySourceCommand,
  ListTagsForResourceCommand,
  PutDeliveryDestinationCommand,
  PutDeliveryDestinationPolicyCommand,
  PutDeliverySourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateDeliveryConfigurationCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const mockSend = vi.fn();
let clientRegion = 'us-east-1';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: {
      send: (cmd: object) => mockSend(cmd),
      config: { region: () => Promise.resolve(clientRegion) },
    },
  }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ child: () => childLogger }),
}));

import { LogsDeliverySourceProvider } from '../../../src/provisioning/providers/logs-delivery-source-provider.js';
import { LogsDeliveryDestinationProvider } from '../../../src/provisioning/providers/logs-delivery-destination-provider.js';
import { LogsDeliveryProvider } from '../../../src/provisioning/providers/logs-delivery-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  priorAttemptLookup,
  withPriorAttempts,
} from '../../../src/deployment/prior-attempt-scope.js';

const SOURCE_ARN = 'arn:aws:logs:us-east-1:123456789012:delivery-source:src';
const DEST_ARN = 'arn:aws:logs:us-east-1:123456789012:delivery-destination:dst';
const DELIVERY_ARN = 'arn:aws:logs:us-east-1:123456789012:delivery:abc123';
const BUS_ARN = 'arn:aws:events:us-east-1:123456789012:event-bus/bus';
const GROUP_ARN = 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/vendedlogs/bus';

function notFound(): Error {
  return Object.assign(new Error('not found'), {
    name: 'ResourceNotFoundException',
    $fault: 'client',
    $metadata: {},
  });
}

function conflict(): Error {
  return Object.assign(new Error('still in use'), {
    name: 'ConflictException',
    $fault: 'client',
    $metadata: {},
  });
}

function inputsOf(klass: { new (...args: never[]): unknown }): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .map(([cmd]) => cmd as { input: Record<string, unknown> })
    .filter((cmd) => cmd instanceof klass)
    .map((cmd) => cmd.input);
}

/** Answer each command class with its handler; an unlisted command fails the test. */
function respond(handlers: Map<unknown, (input: Record<string, unknown>) => unknown>): void {
  mockSend.mockImplementation((cmd: { constructor: unknown; input: Record<string, unknown> }) => {
    const handler = handlers.get(cmd.constructor);
    if (!handler) throw new Error(`unexpected ${String((cmd.constructor as { name: string }).name)}`);
    return Promise.resolve().then(() => handler(cmd.input));
  });
}

const liveSource = {
  name: 'src',
  arn: SOURCE_ARN,
  resourceArns: [BUS_ARN],
  service: 'events',
  logType: 'ERROR_LOGS',
  status: 'ACTIVE',
};

beforeEach(() => {
  mockSend.mockReset();
  vi.clearAllMocks();
  clientRegion = 'us-east-1';
});

describe('LogsDeliverySourceProvider', () => {
  const provider = new LogsDeliverySourceProvider();
  const TYPE = 'AWS::Logs::DeliverySource';
  const props = {
    Name: 'src',
    ResourceArn: BUS_ARN,
    LogType: 'ERROR_LOGS',
    DeliverySourceConfiguration: { k: 'v' },
    Tags: [{ Key: 'team', Value: 'a' }],
  };

  it('creates the source after proving the name free, and returns every read-only attribute', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliverySourceCommand, () => Promise.reject(notFound())],
        [PutDeliverySourceCommand, () => ({ deliverySource: liveSource })],
      ])
    );
    const result = await provider.create('Src', TYPE, props);
    expect(result.physicalId).toBe('src');
    expect(result.attributes).toEqual({
      Arn: SOURCE_ARN,
      ResourceArns: [BUS_ARN],
      Service: 'events',
      Status: 'ACTIVE',
    });
    expect(inputsOf(PutDeliverySourceCommand)).toEqual([
      {
        name: 'src',
        resourceArn: BUS_ARN,
        logType: 'ERROR_LOGS',
        deliverySourceConfiguration: { k: 'v' },
        tags: { team: 'a' },
      },
    ]);
  });

  it('refuses to create over an existing source of the same name (Put is an upsert)', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliverySourceCommand, () => ({ deliverySource: liveSource })],
      ])
    );
    const error = await provider.create('Src', TYPE, props).catch((e: unknown) => e);
    expect(String(error)).toMatch(/already exists/);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(inputsOf(PutDeliverySourceCommand)).toHaveLength(0);
  });

  it('refuses a missing LogType before any AWS call', async () => {
    const { LogType: _omit, ...rest } = props;
    await expect(provider.create('Src', TYPE, rest)).rejects.toThrow(/LogType must be/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update re-puts only when a source member changed, and reconciles tags on the ARN', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliverySourceCommand, () => ({ deliverySource: liveSource })],
        [PutDeliverySourceCommand, () => ({ deliverySource: liveSource })],
        [TagResourceCommand, () => ({})],
        [UntagResourceCommand, () => ({})],
      ])
    );
    await provider.update('Src', 'src', TYPE, { ...props, Tags: [{ Key: 'new', Value: 'b' }] }, props);
    expect(inputsOf(PutDeliverySourceCommand)).toHaveLength(0);
    expect(inputsOf(UntagResourceCommand)).toEqual([{ resourceArn: SOURCE_ARN, tagKeys: ['team'] }]);
    expect(inputsOf(TagResourceCommand)).toEqual([{ resourceArn: SOURCE_ARN, tags: { new: 'b' } }]);

    mockSend.mockClear();
    await provider.update('Src', 'src', TYPE, { ...props, LogType: 'INFO_LOGS' }, props);
    expect(inputsOf(PutDeliverySourceCommand)).toEqual([
      {
        name: 'src',
        resourceArn: BUS_ARN,
        logType: 'INFO_LOGS',
        deliverySourceConfiguration: { k: 'v' },
      },
    ]);
    expect(inputsOf(GetDeliverySourceCommand)).toHaveLength(0);
  });

  it('delete treats not-found as gone, but surfaces a ConflictException', async () => {
    mockSend.mockRejectedValueOnce(notFound());
    await expect(provider.delete('Src', 'src', TYPE)).resolves.toBeUndefined();
    mockSend.mockRejectedValueOnce(conflict());
    await expect(provider.delete('Src', 'src', TYPE)).rejects.toThrow(/Failed to delete/);
  });

  it('delete refuses a not-found from a client in another region than the record', async () => {
    clientRegion = 'eu-west-1';
    mockSend.mockRejectedValueOnce(notFound());
    await expect(
      provider.delete('Src', 'src', TYPE, undefined, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow(/Refusing to treat NotFound/);
  });

  it('getAttribute, import and readCurrentState read the live source', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [
          GetDeliverySourceCommand,
          (i) =>
            i['name'] === 'src'
              ? { deliverySource: { ...liveSource, deliverySourceConfiguration: { k: 'v', d: '1' } } }
              : Promise.reject(notFound()),
        ],
        [ListTagsForResourceCommand, () => ({ tags: { team: 'a', 'aws:cdk:path': 'x' } })],
      ])
    );
    expect(await provider.getAttribute('src', TYPE, 'Service')).toBe('events');
    expect(await provider.import({ logicalId: 'Src', resourceType: TYPE, properties: { Name: 'src' } } as never)).toMatchObject({
      physicalId: 'src',
    });
    expect(await provider.import({ logicalId: 'Src', resourceType: TYPE, properties: { Name: 'nope' } } as never)).toBeNull();
    expect(await provider.readCurrentState('src', 'Src', TYPE, props)).toEqual({
      Name: 'src',
      ResourceArn: BUS_ARN,
      LogType: 'ERROR_LOGS',
      // Only the declared configuration key; AWS's default `d` is not drift.
      DeliverySourceConfiguration: { k: 'v' },
      Tags: [{ Key: 'team', Value: 'a' }],
    });
    expect(await provider.readCurrentState('nope', 'Src', TYPE)).toBe(RESOURCE_NOT_FOUND);
  });
});

describe('LogsDeliveryDestinationProvider', () => {
  const provider = new LogsDeliveryDestinationProvider();
  const TYPE = 'AWS::Logs::DeliveryDestination';
  const policyDoc = { Version: '2012-10-17', Statement: [{ Effect: 'Allow' }] };
  const props = {
    Name: 'dst',
    DestinationResourceArn: GROUP_ARN,
    OutputFormat: 'json',
    DeliveryDestinationPolicy: { DeliveryDestinationName: 'dst', DeliveryDestinationPolicy: policyDoc },
    Tags: [{ Key: 'team', Value: 'a' }],
  };
  const liveDest = {
    name: 'dst',
    arn: DEST_ARN,
    deliveryDestinationType: 'CWL',
    outputFormat: 'json',
    deliveryDestinationConfiguration: { destinationResourceArn: GROUP_ARN },
  };

  it('creates the destination, attaches the policy, and returns Arn', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, () => Promise.reject(notFound())],
        [PutDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })],
        [PutDeliveryDestinationPolicyCommand, () => ({})],
      ])
    );
    const result = await provider.create('Dst', TYPE, props);
    expect(result).toEqual({
      physicalId: 'dst',
      attributes: { Arn: DEST_ARN, DeliveryDestinationType: 'CWL' },
    });
    expect(inputsOf(PutDeliveryDestinationCommand)).toEqual([
      {
        name: 'dst',
        deliveryDestinationConfiguration: { destinationResourceArn: GROUP_ARN },
        outputFormat: 'json',
        tags: { team: 'a' },
      },
    ]);
    expect(inputsOf(PutDeliveryDestinationPolicyCommand)).toEqual([
      { deliveryDestinationName: 'dst', deliveryDestinationPolicy: JSON.stringify(policyDoc) },
    ]);
  });

  it('marks the created destination when the policy call after it fails', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, () => Promise.reject(notFound())],
        [PutDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })],
        [PutDeliveryDestinationPolicyCommand, () => Promise.reject(conflict())],
      ])
    );
    const error = await provider.create('Dst', TYPE, props).catch((e: unknown) => e);
    expect(createdBeforeFailure(error, 'Dst', TYPE)).toBe('dst');
  });

  it('refuses a policy block naming another destination before any call', async () => {
    const bad = {
      ...props,
      DeliveryDestinationPolicy: { DeliveryDestinationName: 'other', DeliveryDestinationPolicy: policyDoc },
    };
    await expect(provider.create('Dst', TYPE, bad)).rejects.toThrow(/must equal the destination Name/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update puts a changed policy and deletes a removed one', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })],
        [PutDeliveryDestinationPolicyCommand, () => ({})],
        [DeleteDeliveryDestinationPolicyCommand, () => ({})],
      ])
    );
    const changed = {
      ...props,
      DeliveryDestinationPolicy: { DeliveryDestinationPolicy: { ...policyDoc, Id: 'x' } },
    };
    await provider.update('Dst', 'dst', TYPE, changed, props);
    expect(inputsOf(PutDeliveryDestinationPolicyCommand)).toHaveLength(1);

    mockSend.mockClear();
    const { DeliveryDestinationPolicy: _drop, ...removed } = props;
    await provider.update('Dst', 'dst', TYPE, removed, props);
    expect(inputsOf(DeleteDeliveryDestinationPolicyCommand)).toEqual([
      { deliveryDestinationName: 'dst' },
    ]);
    expect(inputsOf(PutDeliveryDestinationPolicyCommand)).toHaveLength(0);
  });

  it('delete is idempotent on not-found', async () => {
    mockSend.mockRejectedValueOnce(notFound());
    await expect(provider.delete('Dst', 'dst', TYPE)).resolves.toBeUndefined();
    expect(inputsOf(DeleteDeliveryDestinationCommand)).toEqual([{ name: 'dst' }]);
  });

  it('readCurrentState reads the destination, its policy and tags in the CFn shape', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })],
        [
          GetDeliveryDestinationPolicyCommand,
          () => ({ policy: { deliveryDestinationPolicy: JSON.stringify(policyDoc) } }),
        ],
        [ListTagsForResourceCommand, () => ({ tags: { team: 'a' } })],
      ])
    );
    expect(await provider.readCurrentState('dst', 'Dst', TYPE, props)).toEqual({
      Name: 'dst',
      DestinationResourceArn: GROUP_ARN,
      DeliveryDestinationType: 'CWL',
      OutputFormat: 'json',
      DeliveryDestinationPolicy: { DeliveryDestinationName: 'dst', DeliveryDestinationPolicy: policyDoc },
      Tags: [{ Key: 'team', Value: 'a' }],
    });
  });
});

describe('LogsDeliveryProvider', () => {
  const provider = new LogsDeliveryProvider();
  const TYPE = 'AWS::Logs::Delivery';
  const props = {
    DeliverySourceName: 'src',
    DeliveryDestinationArn: DEST_ARN,
    RecordFields: ['a', 'b'],
    FieldDelimiter: ',',
    S3SuffixPath: 'p/',
    S3EnableHiveCompatiblePath: 'true',
    Tags: [{ Key: 'team', Value: 'a' }],
  };
  const liveDelivery = {
    id: 'abc123',
    arn: DELIVERY_ARN,
    deliverySourceName: 'src',
    deliveryDestinationArn: DEST_ARN,
    deliveryDestinationType: 'CWL',
    recordFields: ['a', 'b'],
    fieldDelimiter: ',',
    s3DeliveryConfiguration: { suffixPath: 'p/', enableHiveCompatiblePath: true },
  };

  it('creates the delivery with every member and records the delivery id', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [CreateDeliveryCommand, () => ({ delivery: liveDelivery })],
      ])
    );
    const result = await provider.create('Del', TYPE, props);
    expect(result).toEqual({
      physicalId: 'abc123',
      attributes: { DeliveryId: 'abc123', Arn: DELIVERY_ARN, DeliveryDestinationType: 'CWL' },
    });
    expect(inputsOf(CreateDeliveryCommand)).toEqual([
      {
        deliverySourceName: 'src',
        deliveryDestinationArn: DEST_ARN,
        recordFields: ['a', 'b'],
        fieldDelimiter: ',',
        s3DeliveryConfiguration: { suffixPath: 'p/', enableHiveCompatiblePath: true },
        tags: { team: 'a' },
      },
    ]);
  });

  it('refuses a malformed S3EnableHiveCompatiblePath before any call', async () => {
    await expect(
      provider.create('Del', TYPE, { ...props, S3EnableHiveCompatiblePath: 'yes' })
    ).rejects.toThrow(/S3EnableHiveCompatiblePath must be a boolean/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update sends a changed configuration and warns that a removed member keeps its value', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [UpdateDeliveryConfigurationCommand, () => ({})],
        [GetDeliveryCommand, () => ({ delivery: liveDelivery })],
      ])
    );
    const { FieldDelimiter: _drop, ...rest } = props;
    await provider.update('Del', 'abc123', TYPE, { ...rest, RecordFields: ['a'] }, props);
    expect(inputsOf(UpdateDeliveryConfigurationCommand)).toEqual([
      {
        id: 'abc123',
        recordFields: ['a'],
        s3DeliveryConfiguration: { suffixPath: 'p/', enableHiveCompatiblePath: true },
      },
    ]);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('FieldDelimiter'));

    // Only a removal: nothing to send.
    mockSend.mockClear();
    await provider.update('Del', 'abc123', TYPE, rest, props);
    expect(inputsOf(UpdateDeliveryConfigurationCommand)).toHaveLength(0);
  });

  it('delete is idempotent on not-found', async () => {
    mockSend.mockRejectedValueOnce(notFound());
    await expect(provider.delete('Del', 'abc123', TYPE)).resolves.toBeUndefined();
    expect(inputsOf(DeleteDeliveryCommand)).toEqual([{ id: 'abc123' }]);
  });

  it('import adopts by id, or by the source/destination pair, and returns null when absent', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryCommand, (i) => (i['id'] === 'abc123' ? { delivery: liveDelivery } : Promise.reject(notFound()))],
        [
          DescribeDeliveriesCommand,
          () => ({ deliveries: [{ ...liveDelivery, id: 'other', deliveryDestinationArn: 'x' }, liveDelivery] }),
        ],
      ])
    );
    const base = { logicalId: 'Del', resourceType: TYPE };
    expect(await provider.import({ ...base, knownPhysicalId: 'abc123', properties: {} } as never)).toMatchObject({
      physicalId: 'abc123',
    });
    expect(await provider.import({ ...base, knownPhysicalId: 'gone', properties: {} } as never)).toBeNull();
    expect(await provider.import({ ...base, properties: props } as never)).toMatchObject({
      physicalId: 'abc123',
    });
    expect(inputsOf(DescribeDeliveriesCommand)[0]).toMatchObject({ deliverySourceNames: ['src'] });
  });

  it('getAttribute and readCurrentState read the live delivery', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryCommand, () => ({ delivery: liveDelivery })],
        [ListTagsForResourceCommand, () => ({ tags: { team: 'a' } })],
      ])
    );
    expect(await provider.getAttribute('abc123', TYPE, 'Arn')).toBe(DELIVERY_ARN);
    expect(await provider.getAttribute('abc123', TYPE, 'DeliveryId')).toBe('abc123');
    expect(await provider.readCurrentState('abc123', 'Del', TYPE)).toEqual({
      DeliverySourceName: 'src',
      DeliveryDestinationArn: DEST_ARN,
      RecordFields: ['a', 'b'],
      FieldDelimiter: ',',
      S3SuffixPath: 'p/',
      S3EnableHiveCompatiblePath: true,
      Tags: [{ Key: 'team', Value: 'a' }],
    });
  });
});

function accessDenied(): Error {
  return Object.assign(new Error('not authorized'), {
    name: 'AccessDeniedException',
    $fault: 'client',
    $metadata: {},
  });
}

function throttled(): Error {
  return Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'client',
    $metadata: {},
  });
}

describe('the delivery providers: guards and edge paths', () => {
  const source = new LogsDeliverySourceProvider();
  const destination = new LogsDeliveryDestinationProvider();
  const delivery = new LogsDeliveryProvider();
  const policyDoc = { Version: '2012-10-17', Statement: [{ Effect: 'Allow' }] };
  const destProps = {
    Name: 'dst',
    DestinationResourceArn: GROUP_ARN,
    DeliveryDestinationPolicy: { DeliveryDestinationPolicy: policyDoc },
  };
  const liveDest = { name: 'dst', arn: DEST_ARN, deliveryDestinationType: 'CWL' };
  const srcProps = { Name: 'src', ResourceArn: BUS_ARN, LogType: 'INFO_LOGS' };
  const delProps = { DeliverySourceName: 'src', DeliveryDestinationArn: DEST_ARN, RecordFields: ['a'] };

  it('a name probe failing with AccessDenied rejects the create and sends no Put (source and destination)', async () => {
    mockSend.mockRejectedValue(accessDenied());
    await expect(source.create('Src', 'AWS::Logs::DeliverySource', srcProps)).rejects.toThrow(
      /Failed to create/
    );
    await expect(
      destination.create('Dst', 'AWS::Logs::DeliveryDestination', destProps)
    ).rejects.toThrow(/Failed to create/);
    expect(inputsOf(PutDeliverySourceCommand)).toHaveLength(0);
    expect(inputsOf(PutDeliveryDestinationCommand)).toHaveLength(0);
  });

  it('refuses to create over an existing destination of the same name', async () => {
    respond(new Map<unknown, (i: Record<string, unknown>) => unknown>([[GetDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })]]));
    const error = await destination
      .create('Dst', 'AWS::Logs::DeliveryDestination', destProps)
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/already exists/);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(inputsOf(PutDeliveryDestinationCommand)).toHaveLength(0);
  });

  it('a retried create after the policy Put was throttled adopts the destination it made', async () => {
    let exists = false;
    let policyCalls = 0;
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [
          GetDeliveryDestinationCommand,
          () => (exists ? { deliveryDestination: liveDest } : Promise.reject(notFound())),
        ],
        [
          PutDeliveryDestinationCommand,
          () => {
            exists = true;
            return { deliveryDestination: liveDest };
          },
        ],
        [
          PutDeliveryDestinationPolicyCommand,
          () => (++policyCalls === 1 ? Promise.reject(throttled()) : {}),
        ],
      ])
    );
    const lookup = priorAttemptLookup('Dst', () => Promise.resolve([]));
    await withPriorAttempts(lookup, async () => {
      const first = await destination
        .create('Dst', 'AWS::Logs::DeliveryDestination', destProps)
        .catch((e: unknown) => e);
      expect(String(first)).toMatch(/ThrottlingException/);
      expect(String(first)).not.toMatch(/already exists/);
      const second = await destination.create('Dst', 'AWS::Logs::DeliveryDestination', destProps);
      expect(second.physicalId).toBe('dst');
    });
    expect(inputsOf(PutDeliveryDestinationPolicyCommand)).toHaveLength(2);
  });

  it('update refuses a policy naming another destination before any call', async () => {
    const bad = {
      ...destProps,
      DeliveryDestinationPolicy: { DeliveryDestinationName: 'other', DeliveryDestinationPolicy: policyDoc },
    };
    await expect(
      destination.update('Dst', 'dst', 'AWS::Logs::DeliveryDestination', bad, destProps)
    ).rejects.toThrow(/must equal the destination Name/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a policy document given as a JSON string, as CloudFormation does', async () => {
    const bad = { ...destProps, DeliveryDestinationPolicy: { DeliveryDestinationPolicy: '{}' } };
    await expect(destination.create('Dst', 'AWS::Logs::DeliveryDestination', bad)).rejects.toThrow(
      /must be a policy document object/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an unchanged policy sends no Put; a changed one sends the new document', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })],
        [PutDeliveryDestinationPolicyCommand, () => ({})],
      ])
    );
    await destination.update('Dst', 'dst', 'AWS::Logs::DeliveryDestination', destProps, destProps);
    expect(inputsOf(PutDeliveryDestinationPolicyCommand)).toHaveLength(0);
    const next = { ...policyDoc, Id: 'x' };
    await destination.update(
      'Dst',
      'dst',
      'AWS::Logs::DeliveryDestination',
      { ...destProps, DeliveryDestinationPolicy: { DeliveryDestinationPolicy: next } },
      destProps
    );
    expect(inputsOf(PutDeliveryDestinationPolicyCommand)).toEqual([
      { deliveryDestinationName: 'dst', deliveryDestinationPolicy: JSON.stringify(next) },
    ]);
  });

  it('a removed policy already gone is not an error', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })],
        [DeleteDeliveryDestinationPolicyCommand, () => Promise.reject(notFound())],
      ])
    );
    const { DeliveryDestinationPolicy: _drop, ...removed } = destProps;
    await expect(
      destination.update('Dst', 'dst', 'AWS::Logs::DeliveryDestination', removed, destProps)
    ).resolves.toMatchObject({ physicalId: 'dst' });
  });

  it.each([
    ['source', () => source.update('Src', 'src', 'AWS::Logs::DeliverySource', srcProps, srcProps, { expectedRegion: 'us-east-1' })],
    ['destination', () => destination.update('Dst', 'dst', 'AWS::Logs::DeliveryDestination', destProps, destProps, { expectedRegion: 'us-east-1' })],
    ['delivery', () => delivery.update('Del', 'abc123', 'AWS::Logs::Delivery', delProps, delProps, { expectedRegion: 'us-east-1' })],
  ])('the %s update refuses a client in another region before any call', async (_n, run) => {
    clientRegion = 'eu-west-1';
    await expect(run()).rejects.toThrow(/Refusing/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['destination', () => destination.delete('Dst', 'dst', 'AWS::Logs::DeliveryDestination', undefined, { expectedRegion: 'us-east-1' })],
    ['delivery', () => delivery.delete('Del', 'abc123', 'AWS::Logs::Delivery', undefined, { expectedRegion: 'us-east-1' })],
  ])('the %s delete refuses a not-found from a client in another region', async (_n, run) => {
    clientRegion = 'eu-west-1';
    mockSend.mockRejectedValueOnce(notFound());
    await expect(run()).rejects.toThrow(/Refusing to treat NotFound/);
  });

  it('a state-borne malformed value warns and is skipped rather than refused', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, () => Promise.reject(notFound())],
        [PutDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })],
      ])
    );
    const bad = { ...destProps, DeliveryDestinationPolicy: 'nope' };
    await expect(
      destination.create('Dst', 'AWS::Logs::DeliveryDestination', bad, { replayingState: true })
    ).resolves.toMatchObject({ physicalId: 'dst' });
    expect(inputsOf(PutDeliveryDestinationPolicyCommand)).toHaveLength(0);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('state-borne'));

    mockSend.mockReset();
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [UpdateDeliveryConfigurationCommand, () => ({})],
        [GetDeliveryCommand, () => ({ delivery: { id: 'abc123', arn: DELIVERY_ARN } })],
      ])
    );
    await expect(
      delivery.update(
        'Del',
        'abc123',
        'AWS::Logs::Delivery',
        { ...delProps, RecordFields: 'x', FieldDelimiter: '|' },
        delProps,
        { replayingState: true }
      )
    ).resolves.toMatchObject({ physicalId: 'abc123' });
    expect(inputsOf(UpdateDeliveryConfigurationCommand)).toEqual([{ id: 'abc123', fieldDelimiter: '|' }]);
  });

  it('readCurrentState reports a destination without a policy, and echoes no undeclared name member', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })],
        [GetDeliveryDestinationPolicyCommand, () => Promise.reject(notFound())],
        [ListTagsForResourceCommand, () => ({ tags: {} })],
      ])
    );
    const none = await destination.readCurrentState('dst', 'Dst', 'AWS::Logs::DeliveryDestination', destProps);
    expect(none).not.toBe(RESOURCE_NOT_FOUND);
    expect(none).not.toHaveProperty('DeliveryDestinationPolicy');

    mockSend.mockReset();
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, () => ({ deliveryDestination: liveDest })],
        [GetDeliveryDestinationPolicyCommand, () => ({ policy: { deliveryDestinationPolicy: JSON.stringify(policyDoc) } })],
        [ListTagsForResourceCommand, () => ({ tags: {} })],
      ])
    );
    const withPolicy = await destination.readCurrentState('dst', 'Dst', 'AWS::Logs::DeliveryDestination', destProps);
    expect(withPolicy).toMatchObject({ DeliveryDestinationPolicy: { DeliveryDestinationPolicy: policyDoc } });
    expect((withPolicy as Record<string, Record<string, unknown>>)['DeliveryDestinationPolicy']).not.toHaveProperty(
      'DeliveryDestinationName'
    );
  });

  it('destination getAttribute and import read the live destination', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [GetDeliveryDestinationCommand, (i) => (i['name'] === 'dst' ? { deliveryDestination: liveDest } : Promise.reject(notFound()))],
      ])
    );
    expect(await destination.getAttribute('dst', 'AWS::Logs::DeliveryDestination', 'Arn')).toBe(DEST_ARN);
    expect(
      await destination.import({ logicalId: 'Dst', resourceType: 'AWS::Logs::DeliveryDestination', properties: { Name: 'dst' } } as never)
    ).toMatchObject({ physicalId: 'dst', attributes: { Arn: DEST_ARN } });
    expect(
      await destination.import({ logicalId: 'Dst', resourceType: 'AWS::Logs::DeliveryDestination', properties: { Name: 'gone' } } as never)
    ).toBeNull();
  });

  it('delivery import follows DescribeDeliveries pages', async () => {
    respond(
      new Map<unknown, (i: Record<string, unknown>) => unknown>([
        [
          DescribeDeliveriesCommand,
          (i) =>
            i['nextToken'] === undefined
              ? { deliveries: [{ id: 'other', deliverySourceName: 'src', deliveryDestinationArn: 'x' }], nextToken: 't1' }
              : { deliveries: [{ id: 'abc123', arn: DELIVERY_ARN, deliverySourceName: 'src', deliveryDestinationArn: DEST_ARN }] },
        ],
      ])
    );
    expect(
      await delivery.import({ logicalId: 'Del', resourceType: 'AWS::Logs::Delivery', properties: delProps } as never)
    ).toMatchObject({ physicalId: 'abc123' });
    expect(inputsOf(DescribeDeliveriesCommand)).toHaveLength(2);
  });

  it('a CreateDelivery answer without an id fails the create', async () => {
    respond(new Map<unknown, (i: Record<string, unknown>) => unknown>([[CreateDeliveryCommand, () => ({ delivery: {} })]]));
    await expect(delivery.create('Del', 'AWS::Logs::Delivery', delProps)).rejects.toThrow(
      /returned no delivery id/
    );
  });
});

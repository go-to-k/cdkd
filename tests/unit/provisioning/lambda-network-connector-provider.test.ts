import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  CreateNetworkConnectorCommand,
  GetNetworkConnectorCommand,
  UpdateNetworkConnectorCommand,
  DeleteNetworkConnectorCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda-core';
import { TagResourceCommand, UntagResourceCommand, ListTagsCommand } from '@aws-sdk/client-lambda';

const mockSend = vi.fn();
// Which client sent each command: tags must go through Lambda, the rest
// through Lambda Core.
const sentBy: Array<{ client: 'core' | 'lambda'; command: string }> = [];
let clientRegion = 'us-east-1';

vi.mock('../../../src/utils/aws-clients.js', () => {
  const via = (client: 'core' | 'lambda') => (cmd: object) => {
    sentBy.push({ client, command: cmd.constructor.name });
    return mockSend(cmd);
  };
  return {
    getAwsClients: () => ({
      lambdaCore: { send: via('core'), config: { region: () => Promise.resolve(clientRegion) } },
      lambda: { send: via('lambda'), config: { region: () => Promise.resolve(clientRegion) } },
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

// The waits poll every second; the tests drive state transitions, not time.
vi.mock('../../../src/provisioning/providers/lambda-web-function-arns.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sleep: () => Promise.resolve(),
}));

import { LambdaNetworkConnectorProvider } from '../../../src/provisioning/providers/lambda-network-connector-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

const TYPE = 'AWS::Lambda::NetworkConnector';
const ARN = 'arn:aws:lambda:us-east-1:123456789012:network-connector:nc-1';
const ROLE = 'arn:aws:iam::123456789012:role/op';
const props = {
  Name: 'egress',
  OperatorRole: ROLE,
  Configuration: {
    VpcEgressConfiguration: {
      SubnetIds: ['subnet-a', 'subnet-b'],
      SecurityGroupIds: ['sg-1'],
      NetworkProtocol: 'IPv4',
      AssociatedComputeResourceTypes: ['WebFunction'],
    },
  },
  Tags: [{ Key: 'team', Value: 'web' }],
};
const active = {
  Arn: ARN,
  State: 'ACTIVE',
  LatestVersion: 1,
  LatestVersionArn: `${ARN}:1`,
};

function callsOf(klass: { new (...args: never[]): unknown }): Array<{ input: Record<string, unknown> }> {
  return mockSend.mock.calls
    .filter((call) => (call[0] as object).constructor.name === klass.name)
    .map((call) => call[0] as { input: Record<string, unknown> });
}

function notFound(): ResourceNotFoundException {
  return new ResourceNotFoundException({ message: 'not found', $metadata: {} });
}

function respond(map: Map<string, unknown[]>): void {
  mockSend.mockImplementation(async (cmd: object) => {
    const queue = map.get(cmd.constructor.name);
    if (!queue || queue.length === 0) throw new Error(`unexpected ${cmd.constructor.name}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
}

beforeEach(() => {
  resetIdempotencyTokensForTests();
  sentBy.length = 0;
  mockSend.mockReset();
  clientRegion = 'us-east-1';
});

describe('LambdaNetworkConnectorProvider', () => {
  const provider = new LambdaNetworkConnectorProvider();

  it('create sends the SDK shape with a client token and waits for ACTIVE', async () => {
    respond(
      new Map<string, unknown[]>([
        ['CreateNetworkConnectorCommand', [{ Arn: ARN, State: 'PENDING' }]],
        ['GetNetworkConnectorCommand', [{ State: 'PENDING' }, active]],
      ])
    );
    const result = await provider.create('Nc', TYPE, props);
    const input = callsOf(CreateNetworkConnectorCommand)[0]!.input;
    expect(input).toMatchObject({
      Name: 'egress',
      OperatorRole: ROLE,
      Configuration: {
        VpcEgressConfiguration: {
          SubnetIds: ['subnet-a', 'subnet-b'],
          SecurityGroupIds: ['sg-1'],
          NetworkProtocol: 'IPv4',
          AssociatedComputeResourceTypes: ['WebFunction'],
        },
      },
      Tags: { team: 'web' },
    });
    expect(typeof input['ClientToken']).toBe('string');
    expect(callsOf(GetNetworkConnectorCommand)).toHaveLength(2);
    expect(result).toEqual({
      physicalId: ARN,
      attributes: { Arn: ARN, State: 'ACTIVE', LatestVersion: 1, LatestVersionArn: `${ARN}:1` },
    });
  });

  it('create generates a name when the template gives none', async () => {
    respond(
      new Map<string, unknown[]>([
        ['CreateNetworkConnectorCommand', [{ Arn: ARN }]],
        ['GetNetworkConnectorCommand', [active]],
      ])
    );
    const { Name: _n, ...unnamed } = props;
    await provider.create('Nc', TYPE, unnamed);
    const name = callsOf(CreateNetworkConnectorCommand)[0]!.input['Name'] as string;
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('create refuses a missing VpcEgressConfiguration or a non-list SubnetIds before any call', async () => {
    await expect(provider.create('Nc', TYPE, { ...props, Configuration: {} })).rejects.toThrow(
      'Configuration.VpcEgressConfiguration must be an object'
    );
    await expect(
      provider.create('Nc', TYPE, {
        ...props,
        Configuration: { VpcEgressConfiguration: { SubnetIds: 'subnet-a' } },
      })
    ).rejects.toThrow('SubnetIds must be a list of strings');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a create that ends FAILED fails the deploy for good: marked, non-retryable, not deleted', async () => {
    respond(
      new Map<string, unknown[]>([
        ['CreateNetworkConnectorCommand', [{ Arn: ARN }]],
        [
          'GetNetworkConnectorCommand',
          [{ State: 'FAILED', StateReason: 'The operator role does not have sufficient permissions' }],
        ],
      ])
    );
    const failed = await provider.create('Nc', TYPE, props).catch((e: unknown) => e);
    expect(String(failed)).toContain('entered FAILED: The operator role does not have sufficient permissions');
    expect(createdBeforeFailure(failed, 'Nc', TYPE)).toBe(ARN);
    expect(isMarkedNonRetryable(failed)).toBe(true);
    expect(callsOf(DeleteNetworkConnectorCommand)).toHaveLength(0);
  });

  it('a failure that is not a terminal state stays retryable', async () => {
    respond(
      new Map<string, unknown[]>([
        ['CreateNetworkConnectorCommand', [{ Arn: ARN }]],
        ['GetNetworkConnectorCommand', [new Error('socket hang up')]],
      ])
    );
    const failed = await provider.create('Nc', TYPE, props).catch((e: unknown) => e);
    expect(isMarkedNonRetryable(failed)).toBe(false);
    expect(createdBeforeFailure(failed, 'Nc', TYPE)).toBe(ARN);
  });

  it('a create call that fails before an ARN marks nothing', async () => {
    respond(new Map<string, unknown[]>([['CreateNetworkConnectorCommand', [new Error('denied')]]]));
    const refused = await provider.create('Nc', TYPE, props).catch((e: unknown) => e);
    expect(createdBeforeFailure(refused, 'Nc', TYPE)).toBeUndefined();
  });

  it('update sends a changed configuration and waits until the update leaves InProgress', async () => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateNetworkConnectorCommand', [{}]],
        ['GetNetworkConnectorCommand', [{ ...active, LastUpdateStatus: 'InProgress' }, { ...active, LastUpdateStatus: 'Successful' }]],
      ])
    );
    const next = {
      ...props,
      Configuration: {
        VpcEgressConfiguration: { ...props.Configuration.VpcEgressConfiguration, SecurityGroupIds: ['sg-2'] },
      },
    };
    await provider.update('Nc', ARN, TYPE, next, props);
    expect(callsOf(UpdateNetworkConnectorCommand)[0]!.input).toMatchObject({
      Identifier: ARN,
      OperatorRole: ROLE,
      Configuration: { VpcEgressConfiguration: { SecurityGroupIds: ['sg-2'] } },
    });
    expect(callsOf(GetNetworkConnectorCommand)).toHaveLength(2);
  });

  it('a tags-only update tags through Lambda and sends no UpdateNetworkConnector', async () => {
    respond(
      new Map<string, unknown[]>([
        ['TagResourceCommand', [{}]],
        ['UntagResourceCommand', [{}]],
        ['GetNetworkConnectorCommand', [active]],
      ])
    );
    await provider.update('Nc', ARN, TYPE, { ...props, Tags: [{ Key: 'owner', Value: 'me' }] }, props);
    expect(callsOf(UpdateNetworkConnectorCommand)).toHaveLength(0);
    expect(callsOf(UntagResourceCommand)[0]!.input).toEqual({ Resource: ARN, TagKeys: ['team'] });
    expect(callsOf(TagResourceCommand)[0]!.input).toEqual({ Resource: ARN, Tags: { owner: 'me' } });
    expect(sentBy.filter((c) => c.client === 'lambda').map((c) => c.command).sort()).toEqual([
      'TagResourceCommand',
      'UntagResourceCommand',
    ]);
  });

  it('update fails when the connector update ends Failed', async () => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateNetworkConnectorCommand', [{}]],
        ['GetNetworkConnectorCommand', [{ ...active, LastUpdateStatus: 'Failed', LastUpdateStatusReason: 'bad sg' }]],
      ])
    );
    await expect(
      provider.update('Nc', ARN, TYPE, { ...props, OperatorRole: `${ROLE}2` }, props)
    ).rejects.toThrow('update failed: bad sg');
  });

  it('update refuses a wrong-region client and a malformed configuration before any write', async () => {
    clientRegion = 'eu-west-1';
    await expect(
      provider.update('Nc', ARN, TYPE, props, props, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow(/eu-west-1[\s\S]*us-east-1|us-east-1[\s\S]*eu-west-1/);
    clientRegion = 'us-east-1';
    await expect(provider.update('Nc', ARN, TYPE, { ...props, Configuration: 'x' }, props)).rejects.toThrow(
      'Configuration.VpcEgressConfiguration must be an object'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('delete waits until the connector reads as gone, and fails on DELETE_FAILED', async () => {
    respond(
      new Map<string, unknown[]>([
        ['DeleteNetworkConnectorCommand', [{ State: 'DELETING' }]],
        ['GetNetworkConnectorCommand', [{ State: 'DELETING' }, notFound()]],
      ])
    );
    await provider.delete('Nc', ARN, TYPE);
    expect(callsOf(DeleteNetworkConnectorCommand)[0]!.input).toEqual({ Identifier: ARN });
    expect(callsOf(GetNetworkConnectorCommand)).toHaveLength(2);

    respond(
      new Map<string, unknown[]>([
        ['DeleteNetworkConnectorCommand', [{}]],
        ['GetNetworkConnectorCommand', [{ State: 'DELETE_FAILED', StateReason: 'in use' }]],
      ])
    );
    await expect(provider.delete('Nc', ARN, TYPE)).rejects.toThrow('entered DELETE_FAILED: in use');
  });

  it('delete treats not-found as deleted in the expected region, and refuses it from another region', async () => {
    respond(new Map<string, unknown[]>([['DeleteNetworkConnectorCommand', [notFound()]]]));
    await expect(provider.delete('Nc', ARN, TYPE, {}, { expectedRegion: 'us-east-1' })).resolves.toBeUndefined();
    clientRegion = 'eu-west-1';
    await expect(provider.delete('Nc', ARN, TYPE, {}, { expectedRegion: 'us-east-1' })).rejects.toThrow(
      /eu-west-1[\s\S]*us-east-1|us-east-1[\s\S]*eu-west-1/
    );
  });

  it('import finds the connector by override or by template Name, and returns null when it is gone', async () => {
    respond(new Map<string, unknown[]>([['GetNetworkConnectorCommand', [active]]]));
    await expect(
      provider.import({ logicalId: 'Nc', resourceType: TYPE, properties: props } as never)
    ).resolves.toMatchObject({ physicalId: ARN });
    expect(callsOf(GetNetworkConnectorCommand)[0]!.input).toEqual({ Identifier: 'egress' });
    respond(new Map<string, unknown[]>([['GetNetworkConnectorCommand', [notFound()]]]));
    await expect(
      provider.import({ logicalId: 'Nc', resourceType: TYPE, knownPhysicalId: ARN } as never)
    ).resolves.toBeNull();
  });

  it('readCurrentState reports the live connector and its tags in the CFn shape', async () => {
    respond(
      new Map<string, unknown[]>([
        [
          'GetNetworkConnectorCommand',
          [
            {
              ...active,
              Name: 'egress',
              OperatorRole: ROLE,
              Configuration: { VpcEgressConfiguration: props.Configuration.VpcEgressConfiguration },
            },
          ],
        ],
        ['ListTagsCommand', [{ Tags: { team: 'web' } }]],
      ])
    );
    await expect(provider.readCurrentState(ARN, 'Nc', TYPE)).resolves.toEqual({
      Name: 'egress',
      OperatorRole: ROLE,
      Configuration: props.Configuration,
      Tags: [{ Key: 'team', Value: 'web' }],
    });
    expect(callsOf(ListTagsCommand)[0]!.input).toEqual({ Resource: ARN });
    respond(new Map<string, unknown[]>([['GetNetworkConnectorCommand', [notFound()]]]));
    await expect(provider.readCurrentState(ARN, 'Nc', TYPE)).resolves.toBe(RESOURCE_NOT_FOUND);
  });

  it('getAttribute returns Arn without a call and the version from AWS', async () => {
    await expect(provider.getAttribute(ARN, TYPE, 'Arn')).resolves.toBe(ARN);
    expect(mockSend).not.toHaveBeenCalled();
    respond(new Map<string, unknown[]>([['GetNetworkConnectorCommand', [active]]]));
    await expect(provider.getAttribute(ARN, TYPE, 'LatestVersionArn')).resolves.toBe(`${ARN}:1`);
  });
});

describe('LambdaNetworkConnectorProvider — review round gaps', () => {
  const provider = new LambdaNetworkConnectorProvider();

  it('update refuses a template that drops OperatorRole, and leaves the role alone on a state-borne bag', async () => {
    const { OperatorRole: _r, ...noRole } = props;
    await expect(provider.update('Nc', ARN, TYPE, noRole, props)).rejects.toThrow(
      'OperatorRole cannot be removed in place'
    );
    expect(mockSend).not.toHaveBeenCalled();
    respond(
      new Map<string, unknown[]>([
        ['UpdateNetworkConnectorCommand', [{}]],
        ['GetNetworkConnectorCommand', [active]],
      ])
    );
    await provider.update('Nc', ARN, TYPE, noRole, props, { replayingState: true });
    expect(callsOf(UpdateNetworkConnectorCommand)[0]!.input).not.toHaveProperty('OperatorRole');
  });

  it('import prefers the --resource override over the template Name', async () => {
    respond(new Map<string, unknown[]>([['GetNetworkConnectorCommand', [active]]]));
    await provider.import({ logicalId: 'Nc', resourceType: TYPE, knownPhysicalId: ARN, properties: props } as never);
    expect(callsOf(GetNetworkConnectorCommand)[0]!.input).toEqual({ Identifier: ARN });
  });

  it('readCurrentState reports a connector that vanished between the Get and ListTags as not found', async () => {
    const { ResourceNotFoundException: LambdaNotFound } = await import('@aws-sdk/client-lambda');
    respond(
      new Map<string, unknown[]>([
        ['GetNetworkConnectorCommand', [{ ...active, Name: 'egress' }]],
        ['ListTagsCommand', [new LambdaNotFound({ message: 'gone', $metadata: {} })]],
      ])
    );
    await expect(provider.readCurrentState(ARN, 'Nc', TYPE)).resolves.toBe(RESOURCE_NOT_FOUND);
    expect(sentBy.find((c) => c.command === 'ListTagsCommand')?.client).toBe('lambda');
  });

  it('create refuses a non-string NetworkProtocol, and an ARN-less create response', async () => {
    await expect(
      provider.create('Nc', TYPE, {
        ...props,
        Configuration: { VpcEgressConfiguration: { ...props.Configuration.VpcEgressConfiguration, NetworkProtocol: 4 } },
      })
    ).rejects.toThrow('NetworkProtocol must be a string');
    expect(mockSend).not.toHaveBeenCalled();
    respond(new Map<string, unknown[]>([['CreateNetworkConnectorCommand', [{}]]]));
    await expect(provider.create('Nc', TYPE, props)).rejects.toThrow('returned no ARN');
  });

  it('update fails when the connector itself ends FAILED', async () => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateNetworkConnectorCommand', [{}]],
        ['GetNetworkConnectorCommand', [{ ...active, State: 'FAILED', StateReason: 'subnet gone' }]],
      ])
    );
    await expect(
      provider.update('Nc', ARN, TYPE, { ...props, OperatorRole: `${ROLE}2` }, props)
    ).rejects.toThrow('entered FAILED: subnet gone');
  });

  it('a config and tag change tags before the update puts the connector in progress', async () => {
    respond(
      new Map<string, unknown[]>([
        ['TagResourceCommand', [{}]],
        ['UntagResourceCommand', [{}]],
        ['UpdateNetworkConnectorCommand', [{}]],
        ['GetNetworkConnectorCommand', [{ ...active, LastUpdateStatus: 'Successful' }]],
      ])
    );
    await provider.update(
      'Nc',
      ARN,
      TYPE,
      { ...props, OperatorRole: `${ROLE}2`, Tags: [{ Key: 'owner', Value: 'me' }] },
      props
    );
    const order = sentBy.map((c) => c.command);
    expect(order.indexOf('TagResourceCommand')).toBeLessThan(order.indexOf('UpdateNetworkConnectorCommand'));
    expect(order.indexOf('UntagResourceCommand')).toBeLessThan(order.indexOf('UpdateNetworkConnectorCommand'));
  });

  it('a wait that meets DELETING fails at once instead of polling to the cap', async () => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateNetworkConnectorCommand', [{}]],
        ['GetNetworkConnectorCommand', [{ ...active, State: 'DELETING', StateReason: 'deleted elsewhere' }]],
      ])
    );
    await expect(
      provider.update('Nc', ARN, TYPE, { ...props, OperatorRole: `${ROLE}2` }, props)
    ).rejects.toThrow('entered DELETING: deleted elsewhere');
    expect(callsOf(GetNetworkConnectorCommand)).toHaveLength(1);
  });

  it('a create re-run after a lost response resends the same ClientToken; a success releases it', async () => {
    respond(new Map<string, unknown[]>([['CreateNetworkConnectorCommand', [new Error('socket hang up')]]]));
    await expect(provider.create('Nc', TYPE, props)).rejects.toThrow('socket hang up');
    respond(
      new Map<string, unknown[]>([
        ['CreateNetworkConnectorCommand', [{ Arn: ARN }]],
        ['GetNetworkConnectorCommand', [active]],
      ])
    );
    await provider.create('Nc', TYPE, props);
    await provider.create('Nc', TYPE, props);
    const tokens = callsOf(CreateNetworkConnectorCommand).map((c) => c.input['ClientToken']);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[1]);
  });

  it('a non-string OperatorRole is refused on a template path and omitted on a replay', async () => {
    const bad = { ...props, OperatorRole: { 'Fn::GetAtt': ['Role', 'Arn'] } };
    await expect(provider.create('Nc', TYPE, bad)).rejects.toThrow('OperatorRole must be a string');
    await expect(provider.update('Nc', ARN, TYPE, bad, props)).rejects.toThrow('OperatorRole must be a string');
    expect(mockSend).not.toHaveBeenCalled();
    respond(
      new Map<string, unknown[]>([
        ['CreateNetworkConnectorCommand', [{ Arn: ARN }]],
        ['GetNetworkConnectorCommand', [active]],
      ])
    );
    await provider.create('Nc', TYPE, bad, { replayingState: true });
    expect(callsOf(CreateNetworkConnectorCommand)[0]!.input).not.toHaveProperty('OperatorRole');
  });

  it.each(['INACTIVE', 'DELETE_FAILED'])('a wait that meets %s fails at once', async (state) => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateNetworkConnectorCommand', [{}]],
        ['GetNetworkConnectorCommand', [{ ...active, State: state, StateReason: 'why' }]],
      ])
    );
    await expect(
      provider.update('Nc', ARN, TYPE, { ...props, OperatorRole: `${ROLE}2` }, props)
    ).rejects.toThrow(`entered ${state}: why`);
    expect(callsOf(GetNetworkConnectorCommand)).toHaveLength(1);
  });

  it('a drift --revert bag passes the OperatorRole refusals like a replay', async () => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateNetworkConnectorCommand', [{}]],
        ['GetNetworkConnectorCommand', [active]],
      ])
    );
    const { OperatorRole: _r, ...noRole } = props;
    await provider.update('Nc', ARN, TYPE, noRole, props, { desiredFromAwsReadback: true });
    await provider.update('Nc', ARN, TYPE, { ...props, OperatorRole: 7 }, props, {
      desiredFromAwsReadback: true,
    });
    for (const call of callsOf(UpdateNetworkConnectorCommand)) {
      expect(call.input).not.toHaveProperty('OperatorRole');
    }
  });

  it('LatestVersion is read off LatestVersionArn when Get returns no LatestVersion (measured)', async () => {
    respond(
      new Map<string, unknown[]>([
        ['GetNetworkConnectorCommand', [{ Arn: ARN, State: 'ACTIVE', LatestVersionArn: `${ARN}:2` }]],
      ])
    );
    await expect(provider.getAttribute(ARN, TYPE, 'LatestVersion')).resolves.toBe(2);
    respond(new Map<string, unknown[]>([['GetNetworkConnectorCommand', [{ Arn: ARN, State: 'ACTIVE' }]]]));
    await expect(provider.getAttribute(ARN, TYPE, 'LatestVersion')).resolves.toBeUndefined();
  });

  it('delete wraps an error other than not-found and does not report the connector deleted', async () => {
    respond(new Map<string, unknown[]>([['DeleteNetworkConnectorCommand', [new Error('throttled')]]]));
    await expect(provider.delete('Nc', ARN, TYPE)).rejects.toThrow(
      'Failed to delete Lambda network connector Nc: throttled'
    );
  });
});

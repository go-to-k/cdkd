import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { RunInstancesCommand } from '@aws-sdk/client-ec2';

// Issue #1277: the EC2 Instance `running` wait was unconditional, so
// `cdkd deploy --no-wait` still blocked on it. The NAT Gateway wait in the
// same provider has always been gated; these cases pin that the Instance
// wait now matches, and that the DEFAULT path is unchanged (which is what
// keeps previously published default-mode measurements valid).

const { mockSend, waitUntilInstanceRunningMock } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  waitUntilInstanceRunningMock: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    waitUntilInstanceRunning: waitUntilInstanceRunningMock,
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const PROPS = { ImageId: 'ami-12345678', InstanceType: 't3.micro', SubnetId: 'subnet-1' };

function mockRunInstancesOk(state: 'pending' | 'running') {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: 'i-1234567890abcdef0' }] });
    }
    // DescribeInstances (and the tag call, which returns nothing meaningful).
    return Promise.resolve({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-1234567890abcdef0',
              State: { Name: state },
              // Under --no-wait the instance can still be `pending`, so AWS
              // has not assigned the addresses yet.
              ...(state === 'running'
                ? {
                    PrivateIpAddress: '10.0.0.5',
                    PublicIpAddress: '54.0.0.5',
                    Placement: { AvailabilityZone: 'us-east-1a' },
                  }
                : {}),
            },
          ],
        },
      ],
    });
  });
}

describe('EC2 Instance running-state wait gating (issue #1277)', () => {
  let originalNoWait: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  it('waits for running by default (unchanged behavior)', async () => {
    mockRunInstancesOk('running');

    const result = await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', PROPS);

    expect(result.physicalId).toBe('i-1234567890abcdef0');
    expect(waitUntilInstanceRunningMock).toHaveBeenCalledTimes(1);
    const [, input] = waitUntilInstanceRunningMock.mock.calls[0] as unknown as [
      unknown,
      { InstanceIds: string[] },
    ];
    expect(input.InstanceIds).toEqual(['i-1234567890abcdef0']);
    expect(result.attributes?.['PrivateIp']).toBe('10.0.0.5');
  });

  it('skips the wait under CDKD_NO_WAIT', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockRunInstancesOk('pending');

    const result = await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', PROPS);

    expect(waitUntilInstanceRunningMock).not.toHaveBeenCalled();
    expect(result.physicalId).toBe('i-1234567890abcdef0');
  });

  it('still returns attributes when the pending instance has no addresses yet', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockRunInstancesOk('pending');

    const result = await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', PROPS);

    // The accepted --no-wait trade-off: empty rather than a hard failure.
    expect(result.attributes?.['PrivateIp']).toBe('');
    expect(result.attributes?.['PublicIp']).toBe('');
    expect(result.attributes?.['InstanceId']).toBe('i-1234567890abcdef0');
  });
});

describe('EC2 Instance AvailabilityZone -> Placement mapping (issue #1276)', () => {
  let originalNoWait: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  it('sends AvailabilityZone as Placement.AvailabilityZone on RunInstances', async () => {
    mockRunInstancesOk('running');

    await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', {
      ...PROPS,
      AvailabilityZone: 'us-east-1a',
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof RunInstancesCommand);
    const input = (call![0] as RunInstancesCommand).input as unknown as Record<string, unknown>;
    expect(input['Placement']).toEqual({ AvailabilityZone: 'us-east-1a' });
  });

  it('omits Placement entirely when the property is absent', async () => {
    mockRunInstancesOk('running');

    await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', PROPS);

    const call = mockSend.mock.calls.find((c) => c[0] instanceof RunInstancesCommand);
    const input = (call![0] as RunInstancesCommand).input as unknown as Record<string, unknown>;
    // An empty `Placement: {}` would be a pointless shape change on every
    // instance that does not set the property.
    expect(input['Placement']).toBeUndefined();
  });

  it('declares AvailabilityZone as handled so the L2 construct stays on the SDK path', () => {
    // The whole point of #1276: an unhandled emitted property routes the
    // resource to Cloud Control via the #614 rule, and CDK's L2
    // `ec2.Instance` ALWAYS emits AvailabilityZone.
    const handled = new EC2Provider().handledProperties?.get('AWS::EC2::Instance');
    expect(handled?.has('AvailabilityZone')).toBe(true);
  });

  it('leaves no actionable silent drop for an L2-shaped property set (the real routing input)', async () => {
    // `handledProperties` above is the provider's DECLARATION; the routing
    // decision in `ProviderRegistry.getProviderFor` reads the GENERATED
    // coverage map instead (they are tied together only by the codegen
    // drift check). Pin the layer routing actually consults, using the
    // property set CDK's L2 `ec2.Instance` emits for a typical app
    // (instance profile + security group + block device + userData + tags).
    const { findActionableSilentDrops } = await import(
      '../../../src/provisioning/property-coverage.js'
    );
    const l2Emitted = {
      AvailabilityZone: 'us-east-1a',
      BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 8 } }],
      IamInstanceProfile: 'profile-1',
      ImageId: 'ami-12345678',
      InstanceType: 't3.micro',
      SecurityGroupIds: ['sg-1'],
      SubnetId: 'subnet-1',
      Tags: [{ Key: 'Name', Value: 'Web' }],
      UserData: 'IyEvYmluL2Jhc2g=',
    };

    expect(findActionableSilentDrops('AWS::EC2::Instance', l2Emitted, new Set())).toEqual([]);
  });

  it('reverse-maps Placement.AvailabilityZone in readCurrentState (no phantom drift)', async () => {
    mockSend.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-1234567890abcdef0',
              State: { Name: 'running' },
              ImageId: 'ami-12345678',
              InstanceType: 't3.micro',
              SubnetId: 'subnet-1',
              Placement: { AvailabilityZone: 'us-east-1a' },
            },
          ],
        },
      ],
    });

    // Signature is (physicalId, logicalId, resourceType) — passing them the
    // other way round still passes against an input-blind mock, so assert the
    // DescribeInstances call actually targeted the physical id too.
    const current = await new EC2Provider().readCurrentState!(
      'i-1234567890abcdef0',
      'MyInstance',
      'AWS::EC2::Instance'
    );

    expect(current?.['AvailabilityZone']).toBe('us-east-1a');
    const describeCall = mockSend.mock.calls.at(-1)?.[0] as { input?: { InstanceIds?: string[] } };
    expect(describeCall?.input?.InstanceIds).toEqual(['i-1234567890abcdef0']);
  });
});

describe('AWS::EC2::Instance immutable-property replacement rules (issue #1276)', () => {
  it('classifies every create-only property as a replacement without DescribeType', async () => {
    // The schema fallback (`create-only-properties.ts`) already classifies
    // these, but it degrades to an EMPTY list when `cloudformation:DescribeType`
    // is unavailable — and `updateInstance` silently ignores an AZ / ImageId /
    // SubnetId / KeyName change, so an in-place classification would leave
    // state recording the new value while AWS keeps the old one.
    const { ReplacementRulesRegistry } = await import('../../../src/analyzer/replacement-rules.js');
    const registry = new ReplacementRulesRegistry();

    for (const prop of ['AvailabilityZone', 'ImageId', 'SubnetId', 'KeyName']) {
      expect(registry.requiresReplacement('AWS::EC2::Instance', prop, 'old', 'new')).toBe(true);
      expect(registry.isClassified('AWS::EC2::Instance', prop)).toBe(true);
    }
  });
});

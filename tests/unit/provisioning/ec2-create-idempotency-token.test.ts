import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, waitUntilInstanceRunningMock, waitUntilNatGatewayAvailableMock } =
  vi.hoisted(() => ({
    mockSend: vi.fn(),
    warnSpy: vi.fn(),
    waitUntilInstanceRunningMock: vi.fn(() => Promise.resolve({})),
    waitUntilNatGatewayAvailableMock: vi.fn(() => Promise.resolve({})),
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
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    waitUntilInstanceRunning: waitUntilInstanceRunningMock,
    waitUntilNatGatewayAvailable: waitUntilNatGatewayAvailableMock,
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { withRetry } from '../../../src/deployment/retry.js';

/** The shape `isTransientServerError` classifies as retryable (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'InternalError',
    $metadata: { httpStatusCode: 500 },
  });

/**
 * A fake EC2 that models the ONE behaviour the fix depends on: a create carrying
 * a `ClientToken` AWS has already seen returns the resource that token minted
 * instead of provisioning a second one.
 *
 * `launched` is the discriminator the issue's acceptance wording asks for —
 * "exactly ONE create reached AWS" — and it counts RESOURCES, not calls, which
 * is what a retry is allowed to repeat.
 */
class FakeEc2 {
  readonly launched: string[] = [];
  readonly clientTokens: (string | undefined)[] = [];
  private readonly byToken = new Map<string, string>();
  private nextId = 1;
  /**
   * Command names whose NEXT call provisions the resource and then loses its
   * response — the exact shape issue #2039 is about, and the only one that
   * reaches a create with no follow-up call to fail (`CreateRouteTable` /
   * `CreateNetworkAcl` return as soon as their tags are applied, and
   * `applyTags` swallows its own failures).
   */
  readonly loseNextResponseFor = new Set<string>();

  private mint(prefix: string, token: string | undefined): string {
    if (token !== undefined) {
      const existing = this.byToken.get(token);
      if (existing !== undefined) {
        return existing;
      }
    }
    const id = `${prefix}-${String(this.nextId++).padStart(3, '0')}`;
    this.launched.push(id);
    if (token !== undefined) {
      this.byToken.set(token, id);
    }
    return id;
  }

  /** Provision (or re-serve) the resource, then lose the response if asked to. */
  private provision(name: string, prefix: string, token: string | undefined): string {
    this.clientTokens.push(token);
    const id = this.mint(prefix, token);
    if (this.loseNextResponseFor.delete(name)) {
      throw transient500();
    }
    return id;
  }

  send = (command: { constructor: { name: string }; input: Record<string, unknown> }): unknown => {
    const name = command.constructor.name;
    const input = command.input;
    const token = input['ClientToken'] as string | undefined;
    switch (name) {
      case 'RunInstancesCommand':
        return Promise.resolve({
          Instances: [{ InstanceId: this.provision(name, 'i', token) }],
        });
      case 'CreateNatGatewayCommand':
        return Promise.resolve({
          NatGateway: { NatGatewayId: this.provision(name, 'nat', token) },
        });
      case 'CreateRouteTableCommand':
        return Promise.resolve({
          RouteTable: { RouteTableId: this.provision(name, 'rtb', token) },
        });
      case 'CreateNetworkAclCommand':
        return Promise.resolve({
          NetworkAcl: { NetworkAclId: this.provision(name, 'acl', token) },
        });
      case 'DescribeInstancesCommand':
        return Promise.resolve({ Reservations: [{ Instances: [{ PrivateIpAddress: '10.0.0.5' }] }] });
      case 'CreateTagsCommand':
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  };
}

/**
 * The retry's sleep, with the CLOCK ADVANCED — see the same helper in
 * `route53-hosted-zone-caller-reference.test.ts` for why it is load-bearing: two
 * attempts separated by no real time share a millisecond, so a fixture that does
 * not advance the clock reports a `Date.now()`-derived token as idempotent and
 * cannot discriminate the exact defect this file exists to fence.
 */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

describe('EC2Provider create idempotency tokens (issue #2039)', () => {
  let provider: EC2Provider;
  let aws: FakeEc2;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetIdempotencyTokensForTests();
    aws = new FakeEc2();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    provider = new EC2Provider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a retried RunInstances whose 500 hid a successful launch produces exactly ONE instance', async () => {
    aws.loseNextResponseFor.add('RunInstancesCommand');

    const result = await withRetry(
      () =>
        provider.create('Instance', 'AWS::EC2::Instance', {
          ImageId: 'ami-123',
          InstanceType: 't3.micro',
          SubnetId: 'subnet-1',
        }),
      'Instance',
      { sleep: advancingSleep }
    );

    expect(aws.clientTokens).toHaveLength(2);
    expect(aws.launched).toEqual(['i-001']);
    expect(result.physicalId).toBe('i-001');
  });

  it('sends the SAME ClientToken on both attempts', async () => {
    aws.loseNextResponseFor.add('RunInstancesCommand');

    await withRetry(
      () =>
        provider.create('Instance', 'AWS::EC2::Instance', {
          ImageId: 'ami-123',
          InstanceType: 't3.micro',
        }),
      'Instance',
      { sleep: advancingSleep }
    );

    const [first, second] = aws.clientTokens;
    expect(first).toBeDefined();
    expect(first).not.toBe('');
    expect(second).toBe(first);
  });

  it('mints a FRESH token for a re-create after a successful one, so a replaced instance is not re-adopted', async () => {
    await provider.create('Instance', 'AWS::EC2::Instance', {
      ImageId: 'ami-123',
      InstanceType: 't3.micro',
    });
    await provider.create('Instance', 'AWS::EC2::Instance', {
      ImageId: 'ami-123',
      InstanceType: 't3.micro',
    });

    expect(aws.clientTokens[1]).not.toBe(aws.clientTokens[0]);
    expect(aws.launched).toEqual(['i-001', 'i-002']);
  });

  it('releases the token when a wiring failure TERMINATES the instance', async () => {
    // The instance the token names is gone, so the retry must launch a fresh
    // one rather than be handed the terminated instance back.
    // NOT a CreateTags failure: `applyTags` swallows its own errors, so one
    // never reaches this arm and a test built on it passes vacuously.
    waitUntilInstanceRunningMock.mockRejectedValueOnce(transient500());

    await withRetry(
      () =>
        provider.create('Instance', 'AWS::EC2::Instance', {
          ImageId: 'ami-123',
          InstanceType: 't3.micro',
        }),
      'Instance',
      { sleep: advancingSleep }
    );

    expect(aws.clientTokens).toHaveLength(2);
    expect(aws.clientTokens[1]).not.toBe(aws.clientTokens[0]);
    expect(aws.launched).toEqual(['i-001', 'i-002']);
  });

  it('KEEPS the token when the wiring-failure terminate itself fails', async () => {
    // The terminate failed, so the instance is still running and billing (the
    // provider says exactly that in a warn). Keeping the token means the retry
    // is handed THAT instance and re-runs its wiring; releasing it would launch
    // a second instance beside an orphan cdkd state never names.
    waitUntilInstanceRunningMock.mockRejectedValueOnce(transient500());
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'TerminateInstancesCommand') {
        return Promise.reject(new Error('UnauthorizedOperation: ec2:TerminateInstances'));
      }
      return aws.send(command as never);
    });

    const result = await withRetry(
      () =>
        provider.create('Instance', 'AWS::EC2::Instance', {
          ImageId: 'ami-123',
          InstanceType: 't3.micro',
        }),
      'Instance',
      { sleep: advancingSleep }
    );

    expect(aws.clientTokens[1]).toBe(aws.clientTokens[0]);
    expect(aws.launched).toEqual(['i-001']);
    expect(result.physicalId).toBe('i-001');
  });

  // The three sibling EC2 creates take the same treatment. Each is driven
  // through the same lost-response replay: the resource IS provisioned and the
  // response never arrives, which is the only shape that reaches these two —
  // `CreateRouteTable` / `CreateNetworkAcl` return as soon as their tags are
  // applied, and `applyTags` swallows its own failures.
  it.each([
    ['AWS::EC2::NatGateway', 'CreateNatGatewayCommand', { SubnetId: 'subnet-1' }, 'nat-001'],
    ['AWS::EC2::RouteTable', 'CreateRouteTableCommand', { VpcId: 'vpc-1' }, 'rtb-001'],
    ['AWS::EC2::NetworkAcl', 'CreateNetworkAclCommand', { VpcId: 'vpc-1' }, 'acl-001'],
  ])(
    '%s retried after a lost response produces exactly ONE resource',
    async (resourceType, commandName, properties, expectedId) => {
      aws.loseNextResponseFor.add(commandName);

      const result = await withRetry(
        () => provider.create('Res', resourceType, properties),
        'Res',
        { sleep: advancingSleep }
      );

      expect(aws.clientTokens).toHaveLength(2);
      expect(aws.clientTokens[1]).toBe(aws.clientTokens[0]);
      expect(aws.launched).toEqual([expectedId]);
      expect(result.physicalId).toBe(expectedId);
    }
  );
});

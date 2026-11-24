import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#4583: when an EC2 create fails AFTER its create call returned
// and the resource is left in AWS (its cleanup failed, or it has none), the
// thrown error names the id `delete()` takes so `cdkd rollback
// --revert-failed` can delete it. A cleanup that succeeded, the create call's
// own failure and a pre-flight refusal name nothing.

const { mockSend, waitUntilInstanceRunningMock, waitUntilNatGatewayAvailableMock } = vi.hoisted(
  () => ({
    mockSend: vi.fn(),
    waitUntilInstanceRunningMock: vi.fn(),
    waitUntilNatGatewayAvailableMock: vi.fn(),
  })
);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  childLogger['child'] = () => childLogger;
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
    waitUntilNatGatewayAvailable: waitUntilNatGatewayAvailableMock,
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import {
  withDeferredReadinessScope,
  type DeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';

/**
 * go-to-k/cdkd#6940: a provider that skips a readiness wait under
 * `--no-wait` hands the same wait to the deploy, which runs it only if it
 * needs the resource. The default mode waits as before and defers nothing.
 */

function respond(table: Record<string, () => Promise<unknown>>): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    const answer = table[command.constructor.name];
    return answer ? answer() : Promise.resolve({});
  });
}

const ok = (value: unknown) => () => Promise.resolve(value);

function scopeFor(logicalId: string, resourceType: string): DeferredReadinessScope {
  return {
    logicalId,
    resourceType,
    deferred: new Map(),
    awaitUpstreamReadiness: async () => undefined,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource: () => undefined,
  };
}

const cases = [
  {
    label: 'NAT gateway',
    logicalId: 'Nat',
    type: 'AWS::EC2::NatGateway',
    id: 'nat-6940',
    props: { SubnetId: 'subnet-a', AllocationId: 'eipalloc-a' },
    create: { CreateNatGatewayCommand: ok({ NatGateway: { NatGatewayId: 'nat-6940', State: 'pending' } }) },
    waiter: () => waitUntilNatGatewayAvailableMock,
    input: { NatGatewayIds: ['nat-6940'] },
  },
  {
    label: 'EC2 instance',
    logicalId: 'Host',
    type: 'AWS::EC2::Instance',
    id: 'i-6940',
    props: { ImageId: 'ami-aaa', InstanceType: 't3.micro' },
    create: { RunInstancesCommand: ok({ Instances: [{ InstanceId: 'i-6940', State: { Name: 'pending' } }] }) },
    waiter: () => waitUntilInstanceRunningMock,
    input: { InstanceIds: ['i-6940'] },
  },
] as const;

describe.each(cases)('$label readiness under --no-wait (#6940)', (c) => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    waitUntilInstanceRunningMock.mockReset();
    waitUntilInstanceRunningMock.mockResolvedValue({ state: 'SUCCESS' });
    waitUntilNatGatewayAvailableMock.mockReset();
    waitUntilNatGatewayAvailableMock.mockResolvedValue({ state: 'SUCCESS' });
    respond(c.create);
    delete process.env['CDKD_NO_WAIT'];
    provider = new EC2Provider();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  it('defers the skipped wait, unstarted, and the deferred wait is the same waiter', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    const scope = scopeFor(c.logicalId, c.type);
    await withDeferredReadinessScope(scope, () => provider.create(c.logicalId, c.type, c.props));
    expect(c.waiter()).not.toHaveBeenCalled();
    expect([...scope.deferred.keys()]).toStrictEqual([c.id]);

    const signal = new AbortController().signal;
    await scope.deferred.get(c.id)!.wait(signal);
    expect(c.waiter()).toHaveBeenCalledTimes(1);
    const [config, input] = c.waiter().mock.calls[0]!;
    expect(input).toStrictEqual(c.input);
    expect((config as { abortSignal?: AbortSignal }).abortSignal).toBe(signal);
  });

  it('the default mode waits during the create and defers nothing', async () => {
    const scope = scopeFor(c.logicalId, c.type);
    await withDeferredReadinessScope(scope, () => provider.create(c.logicalId, c.type, c.props));
    expect(c.waiter()).toHaveBeenCalledTimes(1);
    expect(scope.deferred.size).toBe(0);
  });
});

// go-to-k/cdkd#6940 rule 3: AWS refuses AssociateAddress for an instance that
// is not running, so the association waits for the instance's deferred wait.
describe('Elastic IP association under --no-wait (#6940 rule 3)', () => {
  let provider: EC2Provider;
  const order: string[] = [];

  beforeEach(() => {
    order.length = 0;
    mockSend.mockReset();
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      order.push(command.constructor.name);
      if (command.constructor.name === 'AllocateAddressCommand') {
        return Promise.resolve({ AllocationId: 'eipalloc-6940', PublicIp: '198.51.100.7' });
      }
      return Promise.resolve({});
    });
    process.env['CDKD_NO_WAIT'] = 'true';
    provider = new EC2Provider();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const eipScope = (
    awaitDeferredResource: DeferredReadinessScope['awaitDeferredResource']
  ): DeferredReadinessScope => ({
    logicalId: 'Eip',
    resourceType: 'AWS::EC2::EIP',
    deferred: new Map(),
    awaitUpstreamReadiness: async () => undefined,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource,
  });

  it("waits for the instance's deferred running wait, then associates", async () => {
    const asked: string[] = [];
    const scope = eipScope((physicalId) => {
      asked.push(physicalId);
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push('instance ready');
          resolve();
        }, 10)
      );
    });
    await withDeferredReadinessScope(scope, () =>
      provider.create('Eip', 'AWS::EC2::EIP', { Domain: 'vpc', InstanceId: 'i-6940' })
    );
    expect(asked).toStrictEqual(['i-6940']);
    expect(order).toContain('instance ready');
    expect(order.indexOf('AssociateAddressCommand')).toBeGreaterThan(order.indexOf('instance ready'));
  });

  it('an instance whose wait was not deferred keeps the skip-and-warn', async () => {
    const scope = eipScope(() => undefined);
    await withDeferredReadinessScope(scope, () =>
      provider.create('Eip', 'AWS::EC2::EIP', { Domain: 'vpc', InstanceId: 'i-6940' })
    );
    expect(order).not.toContain('AssociateAddressCommand');
  });

  it('an update repointing the address waits for the deferred instance, then associates', async () => {
    const scope = eipScope(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push('instance ready');
            resolve();
          }, 10)
        )
    );
    await withDeferredReadinessScope(scope, () =>
      provider.update(
        'Eip',
        'eipalloc-6940',
        'AWS::EC2::EIP',
        { Domain: 'vpc', InstanceId: 'i-new' },
        { Domain: 'vpc', InstanceId: 'i-old' }
      )
    );
    expect(order).toContain('instance ready');
    expect(order.indexOf('AssociateAddressCommand')).toBeGreaterThan(order.indexOf('instance ready'));
  });
});

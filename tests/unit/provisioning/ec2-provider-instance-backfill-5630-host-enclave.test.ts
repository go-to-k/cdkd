import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeInstancesCommand,
  ModifyInstanceAttributeCommand,
  ModifyInstancePlacementCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type Instance,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#5630 (final slice): AWS::EC2::Instance Affinity, HostId,
// HostResourceGroupArn, KernelId, RamdiskId and EnclaveOptions.
//  - The schema makes EnclaveOptions and HostResourceGroupArn create-only
//    (CloudFormation's documentation: "Update requires: Replacement").
//  - Affinity, HostId, KernelId and RamdiskId are schema-mutable, documented
//    "Update requires: Some interruptions": EC2 changes them only on a stopped
//    instance (ModifyInstancePlacement, ModifyInstanceAttribute Kernel /
//    Ramdisk), so cdkd stops, modifies and starts the instance.
// None of these update paths is measured against CloudFormation: Affinity /
// HostId / HostResourceGroupArn need a Dedicated Host, and KernelId /
// RamdiskId a paravirtual AMI no current instance type launches.

const { mockSend, warn, cfnSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warn: vi.fn(),
  cfnSend: vi.fn(() => Promise.reject(new Error('DescribeType is not reachable here'))),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: cfnSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    waitUntilInstanceRunning: vi.fn(() => Promise.resolve({})),
    waitUntilInstanceTerminated: vi.fn(() => Promise.resolve({})),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TYPE = 'AWS::EC2::Instance';
const BASE = { ImageId: 'ami-1', InstanceType: 'c6a.xlarge', SubnetId: 'subnet-1' };
const HOST_GROUP = 'arn:aws:resource-groups:us-east-1:123456789012:group/hosts';

/** The instance as DescribeInstances answers it (state follows Stop / Start). */
let live: Instance;

function sent<T>(ctor: new (...a: never[]) => T): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof ctor)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

/** The mutating calls, in order, by command name. */
function writes(): string[] {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter(
      (cmd) =>
        cmd instanceof StopInstancesCommand ||
        cmd instanceof StartInstancesCommand ||
        cmd instanceof ModifyInstancePlacementCommand ||
        cmd instanceof ModifyInstanceAttributeCommand
    )
    .map((cmd) => cmd.constructor.name);
}

beforeEach(() => {
  mockSend.mockReset();
  warn.mockReset();
  live = {
    InstanceId: 'i-1',
    State: { Name: 'running' },
    RootDeviceType: 'ebs',
    Placement: { AvailabilityZone: 'us-east-1a', Tenancy: 'host', Affinity: 'default', HostId: 'h-old' },
    KernelId: 'aki-old',
    RamdiskId: 'ari-old',
    EnclaveOptions: { Enabled: false },
  };
  vi.spyOn(
    EC2Provider.prototype as unknown as { sleep: () => Promise<void> },
    'sleep'
  ).mockResolvedValue(undefined);
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: 'i-1' }] });
    }
    if (cmd instanceof StopInstancesCommand) live.State = { Name: 'stopped' };
    if (cmd instanceof StartInstancesCommand) live.State = { Name: 'running' };
    if (cmd instanceof DescribeInstancesCommand) {
      return Promise.resolve({ Reservations: [{ Instances: [structuredClone(live)] }] });
    }
    return Promise.resolve({});
  });
});

afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
});

describe('AWS::EC2::Instance Dedicated Host / kernel / enclave create (#5630)', () => {
  it('sends all six members on RunInstances, EnclaveOptions.Enabled coerced to a boolean', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      Tenancy: 'host',
      Affinity: 'host',
      HostId: 'h-1',
      HostResourceGroupArn: HOST_GROUP,
      KernelId: 'aki-1',
      RamdiskId: 'ari-1',
      EnclaveOptions: { Enabled: 'true' },
    });
    const run = sent(RunInstancesCommand)[0]!;
    expect(run['Placement']).toEqual({
      Tenancy: 'host',
      Affinity: 'host',
      HostId: 'h-1',
      HostResourceGroupArn: HOST_GROUP,
    });
    expect(run['KernelId']).toBe('aki-1');
    expect(run['RamdiskId']).toBe('ari-1');
    expect(run['EnclaveOptions']).toEqual({ Enabled: true });
  });

  it('sends none of them for an instance that declares none', async () => {
    await new EC2Provider().create('Inst', TYPE, BASE);
    const run = sent(RunInstancesCommand)[0]!;
    expect(run['Placement']).toBeUndefined();
    expect(run).not.toHaveProperty('KernelId');
    expect(run).not.toHaveProperty('RamdiskId');
    expect(run).not.toHaveProperty('EnclaveOptions');
  });

  it.each([
    ['EnclaveOptions', { Enabled: 'yes' }, /EnclaveOptions\.Enabled must be a boolean/],
    ['EnclaveOptions', 'true', /EnclaveOptions must be an object/],
    ['HostId', { Ref: 'Host' }, /HostId/],
    ['Affinity', ['host'], /Affinity/],
    ['HostResourceGroupArn', 42.5, /HostResourceGroupArn/],
    ['KernelId', true, /KernelId/],
    ['RamdiskId', { a: 1 }, /RamdiskId/],
    // EC2 takes no empty id; update() refuses one too, so a rollback replay
    // never meets a record value the create accepted and the update refuses.
    ['Affinity', '', /Affinity must not be empty/],
    ['HostId', '', /HostId must not be empty/],
    ['HostResourceGroupArn', '', /HostResourceGroupArn must not be empty/],
    ['KernelId', '', /KernelId must not be empty/],
    ['RamdiskId', '', /RamdiskId must not be empty/],
  ])('refuses a malformed %s before RunInstances, non-retryably', async (key, value, says) => {
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, [key]: value })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(says);
    expect((error as Error).message).toMatch(/was not launched/);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(sent(RunInstancesCommand)).toHaveLength(0);
  });
});

describe('AWS::EC2::Instance Affinity / HostId / KernelId / RamdiskId update (#5630)', () => {
  const update = (
    desired: Record<string, unknown>,
    previous: Record<string, unknown>,
    context?: Record<string, unknown>
  ) => new EC2Provider().update('Inst', 'i-1', TYPE, desired, previous, context);

  it('changes Affinity and HostId with ONE ModifyInstancePlacement between a stop and a start', async () => {
    const before = { ...BASE, Tenancy: 'host', Affinity: 'default', HostId: 'h-old' };
    await update({ ...before, Affinity: 'host', HostId: 'h-new' }, before);
    expect(writes()).toEqual([
      'StopInstancesCommand',
      'ModifyInstancePlacementCommand',
      'StartInstancesCommand',
    ]);
    expect(sent(ModifyInstancePlacementCommand)).toEqual([
      { InstanceId: 'i-1', Affinity: 'host', HostId: 'h-new' },
    ]);
    expect(live.State?.Name).toBe('running');
  });

  it('sends only the member that changed', async () => {
    const before = { ...BASE, Tenancy: 'host', Affinity: 'default', HostId: 'h-old' };
    await update({ ...before, HostId: 'h-new' }, before);
    expect(sent(ModifyInstancePlacementCommand)).toEqual([{ InstanceId: 'i-1', HostId: 'h-new' }]);
  });

  it('changes KernelId and RamdiskId with ModifyInstanceAttribute in the same stopped window as an InstanceType change', async () => {
    const before = { ...BASE, KernelId: 'aki-old', RamdiskId: 'ari-old' };
    await update({ ...before, InstanceType: 'c6a.2xlarge', KernelId: 'aki-new', RamdiskId: 'ari-new' }, before);
    expect(writes()).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
      'ModifyInstanceAttributeCommand',
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-1', InstanceType: { Value: 'c6a.2xlarge' } },
      { InstanceId: 'i-1', Kernel: { Value: 'aki-new' } },
      { InstanceId: 'i-1', Ramdisk: { Value: 'ari-new' } },
    ]);
  });

  // A record an earlier --prefer-sdk-route deploy wrote without the value.
  it.each([
    ['Affinity', 'default'],
    ['HostId', 'h-old'],
    ['KernelId', 'aki-old'],
    ['RamdiskId', 'ari-old'],
  ])('adds a %s the record lacks with no stop when the instance already has it', async (key, value) => {
    await update({ ...BASE, [key]: value }, BASE);
    expect(writes()).toEqual([]);
  });

  it('takes Affinity default as the value of an instance that reports none', async () => {
    live.Placement = { AvailabilityZone: 'us-east-1a', Tenancy: 'default' };
    await update({ ...BASE, Affinity: 'default' }, BASE);
    expect(writes()).toEqual([]);
  });

  it('refuses a recorded stand-in on a forward update before any call', async () => {
    const before = { ...BASE, KernelId: 'aki-old' };
    const error = await update({ ...before, KernelId: '{{resolve:ssm:/kernel}}' }, before).catch(
      (e: unknown) => e
    );
    expect((error as Error).message).toMatch(/KernelId holds a recorded stand-in/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('keeps a stand-in member live on a rollback revert and still applies the others', async () => {
    const before = { ...BASE, HostId: 'h-old', RamdiskId: 'ari-old' };
    await update({ ...before, HostId: '{{resolve:ssm:/host}}', RamdiskId: 'ari-new' }, before, {
      replayingState: true,
    });
    expect(sent(ModifyInstancePlacementCommand)).toEqual([]);
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-1', Ramdisk: { Value: 'ari-new' } },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/records HostId as a stand-in/));
  });

  it('keeps the live value, with a warning, when a rollback revert restores an empty one', async () => {
    const before = { ...BASE, KernelId: 'aki-new' };
    await update({ ...BASE, KernelId: '' }, before, { replayingState: true });
    expect(writes()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/KernelId must not be empty; the rollback leaves/));
  });

  it('names the placement already applied when a later Kernel change fails', async () => {
    const real = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof ModifyInstanceAttributeCommand
        ? Promise.reject(Object.assign(new Error('kernel refused'), { name: 'InvalidParameterValue' }))
        : real(cmd)
    );
    const before = { ...BASE, Tenancy: 'host', HostId: 'h-old', KernelId: 'aki-old' };
    await expect(update({ ...before, HostId: 'h-new', KernelId: 'aki-new' }, before)).rejects.toThrow(
      /kernel refused/
    );
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/with the new HostId already applied/));
  });

  it('starts the instance again when ModifyInstancePlacement fails after the stop', async () => {
    const real = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof ModifyInstancePlacementCommand
        ? Promise.reject(Object.assign(new Error('host full'), { name: 'InsufficientHostCapacity' }))
        : real(cmd)
    );
    const before = { ...BASE, Tenancy: 'host', HostId: 'h-old' };
    await expect(update({ ...before, HostId: 'h-new' }, before)).rejects.toThrow(/host full/);
    expect(writes()).toEqual([
      'StopInstancesCommand',
      'ModifyInstancePlacementCommand',
      'StartInstancesCommand',
    ]);
    expect(live.State?.Name).toBe('running');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the HostId change failed after instance i-1 was stopped; cdkd started it again/));
  });

  it('adds a member the instance does not have yet with a stop and a start', async () => {
    await update({ ...BASE, KernelId: 'aki-new' }, BASE);
    expect(writes()).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
      'StartInstancesCommand',
    ]);
  });

  it('leaves an instance the user had stopped stopped', async () => {
    live.State = { Name: 'stopped' };
    const before = { ...BASE, RamdiskId: 'ari-old' };
    await update({ ...before, RamdiskId: 'ari-new' }, before);
    expect(writes()).toEqual(['ModifyInstanceAttributeCommand']);
  });

  it.each(['Affinity', 'HostId', 'KernelId', 'RamdiskId'])(
    'refuses a removed %s before any call',
    async (key) => {
      const before = { ...BASE, [key]: 'value-1' };
      const error = await update(BASE, before).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(
        new RegExp(`${key} was removed from the template\\. EC2 has no call that clears it`)
      );
      expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
      expect(writes()).toEqual([]);
    }
  );

  it('keeps the live value, with a warning, when a rollback revert would remove one', async () => {
    const before = { ...BASE, HostId: 'h-new' };
    await update(BASE, before, { replayingState: true });
    expect(writes()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/does not declare HostId/));
  });

  it('refuses an empty value before any call', async () => {
    const before = { ...BASE, KernelId: 'aki-old' };
    const error = await update({ ...before, KernelId: '' }, before).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/KernelId must not be empty/);
    expect(writes()).toEqual([]);
  });

  it('refuses an instance-store-backed instance before any call', async () => {
    live.RootDeviceType = 'instance-store';
    const before = { ...BASE, KernelId: 'aki-old' };
    const error = await update({ ...before, KernelId: 'aki-new' }, before).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((error as Error).message).toMatch(/KernelId can change only on a stopped instance/);
    expect(writes()).toEqual([]);
  });
});

describe('AWS::EC2::Instance EnclaveOptions / HostResourceGroupArn update (#5630)', () => {
  const update = (desired: Record<string, unknown>, previous: Record<string, unknown>) =>
    new EC2Provider().update('Inst', 'i-1', TYPE, desired, previous);

  it.each([
    ['EnclaveOptions', { Enabled: false }, { Enabled: true }],
    ['HostResourceGroupArn', HOST_GROUP, `${HOST_GROUP}-2`],
  ])('refuses a %s change reaching update() before any call', async (key, before, after) => {
    const error = await update({ ...BASE, [key]: after }, { ...BASE, [key]: before }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((error as Error).message).toContain(key);
    expect(writes()).toEqual([]);
  });

  it('takes a stringly-typed EnclaveOptions.Enabled as the same value', async () => {
    await update(
      { ...BASE, EnclaveOptions: { Enabled: 'true' } },
      { ...BASE, EnclaveOptions: { Enabled: true } }
    );
    expect(writes()).toEqual([]);
  });
});

describe('AWS::EC2::Instance readback of the six members (#5630)', () => {
  it('reads them back from DescribeInstances under their CloudFormation names', async () => {
    live.Placement = { ...live.Placement, HostResourceGroupArn: HOST_GROUP };
    live.EnclaveOptions = { Enabled: true };
    const bag = (await new EC2Provider().readCurrentState('i-1', 'Inst', TYPE)) as Record<
      string,
      unknown
    >;
    expect(bag).not.toBe(RESOURCE_NOT_FOUND);
    expect(bag).toMatchObject({
      Affinity: 'default',
      HostId: 'h-old',
      HostResourceGroupArn: HOST_GROUP,
      KernelId: 'aki-old',
      RamdiskId: 'ari-old',
      EnclaveOptions: { Enabled: true },
    });
  });

  it('omits the members an instance does not have', async () => {
    live.Placement = { AvailabilityZone: 'us-east-1a', Tenancy: 'default' };
    delete live.KernelId;
    delete live.RamdiskId;
    const bag = (await new EC2Provider().readCurrentState('i-1', 'Inst', TYPE)) as Record<
      string,
      unknown
    >;
    for (const key of ['Affinity', 'HostId', 'HostResourceGroupArn', 'KernelId', 'RamdiskId']) {
      expect(bag).not.toHaveProperty(key);
    }
    expect(bag['EnclaveOptions']).toEqual({ Enabled: false });
  });
});

describe('AWS::EC2::Instance replacement rules for the six members (#5630)', () => {
  const rules = new ReplacementRulesRegistry();
  it.each(['EnclaveOptions', 'HostResourceGroupArn'])(
    '%s replaces the instance even without DescribeType',
    (key) => {
      expect(rules.requiresReplacement(TYPE, key, 'a', 'b')).toBe(true);
    }
  );
  it.each(['Affinity', 'HostId', 'KernelId', 'RamdiskId'])('%s is updated in place', (key) => {
    expect(rules.requiresReplacement(TYPE, key, 'a', 'b')).toBe(false);
  });
});

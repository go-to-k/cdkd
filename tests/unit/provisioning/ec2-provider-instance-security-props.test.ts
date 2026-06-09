import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  RunInstancesCommand,
  ModifyInstanceAttributeCommand,
  ModifyInstanceMetadataOptionsCommand,
  ModifyInstanceCreditSpecificationCommand,
  MonitorInstancesCommand,
  UnmonitorInstancesCommand,
} from '@aws-sdk/client-ec2';

// Security-focused backfill (#609): DisableApiTermination / MetadataOptions /
// Monitoring / EbsOptimized / CreditSpecification wired into create() +
// update() on AWS::EC2::Instance. (readCurrentState coverage lives in
// ec2-provider-readcurrentstate.test.ts.)

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

/** Find the (single) RunInstancesCommand input from the mock call log. */
function runInstancesInput() {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof RunInstancesCommand);
  return call?.[0].input as Record<string, unknown>;
}

describe('EC2Provider createInstance security props (#609)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    waitUntilInstanceRunningMock.mockReset();
    waitUntilInstanceRunningMock.mockResolvedValue({});
    provider = new EC2Provider();
    // Default: RunInstances returns an id, then applyTags (CreateTags) +
    // post-run DescribeInstances both resolve empty.
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof RunInstancesCommand) {
        return Promise.resolve({ Instances: [{ InstanceId: 'i-new' }] });
      }
      if (cmd?.constructor?.name === 'DescribeInstancesCommand') {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-new' }] }],
        });
      }
      return Promise.resolve({});
    });
  });

  it('declares the five backfilled props as handled on AWS::EC2::Instance', () => {
    const props = provider.handledProperties.get('AWS::EC2::Instance');
    expect(props?.has('DisableApiTermination')).toBe(true);
    expect(props?.has('MetadataOptions')).toBe(true);
    expect(props?.has('Monitoring')).toBe(true);
    expect(props?.has('EbsOptimized')).toBe(true);
    expect(props?.has('CreditSpecification')).toBe(true);
    // Existing handled props remain.
    expect(props?.has('ImageId')).toBe(true);
    expect(props?.has('BlockDeviceMappings')).toBe(true);
  });

  it('rides DisableApiTermination / EbsOptimized booleans on RunInstances', async () => {
    await provider.create('Web', 'AWS::EC2::Instance', {
      ImageId: 'ami-1',
      InstanceType: 't3.micro',
      DisableApiTermination: true,
      EbsOptimized: true,
    });
    const input = runInstancesInput();
    expect(input['DisableApiTermination']).toBe(true);
    expect(input['EbsOptimized']).toBe(true);
  });

  it('coerces stringly-typed booleans at the wire boundary', async () => {
    await provider.create('Web', 'AWS::EC2::Instance', {
      ImageId: 'ami-1',
      DisableApiTermination: 'true',
      EbsOptimized: 'false',
      Monitoring: 'true',
    });
    const input = runInstancesInput();
    expect(input['DisableApiTermination']).toBe(true);
    expect(input['EbsOptimized']).toBe(false);
    expect(input['Monitoring']).toEqual({ Enabled: true });
  });

  it('omits absent boolean props so AWS keeps its defaults', async () => {
    await provider.create('Web', 'AWS::EC2::Instance', { ImageId: 'ami-1' });
    const input = runInstancesInput();
    expect(input['DisableApiTermination']).toBeUndefined();
    expect(input['EbsOptimized']).toBeUndefined();
    expect(input['Monitoring']).toBeUndefined();
    expect(input['MetadataOptions']).toBeUndefined();
    expect(input['CreditSpecification']).toBeUndefined();
  });

  it('builds the Monitoring { Enabled } shape from the CFn boolean', async () => {
    await provider.create('Web', 'AWS::EC2::Instance', {
      ImageId: 'ami-1',
      Monitoring: true,
    });
    expect(runInstancesInput()['Monitoring']).toEqual({ Enabled: true });
  });

  it('passes MetadataOptions through with IMDSv2 enforcement + numeric hop-limit coercion', async () => {
    await provider.create('Web', 'AWS::EC2::Instance', {
      ImageId: 'ami-1',
      MetadataOptions: {
        HttpTokens: 'required',
        HttpEndpoint: 'enabled',
        HttpPutResponseHopLimit: '2',
        HttpProtocolIpv6: 'disabled',
        InstanceMetadataTags: 'enabled',
      },
    });
    expect(runInstancesInput()['MetadataOptions']).toEqual({
      HttpTokens: 'required',
      HttpEndpoint: 'enabled',
      HttpPutResponseHopLimit: 2,
      HttpProtocolIpv6: 'disabled',
      InstanceMetadataTags: 'enabled',
    });
  });

  it('builds CreditSpecification from the canonical CPUCredits key', async () => {
    await provider.create('Web', 'AWS::EC2::Instance', {
      ImageId: 'ami-1',
      InstanceType: 't3.micro',
      CreditSpecification: { CPUCredits: 'unlimited' },
    });
    expect(runInstancesInput()['CreditSpecification']).toEqual({ CpuCredits: 'unlimited' });
  });

  it('also accepts the SDK-style CpuCredits key for hand-authored templates', async () => {
    await provider.create('Web', 'AWS::EC2::Instance', {
      ImageId: 'ami-1',
      CreditSpecification: { CpuCredits: 'standard' },
    });
    expect(runInstancesInput()['CreditSpecification']).toEqual({ CpuCredits: 'standard' });
  });
});

describe('EC2Provider updateInstance security props (#609)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new EC2Provider();
    // update() always ends with a DescribeInstances attribute refresh.
    mockSend.mockImplementation((cmd) => {
      if (cmd?.constructor?.name === 'DescribeInstancesCommand') {
        return Promise.resolve({ Reservations: [{ Instances: [{ InstanceId: 'i-1' }] }] });
      }
      return Promise.resolve({});
    });
  });

  /** Mutating (non-Describe) commands issued during update(). */
  function mutatingCommands() {
    return mockSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd?.constructor?.name !== 'DescribeInstancesCommand');
  }

  it('issues ModifyInstanceAttribute for a DisableApiTermination flip', async () => {
    await provider.update(
      'Web',
      'i-1',
      'AWS::EC2::Instance',
      { ImageId: 'ami-1', DisableApiTermination: true },
      { ImageId: 'ami-1', DisableApiTermination: false }
    );
    const cmds = mutatingCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBeInstanceOf(ModifyInstanceAttributeCommand);
    expect(cmds[0].input).toEqual({
      InstanceId: 'i-1',
      DisableApiTermination: { Value: true },
    });
  });

  it('does NOT issue ModifyInstanceAttribute for an EbsOptimized flip (routed to replacement)', async () => {
    // EbsOptimized can only be changed on a STOPPED instance; cdkd routes the
    // change to replacement via the ReplacementRulesRegistry instead of an
    // in-place ModifyInstanceAttribute (which would 'IncorrectInstanceState'
    // on a running instance). So update() must NOT touch EbsOptimized.
    await provider.update(
      'Web',
      'i-1',
      'AWS::EC2::Instance',
      { ImageId: 'ami-1', EbsOptimized: true },
      { ImageId: 'ami-1', EbsOptimized: false }
    );
    const cmds = mutatingCommands();
    const ebsModify = cmds.filter(
      (c) =>
        c instanceof ModifyInstanceAttributeCommand &&
        (c.input as { EbsOptimized?: unknown }).EbsOptimized !== undefined
    );
    expect(ebsModify).toHaveLength(0);
  });

  it('issues MonitorInstances when Monitoring flips on, UnmonitorInstances when off', async () => {
    await provider.update(
      'Web',
      'i-1',
      'AWS::EC2::Instance',
      { ImageId: 'ami-1', Monitoring: true },
      { ImageId: 'ami-1', Monitoring: false }
    );
    expect(mutatingCommands()[0]).toBeInstanceOf(MonitorInstancesCommand);

    mockSend.mockClear();
    await provider.update(
      'Web',
      'i-1',
      'AWS::EC2::Instance',
      { ImageId: 'ami-1', Monitoring: false },
      { ImageId: 'ami-1', Monitoring: true }
    );
    expect(mutatingCommands()[0]).toBeInstanceOf(UnmonitorInstancesCommand);
  });

  it('issues ModifyInstanceMetadataOptions when MetadataOptions changes', async () => {
    await provider.update(
      'Web',
      'i-1',
      'AWS::EC2::Instance',
      { ImageId: 'ami-1', MetadataOptions: { HttpTokens: 'required' } },
      { ImageId: 'ami-1', MetadataOptions: { HttpTokens: 'optional' } }
    );
    const cmds = mutatingCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBeInstanceOf(ModifyInstanceMetadataOptionsCommand);
    expect(cmds[0].input).toEqual({ InstanceId: 'i-1', HttpTokens: 'required' });
  });

  it('issues ModifyInstanceCreditSpecification when CreditSpecification changes', async () => {
    await provider.update(
      'Web',
      'i-1',
      'AWS::EC2::Instance',
      { ImageId: 'ami-1', CreditSpecification: { CPUCredits: 'unlimited' } },
      { ImageId: 'ami-1', CreditSpecification: { CPUCredits: 'standard' } }
    );
    const cmds = mutatingCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBeInstanceOf(ModifyInstanceCreditSpecificationCommand);
    expect(cmds[0].input).toEqual({
      InstanceCreditSpecifications: [{ InstanceId: 'i-1', CpuCredits: 'unlimited' }],
    });
  });

  it('no-drift round-trip (update(state, state)) issues zero mutating calls', async () => {
    const state = {
      ImageId: 'ami-1',
      InstanceType: 't3.micro',
      DisableApiTermination: true,
      EbsOptimized: true,
      Monitoring: true,
      MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
      CreditSpecification: { CPUCredits: 'unlimited' },
      Tags: [],
    };
    await provider.update('Web', 'i-1', 'AWS::EC2::Instance', state, state);
    // Only the read-only DescribeInstances refresh is allowed.
    expect(mutatingCommands()).toHaveLength(0);
  });
});

describe('AWS::EC2::Instance replacement rules (#609)', () => {
  it('routes EbsOptimized to replacement but keeps the other 4 security props in-place', async () => {
    const { ReplacementRulesRegistry } = await import(
      '../../../src/analyzer/replacement-rules.js'
    );
    const registry = new ReplacementRulesRegistry();
    expect(registry.requiresReplacement('AWS::EC2::Instance', 'EbsOptimized', false, true)).toBe(
      true
    );
    for (const prop of [
      'DisableApiTermination',
      'Monitoring',
      'MetadataOptions',
      'CreditSpecification',
    ]) {
      expect(registry.requiresReplacement('AWS::EC2::Instance', prop, undefined, {})).toBe(false);
    }
  });
});

/**
 * Issue #1160 (absent-field removal), AWS::EC2::VPC slice.
 *
 * `ModifyVpcAttribute` changes only the attribute it is sent, so an update
 * that skips a removed DNS attribute keeps its live value. A real
 * CloudFormation A/B (us-east-1) showed CloudFormation resets each removed
 * attribute to the VPC default: `EnableDnsHostnames` true -> false and
 * `EnableDnsSupport` false -> true. These tests pin the reset on both caller
 * paths (deploy-engine injection and a direct provider call), the cases that
 * send nothing (a removed attribute already at its default, a never-declared
 * one, a drift `--revert` round-trip), and that a present value still wins.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ModifyVpcAttributeCommand } from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

const VPC = 'AWS::EC2::VPC';

/** The attribute payloads of every ModifyVpcAttribute sent, in order. */
function modifyVpcInputs(): unknown[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((cmd) => cmd instanceof ModifyVpcAttributeCommand)
    .map((cmd) => (cmd as ModifyVpcAttributeCommand).input);
}

describe('EC2Provider VPC DNS attribute removal (#1160)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new EC2Provider();
  });

  /** The deploy engine's path: the caller injects, then calls update(). */
  async function deployUpdate(
    desired: Record<string, unknown>,
    previous: Record<string, unknown>
  ): Promise<readonly string[]> {
    const removal = prepareRemovalForUpdate(provider, VPC, desired, previous);
    await provider.update('Vpc', 'vpc-123', VPC, removal.properties, previous, removal.context);
    return removal.unhandled;
  }

  it('declares the CloudFormation defaults measured by the A/B', () => {
    expect(provider.removalDefaults.get(VPC)).toEqual(
      new Map<string, unknown>([
        ['EnableDnsHostnames', false],
        ['EnableDnsSupport', true],
      ])
    );
  });

  it('a removed EnableDnsHostnames: true is reset to false', async () => {
    await deployUpdate(
      { CidrBlock: '10.0.0.0/16', EnableDnsSupport: true },
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: true, EnableDnsSupport: true }
    );
    expect(modifyVpcInputs()).toEqual([
      { VpcId: 'vpc-123', EnableDnsHostnames: { Value: false } },
    ]);
  });

  it('a removed EnableDnsSupport: false is reset to true', async () => {
    await deployUpdate(
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: false },
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: false, EnableDnsSupport: false }
    );
    expect(modifyVpcInputs()).toEqual([{ VpcId: 'vpc-123', EnableDnsSupport: { Value: true } }]);
  });

  it('both removed from a non-default pair: both are reset (string-typed baseline)', async () => {
    await deployUpdate(
      { CidrBlock: '10.0.0.0/16' },
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: 'true', EnableDnsSupport: 'false' }
    );
    expect(modifyVpcInputs()).toEqual([
      { VpcId: 'vpc-123', EnableDnsHostnames: { Value: false } },
      { VpcId: 'vpc-123', EnableDnsSupport: { Value: true } },
    ]);
  });

  it('a direct update() call (no caller context) injects the same reset', async () => {
    await provider.update(
      'Vpc',
      'vpc-123',
      VPC,
      { CidrBlock: '10.0.0.0/16' },
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: true, EnableDnsSupport: false }
    );
    expect(modifyVpcInputs()).toEqual([
      { VpcId: 'vpc-123', EnableDnsHostnames: { Value: false } },
      { VpcId: 'vpc-123', EnableDnsSupport: { Value: true } },
    ]);
  });

  it('a removed attribute that already held its default sends nothing', async () => {
    await deployUpdate(
      { CidrBlock: '10.0.0.0/16' },
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: false, EnableDnsSupport: true }
    );
    expect(modifyVpcInputs()).toEqual([]);
  });

  it('an attribute never declared stays unsent', async () => {
    await deployUpdate({ CidrBlock: '10.0.0.0/16' }, { CidrBlock: '10.0.0.0/16' });
    expect(modifyVpcInputs()).toEqual([]);
  });

  it('a present value is forwarded, not replaced by the default', async () => {
    await deployUpdate(
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: true, EnableDnsSupport: false },
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: false, EnableDnsSupport: true }
    );
    expect(modifyVpcInputs()).toEqual([
      { VpcId: 'vpc-123', EnableDnsHostnames: { Value: true } },
      { VpcId: 'vpc-123', EnableDnsSupport: { Value: false } },
    ]);
  });

  it('a drift --revert call (empty removedProperties) writes no reset', async () => {
    // drift.ts hands an empty set: the readback may carry an attribute the
    // template never declared, which is not a template removal.
    await provider.update(
      'Vpc',
      'vpc-123',
      VPC,
      { CidrBlock: '10.0.0.0/16' },
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: true, EnableDnsSupport: false },
      { removedProperties: new Set<string>() }
    );
    expect(modifyVpcInputs()).toEqual([]);
  });

  it('update(state, state) stays a zero-call round-trip', async () => {
    const state = { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: true, EnableDnsSupport: false };
    await deployUpdate(state, state);
    expect(modifyVpcInputs()).toEqual([]);
  });

  it('a reset DNS attribute is not reported as left in place', async () => {
    const unhandled = await deployUpdate(
      { CidrBlock: '10.0.0.0/16', Tags: [{ Key: 'k', Value: 'v' }] },
      {
        CidrBlock: '10.0.0.0/16',
        EnableDnsHostnames: true,
        Tags: [{ Key: 'k', Value: 'v' }],
      }
    );
    // VPC carries no removalHandledInUpdate entry, so the caller warns about
    // nothing, and the declared keys are reset rather than reported.
    expect(unhandled).toEqual([]);
    expect(modifyVpcInputs()).toEqual([
      { VpcId: 'vpc-123', EnableDnsHostnames: { Value: false } },
    ]);
  });
});

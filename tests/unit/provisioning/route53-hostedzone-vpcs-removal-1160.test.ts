import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import type { UpdateContext } from '../../../src/types/resource.js';

const TYPE = 'AWS::Route53::HostedZone';
const ZONE_ID = 'Z1234567890';
const VPC_A = { VPCId: 'vpc-aaaa1111', VPCRegion: 'us-east-1' };
const VPC_B = { VPCId: 'vpc-bbbb2222', VPCRegion: 'us-east-1' };

/**
 * Issue #1160, the Route 53 `VPCs` full-drop row. CloudFormation A/B
 * (us-east-1, 2026-10-20): a private zone with one VPC and one with two, each
 * updated to drop `VPCs`, kept every association; the two-VPC zone updated
 * again to `VPCs: []` kept both. So cdkd sends no Associate / Disassociate on
 * either shape, and names the kept associations in one warning.
 */
describe('Route53Provider HostedZone VPCs removal (#1160)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
    mockSend.mockResolvedValue({
      DelegationSet: { NameServers: [] },
      HostedZone: { Config: { PrivateZone: true } },
      VPCs: [VPC_A, VPC_B],
    });
  });

  const callsOf = (name: string) =>
    mockSend.mock.calls.filter((c) => c[0].constructor.name === name);
  const vpcCalls = () => [
    ...callsOf('AssociateVPCWithHostedZoneCommand'),
    ...callsOf('DisassociateVPCFromHostedZoneCommand'),
  ];
  const keptWarnings = () =>
    warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('VPC associations'));

  const update = (
    properties: Record<string, unknown>,
    previous: Record<string, unknown>,
    context?: UpdateContext
  ) => provider.update('MyZone', ZONE_ID, TYPE, properties, previous, context);

  it('REMOVED whole: disassociates nothing and warns once, as CloudFormation keeps them', async () => {
    await update({ Name: 'example.internal' }, { Name: 'example.internal', VPCs: [VPC_A, VPC_B] });

    expect(vpcCalls()).toHaveLength(0);
    const warnings = keptWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('MyZone (AWS::Route53::HostedZone)');
    expect(warnings[0]).toContain('VPCs was removed from the template');
    expect(warnings[0]).toContain('as CloudFormation leaves them');
  });

  it('EMPTIED to []: disassociates nothing and warns once', async () => {
    await update(
      { Name: 'example.internal', VPCs: [] },
      { Name: 'example.internal', VPCs: [VPC_A, VPC_B] }
    );

    expect(vpcCalls()).toHaveLength(0);
    expect(keptWarnings()).toHaveLength(1);
  });

  it('a removal on a deploy that names removedProperties warns the same way', async () => {
    await update(
      { Name: 'example.internal' },
      { Name: 'example.internal', VPCs: [VPC_A] },
      { removedProperties: new Set(['VPCs']) }
    );

    expect(vpcCalls()).toHaveLength(0);
    expect(keptWarnings()).toHaveLength(1);
  });

  it('a ROLLBACK revert says the restored state lacks VPCs instead', async () => {
    await update(
      { Name: 'example.internal' },
      { Name: 'example.internal', VPCs: [VPC_A] },
      { replayingState: true }
    );

    const warnings = keptWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('absent from the state being restored');
    expect(warnings[0]).not.toContain('removed from the template');
  });

  it('drift --revert (desired from an AWS readback) does not warn', async () => {
    await update({ Name: 'example.internal' }, { Name: 'example.internal', VPCs: [VPC_A] }, {
      desiredFromAwsReadback: true,
    });

    expect(keptWarnings()).toHaveLength(0);
  });

  it('NEVER PRESENT (a public zone): no VPC call and no warning', async () => {
    await update({ Name: 'example.com' }, { Name: 'example.com' });

    expect(vpcCalls()).toHaveLength(0);
    expect(keptWarnings()).toHaveLength(0);
  });

  it('a previous EMPTY list declared no VPC, so dropping it does not warn', async () => {
    await update({ Name: 'example.internal' }, { Name: 'example.internal', VPCs: [] });

    expect(vpcCalls()).toHaveLength(0);
    expect(keptWarnings()).toHaveLength(0);
  });

  it('KEPT and PARTIALLY dropped: still disassociates the dropped VPC, with no warning', async () => {
    await update(
      { Name: 'example.internal', VPCs: [VPC_A] },
      { Name: 'example.internal', VPCs: [VPC_A, VPC_B] }
    );

    const dis = callsOf('DisassociateVPCFromHostedZoneCommand');
    expect(dis).toHaveLength(1);
    expect(dis[0]![0].input.VPC.VPCId).toBe(VPC_B.VPCId);
    expect(keptWarnings()).toHaveLength(0);
  });

  it('a FAILED update does not warn', async () => {
    mockSend.mockImplementation((command: { constructor: { name: string } }) =>
      command.constructor.name === 'UpdateHostedZoneCommentCommand'
        ? Promise.reject(new Error('Throttling'))
        : Promise.resolve({ DelegationSet: { NameServers: [] } })
    );

    await expect(
      update({ Name: 'example.internal' }, { Name: 'example.internal', VPCs: [VPC_A] })
    ).rejects.toThrow();
    expect(keptWarnings()).toHaveLength(0);
  });
});

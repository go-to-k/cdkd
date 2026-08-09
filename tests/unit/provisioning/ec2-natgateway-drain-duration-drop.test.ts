/**
 * `AWS::EC2::NatGateway.MaxDrainDurationSeconds` declaration guard
 * (issue [#1411](https://github.com/go-to-k/cdkd/issues/1411)).
 *
 * The property used to sit in `EC2Provider.handledProperties` while NOTHING in
 * `src/` read it — the #1392 silent-drop class: the `property-coverage`
 * pre-flight passed on the declaration alone and the value reached no API call,
 * so a template setting it deployed "successfully" with the setting discarded.
 *
 * It cannot be wired from this provider. Verified against the installed
 * `@aws-sdk/client-ec2`: `CreateNatGatewayRequest` has no such member, EC2 ships
 * no `ModifyNatGateway*` operation, and the only two inputs carrying the field
 * (`DisassociateNatGatewayAddressRequest` /
 * `UnassignPrivateNatGatewayAddressRequest`) belong to calls cdkd never issues
 * because `EC2Provider.update` rejects every NatGateway property change. The
 * CFn registry schema agrees it is unreadable — it is listed under
 * `writeOnlyProperties`.
 *
 * So the fix moves it to `unhandledByDesign`, which turns the invisible drop
 * into the #614 routing signal: a NAT gateway whose template sets it is
 * provisioned through Cloud Control API, where AWS's own resource handler
 * applies the value. These tests pin every step of that chain — each one fails
 * against the pre-fix declaration.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { CreateNatGatewayCommand } from '@aws-sdk/client-ec2';

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
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { findSilentDropProperties } from '../../../src/provisioning/property-coverage.js';

const RESOURCE_TYPE = 'AWS::EC2::NatGateway';
const PROPERTY = 'MaxDrainDurationSeconds';

describe('AWS::EC2::NatGateway MaxDrainDurationSeconds (issue #1411)', () => {
  it('is NOT declared handled — the provider never delivers it to any EC2 call', () => {
    const provider = new EC2Provider();
    const handled = provider.handledProperties.get(RESOURCE_TYPE);
    expect(handled, 'EC2Provider must declare handled properties for the NAT gateway').toBeDefined();
    expect([...handled!]).not.toContain(PROPERTY);
    // The siblings that ARE wired stay wired — this is a one-property move, not
    // a rollback of NAT gateway support.
    expect([...handled!]).toEqual(
      expect.arrayContaining([
        'AllocationId',
        'SubnetId',
        'ConnectivityType',
        'PrivateIpAddress',
        'SecondaryAllocationIds',
        'SecondaryPrivateIpAddresses',
        'SecondaryPrivateIpAddressCount',
        'Tags',
      ])
    );
  });

  it('is declared unhandledByDesign with a rationale naming the missing API', () => {
    const provider = new EC2Provider();
    const byDesign = provider.unhandledByDesign?.get(RESOURCE_TYPE);
    expect(byDesign, 'NAT gateway must carry an unhandledByDesign map').toBeDefined();
    const rationale = byDesign!.get(PROPERTY);
    expect(rationale, `${PROPERTY} must carry a rationale`).toBeDefined();
    expect(rationale!.length).toBeGreaterThan(20);
    // The rationale is the artifact a future maintainer reads before
    // "fixing" this by re-declaring it handled, so it has to name WHY.
    expect(rationale).toMatch(/CreateNatGateway/);
  });

  it('is reported as a silent drop at pre-flight, so the resource auto-routes via CC API', () => {
    // The runtime consequence of the declaration move, read off the generated
    // coverage map. Pre-fix this returned [] and nothing ever surfaced.
    const drops = findSilentDropProperties(RESOURCE_TYPE, {
      SubnetId: 'subnet-1',
      MaxDrainDurationSeconds: 350,
    });
    expect(drops.map((d) => d.property)).toContain(PROPERTY);
  });

  it('routes a NAT gateway that sets it through Cloud Control, and one that does not through the SDK provider', () => {
    const registry = new ProviderRegistry();
    registry.register(RESOURCE_TYPE, new EC2Provider());

    const withDrain = registry.getProviderFor({
      resourceType: RESOURCE_TYPE,
      properties: { SubnetId: 'subnet-1', MaxDrainDurationSeconds: 350 },
    });
    expect(withDrain.provisionedBy).toBe('cc-api');
    expect(withDrain.provider).toBe(registry.getCloudControlProvider());

    const withoutDrain = registry.getProviderFor({
      resourceType: RESOURCE_TYPE,
      properties: { SubnetId: 'subnet-1' },
    });
    expect(withoutDrain.provisionedBy).toBe('sdk');
    expect(withoutDrain.provider).not.toBe(registry.getCloudControlProvider());
  });

  it('never forwards the value on CreateNatGateway (the SDK input has no such member)', async () => {
    // The other half of the honesty claim: the SDK path must not pretend to
    // carry it. AWS SDK v3 drops unknown members silently, so a "helpful"
    // pass-through would look wired to a reader and still deliver nothing.
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ NatGateway: { NatGatewayId: 'nat-1' } });
    mockSend.mockResolvedValueOnce({}); // CreateTags
    const previousNoWait = process.env['CDKD_NO_WAIT'];
    process.env['CDKD_NO_WAIT'] = 'true';
    try {
      await new EC2Provider().create('Nat', RESOURCE_TYPE, {
        SubnetId: 'subnet-1',
        MaxDrainDurationSeconds: 350,
      });
    } finally {
      if (previousNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
      else process.env['CDKD_NO_WAIT'] = previousNoWait;
    }

    const createCall = mockSend.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof CreateNatGatewayCommand);
    expect(createCall, 'CreateNatGatewayCommand must have been sent').toBeDefined();
    expect(Object.keys((createCall as CreateNatGatewayCommand).input)).not.toContain(PROPERTY);
  });
});

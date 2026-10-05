import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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

import { HostedZoneAlreadyExists } from '@aws-sdk/client-route-53';

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

// go-to-k/cdkd#4583: a failure after CreateHostedZone returned names the zone
// id for the failed-CREATE journal, unless the Accelerated Recovery arm's
// rollback deleted the zone.
const TYPE = 'AWS::Route53::HostedZone';
const ZONE_ID = 'Z0001';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const VPCS = [
  { VPCId: 'vpc-1', VPCRegion: 'us-east-1' },
  { VPCId: 'vpc-2', VPCRegion: 'us-east-1' },
];

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected create() to throw');
}

function fakeAws(
  overrides: Partial<Record<string, (input: Record<string, unknown>) => unknown>>
): void {
  mockSend.mockImplementation(async (cmd: Cmd) => {
    const handler = overrides[cmd.constructor.name];
    if (handler) return handler(cmd.input);
    if (cmd.constructor.name === 'CreateHostedZoneCommand') {
      return {
        HostedZone: { Id: `/hostedzone/${ZONE_ID}`, Name: 'example.com.' },
        DelegationSet: { NameServers: ['ns-1'] },
      };
    }
    if (cmd.constructor.name === 'ListQueryLoggingConfigsCommand') {
      return { QueryLoggingConfigs: [] };
    }
    return {};
  });
}

describe('Route53Provider HostedZone created-before-failure mark (#4583)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    mockSend.mockReset();
    resetIdempotencyTokensForTests();
    provider = new Route53Provider();
  });

  it('marks the zone id when an additional VPC association fails after create', async () => {
    fakeAws({
      AssociateVPCWithHostedZoneCommand: () => {
        throw new Error('AccessDenied');
      },
    });
    const err = await caught(provider.create('Zone', TYPE, { Name: 'example.com', VPCs: VPCS }));
    expect(createdBeforeFailure(err, 'Zone', TYPE)).toBe(ZONE_ID);
  });

  it('marks the adopted zone (same caller reference) when a follow-up fails', async () => {
    let callerReference = '';
    fakeAws({
      CreateHostedZoneCommand: (input) => {
        callerReference = input['CallerReference'] as string;
        throw new HostedZoneAlreadyExists({ message: 'exists', $metadata: {} });
      },
      ListHostedZonesByNameCommand: () => ({
        HostedZones: [
          { Id: `/hostedzone/${ZONE_ID}`, Name: 'example.com.', CallerReference: callerReference },
        ],
      }),
      GetHostedZoneCommand: () => ({
        HostedZone: { Id: `/hostedzone/${ZONE_ID}`, Name: 'example.com.' },
        DelegationSet: { NameServers: ['ns-1'] },
      }),
      AssociateVPCWithHostedZoneCommand: () => {
        throw new Error('AccessDenied');
      },
    });
    const err = await caught(provider.create('Zone', TYPE, { Name: 'example.com', VPCs: VPCS }));
    expect(createdBeforeFailure(err, 'Zone', TYPE)).toBe(ZONE_ID);
  });

  it('does not mark when the Accelerated Recovery rollback deleted the zone', async () => {
    fakeAws({
      UpdateHostedZoneFeaturesCommand: () => {
        throw new Error('InvalidInput');
      },
    });
    const err = await caught(
      provider.create('Zone', TYPE, {
        Name: 'example.com',
        HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' },
      })
    );
    expect(
      mockSend.mock.calls.some((c) => (c[0] as Cmd).constructor.name === 'DeleteHostedZoneCommand')
    ).toBe(true);
    expect(createdBeforeFailure(err, 'Zone', TYPE)).toBeUndefined();
  });

  it('marks when the Accelerated Recovery rollback delete also failed', async () => {
    fakeAws({
      UpdateHostedZoneFeaturesCommand: () => {
        throw new Error('InvalidInput');
      },
      DeleteHostedZoneCommand: () => {
        throw new Error('Throttling');
      },
    });
    const err = await caught(
      provider.create('Zone', TYPE, {
        Name: 'example.com',
        HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' },
      })
    );
    expect(createdBeforeFailure(err, 'Zone', TYPE)).toBe(ZONE_ID);
  });

  it('does not mark when CreateHostedZone itself fails', async () => {
    fakeAws({
      CreateHostedZoneCommand: () => {
        throw new Error('InvalidDomainName');
      },
    });
    const err = await caught(provider.create('Zone', TYPE, { Name: 'example.com' }));
    expect(createdBeforeFailure(err, 'Zone', TYPE)).toBeUndefined();
  });

  it('does not mark the pre-flight refusal of a missing Name', async () => {
    const err = await caught(provider.create('Zone', TYPE, {}));
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(err, 'Zone', TYPE)).toBeUndefined();
  });
});

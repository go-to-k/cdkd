/**
 * go-to-k/cdkd#2762: `AWS::Route53::HostedZone` `DelegationSetId` is
 * create-only. The SDK provider did not handle it, so declaring it routed the
 * zone through Cloud Control; it now rides on CreateHostedZone and is read back.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateHostedZoneCommand,
  GetHostedZoneCommand,
  ListTagsForResourceCommand,
  ListQueryLoggingConfigsCommand,
} from '@aws-sdk/client-route-53';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-route-53')>(
    '@aws-sdk/client-route-53'
  );
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

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::Route53::HostedZone';

function createInput(): Record<string, unknown> {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateHostedZoneCommand);
  if (!call) throw new Error('CreateHostedZone was not sent');
  return (call[0] as CreateHostedZoneCommand).input as unknown as Record<string, unknown>;
}

describe('Route 53 HostedZone DelegationSetId (#2762)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    mockSend.mockReset();
    resetIdempotencyTokensForTests();
    provider = new Route53Provider();
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateHostedZoneCommand) {
        return Promise.resolve({
          HostedZone: { Id: '/hostedzone/Z1', Name: 'example.com.' },
          DelegationSet: {
            Id: '/delegationset/N1',
            NameServers: ['ns-1.awsdns-01.org'],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it.each(['N1', '/delegationset/N1'])(
    'sends a declared DelegationSetId (%s) to CreateHostedZone as written',
    async (declared) => {
      await provider.create('Zone', TYPE, { Name: 'example.com', DelegationSetId: declared });
      expect(createInput()['DelegationSetId']).toBe(declared);
    }
  );

  it('sends no DelegationSetId when undeclared', async () => {
    await provider.create('Zone', TYPE, { Name: 'example.com' });
    expect(Object.keys(createInput())).not.toContain('DelegationSetId');
  });

  it('refuses a non-string DelegationSetId before any AWS call', async () => {
    await expect(
      provider.create('Zone', TYPE, { Name: 'example.com', DelegationSetId: { Ref: 'X' } })
    ).rejects.toThrow(ProvisioningError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('only warns about a non-string DelegationSetId when replaying a state record', async () => {
    await provider.create(
      'Zone',
      TYPE,
      { Name: 'example.com', DelegationSetId: { Ref: 'X' } },
      { replayingState: true }
    );
    expect(Object.keys(createInput())).not.toContain('DelegationSetId');
  });

  describe('readCurrentState', () => {
    function answerRead(delegationSet: Record<string, unknown> | undefined): void {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetHostedZoneCommand) {
          return Promise.resolve({
            HostedZone: { Id: '/hostedzone/Z1', Name: 'example.com.', Config: {} },
            ...(delegationSet ? { DelegationSet: delegationSet } : {}),
          });
        }
        if (cmd instanceof ListTagsForResourceCommand) {
          return Promise.resolve({ ResourceTagSet: { Tags: [] } });
        }
        if (cmd instanceof ListQueryLoggingConfigsCommand) {
          return Promise.resolve({ QueryLoggingConfigs: [] });
        }
        return Promise.resolve({});
      });
    }

    it('reads a reusable delegation set id back bare', async () => {
      answerRead({ Id: '/delegationset/N1', NameServers: ['ns-1'] });
      const result = (await provider.readCurrentState('Z1', 'Zone', TYPE)) as Record<
        string,
        unknown
      >;
      expect(result['DelegationSetId']).toBe('N1');
    });

    it('keeps the prefixed spelling when the declaration uses it for this same id', async () => {
      answerRead({ Id: '/delegationset/N1', NameServers: ['ns-1'] });
      const declared = (await provider.readCurrentState('Z1', 'Zone', TYPE, {
        Name: 'example.com',
        DelegationSetId: '/delegationset/N1',
      })) as Record<string, unknown>;
      expect(declared['DelegationSetId']).toBe('/delegationset/N1');

      // A DIFFERENT declared id is real drift, reported bare.
      answerRead({ Id: '/delegationset/N2', NameServers: ['ns-1'] });
      const other = (await provider.readCurrentState('Z1', 'Zone', TYPE, {
        Name: 'example.com',
        DelegationSetId: '/delegationset/N1',
      })) as Record<string, unknown>;
      expect(other['DelegationSetId']).toBe('N2');
    });

    it('emits no DelegationSetId for a zone with its own name servers', async () => {
      answerRead({ NameServers: ['ns-1'] });
      const result = (await provider.readCurrentState('Z1', 'Zone', TYPE)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(result)).not.toContain('DelegationSetId');
    });
  });
});

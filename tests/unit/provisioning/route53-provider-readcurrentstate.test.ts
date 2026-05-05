import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetHostedZoneCommand,
  ListResourceRecordSetsCommand,
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

describe('Route53Provider.readCurrentState', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
  });

  describe('AWS::Route53::HostedZone', () => {
    it('returns CFn-shaped HostedZone properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        HostedZone: {
          Id: '/hostedzone/Z1',
          Name: 'example.com.',
          Config: { Comment: 'mine', PrivateZone: true },
        },
        VPCs: [{ VPCId: 'vpc-1', VPCRegion: 'us-east-1' }],
      });

      const result = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetHostedZoneCommand);
      expect(result).toEqual({
        Name: 'example.com.',
        HostedZoneConfig: { Comment: 'mine', PrivateZone: true },
        VPCs: [{ VPCId: 'vpc-1', VPCRegion: 'us-east-1' }],
      });
    });

    it('returns undefined when zone is gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { name: 'NoSuchHostedZone' })
      );
      const result = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::Route53::RecordSet', () => {
    it('returns CFn-shaped RecordSet properties + flattens ResourceRecords', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          {
            Name: 'a.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '1.2.3.4' }, { Value: '5.6.7.8' }],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'Z1|a.example.com.|A',
        'L',
        'AWS::Route53::RecordSet'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(ListResourceRecordSetsCommand);
      expect(result).toEqual({
        HostedZoneId: 'Z1',
        Name: 'a.example.com.',
        Type: 'A',
        TTL: 300,
        ResourceRecords: ['1.2.3.4', '5.6.7.8'],
      });
    });

    it('returns AliasTarget for alias records', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          {
            Name: 'alias.example.com.',
            Type: 'A',
            AliasTarget: {
              HostedZoneId: 'Z2',
              DNSName: 'lb-1.us-east-1.elb.amazonaws.com.',
              EvaluateTargetHealth: false,
            },
          },
        ],
      });

      const result = await provider.readCurrentState(
        'Z1|alias.example.com.|A',
        'L',
        'AWS::Route53::RecordSet'
      );

      expect(result).toEqual({
        HostedZoneId: 'Z1',
        Name: 'alias.example.com.',
        Type: 'A',
        AliasTarget: {
          HostedZoneId: 'Z2',
          DNSName: 'lb-1.us-east-1.elb.amazonaws.com.',
          EvaluateTargetHealth: false,
        },
      });
    });

    it('returns undefined when no matching record', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          { Name: 'other.example.com.', Type: 'A' },
        ],
      });
      const result = await provider.readCurrentState(
        'Z1|missing.example.com.|A',
        'L',
        'AWS::Route53::RecordSet'
      );
      expect(result).toBeUndefined();
    });
  });
});

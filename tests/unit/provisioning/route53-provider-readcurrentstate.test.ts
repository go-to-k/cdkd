import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetHostedZoneCommand,
  ListQueryLoggingConfigsCommand,
  ListResourceRecordSetsCommand,
  ListTagsForResourceCommand,
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
      mockSend
        .mockResolvedValueOnce({
          HostedZone: {
            Id: '/hostedzone/Z1',
            Name: 'example.com.',
            Config: { Comment: 'mine', PrivateZone: true },
          },
          VPCs: [{ VPCId: 'vpc-1', VPCRegion: 'us-east-1' }],
        })
        .mockResolvedValueOnce({ ResourceTagSet: { ResourceId: 'Z1', Tags: [] } })
        .mockResolvedValueOnce({ QueryLoggingConfigs: [] });

      const result = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetHostedZoneCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListQueryLoggingConfigsCommand);
      expect(result).toEqual({
        Name: 'example.com.',
        HostedZoneConfig: { Comment: 'mine', PrivateZone: true },
        VPCs: [{ VPCId: 'vpc-1', VPCRegion: 'us-east-1' }],
        HostedZoneTags: [],
        QueryLoggingConfig: {},
      });
    });

    it('surfaces QueryLoggingConfig.CloudWatchLogsLogGroupArn when AWS has one configured', async () => {
      mockSend
        .mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1', Name: 'example.com.' },
        })
        .mockResolvedValueOnce({ ResourceTagSet: { ResourceId: 'Z1', Tags: [] } })
        .mockResolvedValueOnce({
          QueryLoggingConfigs: [
            {
              Id: 'qlc-id',
              HostedZoneId: 'Z1',
              CloudWatchLogsLogGroupArn:
                'arn:aws:logs:us-east-1:123:log-group:/aws/route53/example',
            },
          ],
        });

      const result = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');
      expect(result?.QueryLoggingConfig).toEqual({
        CloudWatchLogsLogGroupArn:
          'arn:aws:logs:us-east-1:123:log-group:/aws/route53/example',
      });
    });

    it('returns undefined when zone is gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { name: 'NoSuchHostedZone' })
      );
      const result = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');
      expect(result).toBeUndefined();
    });

    it('surfaces HostedZoneTags from ListTagsForResource with aws:* filtered out', async () => {
      mockSend
        .mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1', Name: 'example.com.' },
        })
        .mockResolvedValueOnce({
          ResourceTagSet: {
            ResourceId: 'Z1',
            Tags: [
              { Key: 'Foo', Value: 'Bar' },
              { Key: 'aws:cdk:path', Value: 'MyStack/MyZone/Resource' },
            ],
          },
        })
        .mockResolvedValueOnce({ QueryLoggingConfigs: [] });

      const result = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');
      expect(result?.HostedZoneTags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
    });

    it('emits empty HostedZoneTags placeholder when ListTagsForResource returns no user tags', async () => {
      mockSend
        .mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1', Name: 'example.com.' },
        })
        .mockResolvedValueOnce({
          ResourceTagSet: {
            ResourceId: 'Z1',
            Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyZone/Resource' }],
          },
        })
        .mockResolvedValueOnce({ QueryLoggingConfigs: [] });

      const result = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');
      expect(result?.HostedZoneTags).toEqual([]);
    });

    it('emits HostedZoneFeatures when GetHostedZone returns Features.AcceleratedRecoveryStatus', async () => {
      mockSend
        .mockResolvedValueOnce({
          HostedZone: {
            Id: '/hostedzone/Z1',
            Name: 'example.com.',
            Features: { AcceleratedRecoveryStatus: 'ENABLED' },
          },
        })
        .mockResolvedValueOnce({ ResourceTagSet: { Tags: [] } })
        .mockResolvedValueOnce({ QueryLoggingConfigs: [] });

      const result = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');
      expect(result?.HostedZoneFeatures).toEqual({ AcceleratedRecoveryStatus: 'ENABLED' });
    });

    it('omits HostedZoneFeatures when GetHostedZone returns no Features (typical zone)', async () => {
      // Emit-when-present: a zone that never opted into AcceleratedRecovery
      // returns no Features from GetHostedZone. A placeholder
      // `{ AcceleratedRecoveryStatus: 'DISABLED' }` would force guaranteed
      // drift on every clean run for zones older than the 2025 feature launch.
      mockSend
        .mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1', Name: 'example.com.' },
        })
        .mockResolvedValueOnce({ ResourceTagSet: { Tags: [] } })
        .mockResolvedValueOnce({ QueryLoggingConfigs: [] });

      const result = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');
      expect(result).not.toHaveProperty('HostedZoneFeatures');
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

      // Class 1 gate: alias records do NOT carry TTL / ResourceRecords
      // placeholders in the observed snapshot — those fields are
      // mutually exclusive with AliasTarget per AWS, so emitting `[]`
      // would (a) fire false drift against state that never had the
      // key and (b) round-trip into a structurally-invalid
      // ChangeResourceRecordSets input.
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

    it('emits GeoProximityLocation (emit-when-present) when AWS returns it', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          {
            Name: 'geo.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '198.51.100.1' }],
            SetIdentifier: 'geo-use1',
            GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: 10 },
          },
        ],
      });

      const result = await provider.readCurrentState(
        'Z1|geo.example.com.|A',
        'L',
        'AWS::Route53::RecordSet'
      );

      expect(result).toEqual({
        HostedZoneId: 'Z1',
        Name: 'geo.example.com.',
        Type: 'A',
        TTL: 300,
        ResourceRecords: ['198.51.100.1'],
        SetIdentifier: 'geo-use1',
        GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: 10 },
      });
    });

    it('emits GeoProximityLocation Coordinates + LocalZoneGroup sub-fields when present', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          {
            Name: 'geo2.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '198.51.100.2' }],
            SetIdentifier: 'geo-coords',
            GeoProximityLocation: {
              LocalZoneGroup: 'us-east-1-bue-1',
              Coordinates: { Latitude: '49.22', Longitude: '-74.01' },
              Bias: 0,
            },
          },
        ],
      });

      const result = await provider.readCurrentState(
        'Z1|geo2.example.com.|A',
        'L',
        'AWS::Route53::RecordSet'
      );

      // Bias=0 survives the `!== undefined` emit gate.
      expect(result?.['GeoProximityLocation']).toEqual({
        LocalZoneGroup: 'us-east-1-bue-1',
        Coordinates: { Latitude: '49.22', Longitude: '-74.01' },
        Bias: 0,
      });
    });

    it('omits GeoProximityLocation when AWS does not return it', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          {
            Name: 'plain.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '1.2.3.4' }],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'Z1|plain.example.com.|A',
        'L',
        'AWS::Route53::RecordSet'
      );

      expect(result).not.toHaveProperty('GeoProximityLocation');
    });

    it('emits CidrRoutingConfig (emit-when-present) when AWS returns it', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          {
            Name: 'cidr.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '198.51.100.4' }],
            SetIdentifier: 'cidr-office',
            CidrRoutingConfig: { CollectionId: 'col-1234', LocationName: 'office' },
          },
        ],
      });

      const result = await provider.readCurrentState(
        'Z1|cidr.example.com.|A',
        'L',
        'AWS::Route53::RecordSet'
      );

      expect(result).toEqual({
        HostedZoneId: 'Z1',
        Name: 'cidr.example.com.',
        Type: 'A',
        TTL: 300,
        ResourceRecords: ['198.51.100.4'],
        SetIdentifier: 'cidr-office',
        CidrRoutingConfig: { CollectionId: 'col-1234', LocationName: 'office' },
      });
    });

    it('emits only the CidrRoutingConfig sub-fields AWS returns', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          {
            Name: 'cidr2.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '198.51.100.5' }],
            SetIdentifier: 'cidr-default',
            // CollectionId-only readback (LocationName absent on the wire).
            CidrRoutingConfig: { CollectionId: 'col-5678' },
          },
        ],
      });

      const result = await provider.readCurrentState(
        'Z1|cidr2.example.com.|A',
        'L',
        'AWS::Route53::RecordSet'
      );

      expect(result?.['CidrRoutingConfig']).toEqual({ CollectionId: 'col-5678' });
    });

    it('omits CidrRoutingConfig when AWS does not return it', async () => {
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          {
            Name: 'plain3.example.com.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '1.2.3.4' }],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'Z1|plain3.example.com.|A',
        'L',
        'AWS::Route53::RecordSet'
      );

      expect(result).not.toHaveProperty('CidrRoutingConfig');
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

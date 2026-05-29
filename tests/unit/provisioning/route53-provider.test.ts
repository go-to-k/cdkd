import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({ send: mockSend, config: { region: () => Promise.resolve('us-east-1') } })),
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

describe('Route53Provider', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
  });

  // ─── AWS::Route53::HostedZone ──────────────────────────────────────

  describe('HostedZone', () => {
    describe('create', () => {
      it('should create hosted zone and return zone ID without /hostedzone/ prefix', async () => {
        mockSend.mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1234567890' },
          DelegationSet: {
            NameServers: ['ns-1.example.com', 'ns-2.example.com'],
          },
        });

        const result = await provider.create(
          'MyZone',
          'AWS::Route53::HostedZone',
          { Name: 'example.com' }
        );

        expect(result.physicalId).toBe('Z1234567890');
        expect(result.attributes).toEqual({
          Id: 'Z1234567890',
          NameServers: 'ns-1.example.com,ns-2.example.com',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateHostedZoneCommand');
        expect(createCall.input.Name).toBe('example.com');
      });
    });

    describe('delete', () => {
      it('should delete hosted zone', async () => {
        // First call: ListQueryLoggingConfigs (cleanup before delete)
        mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
        // Second call: DeleteHostedZone
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyZone',
          'Z1234567890',
          'AWS::Route53::HostedZone'
        );

        expect(mockSend).toHaveBeenCalledTimes(2);

        const listCall = mockSend.mock.calls[0][0];
        expect(listCall.constructor.name).toBe('ListQueryLoggingConfigsCommand');

        const deleteCall = mockSend.mock.calls[1][0];
        expect(deleteCall.constructor.name).toBe('DeleteHostedZoneCommand');
        expect(deleteCall.input.Id).toBe('Z1234567890');
      });

      it('should handle NoSuchHostedZone', async () => {
        // ListQueryLoggingConfigs succeeds (or fails gracefully)
        mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
        // DeleteHostedZone throws NoSuchHostedZone
        const error = new Error('No such hosted zone');
        error.name = 'NoSuchHostedZone';
        mockSend.mockRejectedValueOnce(error);

        await provider.delete(
          'MyZone',
          'Z1234567890',
          'AWS::Route53::HostedZone'
        );

        expect(mockSend).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ─── AWS::Route53::RecordSet ───────────────────────────────────────

  describe('RecordSet', () => {
    describe('create', () => {
      it('should create record set with composite physicalId (zoneId|name|type)', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create(
          'MyRecord',
          'AWS::Route53::RecordSet',
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '300',
            ResourceRecords: ['1.2.3.4'],
          }
        );

        expect(result.physicalId).toBe('Z1234567890|www.example.com.|A');
        expect(mockSend).toHaveBeenCalledTimes(1);

        const changeCall = mockSend.mock.calls[0][0];
        expect(changeCall.constructor.name).toBe(
          'ChangeResourceRecordSetsCommand'
        );
        expect(changeCall.input.ChangeBatch.Changes[0].Action).toBe('CREATE');
      });

      it('should convert ResourceRecords strings to {Value} format', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyRecord', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'www.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['1.2.3.4', '5.6.7.8'],
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.ResourceRecords).toEqual([
          { Value: '1.2.3.4' },
          { Value: '5.6.7.8' },
        ]);
      });

      it('should handle AliasTarget', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyAlias', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'www.example.com.',
          Type: 'A',
          AliasTarget: {
            HostedZoneId: 'Z2FDTNDATAQYW2',
            DNSName: 'd123456.cloudfront.net.',
            EvaluateTargetHealth: false,
          },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.AliasTarget).toEqual({
          HostedZoneId: 'Z2FDTNDATAQYW2',
          DNSName: 'd123456.cloudfront.net.',
          EvaluateTargetHealth: false,
        });
        // AliasTarget records should not have TTL or ResourceRecords
        expect(recordSet.TTL).toBeUndefined();
        expect(recordSet.ResourceRecords).toBeUndefined();
      });

      it('should send GeoProximityLocation (AWSRegion + Bias) into the ChangeResourceRecordSets ResourceRecordSet', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyGeoProximity', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'geo.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['198.51.100.1'],
          SetIdentifier: 'geo-use1',
          GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: 10 },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.SetIdentifier).toBe('geo-use1');
        expect(recordSet.GeoProximityLocation).toEqual({
          AWSRegion: 'us-east-1',
          Bias: 10,
        });
      });

      it('should coerce a string Bias to a number (CFn may emit numeric props as strings)', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyGeoProximityStrBias', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'geo3.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['198.51.100.3'],
          SetIdentifier: 'geo-strbias',
          GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: '10' },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        // `Bias` must reach the SDK as a number, not the string '10'.
        expect(recordSet.GeoProximityLocation).toEqual({
          AWSRegion: 'us-east-1',
          Bias: 10,
        });
      });

      it('should map GeoProximityLocation Coordinates + LocalZoneGroup when present', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyGeoProximityCoords', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'geo2.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['198.51.100.2'],
          SetIdentifier: 'geo-coords',
          GeoProximityLocation: {
            Coordinates: { Latitude: '49.22', Longitude: '-74.01' },
            Bias: 0,
          },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        // Bias=0 must survive the omit-when-absent gate (falsy-value guard).
        expect(recordSet.GeoProximityLocation).toEqual({
          Coordinates: { Latitude: '49.22', Longitude: '-74.01' },
          Bias: 0,
        });
      });

      it('should omit GeoProximityLocation when absent', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyPlainRecord', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'www.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['1.2.3.4'],
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.GeoProximityLocation).toBeUndefined();
      });
    });

    describe('update', () => {
      it('should UPSERT record', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.update(
          'MyRecord',
          'Z1234567890|www.example.com.|A',
          'AWS::Route53::RecordSet',
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '600',
            ResourceRecords: ['1.2.3.4'],
          },
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '300',
            ResourceRecords: ['1.2.3.4'],
          }
        );

        expect(result.physicalId).toBe('Z1234567890|www.example.com.|A');
        expect(result.wasReplaced).toBe(false);
        expect(mockSend).toHaveBeenCalledTimes(1);

        const changeCall = mockSend.mock.calls[0][0];
        expect(changeCall.input.ChangeBatch.Changes[0].Action).toBe('UPSERT');
      });
    });

    describe('delete', () => {
      it('should DELETE record', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyRecord',
          'Z1234567890|www.example.com.|A',
          'AWS::Route53::RecordSet',
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '300',
            ResourceRecords: ['1.2.3.4'],
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);

        const changeCall = mockSend.mock.calls[0][0];
        expect(changeCall.constructor.name).toBe(
          'ChangeResourceRecordSetsCommand'
        );
        expect(changeCall.input.ChangeBatch.Changes[0].Action).toBe('DELETE');
      });

      it('should handle not-found error (InvalidChangeBatch)', async () => {
        const error = new Error(
          'Tried to delete resource record set but it was not found'
        );
        error.name = 'InvalidChangeBatch';
        mockSend.mockRejectedValueOnce(error);

        await provider.delete(
          'MyRecord',
          'Z1234567890|www.example.com.|A',
          'AWS::Route53::RecordSet',
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '300',
            ResourceRecords: ['1.2.3.4'],
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyZone',
        resourceType: 'AWS::Route53::HostedZone',
        cdkPath: 'MyStack/MyZone',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('explicit override (HostedZone): GetHostedZone verifies and returns id', async () => {
      mockSend.mockResolvedValueOnce({ HostedZone: { Id: '/hostedzone/Z123' } });

      const result = await provider.import(makeInput({ knownPhysicalId: 'Z123' }));

      expect(result).toEqual({ physicalId: 'Z123', attributes: {} });
      const call = mockSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('GetHostedZoneCommand');
      expect(call.input).toEqual({ Id: 'Z123' });
    });

    it('tag-based lookup (HostedZone): walks ListHostedZones + ListTagsForResource', async () => {
      // ListHostedZones
      mockSend.mockResolvedValueOnce({
        HostedZones: [
          { Id: '/hostedzone/ZAAA', Name: 'a.example.com.' },
          { Id: '/hostedzone/ZBBB', Name: 'b.example.com.' },
        ],
        IsTruncated: false,
      });
      // ListTagsForResource for ZAAA
      mockSend.mockResolvedValueOnce({
        ResourceTagSet: { Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }] },
      });
      // ListTagsForResource for ZBBB
      mockSend.mockResolvedValueOnce({
        ResourceTagSet: { Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyZone' }] },
      });

      const result = await provider.import(makeInput());
      expect(result).toEqual({ physicalId: 'ZBBB', attributes: {} });
    });

    it('returns null (HostedZone) when no zone matches', async () => {
      mockSend.mockResolvedValueOnce({
        HostedZones: [{ Id: '/hostedzone/Zonly', Name: 'only.example.com.' }],
        IsTruncated: false,
      });
      mockSend.mockResolvedValueOnce({
        ResourceTagSet: { Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }] },
      });

      const result = await provider.import(makeInput());
      expect(result).toBeNull();
    });

    it('RecordSet: explicit override returned as-is, no AWS calls', async () => {
      const result = await provider.import(
        makeInput({
          resourceType: 'AWS::Route53::RecordSet',
          knownPhysicalId: 'Z123|www.example.com.|A',
        })
      );
      expect(result).toEqual({ physicalId: 'Z123|www.example.com.|A', attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('RecordSet: returns null without explicit override (not taggable)', async () => {
      const result = await provider.import(
        makeInput({ resourceType: 'AWS::Route53::RecordSet' })
      );
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});

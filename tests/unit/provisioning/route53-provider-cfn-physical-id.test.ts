import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
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

import {
  Route53Provider,
  parseRecordSetCompositeId,
} from '../../../src/provisioning/providers/route53-provider.js';

const RECORD_PROPS = {
  HostedZoneId: 'Z0123456789ABCDEFGHIJ',
  Name: 'record.example.com.',
  Type: 'A',
  TTL: 300,
  ResourceRecords: ['1.2.3.4'],
};

/** The shape `ListResourceRecordSets` returns for RECORD_PROPS. */
const AWS_RECORD = {
  ResourceRecordSets: [
    {
      Name: 'record.example.com.',
      Type: 'A',
      TTL: 300,
      ResourceRecords: [{ Value: '1.2.3.4' }],
    },
  ],
};

describe('Route53 RecordSet physicalId: CloudFormation form vs cdkd composite (issue #1658)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
  });

  describe('parseRecordSetCompositeId', () => {
    it('parses cdkd composite ids', () => {
      expect(parseRecordSetCompositeId('Z1|record.example.com.|A')).toEqual({
        hostedZoneId: 'Z1',
        name: 'record.example.com.',
        type: 'A',
      });
    });

    it("rejects CloudFormation's scalar physicalId (the record name)", () => {
      expect(parseRecordSetCompositeId('record.example.com')).toBeUndefined();
    });

    it('rejects wrong-arity and blank-segment ids', () => {
      expect(parseRecordSetCompositeId('Z1|record.example.com.')).toBeUndefined();
      expect(parseRecordSetCompositeId('Z1|record.example.com.|A|extra')).toBeUndefined();
      expect(parseRecordSetCompositeId('Z1||A')).toBeUndefined();
    });
  });

  describe('import()', () => {
    it("canonicalizes CloudFormation's record-name physicalId into cdkd's composite", async () => {
      mockSend.mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: RECORD_PROPS,
        // What `--migrate-from-cloudformation` pre-populates from
        // DescribeStackResources: CFn's physicalId, not cdkd's composite.
        knownPhysicalId: 'record.example.com',
      });

      expect(result).toEqual({
        physicalId: 'Z0123456789ABCDEFGHIJ|record.example.com.|A',
        attributes: {},
      });
      const verify = mockSend.mock.calls[0]?.[0];
      expect(verify).toBeInstanceOf(ListResourceRecordSetsCommand);
      expect(verify.input).toMatchObject({ HostedZoneId: 'Z0123456789ABCDEFGHIJ' });
    });

    it('passes an already-composite override through without an AWS call', async () => {
      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: RECORD_PROPS,
        knownPhysicalId: 'Z9|record.example.com.|A',
      });

      expect(result).toEqual({ physicalId: 'Z9|record.example.com.|A', attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('resolves the zone via HostedZoneName when the template has no HostedZoneId', async () => {
      mockSend
        .mockResolvedValueOnce({
          HostedZones: [{ Id: '/hostedzone/Z0123456789ABCDEFGHIJ', Name: 'example.com.' }],
        })
        .mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { ...RECORD_PROPS, HostedZoneId: undefined, HostedZoneName: 'example.com' },
        knownPhysicalId: 'record.example.com',
      });

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(ListHostedZonesByNameCommand);
      expect(result).toEqual({
        physicalId: 'Z0123456789ABCDEFGHIJ|record.example.com.|A',
        attributes: {},
      });
    });

    it('stays override-only: declines with no override, per docs/import.md', async () => {
      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: RECORD_PROPS,
      });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null (skipped-not-found) when the record does not exist in AWS', async () => {
      mockSend.mockResolvedValueOnce({ ResourceRecordSets: [] });

      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: RECORD_PROPS,
        knownPhysicalId: 'record.example.com',
      });

      expect(result).toBeNull();
    });

    it('returns null when the zone cannot be resolved from the template', async () => {
      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { Name: 'record.example.com.', Type: 'A' },
        knownPhysicalId: 'record.example.com',
      });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('delete()', () => {
    it('deletes a record whose state carries the cdkd composite id', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete(
        'WebsiteRecord',
        'Z0123456789ABCDEFGHIJ|record.example.com.|A',
        'AWS::Route53::RecordSet',
        RECORD_PROPS
      );

      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(ChangeResourceRecordSetsCommand);
      expect(call.input.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
    });

    it("deletes a record whose state carries CloudFormation's scalar id, by resolving the zone from properties", async () => {
      mockSend.mockResolvedValueOnce({});

      // Pre-#1658 state written by `cdkd import --migrate-from-cloudformation`.
      await provider.delete(
        'WebsiteRecord',
        'record.example.com',
        'AWS::Route53::RecordSet',
        RECORD_PROPS
      );

      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(ChangeResourceRecordSetsCommand);
      expect(call.input.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
      expect(call.input.ChangeBatch.Changes[0].Action).toBe('DELETE');
    });

    it('resolves the zone via HostedZoneName when state carries the scalar id and no HostedZoneId', async () => {
      mockSend
        .mockResolvedValueOnce({
          HostedZones: [{ Id: '/hostedzone/Z0123456789ABCDEFGHIJ', Name: 'example.com.' }],
        })
        .mockResolvedValueOnce({});

      await provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
        ...RECORD_PROPS,
        HostedZoneId: undefined,
        HostedZoneName: 'example.com',
      });

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(ListHostedZonesByNameCommand);
      const del = mockSend.mock.calls[1]?.[0];
      expect(del).toBeInstanceOf(ChangeResourceRecordSetsCommand);
      expect(del.input.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
    });

    it('still errors when neither the id nor the properties identify a zone', async () => {
      await expect(
        provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
          Name: 'record.example.com.',
          Type: 'A',
        })
      ).rejects.toThrow(/HostedZoneId or HostedZoneName is required/);
    });
  });

  describe('readCurrentState()', () => {
    it("reports drift for a record whose state carries CloudFormation's scalar id", async () => {
      mockSend.mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.readCurrentState(
        'record.example.com',
        'WebsiteRecord',
        'AWS::Route53::RecordSet',
        RECORD_PROPS
      );

      expect(result).toMatchObject({
        HostedZoneId: 'Z0123456789ABCDEFGHIJ',
        Name: 'record.example.com.',
        Type: 'A',
        TTL: 300,
        ResourceRecords: ['1.2.3.4'],
      });
    });

    it('reads back a composite-id record without consulting properties', async () => {
      mockSend.mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.readCurrentState(
        'Z0123456789ABCDEFGHIJ|record.example.com.|A',
        'WebsiteRecord',
        'AWS::Route53::RecordSet'
      );

      expect(result).toMatchObject({ Name: 'record.example.com.', Type: 'A' });
    });

    it('matches a composite whose Name lacks the trailing dot AWS reports', async () => {
      mockSend.mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.readCurrentState(
        'Z0123456789ABCDEFGHIJ|record.example.com|A',
        'WebsiteRecord',
        'AWS::Route53::RecordSet'
      );

      expect(result).toMatchObject({ Type: 'A', TTL: 300 });
    });

    it('returns undefined when the id is unparsable and no properties are available', async () => {
      const result = await provider.readCurrentState(
        'record.example.com',
        'WebsiteRecord',
        'AWS::Route53::RecordSet'
      );

      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});

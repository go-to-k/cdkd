import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutAnomalyDetectorCommand,
  DeleteAnomalyDetectorCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch';

const mockSend = vi.fn();

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatch: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../../src/utils/logger.js', () => {
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

import { CloudWatchAnomalyDetectorProvider } from '../../../../src/provisioning/providers/cloudwatch-anomaly-detector-provider.js';

const TYPE = 'AWS::CloudWatch::AnomalyDetector';

function putInput() {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof PutAnomalyDetectorCommand);
  expect(call).toBeDefined();
  return call![0].input as Record<string, unknown>;
}

describe('CloudWatchAnomalyDetectorProvider', () => {
  let provider: CloudWatchAnomalyDetectorProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudWatchAnomalyDetectorProvider();
  });

  describe('create', () => {
    it('maps the top-level single-metric tuple and derives a readable physical id', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await provider.create('Detector', TYPE, {
        Namespace: 'AWS/SQS',
        MetricName: 'NumberOfMessagesSent',
        Stat: 'Sum',
        Dimensions: [{ Name: 'QueueName', Value: 'my-queue' }],
      });

      const input = putInput();
      expect(input['Namespace']).toBe('AWS/SQS');
      expect(input['MetricName']).toBe('NumberOfMessagesSent');
      expect(input['Stat']).toBe('Sum');
      expect(input['Dimensions']).toEqual([{ Name: 'QueueName', Value: 'my-queue' }]);

      expect(result.physicalId).toBe('AWS/SQS:NumberOfMessagesSent:Sum:QueueName=my-queue');
      expect(result.attributes).toEqual({
        Id: 'AWS/SQS:NumberOfMessagesSent:Sum:QueueName=my-queue',
      });
    });

    it('sorts dimensions in the physical id so template order does not matter', async () => {
      mockSend.mockResolvedValue({});

      const a = await provider.create('D1', TYPE, {
        Namespace: 'NS',
        MetricName: 'M',
        Stat: 'Sum',
        Dimensions: [
          { Name: 'b', Value: '2' },
          { Name: 'a', Value: '1' },
        ],
      });
      const b = await provider.create('D2', TYPE, {
        Namespace: 'NS',
        MetricName: 'M',
        Stat: 'Sum',
        Dimensions: [
          { Name: 'a', Value: '1' },
          { Name: 'b', Value: '2' },
        ],
      });

      expect(a.physicalId).toBe(b.physicalId);
      expect(a.physicalId).toBe('NS:M:Sum:a=1,b=2');
    });

    it('passes SingleMetricAnomalyDetector / MetricCharacteristics through and converts Configuration range times to Date', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('Detector', TYPE, {
        SingleMetricAnomalyDetector: {
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Stat: 'Sum',
        },
        MetricCharacteristics: { PeriodicSpikes: true },
        Configuration: {
          MetricTimeZone: 'UTC',
          ExcludedTimeRanges: [
            { StartTime: '2026-01-01T00:00:00Z', EndTime: '2026-01-02T00:00:00Z' },
          ],
        },
      });

      const input = putInput();
      expect(input['SingleMetricAnomalyDetector']).toEqual({
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Stat: 'Sum',
      });
      expect(input['MetricCharacteristics']).toEqual({ PeriodicSpikes: true });
      const config = input['Configuration'] as {
        MetricTimezone: string;
        MetricTimeZone?: string;
        ExcludedTimeRanges: Array<{ StartTime: Date; EndTime: Date }>;
      };
      // CFn `MetricTimeZone` (capital Z) MUST be re-keyed to the SDK's
      // `MetricTimezone` (lowercase z) — passing the CFn key through is a
      // client-side silent drop (the SDK serializer ignores unknown keys).
      expect(config.MetricTimezone).toBe('UTC');
      expect(config.MetricTimeZone).toBeUndefined();
      expect(config.ExcludedTimeRanges[0].StartTime).toBeInstanceOf(Date);
      expect(config.ExcludedTimeRanges[0].StartTime.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('derives the physical id from the SingleMetricAnomalyDetector descriptor (not only the top-level tuple)', async () => {
      mockSend.mockResolvedValue({});

      const result = await provider.create('Detector', TYPE, {
        SingleMetricAnomalyDetector: {
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Stat: 'Sum',
        },
      });
      // If the single-metric precedence regressed to top-level-only reads,
      // every single-metric detector would collide on `math:<hash of {}>`.
      expect(result.physicalId).toBe('AWS/Lambda:Errors:Sum');

      const crossAccount = await provider.create('Detector2', TYPE, {
        SingleMetricAnomalyDetector: {
          AccountId: '111122223333',
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Stat: 'Sum',
        },
      });
      // Cross-account detectors must not collide with same-account ones.
      expect(crossAccount.physicalId).toBe('111122223333:AWS/Lambda:Errors:Sum');
    });

    it('accepts Date instances in ExcludedTimeRanges and rejects unparsable time values', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.create('Detector', TYPE, {
        Namespace: 'NS',
        MetricName: 'M',
        Stat: 'Sum',
        Configuration: {
          ExcludedTimeRanges: [
            { StartTime: new Date('2026-02-01T00:00:00Z'), EndTime: new Date('2026-02-02T00:00:00Z') },
          ],
        },
      });
      const config = putInput()['Configuration'] as {
        ExcludedTimeRanges: Array<{ StartTime: Date }>;
      };
      expect(config.ExcludedTimeRanges[0].StartTime.toISOString()).toBe('2026-02-01T00:00:00.000Z');

      mockSend.mockClear();
      await expect(
        provider.create('Detector', TYPE, {
          Namespace: 'NS',
          MetricName: 'M',
          Stat: 'Sum',
          Configuration: { ExcludedTimeRanges: [{ StartTime: 'garbage', EndTime: 'garbage' }] },
        })
      ).rejects.toThrow('unparsable time value');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('derives a stable hash id for metric-math detectors', async () => {
      mockSend.mockResolvedValue({});

      const queries = [
        { Id: 'm1', Expression: 'ANOMALY_DETECTION_BAND(m2, 2)', ReturnData: true },
      ];
      const a = await provider.create('D1', TYPE, {
        MetricMathAnomalyDetector: { MetricDataQueries: queries },
      });
      const b = await provider.create('D2', TYPE, {
        MetricMathAnomalyDetector: { MetricDataQueries: queries },
      });

      expect(a.physicalId).toMatch(/^math:[0-9a-f]{16}$/);
      expect(a.physicalId).toBe(b.physicalId);

      const other = await provider.create('D3', TYPE, {
        MetricMathAnomalyDetector: {
          MetricDataQueries: [{ Id: 'm1', Expression: 'ANOMALY_DETECTION_BAND(m2, 5)', ReturnData: true }],
        },
      });
      expect(other.physicalId).not.toBe(a.physicalId);
    });

    it('rejects a template with no metric descriptor before calling AWS', async () => {
      await expect(provider.create('Detector', TYPE, { Configuration: {} })).rejects.toThrow(
        'needs a metric descriptor'
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('wraps AWS errors in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));
      await expect(
        provider.create('Detector', TYPE, { Namespace: 'NS', MetricName: 'M', Stat: 'Sum' })
      ).rejects.toThrow('Failed to create CloudWatch anomaly detector');
    });
  });

  describe('update (Configuration is the only in-place mutable property)', () => {
    it('re-puts the detector with the new Configuration and keeps the physical id', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'Detector',
        'AWS/SQS:NumberOfMessagesSent:Sum',
        TYPE,
        {
          Namespace: 'AWS/SQS',
          MetricName: 'NumberOfMessagesSent',
          Stat: 'Sum',
          Configuration: { MetricTimeZone: 'UTC' },
        },
        { Namespace: 'AWS/SQS', MetricName: 'NumberOfMessagesSent', Stat: 'Sum' }
      );

      expect(putInput()['Configuration']).toEqual({ MetricTimezone: 'UTC' });
      expect(result.wasReplaced).toBe(false);
      expect(result.physicalId).toBe('AWS/SQS:NumberOfMessagesSent:Sum');
      expect(result.attributes).toEqual({ Id: 'AWS/SQS:NumberOfMessagesSent:Sum' });
    });

    it('wraps AWS errors in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));
      await expect(
        provider.update('Detector', 'pid', TYPE, { Namespace: 'NS', MetricName: 'M' }, {})
      ).rejects.toThrow('Failed to update CloudWatch anomaly detector');
    });
  });

  describe('delete', () => {
    const PROPS = {
      Namespace: 'AWS/SQS',
      MetricName: 'NumberOfMessagesSent',
      Stat: 'Sum',
      Configuration: { MetricTimeZone: 'UTC' },
    };

    it('addresses the model by descriptor and omits the mutable Configuration', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('Detector', 'AWS/SQS:NumberOfMessagesSent:Sum', TYPE, PROPS);

      const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteAnomalyDetectorCommand);
      expect(call).toBeDefined();
      const input = call![0].input as Record<string, unknown>;
      expect(input['Namespace']).toBe('AWS/SQS');
      expect(input['MetricName']).toBe('NumberOfMessagesSent');
      expect(input['Stat']).toBe('Sum');
      expect(input['Configuration']).toBeUndefined();
    });

    it('treats ResourceNotFoundException as idempotent success', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );

      await expect(
        provider.delete('Detector', 'pid', TYPE, PROPS, { expectedRegion: 'us-east-1' })
      ).resolves.toBeUndefined();
    });

    it('refuses NotFound-as-success when the client region does not match the state region', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );

      await expect(
        provider.delete('Detector', 'pid', TYPE, PROPS, { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow(/region/i);
    });

    it('passes the SingleMetricAnomalyDetector descriptor arm through to DeleteAnomalyDetector', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('Detector', 'pid', TYPE, {
        SingleMetricAnomalyDetector: { Namespace: 'AWS/Lambda', MetricName: 'Errors', Stat: 'Sum' },
        Configuration: { MetricTimeZone: 'UTC' },
      });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteAnomalyDetectorCommand);
      const input = call![0].input as Record<string, unknown>;
      expect(input['SingleMetricAnomalyDetector']).toEqual({
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Stat: 'Sum',
      });
      expect(input['Configuration']).toBeUndefined();
    });

    it('passes the MetricMathAnomalyDetector descriptor arm through to DeleteAnomalyDetector', async () => {
      mockSend.mockResolvedValueOnce({});

      const math = { MetricDataQueries: [{ Id: 'm1', Expression: 'ANOMALY_DETECTION_BAND(m2, 2)' }] };
      await provider.delete('Detector', 'math:abc', TYPE, { MetricMathAnomalyDetector: math });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteAnomalyDetectorCommand);
      expect((call![0].input as Record<string, unknown>)['MetricMathAnomalyDetector']).toEqual(math);
    });

    it('fails with state-orphan guidance when the state record has no properties', async () => {
      await expect(provider.delete('Detector', 'pid', TYPE)).rejects.toThrow('cdkd state orphan');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('wraps other AWS errors in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));
      await expect(provider.delete('Detector', 'pid', TYPE, PROPS)).rejects.toThrow(
        'Failed to delete CloudWatch anomaly detector'
      );
    });
  });

  describe('getAttribute', () => {
    it('resolves Id to the physical id without an AWS call', async () => {
      await expect(provider.getAttribute('the-id', TYPE, 'Id')).resolves.toBe('the-id');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects unknown attributes', async () => {
      await expect(provider.getAttribute('the-id', TYPE, 'Arn')).rejects.toThrow(
        'Unknown attribute Arn'
      );
    });
  });

  describe('import (explicit-override only)', () => {
    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const result = await provider.import({
        logicalId: 'Detector',
        resourceType: TYPE,
        properties: {},
        stackName: 'Stack',
        region: 'us-east-1',
        knownPhysicalId: 'NS:M:Sum',
      });
      expect(result).toEqual({ physicalId: 'NS:M:Sum', attributes: { Id: 'NS:M:Sum' } });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import({
        logicalId: 'Detector',
        resourceType: TYPE,
        properties: {},
        stackName: 'Stack',
        region: 'us-east-1',
      });
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});

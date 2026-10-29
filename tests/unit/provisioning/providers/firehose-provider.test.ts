import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-firehose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-firehose')>();
  return {
    ...actual,
    FirehoseClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import {
  DescribeDeliveryStreamCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-firehose';
import { FirehoseProvider } from '../../../../src/provisioning/providers/firehose-provider.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../../src/utils/error-handler.js';
import { isWaitAbandonedError } from '../../../../src/provisioning/wait-abandoned.js';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';
import { withResourceDeadline } from '../../../../src/deployment/resource-deadline.js';
import { getLogger } from '../../../../src/utils/logger.js';
import { createdBeforeFailure } from '../../../../src/provisioning/auxiliary-failure.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../../src/provisioning/interrupt-watch.js';

describe('FirehoseProvider', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  describe('create', () => {
    it('should create delivery stream with S3DestinationConfiguration (BucketArn→BucketARN, RoleArn→RoleARN mapping)', async () => {
      mockSend
        .mockResolvedValueOnce({
          DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/test-stream',
        })
        .mockResolvedValueOnce({
          DeliveryStreamDescription: { DeliveryStreamStatus: 'ACTIVE' },
        });

      const result = await provider.create(
        'MyDeliveryStream',
        'AWS::KinesisFirehose::DeliveryStream',
        {
          DeliveryStreamName: 'test-stream',
          S3DestinationConfiguration: {
            BucketArn: 'arn:aws:s3:::my-bucket',
            RoleArn: 'arn:aws:iam::123456789012:role/my-role',
            Prefix: 'logs/',
          },
        }
      );

      expect(result.physicalId).toBe('test-stream');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/test-stream',
      });
      expect(mockSend).toHaveBeenCalledTimes(2);

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.constructor.name).toBe('CreateDeliveryStreamCommand');
      expect(cmd.input.DeliveryStreamName).toBe('test-stream');
      expect(cmd.input.S3DestinationConfiguration.BucketARN).toBe('arn:aws:s3:::my-bucket');
      expect(cmd.input.S3DestinationConfiguration.RoleARN).toBe(
        'arn:aws:iam::123456789012:role/my-role'
      );
      expect(cmd.input.S3DestinationConfiguration.Prefix).toBe('logs/');
    });

    it('should create delivery stream with ExtendedS3DestinationConfiguration', async () => {
      mockSend
        .mockResolvedValueOnce({
          DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/ext-stream',
        })
        .mockResolvedValueOnce({
          DeliveryStreamDescription: { DeliveryStreamStatus: 'ACTIVE' },
        });

      const result = await provider.create(
        'MyExtStream',
        'AWS::KinesisFirehose::DeliveryStream',
        {
          DeliveryStreamName: 'ext-stream',
          ExtendedS3DestinationConfiguration: {
            BucketArn: 'arn:aws:s3:::my-ext-bucket',
            RoleArn: 'arn:aws:iam::123456789012:role/ext-role',
            Prefix: 'data/',
            CompressionFormat: 'GZIP',
            BufferingHints: {
              SizeInMBs: 64,
              IntervalInSeconds: 300,
            },
          },
        }
      );

      expect(result.physicalId).toBe('ext-stream');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/ext-stream',
      });

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.constructor.name).toBe('CreateDeliveryStreamCommand');
      expect(cmd.input.ExtendedS3DestinationConfiguration.BucketARN).toBe(
        'arn:aws:s3:::my-ext-bucket'
      );
      expect(cmd.input.ExtendedS3DestinationConfiguration.RoleARN).toBe(
        'arn:aws:iam::123456789012:role/ext-role'
      );
      expect(cmd.input.ExtendedS3DestinationConfiguration.Prefix).toBe('data/');
      expect(cmd.input.ExtendedS3DestinationConfiguration.CompressionFormat).toBe('GZIP');
      expect(cmd.input.ExtendedS3DestinationConfiguration.BufferingHints).toEqual({
        SizeInMBs: 64,
        IntervalInSeconds: 300,
      });
    });

    it('should create delivery stream with KinesisStreamSourceConfiguration', async () => {
      mockSend
        .mockResolvedValueOnce({
          DeliveryStreamARN:
            'arn:aws:firehose:us-east-1:123456789012:deliverystream/kinesis-stream',
        })
        .mockResolvedValueOnce({
          DeliveryStreamDescription: { DeliveryStreamStatus: 'ACTIVE' },
        });

      const result = await provider.create(
        'MyKinesisStream',
        'AWS::KinesisFirehose::DeliveryStream',
        {
          DeliveryStreamName: 'kinesis-stream',
          DeliveryStreamType: 'KinesisStreamAsSource',
          KinesisStreamSourceConfiguration: {
            KinesisStreamArn: 'arn:aws:kinesis:us-east-1:123456789012:stream/my-kinesis',
            RoleArn: 'arn:aws:iam::123456789012:role/kinesis-role',
          },
        }
      );

      expect(result.physicalId).toBe('kinesis-stream');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/kinesis-stream',
      });

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.DeliveryStreamType).toBe('KinesisStreamAsSource');
      expect(cmd.input.KinesisStreamSourceConfiguration.KinesisStreamARN).toBe(
        'arn:aws:kinesis:us-east-1:123456789012:stream/my-kinesis'
      );
      expect(cmd.input.KinesisStreamSourceConfiguration.RoleARN).toBe(
        'arn:aws:iam::123456789012:role/kinesis-role'
      );
    });
  });

  describe('create: the wait for ACTIVE (#5509)', () => {
    const TYPE = 'AWS::KinesisFirehose::DeliveryStream';
    const props = {
      DeliveryStreamName: 'wait-stream',
      S3DestinationConfiguration: {
        BucketArn: 'arn:aws:s3:::b',
        RoleArn: 'arn:aws:iam::123456789012:role/r',
      },
    };

    /** CreateDeliveryStream answers, then each read reports the next status (the last repeats). */
    function routeStatuses(
      statuses: Array<string | { status: string; failure?: { Type?: string; Details?: string } }>
    ): () => number {
      let reads = 0;
      mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'CreateDeliveryStreamCommand') {
          return {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/wait-stream',
          };
        }
        const entry = statuses[Math.min(reads, statuses.length - 1)];
        reads += 1;
        const { status, failure } = typeof entry === 'string' ? { status: entry, failure: undefined } : entry;
        return {
          DeliveryStreamDescription: {
            DeliveryStreamStatus: status,
            ...(failure !== undefined && { FailureDescription: failure }),
          },
        };
      });
      return () => reads;
    }

    async function settle<T>(p: Promise<T>): Promise<{ ok?: T; err?: unknown }> {
      vi.useFakeTimers();
      try {
        const settled = p.then(
          (ok) => ({ ok }),
          (err: unknown) => ({ err })
        );
        await vi.runAllTimersAsync();
        return await settled;
      } finally {
        vi.useRealTimers();
      }
    }

    it('keeps waiting past the old ~60 s cap and returns once the stream is ACTIVE', async () => {
      // 40 CREATING reads at 5 s is 200 s: the old wait warned and returned at 30 reads.
      const reads = routeStatuses([...Array<string>(40).fill('CREATING'), 'ACTIVE']);
      const { ok, err } = await settle(provider.create('S', TYPE, props));
      expect(err).toBeUndefined();
      expect(ok?.physicalId).toBe('wait-stream');
      expect(reads()).toBe(41);
    });

    it('fails the create on CREATING_FAILED with AWS\'s failure description, masked, and records the stream', async () => {
      routeStatuses([
        'CREATING',
        { status: 'CREATING_FAILED', failure: { Type: 'INVALID_KMS_KEY', Details: 'key s3cr3t-token denied' } },
      ]);
      const { err } = await settle(
        provider.create('S', TYPE, props, {
          maskSecrets: (t: string) => t.replace('s3cr3t-token', '****'),
        })
      );
      expect(err).toBeInstanceOf(ProvisioningError);
      const message = (err as Error).message;
      expect(message).toContain('AWS reports CREATING_FAILED');
      expect(message).toContain('INVALID_KMS_KEY: key **** denied');
      expect(message).not.toContain('s3cr3t-token');
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect(createdBeforeFailure(err, 'S', TYPE)).toBe('wait-stream');
      // Terminal: no read after the failure report.
      expect(
        mockSend.mock.calls.filter((c) => c[0].constructor.name === 'DescribeDeliveryStreamCommand')
      ).toHaveLength(2);
    });

    it('fails the create, rather than warning and returning, when the stream never leaves CREATING', async () => {
      routeStatuses(['CREATING']);
      const { ok, err } = await settle(provider.create('S', TYPE, props));
      expect(ok).toBeUndefined();
      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toContain('Timed out waiting for Firehose delivery stream S');
      expect((err as Error).message).toContain('last status: CREATING');
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect(createdBeforeFailure(err, 'S', TYPE)).toBe('wait-stream');
    });

    it('fails the create before the resource deadline fires, so the deadline wrapper relays the created-stream mark', async () => {
      // withResourceDeadline drops a provider error that lands after it fired,
      // and the created-id mark rides only on that error: the wait must throw
      // while time is left, so the error the engine reads still names the stream.
      const reads = routeStatuses(['CREATING']);
      vi.useFakeTimers();
      try {
        const outer = withResourceDeadline(() => provider.create('S', TYPE, props), {
          warnAfterMs: 1000,
          timeoutMs: 60_000,
          onTimeout: () => new Error('deadline fired'),
        }).then(
          (): { err?: unknown } => ({}),
          (err: unknown) => ({ err })
        );
        await vi.runAllTimersAsync();
        const { err } = await outer;
        expect((err as Error).message).not.toBe('deadline fired');
        expect(err).toBeInstanceOf(ProvisioningError);
        expect((err as Error).message).toContain('The resource timeout would expire while waiting');
        expect((err as Error).message).toContain('last status: CREATING');
        expect(createdBeforeFailure(err, 'S', TYPE)).toBe('wait-stream');
        expect(isMarkedNonRetryable(err)).toBe(true);
        // 60 s at 5 s per read: the wait stopped with the deadline, not at the cap.
        expect(reads()).toBeLessThanOrEqual(12);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a Ctrl-C during the wait stops it, and the create still records the stream', async () => {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      try {
        const baselineListeners = process.listeners('SIGINT');
        let reads = 0;
        mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
          if (cmd.constructor.name === 'CreateDeliveryStreamCommand') {
            return {
              DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/wait-stream',
            };
          }
          reads += 1;
          if (reads === 2) {
            // The signal lands while the second report is in flight.
            const ours = process.listeners('SIGINT').filter((l) => !baselineListeners.includes(l));
            expect(ours.length).toBeGreaterThan(0);
            for (const l of ours) (l as unknown as () => void)();
          }
          return { DeliveryStreamDescription: { DeliveryStreamStatus: 'CREATING' } };
        });
        const { err } = await settle(provider.create('S', TYPE, props));
        expect(isInterruptedWaitError(err)).toBe(true);
        expect(createdBeforeFailure(err, 'S', TYPE)).toBe('wait-stream');
        expect(reads).toBe(2);
      } finally {
        interruptWatchTestSeam.commandOwnsInterrupts = undefined;
        disarmInterruptWatchForTests();
      }
    });
  });

  describe('update', () => {
    const STREAM_ARN = 'arn:aws:firehose:us-east-1:111:deliverystream/test-stream';
    const describeAnswer = {
      DeliveryStreamDescription: {
        DeliveryStreamARN: STREAM_ARN,
        DeliveryStreamStatus: 'ACTIVE',
        VersionId: '7',
        Destinations: [{ DestinationId: 'destinationId-000000000001' }],
      },
    };
    // clearAllMocks keeps a mockResolvedValue default; later blocks expect none.
    afterEach(() => {
      mockSend.mockReset();
    });

    // go-to-k/cdkd#5439: CloudFormation updates the legacy shape in place
    // (change set `Replacement: False`, same stream ARN), so cdkd sends
    // UpdateDestination with an S3DestinationUpdate instead of refusing.
    it('updates a legacy S3DestinationConfiguration in place with S3DestinationUpdate', async () => {
      mockSend.mockResolvedValue(describeAnswer);

      const result = await provider.update(
        'MyDeliveryStream',
        'test-stream',
        'AWS::KinesisFirehose::DeliveryStream',
        {
          DeliveryStreamName: 'test-stream',
          S3DestinationConfiguration: {
            BucketARN: 'arn:aws:s3:::bucket',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
            Prefix: 'b/',
            CompressionFormat: 'GZIP',
            BufferingHints: { IntervalInSeconds: 120, SizeInMBs: 10 },
          },
        },
        {
          DeliveryStreamName: 'test-stream',
          S3DestinationConfiguration: {
            BucketARN: 'arn:aws:s3:::bucket',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
            Prefix: 'a/',
            CompressionFormat: 'UNCOMPRESSED',
            BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 5 },
          },
        }
      );

      const updates = mockSend.mock.calls
        .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
        .filter((c) => c.constructor.name === 'UpdateDestinationCommand');
      expect(updates).toHaveLength(1);
      expect(updates[0]!.input).toEqual({
        DeliveryStreamName: 'test-stream',
        CurrentDeliveryStreamVersionId: '7',
        DestinationId: 'destinationId-000000000001',
        S3DestinationUpdate: {
          BucketARN: 'arn:aws:s3:::bucket',
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          Prefix: 'b/',
          CompressionFormat: 'GZIP',
          BufferingHints: { IntervalInSeconds: 120, SizeInMBs: 10 },
        },
      });
      expect(result).toEqual({
        physicalId: 'test-stream',
        wasReplaced: false,
        attributes: { Arn: STREAM_ARN },
      });
    });

    it('sends no UpdateDestination when only the Tags of a legacy-S3 stream change', async () => {
      mockSend.mockResolvedValue(describeAnswer);
      const dest = {
        BucketARN: 'arn:aws:s3:::bucket',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
      };

      await provider.update(
        'MyDeliveryStream',
        'test-stream',
        'AWS::KinesisFirehose::DeliveryStream',
        { S3DestinationConfiguration: dest, Tags: [{ Key: 'k', Value: 'v2' }] },
        { S3DestinationConfiguration: dest, Tags: [{ Key: 'k', Value: 'v1' }] }
      );

      const names = mockSend.mock.calls.map(
        (c) => (c[0] as { constructor: { name: string } }).constructor.name
      );
      expect(names).toContain('TagDeliveryStreamCommand');
      expect(names).not.toContain('UpdateDestinationCommand');
    });

    it('still refuses switching from the legacy S3 shape to ExtendedS3 before any call', async () => {
      const dest = {
        BucketARN: 'arn:aws:s3:::bucket',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
      };
      await expect(
        provider.update(
          'MyDeliveryStream',
          'test-stream',
          'AWS::KinesisFirehose::DeliveryStream',
          { ExtendedS3DestinationConfiguration: dest },
          { S3DestinationConfiguration: dest }
        )
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('update: DeliveryStreamEncryptionConfigurationInput (#5357)', () => {
    const KEY_A = 'arn:aws:kms:us-east-1:123456789012:key/aaaa';
    const KEY_B = 'arn:aws:kms:us-east-1:123456789012:key/bbbb';
    const ENC = 'DeliveryStreamEncryptionConfigurationInput';

    /**
     * Route every call by command name. Each DescribeDeliveryStream answers the
     * next encryption report in `reports` (the last one repeats).
     */
    function route(reports: Array<Record<string, unknown> | undefined>): void {
      mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'DescribeDeliveryStreamCommand') {
          const enc = reports.length > 1 ? reports.shift() : reports[0];
          return {
            DeliveryStreamDescription: {
              DeliveryStreamStatus: 'ACTIVE',
              DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/s',
              ...(enc !== undefined && { DeliveryStreamEncryptionConfiguration: enc }),
            },
          };
        }
        return {};
      });
    }

    /** Fake-clock time the last helper run took, every timer included. */
    let lastElapsedMs = 0;

    const sent = (name: string) =>
      mockSend.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);

    async function runUpdate(
      next: unknown,
      prev: unknown,
      context?: Record<string, unknown>
    ): Promise<unknown> {
      vi.useFakeTimers();
      const startedAt = Date.now();
      try {
        const settled = provider
          .update(
            'MyStream',
            's',
            'AWS::KinesisFirehose::DeliveryStream',
            next === undefined ? {} : { [ENC]: next },
            prev === undefined ? {} : { [ENC]: prev },
            context
          )
          .then(
            (r) => ({ ok: r }),
            (e: unknown) => ({ err: e })
          );
        await vi.runAllTimersAsync();
        lastElapsedMs = Date.now() - startedAt;
        const out = await settled;
        if ('err' in out) throw out.err;
        return out.ok;
      } finally {
        vi.useRealTimers();
      }
    }

    afterEach(() => {
      mockSend.mockReset();
    });

    it('adding the block starts AWS-owned encryption and waits for ENABLED', async () => {
      route([
        { Status: 'DISABLED' },
        { Status: 'ENABLING', KeyType: 'AWS_OWNED_CMK' },
        { Status: 'ENABLING', KeyType: 'AWS_OWNED_CMK' },
        { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' },
      ]);
      await runUpdate({ KeyType: 'AWS_OWNED_CMK' }, undefined);
      const starts = sent('StartDeliveryStreamEncryptionCommand');
      expect(starts).toHaveLength(1);
      expect(starts[0].input).toEqual({
        DeliveryStreamName: 's',
        DeliveryStreamEncryptionConfigurationInput: { KeyType: 'AWS_OWNED_CMK' },
      });
      expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
      // settle read + 3 polls to ENABLED + the result envelope's read
      expect(sent('DescribeDeliveryStreamCommand')).toHaveLength(5);
    });

    it('removing the block stops encryption and waits for DISABLED', async () => {
      route([
        { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' },
        { Status: 'DISABLING', KeyType: 'AWS_OWNED_CMK' },
        { Status: 'DISABLED' },
      ]);
      await runUpdate(undefined, { KeyType: 'AWS_OWNED_CMK' });
      const stops = sent('StopDeliveryStreamEncryptionCommand');
      expect(stops).toHaveLength(1);
      expect(stops[0].input).toEqual({ DeliveryStreamName: 's' });
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);
      expect(sent('DescribeDeliveryStreamCommand')).toHaveLength(4);
    });

    it('a changed customer-managed key starts with the new KeyARN and waits past the old ENABLED', async () => {
      route([
        { Status: 'ENABLED', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A },
        { Status: 'ENABLED', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A },
        { Status: 'ENABLING', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_B },
        { Status: 'ENABLED', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_B },
      ]);
      await runUpdate(
        { KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_B },
        { KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A }
      );
      const starts = sent('StartDeliveryStreamEncryptionCommand');
      expect(starts).toHaveLength(1);
      expect(starts[0].input.DeliveryStreamEncryptionConfigurationInput).toEqual({
        KeyType: 'CUSTOMER_MANAGED_CMK',
        KeyARN: KEY_B,
      });
      expect(sent('DescribeDeliveryStreamCommand')).toHaveLength(5);
    });

    it('reads the KeyArn spelling the create path accepts', async () => {
      route([{ Status: 'DISABLED' }, { Status: 'ENABLED', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A }]);
      await runUpdate({ KeyType: 'CUSTOMER_MANAGED_CMK', KeyArn: KEY_A }, undefined);
      expect(
        sent('StartDeliveryStreamEncryptionCommand')[0].input.DeliveryStreamEncryptionConfigurationInput
      ).toEqual({ KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A });
    });

    it('an unchanged block sends nothing and reads no encryption state', async () => {
      route([{ Status: 'DISABLED' }]);
      await runUpdate({ KeyType: 'AWS_OWNED_CMK' }, { KeyType: 'AWS_OWNED_CMK' });
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);
      expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
      expect(sent('DescribeDeliveryStreamCommand')).toHaveLength(1);
    });

    it('skips the call when the stream already holds the requested state (a retried update)', async () => {
      route([{ Status: 'ENABLED', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A }]);
      await runUpdate({ KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A }, undefined);
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);

      mockSend.mockReset();
      route([{ Status: 'DISABLED' }]);
      await runUpdate(undefined, { KeyType: 'AWS_OWNED_CMK' });
      expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
    });

    it('waits out an earlier transition before deciding', async () => {
      route([
        { Status: 'ENABLING', KeyType: 'AWS_OWNED_CMK' },
        { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' },
      ]);
      await runUpdate({ KeyType: 'AWS_OWNED_CMK' }, undefined);
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);
    });

    it('ENABLING_FAILED fails the update with the masked failure description', async () => {
      route([
        { Status: 'DISABLED' },
        {
          Status: 'ENABLING_FAILED',
          KeyType: 'CUSTOMER_MANAGED_CMK',
          KeyARN: KEY_A,
          FailureDescription: { Type: 'KMS_ACCESS_DENIED', Details: 'denied: s3cr3t-value' },
        },
      ]);
      const error = await runUpdate(
        { KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A },
        undefined,
        { maskSecrets: (text: string) => text.replaceAll('s3cr3t-value', '***') }
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toContain('ENABLING_FAILED');
      expect((error as Error).message).toContain('KMS_ACCESS_DENIED: denied: ***');
      expect((error as Error).message).not.toContain('s3cr3t-value');
      // A retry would only issue the same Start against the same key.
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('an unreadable desired block is refused before any call', async () => {
      route([{ Status: 'DISABLED' }]);
      const error = await runUpdate('AWS_OWNED_CMK', undefined).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toContain('is not an object with a string KeyType');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a template {} is refused: the CFn schema requires KeyType', async () => {
      route([{ Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }]);
      const error = await runUpdate({}, { KeyType: 'AWS_OWNED_CMK' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a readback {} placeholder (drift --revert) reads as "not encrypted" and stops encryption', async () => {
      route([{ Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }, { Status: 'DISABLED' }]);
      await runUpdate({}, { KeyType: 'AWS_OWNED_CMK' }, { desiredFromAwsReadback: true });
      expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(1);
    });

    it('a recorded {} placeholder beside an absent desired block is no change', async () => {
      route([{ Status: 'DISABLED' }]);
      await runUpdate(undefined, {});
      expect(sent('DescribeDeliveryStreamCommand')).toHaveLength(1);
      expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
    });

    it('a state replay with an unreadable block warns, leaves encryption alone and records the previous block', async () => {
      route([{ Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }]);
      const result = (await runUpdate(
        'AWS_OWNED_CMK',
        { KeyType: 'AWS_OWNED_CMK' },
        { replayingState: true }
      )) as { effectiveProperties?: Record<string, unknown> };
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);
      expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
      expect(result.effectiveProperties).toEqual({ [ENC]: { KeyType: 'AWS_OWNED_CMK' } });
    });

    it('an ENABLING_FAILED left by an earlier Start is not blamed on this one', async () => {
      const stale = {
        Status: 'ENABLING_FAILED',
        FailureDescription: { Type: 'DISABLED_KMS_KEY', Details: 'old' },
      };
      route([
        stale,
        stale,
        { Status: 'ENABLING', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_B },
        { Status: 'ENABLED', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_B },
      ]);
      await runUpdate(
        { KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_B },
        { KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A }
      );
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(1);
    });

    it('an ENABLING_FAILED reported again after the new ENABLING fails the update', async () => {
      const failedReport = {
        Status: 'ENABLING_FAILED',
        FailureDescription: { Type: 'DISABLED_KMS_KEY', Details: 'disabled' },
      };
      route([
        failedReport,
        { Status: 'ENABLING', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_B },
        failedReport,
      ]);
      const error = await runUpdate({ KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_B }, undefined).catch(
        (e: unknown) => e
      );
      expect((error as Error).message).toContain('ENABLING_FAILED');
    });

    it('removing the block from an ENABLING_FAILED stream sends no Stop (AWS: "already disabled")', async () => {
      route([{ Status: 'ENABLING_FAILED', FailureDescription: { Type: 'DISABLED_KMS_KEY' } }]);
      await runUpdate(undefined, { KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A });
      expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
    });

    it('a replayed {} is not read as a removal: encryption is left alone and the live state recorded', async () => {
      route([{ Status: 'ENABLED', KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A }]);
      const result = (await runUpdate(
        {},
        { KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_B },
        { replayingState: true }
      )) as { effectiveProperties?: Record<string, unknown> };
      expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);
      // The live key, not the recorded previous one the stream does not hold.
      expect(result.effectiveProperties).toEqual({
        [ENC]: { KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A },
      });
    });

    it('a state replay over an absent previous block drops the key from the record', async () => {
      route([{ Status: 'DISABLED' }]);
      const result = (await runUpdate(42, undefined, { replayingState: true })) as {
        effectiveProperties?: Record<string, unknown>;
      };
      expect(result.effectiveProperties).toEqual({});
    });

    /**
     * Run the update inside the engine's per-resource deadline. The deadline
     * rejects the outer promise but does not cancel the update, so the
     * update's own settlement is returned once every timer has run.
     */
    async function runUpdateWithinDeadline(
      next: unknown,
      prev: unknown,
      timeoutMs: number
    ): Promise<{ outer: unknown; inner: { ok?: unknown; err?: unknown } }> {
      vi.useFakeTimers();
      const startedAt = Date.now();
      try {
        let inner: Promise<{ ok?: unknown; err?: unknown }> | undefined;
        const outer = withResourceDeadline(
          () => {
            inner = provider
              .update(
                'MyStream',
                's',
                'AWS::KinesisFirehose::DeliveryStream',
                next === undefined ? {} : { [ENC]: next },
                prev === undefined ? {} : { [ENC]: prev }
              )
              .then(
                (r) => ({ ok: r }),
                (e: unknown) => ({ err: e })
              );
            return inner;
          },
          { warnAfterMs: 1000, timeoutMs, onTimeout: () => new Error('deadline fired') }
        ).then(
          (r) => r,
          (e: unknown) => e
        );
        await vi.runAllTimersAsync();
        lastElapsedMs = Date.now() - startedAt;
        return { outer: await outer, inner: await inner! };
      } finally {
        vi.useRealTimers();
      }
    }

    it('sends no Start once the resource deadline expired during the settle wait', async () => {
      // The settle read itself outlives the 20 s deadline, then reports a
      // stream with no encryption: a Start now could land after the rollback.
      let reads = 0;
      mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'DescribeDeliveryStreamCommand') {
          reads += 1;
          if (reads === 1) await new Promise((r) => setTimeout(r, 30_000));
          return { DeliveryStreamDescription: { DeliveryStreamEncryptionConfiguration: { Status: 'DISABLED' } } };
        }
        return {};
      });
      const { outer, inner } = await runUpdateWithinDeadline({ KeyType: 'AWS_OWNED_CMK' }, undefined, 20_000);
      expect((outer as Error).message).toBe('deadline fired');
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);
      expect(inner.err).toBeInstanceOf(ProvisioningError);
      expect((inner.err as Error).message).toContain('no encryption call was sent');
      expect(isMarkedNonRetryable(inner.err)).toBe(true);
    });

    it('sends no Stop once the resource deadline expired during the settle wait', async () => {
      let reads = 0;
      mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'DescribeDeliveryStreamCommand') {
          reads += 1;
          if (reads === 1) await new Promise((r) => setTimeout(r, 30_000));
          return {
            DeliveryStreamDescription: {
              DeliveryStreamEncryptionConfiguration: { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' },
            },
          };
        }
        return {};
      });
      const { inner } = await runUpdateWithinDeadline(undefined, { KeyType: 'AWS_OWNED_CMK' }, 20_000);
      expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
      expect((inner.err as Error).message).toContain('no encryption call was sent');
    });

    it('the wait after a Start ends at the resource deadline, and warns that the change may still finish', async () => {
      route([{ Status: 'DISABLED' }, { Status: 'ENABLING', KeyType: 'AWS_OWNED_CMK' }]);
      // 22 s is not a multiple of the 5 s cadence: the last sleep is cut to
      // 2 s, so the wait ends with the deadline rather than at 25 s.
      const { inner } = await runUpdateWithinDeadline({ KeyType: 'AWS_OWNED_CMK' }, undefined, 22_000);
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(1);
      expect((inner.err as Error).message).toContain('The resource timeout expired while waiting to enable');
      expect(isMarkedNonRetryable(inner.err)).toBe(true);
      expect(lastElapsedMs).toBe(22_000);
      // settle read + reads at 0, 5, 10, 15 and 20 s; none at or after 22 s.
      expect(sent('DescribeDeliveryStreamCommand')).toHaveLength(6);
      const warn = getLogger().child('FirehoseProvider').warn as ReturnType<typeof vi.fn>;
      const warned = String(warn.mock.calls.at(-1)?.[0]);
      expect(warned).toContain('StartDeliveryStreamEncryption was sent but the encryption change did not finish');
      expect(warned).toContain('the stream may still finish the change');
    });

    it('a Stop whose wait fails warns that the record keeps the previous block', async () => {
      route([
        { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' },
        { Status: 'DISABLING', KeyType: 'AWS_OWNED_CMK' },
        { Status: 'DISABLING_FAILED', KeyType: 'AWS_OWNED_CMK' },
      ]);
      const error = await runUpdate(undefined, { KeyType: 'AWS_OWNED_CMK' }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('DISABLING_FAILED');
      const warn = getLogger().child('FirehoseProvider').warn as ReturnType<typeof vi.fn>;
      const warned = String(warn.mock.calls.at(-1)?.[0]);
      expect(warned).toContain('StopDeliveryStreamEncryption was sent but the encryption change did not finish');
      // A terminal report: AWS ended the transition, it will not finish.
      expect(warned).toContain('AWS reported the change failed');
      expect(warned).not.toContain('may still finish');
    });

    it('no unfinished-change warning when the settle wait fails or AWS refuses the Start', async () => {
      const warn = getLogger().child('FirehoseProvider').warn as ReturnType<typeof vi.fn>;
      // The settle wait times out: nothing was sent.
      route([{ Status: 'ENABLING', KeyType: 'AWS_OWNED_CMK' }]);
      const settleError = await runUpdate(undefined, { KeyType: 'AWS_OWNED_CMK' }).catch((e: unknown) => e);
      expect((settleError as Error).message).toContain('Timed out waiting to settle');
      // AWS refuses the Start itself (a disabled key): no transition began.
      mockSend.mockReset();
      mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'StartDeliveryStreamEncryptionCommand') {
          throw Object.assign(new Error('key is disabled'), { name: 'InvalidKMSResourceException' });
        }
        return { DeliveryStreamDescription: { DeliveryStreamEncryptionConfiguration: { Status: 'DISABLED' } } };
      });
      const startError = await runUpdate({ KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: KEY_A }, undefined).catch(
        (e: unknown) => e
      );
      expect(startError).toBeInstanceOf(Error);
      expect(
        warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('was sent but'))
      ).toHaveLength(0);
    });

    it('a Ctrl-C during the settle wait\'s last read sends no Stop', async () => {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      try {
        const baselineListeners = process.listeners('SIGINT');
        mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
          if (cmd.constructor.name === 'DescribeDeliveryStreamCommand') {
            // The signal lands while the settled report is in flight.
            const ours = process.listeners('SIGINT').filter((l) => !baselineListeners.includes(l));
            expect(ours.length).toBeGreaterThan(0);
            for (const l of ours) (l as unknown as () => void)();
            return {
              DeliveryStreamDescription: {
                DeliveryStreamEncryptionConfiguration: { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' },
              },
            };
          }
          return {};
        });
        const error = await runUpdate(undefined, { KeyType: 'AWS_OWNED_CMK' }).catch((e: unknown) => e);
        expect(isInterruptedWaitError(error)).toBe(true);
        expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
      } finally {
        interruptWatchTestSeam.commandOwnsInterrupts = undefined;
        disarmInterruptWatchForTests();
      }
    });

    it('a wait outside any deadline is not capped by it', async () => {
      route([
        { Status: 'DISABLED' },
        ...Array.from({ length: 10 }, () => ({ Status: 'ENABLING', KeyType: 'AWS_OWNED_CMK' })),
        { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' },
      ]);
      await runUpdate({ KeyType: 'AWS_OWNED_CMK' }, undefined);
      expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(1);
      // Ten 5 s sleeps: an Infinity budget must not shrink the cadence.
      expect(lastElapsedMs).toBeGreaterThanOrEqual(50_000);
    });

    describe('unsettled encryption (go-to-k/cdkd#5380)', () => {
      /** A sink that records each mark with the Start / Stop calls sent before it. */
      function sink(): { marks: string[]; sentAtMark: number[]; markUnsettled: (k: string) => void } {
        const marks: string[] = [];
        const sentAtMark: number[] = [];
        return {
          marks,
          sentAtMark,
          markUnsettled: (k: string) => {
            marks.push(k);
            sentAtMark.push(
              sent('StartDeliveryStreamEncryptionCommand').length +
                sent('StopDeliveryStreamEncryptionCommand').length
            );
          },
        };
      }

      it('marks the key before the Start is sent', async () => {
        route([{ Status: 'DISABLED' }, { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }]);
        const s = sink();
        await runUpdate({ KeyType: 'AWS_OWNED_CMK' }, undefined, { markUnsettled: s.markUnsettled });
        expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(1);
        expect(s.marks).toEqual([ENC]);
        expect(s.sentAtMark).toEqual([0]);
      });

      it('marks the key before the Stop is sent', async () => {
        route([{ Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }, { Status: 'DISABLED' }]);
        const s = sink();
        await runUpdate(undefined, { KeyType: 'AWS_OWNED_CMK' }, { markUnsettled: s.markUnsettled });
        expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(1);
        expect(s.marks).toEqual([ENC]);
        expect(s.sentAtMark).toEqual([0]);
      });

      it('marks nothing when no Start / Stop is sent: unchanged, already held, or a failed settle', async () => {
        const s = sink();
        route([{ Status: 'DISABLED' }]);
        await runUpdate({ KeyType: 'AWS_OWNED_CMK' }, { KeyType: 'AWS_OWNED_CMK' }, { markUnsettled: s.markUnsettled });
        mockSend.mockReset();
        route([{ Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }]);
        await runUpdate({ KeyType: 'AWS_OWNED_CMK' }, undefined, { markUnsettled: s.markUnsettled });
        mockSend.mockReset();
        route([{ Status: 'ENABLING', KeyType: 'AWS_OWNED_CMK' }]);
        const settleError = await runUpdate(undefined, { KeyType: 'AWS_OWNED_CMK' }, {
          markUnsettled: s.markUnsettled,
        }).catch((e: unknown) => e);
        expect((settleError as Error).message).toContain('Timed out waiting to settle');
        expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
        expect(s.marks).toEqual([]);
      });

      it('an unfinished wait on a deploy says the key is recorded unsettled; without the sink it points at drift', async () => {
        const warn = getLogger().child('FirehoseProvider').warn as ReturnType<typeof vi.fn>;
        route([
          { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' },
          { Status: 'DISABLING', KeyType: 'AWS_OWNED_CMK' },
          { Status: 'DISABLING_FAILED', KeyType: 'AWS_OWNED_CMK' },
        ]);
        const s = sink();
        await runUpdate(undefined, { KeyType: 'AWS_OWNED_CMK' }, { markUnsettled: s.markUnsettled }).catch(
          () => undefined
        );
        const onDeploy = String(warn.mock.calls.at(-1)?.[0]);
        expect(s.marks).toEqual([ENC]);
        expect(onDeploy).toContain(`records ${ENC} as unsettled`);
        expect(onDeploy).toContain("the next 'cdkd deploy' reads the stream");
        expect(onDeploy).not.toContain("'cdkd drift --revert'");
        mockSend.mockReset();
        route([
          { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' },
          { Status: 'DISABLING', KeyType: 'AWS_OWNED_CMK' },
          { Status: 'DISABLING_FAILED', KeyType: 'AWS_OWNED_CMK' },
        ]);
        await runUpdate(undefined, { KeyType: 'AWS_OWNED_CMK' }).catch(() => undefined);
        const elsewhere = String(warn.mock.calls.at(-1)?.[0]);
        expect(elsewhere).toContain("'cdkd drift --revert'");
        expect(elsewhere).not.toContain('as unsettled');
      });

      it('an unsettled key with equal bags is converged: the stream still encrypted is stopped', async () => {
        route([{ Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }, { Status: 'DISABLED' }]);
        await runUpdate(undefined, undefined, { unsettledProperties: new Set([ENC]) });
        expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(1);
        expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);
      });

      it('an unsettled key with equal bags is converged: a stream left unencrypted is started', async () => {
        route([{ Status: 'ENABLING_FAILED' }, { Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }]);
        await runUpdate({ KeyType: 'AWS_OWNED_CMK' }, { KeyType: 'AWS_OWNED_CMK' }, {
          unsettledProperties: new Set([ENC]),
        });
        expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(1);
      });

      it('an unsettled key the stream already holds sends nothing', async () => {
        route([{ Status: 'DISABLED' }]);
        await runUpdate(undefined, undefined, { unsettledProperties: new Set([ENC]) });
        expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
        expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);
      });

      it('another unsettled key does not force the encryption read', async () => {
        route([{ Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }]);
        await runUpdate(undefined, undefined, { unsettledProperties: new Set(['Tags']) });
        expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
        // Only the result envelope's read: no settle read for encryption.
        expect(sent('DescribeDeliveryStreamCommand')).toHaveLength(1);
      });

      it('unsettledInTransition: the encryption key while ENABLING / DISABLING, none once settled', async () => {
        const ask = (status: string | undefined) => {
          mockSend.mockReset();
          route([status === undefined ? undefined : { Status: status }]);
          return provider.unsettledInTransition('s', 'MyStream', 'AWS::KinesisFirehose::DeliveryStream', new Set([ENC]));
        };
        expect([...(await ask('ENABLING'))]).toEqual([ENC]);
        expect([...(await ask('DISABLING'))]).toEqual([ENC]);
        expect([...(await ask('ENABLED'))]).toEqual([]);
        expect([...(await ask('DISABLED'))]).toEqual([]);
        expect([...(await ask('ENABLING_FAILED'))]).toEqual([]);
        expect([...(await ask(undefined))]).toEqual([]);
      });

      it('unsettledInTransition: no read for other names, and a failed read keeps the key', async () => {
        mockSend.mockReset();
        route([{ Status: 'ENABLING' }]);
        const other = await provider.unsettledInTransition('s', 'MyStream', 'AWS::KinesisFirehose::DeliveryStream', new Set(['Tags']));
        expect([...other]).toEqual([]);
        expect(sent('DescribeDeliveryStreamCommand')).toHaveLength(0);
        mockSend.mockReset();
        mockSend.mockRejectedValue(new Error('throttled'));
        const failed = await provider.unsettledInTransition('s', 'MyStream', 'AWS::KinesisFirehose::DeliveryStream', new Set([ENC]));
        expect([...failed]).toEqual([ENC]);
      });

      it('an unsettled but unusable block is not forced into a refusal', async () => {
        route([{ Status: 'ENABLED', KeyType: 'AWS_OWNED_CMK' }]);
        await runUpdate({ KeyType: 7 }, { KeyType: 7 }, { unsettledProperties: new Set([ENC]) });
        expect(sent('StopDeliveryStreamEncryptionCommand')).toHaveLength(0);
        expect(sent('StartDeliveryStreamEncryptionCommand')).toHaveLength(0);
      });
    });
  });

  describe('update: a DescribeDeliveryStream answer with no VersionId (#4222)', () => {
    // Every destination-update helper raises this error. Its logical-id slot
    // takes the template LOGICAL id and the stream name goes in the physical-id
    // slot: a physical id there never matches the resource the
    // retry classifiers anchor on, and a stream name can be secret-derived.
    it.each([
      'AmazonOpenSearchServerlessDestinationConfiguration',
      'AmazonopensearchserviceDestinationConfiguration',
      'ElasticsearchDestinationConfiguration',
      'ExtendedS3DestinationConfiguration',
      'HttpEndpointDestinationConfiguration',
      'IcebergDestinationConfiguration',
      'RedshiftDestinationConfiguration',
      'SnowflakeDestinationConfiguration',
      'SplunkDestinationConfiguration',
    ])('%s names the logical id, not the stream name', async (destKey) => {
      mockSend.mockResolvedValue({ DeliveryStreamDescription: {} });
      const error = await provider
        .update(
          'MyDeliveryStream',
          'my-stream',
          'AWS::KinesisFirehose::DeliveryStream',
          { [destKey]: { RoleARN: 'arn:aws:iam::123456789012:role/next' } },
          { [destKey]: { RoleARN: 'arn:aws:iam::123456789012:role/prev' } }
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(error).toMatchObject({
        message: expect.stringContaining('did not return VersionId or DestinationId'),
        logicalId: 'MyDeliveryStream',
        physicalId: 'my-stream',
      });
    });
  });

  describe('update: S3BackupMode on an OpenSearch / Elasticsearch destination (#5386)', () => {
    const DESCRIPTIONS: Record<string, string> = {
      ElasticsearchDestinationConfiguration: 'ElasticsearchDestinationDescription',
      AmazonopensearchserviceDestinationConfiguration:
        'AmazonopensearchserviceDestinationDescription',
      AmazonOpenSearchServerlessDestinationConfiguration:
        'AmazonOpenSearchServerlessDestinationDescription',
    };
    const DEST = 'AmazonOpenSearchServerlessDestinationConfiguration';

    /** Route each call by command; `failRead` rejects the Describe at that 1-based index. */
    function mockStream(destKey: string, liveMode: string | undefined, failRead?: number): void {
      let reads = 0;
      mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name !== 'DescribeDeliveryStreamCommand') return {};
        reads += 1;
        if (reads === failRead) throw new Error('throttled');
        return {
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/s',
            VersionId: '1',
            Destinations: [
              {
                DestinationId: 'destinationId-000000000001',
                [DESCRIPTIONS[destKey] ?? 'ExtendedS3DestinationDescription']: {
                  ...(liveMode !== undefined && { S3BackupMode: liveMode }),
                },
              },
            ],
          },
        };
      });
    }

    function backupWarnings(): string[] {
      const warn = getLogger().child('FirehoseProvider').warn as ReturnType<typeof vi.fn>;
      return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('S3BackupMode'));
    }

    function describeCount(): number {
      return mockSend.mock.calls.filter(
        (c) => (c[0] as { constructor: { name: string } }).constructor.name === 'DescribeDeliveryStreamCommand'
      ).length;
    }

    const bag = (destKey: string, extra: Record<string, unknown>) => ({
      [destKey]: { IndexName: 'idx', RoleARN: 'arn:aws:iam::123456789012:role/r', ...extra },
    });

    it.each(Object.keys(DESCRIPTIONS))(
      '%s: a changed mode the stream does not hold is warned, and the declared value is recorded',
      async (destKey) => {
        mockStream(destKey, 'FailedDocumentsOnly');
        const result = await provider.update(
          'MyStream',
          's',
          'AWS::KinesisFirehose::DeliveryStream',
          bag(destKey, { S3BackupMode: 'AllDocuments' }),
          bag(destKey, { S3BackupMode: 'FailedDocumentsOnly' }),
          { changedProperties: new Set([destKey]) }
        );
        const warnings = backupWarnings();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`MyStream (AWS::KinesisFirehose::DeliveryStream): ${destKey}.S3BackupMode changed`);
        expect(warnings[0]).toContain('keeps its current mode (FailedDocumentsOnly), as CloudFormation does');
        expect(warnings[0]).toContain('new DeliveryStreamName or a new logical id');
        // The update payload has no member for it, so nothing names the mode on the wire.
        const update = mockSend.mock.calls.find(
          (c) => (c[0] as { constructor: { name: string } }).constructor.name === 'UpdateDestinationCommand'
        );
        expect(JSON.stringify(update?.[0].input)).not.toContain('S3BackupMode');
        // State records the declared value, as CloudFormation's stored template does.
        expect(result.effectiveProperties).toBeUndefined();
        // Confirmed against the closing read: no read beyond the two an update makes.
        expect(describeCount()).toBe(2);
      }
    );

    it('no warning, and no extra read, when the mode is unchanged', async () => {
      mockStream(DEST, 'FailedDocumentsOnly');
      await provider.update(
        'MyStream',
        's',
        'AWS::KinesisFirehose::DeliveryStream',
        bag(DEST, { S3BackupMode: 'FailedDocumentsOnly', IndexName: 'idx2' }),
        bag(DEST, { S3BackupMode: 'FailedDocumentsOnly' })
      );
      expect(backupWarnings()).toEqual([]);
      // One read for UpdateDestination's version id, one for the result envelope.
      expect(describeCount()).toBe(2);
    });

    it('no warning when the live stream already holds the declared mode', async () => {
      mockStream(DEST, 'AllDocuments');
      await provider.update(
        'MyStream',
        's',
        'AWS::KinesisFirehose::DeliveryStream',
        bag(DEST, { S3BackupMode: 'AllDocuments' }),
        bag(DEST, { S3BackupMode: 'FailedDocumentsOnly' })
      );
      expect(backupWarnings()).toEqual([]);
    });

    it('a failed closing read fails the update without printing the warning', async () => {
      // Read 1: UpdateDestination's version id. Read 2: the closing read the
      // warning is confirmed against.
      mockStream(DEST, 'FailedDocumentsOnly', 2);
      await expect(
        provider.update(
          'MyStream',
          's',
          'AWS::KinesisFirehose::DeliveryStream',
          bag(DEST, { S3BackupMode: 'AllDocuments' }),
          bag(DEST, { S3BackupMode: 'FailedDocumentsOnly' })
        )
      ).rejects.toThrow('throttled');
      expect(backupWarnings()).toEqual([]);
    });

    it('a closing read that reports no mode still warns, without naming one', async () => {
      mockStream(DEST, undefined);
      const result = await provider.update(
        'MyStream',
        's',
        'AWS::KinesisFirehose::DeliveryStream',
        bag(DEST, { S3BackupMode: 'AllDocuments' }),
        bag(DEST, { S3BackupMode: 'FailedDocumentsOnly' })
      );
      expect(result.wasReplaced).toBe(false);
      const warnings = backupWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('keeps its current mode, as CloudFormation does');
    });

    it('no warning when the engine did not report the destination as changed', async () => {
      mockStream(DEST, 'FailedDocumentsOnly');
      await provider.update(
        'MyStream',
        's',
        'AWS::KinesisFirehose::DeliveryStream',
        { ...bag(DEST, { S3BackupMode: 'AllDocuments' }), Tags: [] },
        { ...bag(DEST, { S3BackupMode: 'FailedDocumentsOnly' }), Tags: [] },
        { changedProperties: new Set(['Tags']) }
      );
      expect(backupWarnings()).toEqual([]);
    });

    it('a removed mode compares against the FailedDocumentsOnly default', async () => {
      mockStream(DEST, 'AllDocuments');
      await provider.update(
        'MyStream',
        's',
        'AWS::KinesisFirehose::DeliveryStream',
        bag(DEST, {}),
        bag(DEST, { S3BackupMode: 'AllDocuments' })
      );
      expect(backupWarnings()).toHaveLength(1);

      vi.clearAllMocks();
      mockStream(DEST, 'FailedDocumentsOnly');
      await provider.update(
        'MyStream',
        's',
        'AWS::KinesisFirehose::DeliveryStream',
        bag(DEST, {}),
        bag(DEST, { S3BackupMode: 'AllDocuments' })
      );
      expect(backupWarnings()).toEqual([]);
    });

    it('an ExtendedS3 S3BackupMode change is sent, not warned', async () => {
      const destKey = 'ExtendedS3DestinationConfiguration';
      mockStream(destKey, undefined);
      const s3 = { BucketARN: 'arn:aws:s3:::b', RoleARN: 'arn:aws:iam::123456789012:role/r' };
      await provider.update(
        'MyStream',
        's',
        'AWS::KinesisFirehose::DeliveryStream',
        { [destKey]: { ...s3, S3BackupMode: 'Enabled' } },
        { [destKey]: { ...s3, S3BackupMode: 'Disabled' } }
      );
      expect(backupWarnings()).toEqual([]);
      const update = mockSend.mock.calls.find(
        (c) =>
          (c[0] as { constructor: { name: string } }).constructor.name ===
          'UpdateDestinationCommand'
      );
      expect(update?.[0].input.ExtendedS3DestinationUpdate.S3BackupMode).toBe('Enabled');
    });
  });

  describe('delete', () => {
    const notFound = () =>
      new ResourceNotFoundException({ $metadata: {}, message: 'Delivery stream not found' });

    afterEach(() => {
      vi.useRealTimers();
      // The cap cases install a DELETING-forever implementation, which
      // clearAllMocks() does not remove.
      mockSend.mockReset();
    });

    it('should delete delivery stream', async () => {
      mockSend.mockResolvedValueOnce({}).mockRejectedValueOnce(notFound());

      await provider.delete(
        'MyDeliveryStream',
        'test-stream',
        'AWS::KinesisFirehose::DeliveryStream'
      );

      expect(mockSend).toHaveBeenCalledTimes(2);

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.constructor.name).toBe('DeleteDeliveryStreamCommand');
      expect(cmd.input.DeliveryStreamName).toBe('test-stream');
    });

    // Issue #3872: the delivery stream holds its NAME while DELETING (~100s
    // measured), and a create of that name is refused with the live-stream
    // text, so delete() must not return until DescribeDeliveryStream reports
    // the stream gone.
    it('waits through DELETING until DescribeDeliveryStream reports the stream gone', async () => {
      vi.useFakeTimers();
      const deleting = { DeliveryStreamDescription: { DeliveryStreamStatus: 'DELETING' } };
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(deleting)
        .mockResolvedValueOnce(deleting)
        .mockRejectedValueOnce(notFound());

      let settled = false;
      const done = provider
        .delete('MyDeliveryStream', 'test-stream', 'AWS::KinesisFirehose::DeliveryStream')
        .then(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await done;

      expect(mockSend).toHaveBeenCalledTimes(4);
      for (const call of mockSend.mock.calls.slice(1)) {
        expect(call[0]).toBeInstanceOf(DescribeDeliveryStreamCommand);
        expect(call[0].input).toEqual({ DeliveryStreamName: 'test-stream' });
      }
    });

    it('throws, keeping the state record, when the stream enters DELETING_FAILED', async () => {
      vi.useFakeTimers();
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ DeliveryStreamDescription: { DeliveryStreamStatus: 'DELETING' } })
        .mockResolvedValueOnce({
          DeliveryStreamDescription: { DeliveryStreamStatus: 'DELETING_FAILED' },
        });

      const outcome = provider
        .delete('MyDeliveryStream', 'test-stream', 'AWS::KinesisFirehose::DeliveryStream')
        .then(
          () => undefined,
          (e: unknown) => e
        );
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await outcome;

      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toMatch(/entered DELETING_FAILED/);
      expect((err as Error).message).toMatch(/outside cdkd with AllowForceDelete \(cdkd never sends it\)/);
      expect(isWaitAbandonedError(err)).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('stops waiting at its cap without throwing when the stream never disappears', async () => {
      vi.useFakeTimers();
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof DescribeDeliveryStreamCommand
          ? Promise.resolve({ DeliveryStreamDescription: { DeliveryStreamStatus: 'DELETING' } })
          : Promise.resolve({})
      );

      let settled = false;
      const done = provider
        .delete('MyDeliveryStream', 'test-stream', 'AWS::KinesisFirehose::DeliveryStream')
        .then(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 5_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await done;

      const describes = mockSend.mock.calls.filter(
        (call: unknown[]) => call[0] instanceof DescribeDeliveryStreamCommand
      );
      // One poll every 5s across the 10-minute cap, plus the one at the cap.
      expect(describes).toHaveLength(121);
    });

    it('should handle ResourceNotFoundException gracefully (idempotent)', async () => {
      const { ResourceNotFoundException } = await import('@aws-sdk/client-firehose');
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({
          $metadata: {},
          message: 'Delivery stream not found',
        })
      );

      // Should not throw
      await provider.delete(
        'MyDeliveryStream',
        'test-stream',
        'AWS::KinesisFirehose::DeliveryStream'
      );

      // Already gone: no gone-wait follows the idempotent arm.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyDeliveryStream',
        resourceType: 'AWS::KinesisFirehose::DeliveryStream',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('explicit override: DescribeDeliveryStream verifies and returns the name', async () => {
      mockSend.mockResolvedValueOnce({
        DeliveryStreamDescription: { DeliveryStreamName: 'adopted' },
      });

      const result = await provider.import(makeInput({ knownPhysicalId: 'adopted' }));

      expect(result).toEqual({ physicalId: 'adopted', attributes: {} });
      const call = mockSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('DescribeDeliveryStreamCommand');
      expect(call.input).toEqual({ DeliveryStreamName: 'adopted' });
    });

    // The `aws:cdk:path` tag walk was removed (issue #1134): AWS rejects
    // `aws:`-prefixed tag writes, so the tag never exists on a real stream.
    // With no explicit id, import returns null without issuing any AWS call.
    it('returns null without any AWS call when only cdkPath is given', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});

describe('FirehoseProvider update region guard (issue #2613)', () => {
  let provider: FirehoseProvider;
  const desired = { DeliveryStreamName: 'test-stream', Tags: [{ Key: 'team', Value: 'a' }] };
  const previous = { DeliveryStreamName: 'test-stream', Tags: [] as Array<{ Key: string; Value: string }> };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  it('refuses an update from a wrong-region client before any call', async () => {
    await expect(
      provider.update('MyDeliveryStream', 'test-stream', 'AWS::KinesisFirehose::DeliveryStream', desired, previous, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(/Refusing to update MyDeliveryStream .*does not match stack state region us-west-2/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('updates when the client region matches the recorded one', async () => {
    mockSend.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof DescribeDeliveryStreamCommand
          ? { DeliveryStreamDescription: { VersionId: '1', Destinations: [] } }
          : {}
      )
    );
    await provider.update('MyDeliveryStream', 'test-stream', 'AWS::KinesisFirehose::DeliveryStream', desired, previous, {
      expectedRegion: 'us-east-1',
    });
    expect(mockSend.mock.calls.map((c) => (c[0] as object).constructor.name)).toContain(
      'TagDeliveryStreamCommand'
    );
  });

  it('without a recorded region proceeds and never resolves the client region', async () => {
    const region = vi.fn(() => Promise.resolve('us-west-2'));
    (provider as unknown as { getClient(): { config: { region: unknown } } }).getClient().config.region = region;
    mockSend.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof DescribeDeliveryStreamCommand
          ? { DeliveryStreamDescription: { VersionId: '1', Destinations: [] } }
          : {}
      )
    );
    await provider.update('MyDeliveryStream', 'test-stream', 'AWS::KinesisFirehose::DeliveryStream', desired, previous);
    expect(region).not.toHaveBeenCalled();
    expect(mockSend.mock.calls.map((c) => (c[0] as object).constructor.name)).toContain(
      'TagDeliveryStreamCommand'
    );
  });
});

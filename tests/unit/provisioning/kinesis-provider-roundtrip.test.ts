import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeStreamCommand,
  StartStreamEncryptionCommand,
  StopStreamEncryptionCommand,
  UpdateShardCountCommand,
  IncreaseStreamRetentionPeriodCommand,
  DecreaseStreamRetentionPeriodCommand,
  AddTagsToStreamCommand,
  RemoveTagsFromStreamCommand,
  ListTagsForStreamCommand,
} from '@aws-sdk/client-kinesis';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kinesis', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-kinesis')>(
    '@aws-sdk/client-kinesis'
  );
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => ({
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

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';

const STREAM_NAME = 'mystream';
const STREAM_ARN = `arn:aws:kinesis:us-east-1:123456789012:stream/${STREAM_NAME}`;

describe('KinesisStreamProvider read-update round-trip', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new KinesisStreamProvider();
  });

  it('Class 1 — ON_DEMAND stream readCurrentState does not emit ShardCount', async () => {
    // Mechanical guard for Class 1 placeholder regression on type-
    // discriminator-dependent fields. See docs/provider-development.md
    // § 3b "Read-update round-trip test".
    //
    // ShardCount is PROVISIONED-only. AWS rejects UpdateShardCount on
    // ON_DEMAND streams (capacity is managed by AWS). Even though
    // DescribeStream returns shards on ON_DEMAND streams too, the type
    // discriminator is StreamMode — readCurrentState must NOT surface
    // ShardCount on ON_DEMAND so a `cdkd drift --revert` round-trip
    // never pushes UpdateShardCount.
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: STREAM_NAME,
          StreamModeDetails: { StreamMode: 'ON_DEMAND' },
          // AWS reports shards on ON_DEMAND too (capacity managed by AWS).
          Shards: [{ ShardId: 's-1' }, { ShardId: 's-2' }],
          RetentionPeriodHours: 24,
          EncryptionType: 'NONE',
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const observed = await provider.readCurrentState(
      STREAM_NAME,
      'L',
      'AWS::Kinesis::Stream'
    );

    expect(observed?.['StreamModeDetails']).toEqual({ StreamMode: 'ON_DEMAND' });
    expect(observed).not.toHaveProperty('ShardCount');
  });

  it('Class 1 — PROVISIONED stream emits ShardCount as Shards.length', async () => {
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: STREAM_NAME,
          StreamModeDetails: { StreamMode: 'PROVISIONED' },
          Shards: [{ ShardId: 's-1' }, { ShardId: 's-2' }],
          RetentionPeriodHours: 24,
          EncryptionType: 'NONE',
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const observed = await provider.readCurrentState(
      STREAM_NAME,
      'L',
      'AWS::Kinesis::Stream'
    );

    expect(observed?.['ShardCount']).toBe(2);
  });

  it('Class 1/2 — round-trip on unencrypted PROVISIONED stream skips StartStreamEncryption', async () => {
    // Mechanical guard for Class 1/2 placeholder regression on
    // EncryptionType=NONE. readCurrentState always-emits
    // `StreamEncryption: { EncryptionType: 'NONE' }` on unencrypted
    // streams so the comparator can detect a console-side KMS attach.
    // On the write side, neither StartStreamEncryption (KMS-only) nor
    // StopStreamEncryption accepts NONE. A `cdkd drift --revert`
    // round-trip must NOT call either API when the desired and
    // previous states are both NONE.

    // 1. Build observed snapshot directly (matches what
    //    readCurrentState would produce — exercised by its own
    //    dedicated test file).
    const observed = {
      Name: STREAM_NAME,
      StreamModeDetails: { StreamMode: 'PROVISIONED' },
      ShardCount: 2,
      RetentionPeriodHours: 24,
      StreamEncryption: { EncryptionType: 'NONE' },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    // 2. Set up update() expectations: only the trailing DescribeStream
    //    call for attributes returns. No mutation calls should fire.
    mockSend.mockResolvedValueOnce({
      StreamDescription: { StreamARN: STREAM_ARN },
    });

    // 3. Round-trip: pass observed as both new (desired) and old.
    //    No drift -> update should be a logical no-op on AWS.
    await provider.update(
      'L',
      STREAM_NAME,
      'AWS::Kinesis::Stream',
      observed,
      observed
    );

    // 4. Assert: NO StartStreamEncryption / StopStreamEncryption / etc.
    //    AWS rejects StartStreamEncryption(EncryptionType=NONE) and
    //    StopStreamEncryption is encryption-removal — neither is valid
    //    on a never-encrypted stream.
    expect(mockSend.mock.calls.find((c) => c[0] instanceof StartStreamEncryptionCommand)).toBeUndefined();
    expect(mockSend.mock.calls.find((c) => c[0] instanceof StopStreamEncryptionCommand)).toBeUndefined();
    // No shard count change either (old == new).
    expect(mockSend.mock.calls.find((c) => c[0] instanceof UpdateShardCountCommand)).toBeUndefined();
    // No retention change either (old == new == 24).
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof IncreaseStreamRetentionPeriodCommand)
    ).toBeUndefined();
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof DecreaseStreamRetentionPeriodCommand)
    ).toBeUndefined();
  });

  it('Class 1/2 — KMS attach (NONE -> KMS) round-trip calls StartStreamEncryption with EncryptionType=KMS', async () => {
    // The complement of the no-op test: when --revert pushes a console-
    // side KMS detachment back to AWS, the new value is KMS and old is
    // NONE. Update should fire StartStreamEncryption(KMS) — and crucially
    // NOT StopStreamEncryption(NONE), which AWS rejects.
    const oldObserved = {
      Name: STREAM_NAME,
      StreamModeDetails: { StreamMode: 'PROVISIONED' },
      ShardCount: 1,
      RetentionPeriodHours: 24,
      StreamEncryption: { EncryptionType: 'NONE' },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };
    const newDesired = {
      ...oldObserved,
      StreamEncryption: {
        EncryptionType: 'KMS',
        KeyId: 'arn:aws:kms:us-east-1:123:key/abc',
      },
    };

    mockSend
      .mockResolvedValueOnce({}) // StartStreamEncryption
      .mockResolvedValueOnce({
        StreamDescription: { StreamStatus: 'ACTIVE', StreamARN: STREAM_ARN },
      }) // waitForStreamActive (DescribeStream)
      .mockResolvedValueOnce({
        StreamDescription: { StreamARN: STREAM_ARN },
      }); // trailing DescribeStream for attributes

    await provider.update(
      'L',
      STREAM_NAME,
      'AWS::Kinesis::Stream',
      newDesired,
      oldObserved
    );

    // StopStreamEncryption MUST NOT fire — old was NONE.
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof StopStreamEncryptionCommand)
    ).toBeUndefined();

    const startCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof StartStreamEncryptionCommand
    );
    expect(startCall).toBeDefined();
    const startInput = startCall![0].input as {
      EncryptionType: string;
      KeyId: string;
      StreamName: string;
    };
    expect(startInput.EncryptionType).toBe('KMS');
    expect(startInput.KeyId).toBe('arn:aws:kms:us-east-1:123:key/abc');
    expect(startInput.StreamName).toBe(STREAM_NAME);
  });

  it('Class 1/2 — KMS detach (KMS -> NONE) calls StopStreamEncryption with EncryptionType=KMS, not NONE', async () => {
    // Complement: when state has NONE but AWS-current is KMS,
    // --accept would update state; --revert would push state (NONE)
    // back to AWS. Expected: StopStreamEncryption(KMS) (the documented
    // way to remove encryption), and NOT StartStreamEncryption(NONE).
    const oldObserved = {
      Name: STREAM_NAME,
      StreamModeDetails: { StreamMode: 'PROVISIONED' },
      ShardCount: 1,
      RetentionPeriodHours: 24,
      StreamEncryption: {
        EncryptionType: 'KMS',
        KeyId: 'arn:aws:kms:us-east-1:123:key/abc',
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };
    const newDesired = {
      ...oldObserved,
      StreamEncryption: { EncryptionType: 'NONE' },
    };

    mockSend
      .mockResolvedValueOnce({}) // StopStreamEncryption
      .mockResolvedValueOnce({
        StreamDescription: { StreamStatus: 'ACTIVE', StreamARN: STREAM_ARN },
      }) // waitForStreamActive
      .mockResolvedValueOnce({
        StreamDescription: { StreamARN: STREAM_ARN },
      }); // trailing DescribeStream

    await provider.update(
      'L',
      STREAM_NAME,
      'AWS::Kinesis::Stream',
      newDesired,
      oldObserved
    );

    // StartStreamEncryption MUST NOT fire — new is NONE.
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof StartStreamEncryptionCommand)
    ).toBeUndefined();

    const stopCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof StopStreamEncryptionCommand
    );
    expect(stopCall).toBeDefined();
    const stopInput = stopCall![0].input as {
      EncryptionType: string;
      KeyId: string | undefined;
    };
    // EncryptionType MUST be 'KMS' (the encryption being stopped is KMS),
    // never the NONE placeholder.
    expect(stopInput.EncryptionType).toBe('KMS');
    expect(stopInput.KeyId).toBe('arn:aws:kms:us-east-1:123:key/abc');
  });

  it('round-trip on no-drift KMS-encrypted PROVISIONED snapshot is a logical no-op', async () => {
    // Stronger assertion for diff-based providers: state == AWS implies
    // update() must make no AWS-side mutations beyond the trailing
    // DescribeStream for attributes. PR-style round-trip guard.
    const observed = {
      Name: STREAM_NAME,
      StreamModeDetails: { StreamMode: 'PROVISIONED' },
      ShardCount: 4,
      RetentionPeriodHours: 48,
      StreamEncryption: {
        EncryptionType: 'KMS',
        KeyId: 'arn:aws:kms:us-east-1:123:key/abc',
      },
      Tags: [{ Key: 'k', Value: 'v' }],
    };

    mockSend.mockResolvedValueOnce({
      StreamDescription: { StreamARN: STREAM_ARN },
    });

    await provider.update(
      'L',
      STREAM_NAME,
      'AWS::Kinesis::Stream',
      observed,
      observed
    );

    // Only the trailing DescribeStream for attributes ran.
    const mutationCalls = mockSend.mock.calls.filter(
      (c) =>
        c[0] instanceof StartStreamEncryptionCommand ||
        c[0] instanceof StopStreamEncryptionCommand ||
        c[0] instanceof UpdateShardCountCommand ||
        c[0] instanceof IncreaseStreamRetentionPeriodCommand ||
        c[0] instanceof DecreaseStreamRetentionPeriodCommand ||
        c[0] instanceof AddTagsToStreamCommand ||
        c[0] instanceof RemoveTagsFromStreamCommand
    );
    expect(mutationCalls).toHaveLength(0);
    // Trailing DescribeStream did fire (for the returned Arn attribute).
    const describeCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DescribeStreamCommand
    );
    expect(describeCalls).toHaveLength(1);
  });

  it('round-trip ListTagsForStream is symmetric — empty Tags array does not push tag calls', async () => {
    // readCurrentState emits Tags: [] when AWS reports no user tags.
    // applyTagDiff with empty old == empty new must produce zero tag
    // API calls.
    const observed = {
      Name: STREAM_NAME,
      StreamModeDetails: { StreamMode: 'PROVISIONED' },
      ShardCount: 1,
      RetentionPeriodHours: 24,
      StreamEncryption: { EncryptionType: 'NONE' },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValueOnce({
      StreamDescription: { StreamARN: STREAM_ARN },
    });

    await provider.update(
      'L',
      STREAM_NAME,
      'AWS::Kinesis::Stream',
      observed,
      observed
    );

    expect(mockSend.mock.calls.find((c) => c[0] instanceof AddTagsToStreamCommand)).toBeUndefined();
    expect(
      mockSend.mock.calls.find((c) => c[0] instanceof RemoveTagsFromStreamCommand)
    ).toBeUndefined();
    // The ListTagsForStream is part of readCurrentState, NOT update().
    // update() does not list tags itself; verify no list call.
    expect(mockSend.mock.calls.find((c) => c[0] instanceof ListTagsForStreamCommand)).toBeUndefined();
  });
});

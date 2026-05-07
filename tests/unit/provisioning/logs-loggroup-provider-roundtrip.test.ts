import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PutRetentionPolicyCommand,
  DeleteRetentionPolicyCommand,
  PutDataProtectionPolicyCommand,
  DeleteDataProtectionPolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

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

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';

const RESOURCE_TYPE = 'AWS::Logs::LogGroup';
const PHYSICAL_ID = '/aws/lambda/my-fn';

describe('LogsLogGroupProvider read-update round-trip', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LogsLogGroupProvider();
  });

  it('round-trip on no-drift snapshot is a logical no-op (zero AWS mutations)', async () => {
    // Mechanical guard for the read-update round-trip: when state
    // matches AWS, `cdkd drift --revert` round-trips
    // observedProperties through update() and must NOT mutate AWS.
    //
    // Build a snapshot that mirrors what readCurrentState emits for an
    // initially-untagged log group with no retention and no KMS:
    //   - KmsKeyId: '' (always-emit string placeholder)
    //   - RetentionInDays: 0 (always-emit "never expire" semantic default)
    //   - Tags: [] (always-emit array placeholder)
    const observed: Record<string, unknown> = {
      LogGroupName: PHYSICAL_ID,
      KmsKeyId: '',
      RetentionInDays: 0,
      Tags: [],
    };

    // sts mock for buildArn — return the result twice in case
    mockSend.mockResolvedValue({ Account: '123456789012' });

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    // No drift -> no AWS-side mutations on retention, data protection,
    // or tags.
    const mutationCalls = mockSend.mock.calls.filter((c) => {
      const cmd = c[0];
      return (
        cmd instanceof PutRetentionPolicyCommand ||
        cmd instanceof DeleteRetentionPolicyCommand ||
        cmd instanceof PutDataProtectionPolicyCommand ||
        cmd instanceof DeleteDataProtectionPolicyCommand ||
        cmd instanceof TagResourceCommand ||
        cmd instanceof UntagResourceCommand
      );
    });
    expect(mutationCalls).toHaveLength(0);
  });

  it('Class 2 — RetentionInDays: 0 placeholder does NOT push PutRetentionPolicy(0) to AWS', async () => {
    // Class 2 round-trip guard. AWS rejects PutRetentionPolicy with
    // retentionInDays=0 ("retentionInDays must be a positive integer").
    // The "no retention" snapshot must therefore translate to either
    // no AWS call at all (round-trip no-op) or a DeleteRetentionPolicy
    // — never to PutRetentionPolicy(0).
    const observed: Record<string, unknown> = {
      LogGroupName: PHYSICAL_ID,
      KmsKeyId: '',
      RetentionInDays: 0,
      Tags: [],
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    const putRetention = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutRetentionPolicyCommand
    );
    expect(putRetention).toBeUndefined();
  });

  it('RetentionInDays change from 0 -> 30 routes to PutRetentionPolicy', async () => {
    // Complement of the Class 2 guard: a real change from "no
    // retention" to "30 days" must produce a PutRetentionPolicy call
    // (not a Delete).
    const oldProps: Record<string, unknown> = {
      LogGroupName: PHYSICAL_ID,
      KmsKeyId: '',
      RetentionInDays: 0,
      Tags: [],
    };
    const newProps: Record<string, unknown> = {
      ...oldProps,
      RetentionInDays: 30,
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);

    const putRetentionCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutRetentionPolicyCommand
    );
    expect(putRetentionCall).toBeDefined();
    const input = putRetentionCall?.[0].input as { retentionInDays: number };
    expect(input.retentionInDays).toBe(30);
  });

  it('RetentionInDays change from 30 -> 0 routes to DeleteRetentionPolicy', async () => {
    // The reverse: dropping retention back to "never expire" must
    // produce a Delete, matching the always-emit `?? 0` semantic on
    // the read side.
    const oldProps: Record<string, unknown> = {
      LogGroupName: PHYSICAL_ID,
      KmsKeyId: '',
      RetentionInDays: 30,
      Tags: [],
    };
    const newProps: Record<string, unknown> = {
      ...oldProps,
      RetentionInDays: 0,
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);

    const deleteRetentionCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof DeleteRetentionPolicyCommand
    );
    expect(deleteRetentionCall).toBeDefined();
    const putRetentionCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutRetentionPolicyCommand
    );
    expect(putRetentionCall).toBeUndefined();
  });

  it('Tags=[] round-trip on initially-untagged group does NOT call Tag/UntagResource', async () => {
    // Always-emit Tags=[] placeholder must not produce an UntagResource
    // call when the previous Tags is also []. This protects the
    // initially-untagged path from spurious AWS calls (which AWS
    // accepts but is wasteful and noisy).
    const observed: Record<string, unknown> = {
      LogGroupName: PHYSICAL_ID,
      KmsKeyId: '',
      RetentionInDays: 0,
      Tags: [],
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    const tagCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagCalls).toHaveLength(0);
  });
});

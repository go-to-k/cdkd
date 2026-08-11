import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  UpdateTrailCommand,
  PutEventSelectorsCommand,
} from '@aws-sdk/client-cloudtrail';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudtrail')>(
    '@aws-sdk/client-cloudtrail'
  );
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
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

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';

const TRAIL_ARN = 'arn:aws:cloudtrail:us-east-1:1:trail/mytrail';
const RESOURCE_TYPE = 'AWS::CloudTrail::Trail';

describe('CloudTrailProvider read-update round-trip', () => {
  let provider: CloudTrailProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudTrailProvider();
  });

  it('Class 1 — CW-logs-disabled trail does not push empty CW log ARNs to AWS on round-trip', async () => {
    // readCurrentState on a CW-logs-disabled trail must NOT emit
    // CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn at all (the
    // discriminator-pair guard). Round-tripping an observed snapshot
    // through update() must therefore not include those keys, so AWS
    // never sees the rejection-shape input
    // (`CloudWatchLogsLogGroupArn is not in valid ARN format`).
    // NOTE: that rejection claim was DISPROVEN by the issue #1160 probe
    // (2026-08-10) — `''` IS accepted for this field. The all-or-nothing
    // pair discriminator is the surviving rationale for the guard.
    const observed = {
      TrailName: 'mytrail',
      S3BucketName: 'mybucket',
      S3KeyPrefix: '',
      IsMultiRegionTrail: false,
      IncludeGlobalServiceEvents: true,
      EnableLogFileValidation: false,
      KMSKeyId: '',
      SnsTopicName: '',
      IsOrganizationTrail: false,
      IsLogging: true,
      EventSelectors: [],
      Tags: [] as Array<{ Key: string; Value: string }>,
      // CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn intentionally
      // absent — Class 1 guard kicks in at readCurrentState.
    };

    // SDK sends: UpdateTrail (no CW logs change → no PutEventSelectors,
    // no IsLogging change → no Start/Stop, no tag diff).
    mockSend.mockResolvedValueOnce({});

    await provider.update('L', TRAIL_ARN, RESOURCE_TYPE, observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTrailCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as {
      CloudWatchLogsLogGroupArn?: string;
      CloudWatchLogsRoleArn?: string;
      KmsKeyId?: string;
      SnsTopicName?: string;
    };
    // None of the empty-placeholder ARN-shaped fields reach AWS.
    expect(input.CloudWatchLogsLogGroupArn).toBeUndefined();
    expect(input.CloudWatchLogsRoleArn).toBeUndefined();
    expect(input.KmsKeyId).toBeUndefined();
    expect(input.SnsTopicName).toBeUndefined();
  });

  it('Class 2 — empty-string KMS / SNS placeholders are sanitized to undefined at the wire layer', async () => {
    // The wire-layer sanitizer converts an explicit `''` to undefined so AWS
    // cannot reject with "is not in valid ARN format" -- a claim the issue
    // #1160 probe DISPROVED (2026-08-10) for the fields it tested, but which
    // stays the conservative default for the ones it did not.
    //
    // The CloudWatch Logs PAIR is deliberately NOT in this set since issue
    // #1565: `readCurrentState` always-emits it as `''` on an unwired trail,
    // so sanitizing there made `drift --revert` of a console-side enable a
    // silent no-op that still reported success. It is asserted separately
    // below.
    const observed = {
      TrailName: 'mytrail',
      S3BucketName: 'mybucket',
      KMSKeyId: '',
      SnsTopicName: '',
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValueOnce({});

    await provider.update('L', TRAIL_ARN, RESOURCE_TYPE, observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTrailCommand);
    const input = updateCall![0].input as Record<string, unknown>;
    expect(input['KmsKeyId']).toBeUndefined();
    expect(input['SnsTopicName']).toBeUndefined();
    for (const key of ['KmsKeyId', 'SnsTopicName']) {
      expect(input[key]).not.toBe('');
    }
  });

  it("the CloudWatch Logs pair's '' placeholders are FORWARDED, not sanitized (issue #1565)", async () => {
    // The exception to the rule above, and the reason it is an exception: the
    // pair is always-emitted, so `''` is the recorded baseline of an unwired
    // trail and forwarding it is what lets a revert actually clear a
    // console-side enable. Dropping it left the wiring in place while cdkd
    // printed the resource as reverted.
    const observed = {
      TrailName: 'mytrail',
      S3BucketName: 'mybucket',
      CloudWatchLogsLogGroupArn: '',
      CloudWatchLogsRoleArn: '',
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValueOnce({});

    await provider.update('L', TRAIL_ARN, RESOURCE_TYPE, observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTrailCommand);
    const input = updateCall![0].input as Record<string, unknown>;
    expect(input['CloudWatchLogsLogGroupArn']).toBe('');
    expect(input['CloudWatchLogsRoleArn']).toBe('');
  });

  it('FIFO-equivalent — populated ARN fields round-trip without sanitization to undefined', async () => {
    // Complement of the Class 1 / Class 2 tests: a populated ARN value
    // must reach AWS unchanged. (No drift, so update is a logical no-
    // op, but the wire-layer values still need to round-trip.)
    const observed = {
      TrailName: 'mytrail',
      S3BucketName: 'mybucket',
      KMSKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
      SnsTopicName: 'arn:aws:sns:us-east-1:1:my-topic',
      CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:1:log-group:/aws/cloudtrail/mytrail:*',
      CloudWatchLogsRoleArn: 'arn:aws:iam::1:role/CloudTrailLogsRole',
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValueOnce({});

    await provider.update('L', TRAIL_ARN, RESOURCE_TYPE, observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTrailCommand);
    const input = updateCall![0].input as Record<string, unknown>;
    expect(input['KmsKeyId']).toBe('arn:aws:kms:us-east-1:1:key/abc');
    expect(input['SnsTopicName']).toBe('arn:aws:sns:us-east-1:1:my-topic');
    expect(input['CloudWatchLogsLogGroupArn']).toBe(
      'arn:aws:logs:us-east-1:1:log-group:/aws/cloudtrail/mytrail:*'
    );
    expect(input['CloudWatchLogsRoleArn']).toBe('arn:aws:iam::1:role/CloudTrailLogsRole');
  });
});

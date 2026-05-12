import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeLogGroupsCommand,
  ListTagsForResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: vi.fn() },
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

describe('LogsLogGroupProvider.readCurrentState', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LogsLogGroupProvider();
  });

  it('returns CFn-shaped properties from DescribeLogGroups (camelCase -> PascalCase)', async () => {
    mockSend.mockResolvedValueOnce({
      logGroups: [
        {
          logGroupName: '/aws/lambda/my-fn',
          kmsKeyId: 'arn:aws:kms:us-east-1:123:key/abc',
          retentionInDays: 30,
          logGroupClass: 'STANDARD',
          deletionProtectionEnabled: true,
          bearerTokenAuthenticationEnabled: false,
          // AWS-managed fields ignored by the comparator:
          arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn:*',
          creationTime: 0,
          storedBytes: 0,
        },
      ],
    });
    // ListTagsForResource — no user tags
    mockSend.mockResolvedValueOnce({ tags: {} });
    // GetDataProtectionPolicy — no policy.
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('No policy'), { name: 'ResourceNotFoundException' })
    );
    // DescribeIndexPolicies — no log-group-level policies.
    mockSend.mockResolvedValueOnce({ indexPolicies: [] });

    const result = await provider.readCurrentState(
      '/aws/lambda/my-fn',
      'Logical',
      'AWS::Logs::LogGroup'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeLogGroupsCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      LogGroupName: '/aws/lambda/my-fn',
      KmsKeyId: 'arn:aws:kms:us-east-1:123:key/abc',
      RetentionInDays: 30,
      LogGroupClass: 'STANDARD',
      DeletionProtectionEnabled: true,
      BearerTokenAuthenticationEnabled: false,
      Tags: [],
      DataProtectionPolicy: '',
      FieldIndexPolicies: [],
    });
  });

  it('surfaces FieldIndexPolicies from DescribeIndexPolicies (filtered to log-group-level, JSON-parsed)', async () => {
    const policyDoc = { Fields: ['eventName', 'requestId'] };
    mockSend.mockResolvedValueOnce({
      logGroups: [
        {
          logGroupName: '/aws/lambda/my-fn',
          arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn:*',
        },
      ],
    });
    mockSend.mockResolvedValueOnce({ tags: {} });
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('No policy'), { name: 'ResourceNotFoundException' })
    );
    mockSend.mockResolvedValueOnce({
      indexPolicies: [
        // Account-level policy — filtered out (inherited, not user-templated on this log group).
        {
          source: 'ACCOUNT',
          policyDocument: JSON.stringify({ Fields: ['ignored'] }),
        },
        // Log-group-level — surfaced.
        {
          source: 'LOG_GROUP',
          policyDocument: JSON.stringify(policyDoc),
        },
      ],
    });

    const result = await provider.readCurrentState(
      '/aws/lambda/my-fn',
      'Logical',
      'AWS::Logs::LogGroup'
    );
    expect(result?.FieldIndexPolicies).toEqual([policyDoc]);
  });

  it('surfaces parsed DataProtectionPolicy when GetDataProtectionPolicy succeeds', async () => {
    const policyDoc = {
      Name: 'pii-policy',
      Description: 'Mask PII',
      Version: '2021-06-01',
      Statement: [
        {
          Sid: 'audit',
          DataIdentifier: ['arn:aws:dataprotection::aws:data-identifier/EmailAddress'],
          Operation: { Audit: { FindingsDestination: {} } },
        },
      ],
    };
    mockSend.mockResolvedValueOnce({
      logGroups: [
        {
          logGroupName: '/aws/lambda/my-fn',
          arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn:*',
        },
      ],
    });
    mockSend.mockResolvedValueOnce({ tags: {} });
    mockSend.mockResolvedValueOnce({ policyDocument: JSON.stringify(policyDoc) });
    mockSend.mockResolvedValueOnce({ indexPolicies: [] });

    const result = await provider.readCurrentState(
      '/aws/lambda/my-fn',
      'Logical',
      'AWS::Logs::LogGroup'
    );

    expect(result?.DataProtectionPolicy).toEqual(policyDoc);
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      logGroups: [
        {
          logGroupName: '/aws/lambda/my-fn',
          arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn:*',
        },
      ],
    });
    mockSend.mockResolvedValueOnce({
      tags: { Foo: 'Bar', 'aws:cdk:path': 'MyStack/MyLogGroup/Resource' },
    });
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('No policy'), { name: 'ResourceNotFoundException' })
    );
    mockSend.mockResolvedValueOnce({ indexPolicies: [] });

    const result = await provider.readCurrentState(
      '/aws/lambda/my-fn',
      'Logical',
      'AWS::Logs::LogGroup'
    );
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('emits Tags=[] when ListTagsForResource returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      logGroups: [
        {
          logGroupName: '/aws/lambda/my-fn',
          arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn:*',
        },
      ],
    });
    mockSend.mockResolvedValueOnce({
      tags: { 'aws:cdk:path': 'MyStack/MyLogGroup/Resource' },
    });
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('No policy'), { name: 'ResourceNotFoundException' })
    );
    mockSend.mockResolvedValueOnce({ indexPolicies: [] });

    const result = await provider.readCurrentState(
      '/aws/lambda/my-fn',
      'Logical',
      'AWS::Logs::LogGroup'
    );
    expect(result?.Tags).toEqual([]);
  });

  it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
    // Mandatory always-emit test per docs/provider-development.md § 3b.
    // Required field only (logGroupName + arn) — every optional
    // undefined. Keys must include the placeholder defaults so a
    // console-side change to a previously-default field surfaces as
    // drift on the v3 observedProperties baseline.
    mockSend.mockResolvedValueOnce({
      logGroups: [
        {
          logGroupName: '/aws/lambda/min',
          arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/min:*',
          // Everything else undefined: kmsKeyId, retentionInDays,
          // logGroupClass.
        },
      ],
    });
    mockSend.mockResolvedValueOnce({ tags: {} });
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('No policy'), { name: 'ResourceNotFoundException' })
    );
    mockSend.mockResolvedValueOnce({ indexPolicies: [] });

    const result = await provider.readCurrentState(
      '/aws/lambda/min',
      'Logical',
      'AWS::Logs::LogGroup'
    );

    // LogGroupClass is immutable on create — skip emit is correct
    // (per the § 3b "immutable on create" rule).
    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'LogGroupName',
        'KmsKeyId',
        'RetentionInDays',
        'Tags',
        'DataProtectionPolicy',
        'DeletionProtectionEnabled',
        'BearerTokenAuthenticationEnabled',
        'FieldIndexPolicies',
      ].sort()
    );
    expect(result?.LogGroupName).toBe('/aws/lambda/min');
    expect(result?.KmsKeyId).toBe(''); // string placeholder
    expect(result?.RetentionInDays).toBe(0); // semantic "never expire"
    expect(result?.DataProtectionPolicy).toBe(''); // string placeholder
    expect(result?.Tags).toEqual([]); // array placeholder
    expect(result?.DeletionProtectionEnabled).toBe(false);
    expect(result?.BearerTokenAuthenticationEnabled).toBe(false);
    expect(result?.FieldIndexPolicies).toEqual([]);
  });

  it('returns undefined when log group does not exist (no exact match)', async () => {
    // logGroupNamePrefix can return matching-prefix log groups; the impl
    // narrows to exact name. Simulate "no exact match" via empty list.
    mockSend.mockResolvedValueOnce({ logGroups: [] });

    const result = await provider.readCurrentState(
      '/aws/lambda/missing',
      'Logical',
      'AWS::Logs::LogGroup'
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when DescribeLogGroups throws ResourceNotFoundException', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      '/aws/lambda/missing',
      'Logical',
      'AWS::Logs::LogGroup'
    );
    expect(result).toBeUndefined();
  });
});

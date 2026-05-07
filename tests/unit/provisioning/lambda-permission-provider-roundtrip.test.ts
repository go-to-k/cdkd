import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AddPermissionCommand, RemovePermissionCommand } from '@aws-sdk/client-lambda';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';

const PHYSICAL_ID = 'AllowSnsInvoke';

describe('LambdaPermissionProvider read-update round-trip', () => {
  let provider: LambdaPermissionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: RemovePermission and AddPermission both succeed.
    mockSend.mockResolvedValue({});
    provider = new LambdaPermissionProvider();
  });

  it('round-trip on state==AWS produces exactly one Remove + one Add (remove+add design contract)', async () => {
    // Lambda Permission's update() is structurally remove+add (no in-place
    // UpdatePermission API). Unlike diff-based providers (SNS / SQS), state ==
    // AWS does NOT yield zero SDK calls — it yields exactly one remove and
    // one add. This test pins that contract so a future "skip if no diff"
    // optimization can't silently regress drift --revert correctness.
    const observed = {
      FunctionName: 'my-function',
      Action: 'lambda:InvokeFunction',
      Principal: 'sns.amazonaws.com',
      SourceArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
    };

    await provider.update(
      'AllowSnsInvoke',
      PHYSICAL_ID,
      'AWS::Lambda::Permission',
      observed,
      observed
    );

    const removeCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] instanceof RemovePermissionCommand
    );
    const addCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] instanceof AddPermissionCommand
    );
    expect(removeCalls).toHaveLength(1);
    expect(addCalls).toHaveLength(1);
  });

  it('Class 2 guard — permission with no SourceArn/SourceAccount/PrincipalOrgID/EventSourceToken does NOT send empty-string conditions to AWS', async () => {
    // The Class 2 bug class: readCurrentState's optional condition fields
    // (SourceArn / SourceAccount / PrincipalOrgID / EventSourceToken) must
    // not surface as empty-string placeholders that the write layer then
    // forwards to AddPermission. AWS rejects empty SourceArn with a
    // ValidationException; if a future readCurrentState change ever
    // started always-emitting these as '', drift --revert would crash.
    //
    // readCurrentState today only emits these keys when the policy
    // statement actually has them — verified in the dedicated
    // readCurrentState test file. This round-trip test is the structural
    // guard against a regression in either layer.
    const observed = {
      FunctionName: 'my-function',
      Action: 'lambda:InvokeFunction',
      Principal: '*',
      // No SourceArn, SourceAccount, PrincipalOrgID, EventSourceToken.
    };

    await provider.update('AllowAny', PHYSICAL_ID, 'AWS::Lambda::Permission', observed, observed);

    const addCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] instanceof AddPermissionCommand
    );
    expect(addCalls).toHaveLength(1);
    const firstAdd = addCalls[0] as [AddPermissionCommand];
    const input = firstAdd[0].input as Record<string, unknown>;
    // Optional fields must be entirely absent — not '' / null / undefined-as-key.
    expect(input).not.toHaveProperty('SourceArn');
    expect(input).not.toHaveProperty('SourceAccount');
    expect(input).not.toHaveProperty('PrincipalOrgID');
    expect(input).not.toHaveProperty('EventSourceToken');
    expect(input).not.toHaveProperty('FunctionUrlAuthType');
    // Required fields must be present and correctly populated.
    expect(input['FunctionName']).toBe('my-function');
    expect(input['Action']).toBe('lambda:InvokeFunction');
    expect(input['Principal']).toBe('*');
  });

  it('round-trip with full optional fields preserves them on AddPermission', async () => {
    // Complement to the Class 2 guard: when readCurrentState legitimately
    // emits SourceArn / SourceAccount, the round-trip must forward them
    // unchanged so AWS rebuilds the same statement.
    const observed = {
      FunctionName: 'my-function',
      Action: 'lambda:InvokeFunction',
      Principal: 's3.amazonaws.com',
      SourceArn: 'arn:aws:s3:::my-bucket',
      SourceAccount: '123456789012',
    };

    await provider.update('AllowS3', PHYSICAL_ID, 'AWS::Lambda::Permission', observed, observed);

    const addCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] instanceof AddPermissionCommand
    );
    expect(addCalls).toHaveLength(1);
    const firstAdd = addCalls[0] as [AddPermissionCommand];
    const input = firstAdd[0].input as Record<string, unknown>;
    expect(input['SourceArn']).toBe('arn:aws:s3:::my-bucket');
    expect(input['SourceAccount']).toBe('123456789012');
    expect(input['Principal']).toBe('s3.amazonaws.com');
  });
});

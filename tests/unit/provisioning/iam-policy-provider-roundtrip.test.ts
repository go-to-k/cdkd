import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PutRolePolicyCommand,
  PutGroupPolicyCommand,
  PutUserPolicyCommand,
  DeleteRolePolicyCommand,
  DeleteGroupPolicyCommand,
  DeleteUserPolicyCommand,
} from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';

const RESOURCE_TYPE = 'AWS::IAM::Policy';
const PHYSICAL_ID = 'my-policy';

describe('IAMPolicyProvider read-update round-trip', () => {
  let provider: IAMPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new IAMPolicyProvider();
  });

  it('round-trip on no-drift snapshot does not emit AWS-rejection-shaped inputs (Roles target)', async () => {
    // Mechanical guard for the read-update round-trip per
    // docs/provider-development.md § 3b. AWS::IAM::Policy is an inline
    // policy attached via PutRolePolicy / PutGroupPolicy / PutUserPolicy.
    // The observed snapshot readCurrentState produces echoes back the
    // state-recorded target lists plus the AWS-current PolicyDocument
    // and PolicyName. When --revert round-trips that snapshot back
    // through update():
    //   - PolicyDocument is always non-empty (early return guards it)
    //   - Roles / Groups / Users come from state, not AWS, so an "AWS
    //     minimum response" cannot empty them out as a placeholder
    //   - No Class 1 (no type-discriminator-dependent fields exist)
    //   - No Class 2 (no `?? {}` / `?? []` placeholders that AWS would
    //     reject as structurally incomplete)
    //
    // The remaining failure mode worth guarding mechanically: the
    // PolicyDocument shipped to PutRolePolicy must be the JSON string
    // form (not the parsed-object form readCurrentState returns), and
    // no Delete*Policy call should fire on a no-drift round-trip
    // (would orphan the inline policy on AWS).
    const policyDoc = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
    };
    const observed = {
      PolicyName: 'my-policy',
      PolicyDocument: policyDoc,
      Roles: ['my-role'],
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    // Exactly one PutRolePolicy call (the idempotent re-attach). No
    // Group/User Put, no Delete* of any kind on a no-drift round-trip.
    const putRoleCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutRolePolicyCommand
    );
    expect(putRoleCalls).toHaveLength(1);
    const putInput = putRoleCalls[0]?.[0].input as {
      RoleName: string;
      PolicyName: string;
      PolicyDocument: unknown;
    };
    expect(putInput.RoleName).toBe('my-role');
    expect(putInput.PolicyName).toBe('my-policy');
    // PolicyDocument MUST be a JSON string — IAM rejects an object.
    expect(typeof putInput.PolicyDocument).toBe('string');
    expect(JSON.parse(putInput.PolicyDocument as string)).toEqual(policyDoc);

    // No Group / User puts.
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof PutGroupPolicyCommand)
    ).toHaveLength(0);
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof PutUserPolicyCommand)
    ).toHaveLength(0);

    // No Delete* on a no-drift round-trip — would silently orphan the
    // inline policy on AWS while drift --revert reports success.
    expect(
      mockSend.mock.calls.filter(
        (c) =>
          c[0] instanceof DeleteRolePolicyCommand ||
          c[0] instanceof DeleteGroupPolicyCommand ||
          c[0] instanceof DeleteUserPolicyCommand
      )
    ).toHaveLength(0);
  });

  it('round-trip with Groups target uses PutGroupPolicy, no Delete*', async () => {
    const policyDoc = { Version: '2012-10-17', Statement: [] };
    const observed = {
      PolicyName: 'my-policy',
      PolicyDocument: policyDoc,
      Groups: ['my-group'],
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    const putGroupCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutGroupPolicyCommand
    );
    expect(putGroupCalls).toHaveLength(1);
    const input = putGroupCalls[0]?.[0].input as {
      GroupName: string;
      PolicyDocument: unknown;
    };
    expect(input.GroupName).toBe('my-group');
    expect(typeof input.PolicyDocument).toBe('string');

    expect(
      mockSend.mock.calls.filter(
        (c) =>
          c[0] instanceof DeleteRolePolicyCommand ||
          c[0] instanceof DeleteGroupPolicyCommand ||
          c[0] instanceof DeleteUserPolicyCommand
      )
    ).toHaveLength(0);
  });

  it('round-trip with Users target uses PutUserPolicy, no Delete*', async () => {
    const policyDoc = { Version: '2012-10-17', Statement: [] };
    const observed = {
      PolicyName: 'my-policy',
      PolicyDocument: policyDoc,
      Users: ['my-user'],
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    const putUserCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutUserPolicyCommand
    );
    expect(putUserCalls).toHaveLength(1);
    const input = putUserCalls[0]?.[0].input as {
      UserName: string;
      PolicyDocument: unknown;
    };
    expect(input.UserName).toBe('my-user');
    expect(typeof input.PolicyDocument).toBe('string');

    expect(
      mockSend.mock.calls.filter(
        (c) =>
          c[0] instanceof DeleteRolePolicyCommand ||
          c[0] instanceof DeleteGroupPolicyCommand ||
          c[0] instanceof DeleteUserPolicyCommand
      )
    ).toHaveLength(0);
  });

  it('PolicyDocument string form survives round-trip without double-encoding', async () => {
    // Defensive: if a user happens to record PolicyDocument in state as
    // a string (rare but allowed by `typeof policyDocument === 'string'`
    // in create/update), the round-trip must not double-stringify it
    // (`"\"{\\\"Version\\\"...\""`) on its way back to AWS.
    const policyDocStr = JSON.stringify({ Version: '2012-10-17', Statement: [] });
    const observed = {
      PolicyName: 'my-policy',
      PolicyDocument: policyDocStr,
      Roles: ['my-role'],
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutRolePolicyCommand
    );
    const input = putCall?.[0].input as { PolicyDocument: unknown };
    // Should equal the original string, not JSON.stringify(originalString).
    expect(input.PolicyDocument).toBe(policyDocStr);
  });
});

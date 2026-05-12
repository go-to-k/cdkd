import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateLogGroupCommand,
  DeleteIndexPolicyCommand,
  PutBearerTokenAuthenticationCommand,
  PutIndexPolicyCommand,
  PutLogGroupDeletionProtectionCommand,
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

  // ---------------------------------------------------------------
  // DeletionProtectionEnabled round-trip
  // ---------------------------------------------------------------

  it('create() forwards DeletionProtectionEnabled=true on CreateLogGroup', async () => {
    mockSend.mockResolvedValue({});
    await provider.create('L', RESOURCE_TYPE, {
      LogGroupName: PHYSICAL_ID,
      DeletionProtectionEnabled: true,
    });
    const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateLogGroupCommand);
    expect(createCall).toBeDefined();
    const input = createCall?.[0].input as { deletionProtectionEnabled?: boolean };
    expect(input.deletionProtectionEnabled).toBe(true);
  });

  it('update from undefined -> true routes to PutLogGroupDeletionProtection(true)', async () => {
    const oldProps = { LogGroupName: PHYSICAL_ID };
    const newProps = { LogGroupName: PHYSICAL_ID, DeletionProtectionEnabled: true };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);
    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutLogGroupDeletionProtectionCommand
    );
    expect(call).toBeDefined();
    const input = call?.[0].input as { deletionProtectionEnabled: boolean };
    expect(input.deletionProtectionEnabled).toBe(true);
  });

  it('update from true -> false routes to PutLogGroupDeletionProtection(false)', async () => {
    const oldProps = { LogGroupName: PHYSICAL_ID, DeletionProtectionEnabled: true };
    const newProps = { LogGroupName: PHYSICAL_ID, DeletionProtectionEnabled: false };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);
    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutLogGroupDeletionProtectionCommand
    );
    expect(call).toBeDefined();
    const input = call?.[0].input as { deletionProtectionEnabled: boolean };
    expect(input.deletionProtectionEnabled).toBe(false);
  });

  it('update from true -> undefined disables (round-trip lands at AWS-side default false)', async () => {
    const oldProps = { LogGroupName: PHYSICAL_ID, DeletionProtectionEnabled: true };
    const newProps = { LogGroupName: PHYSICAL_ID };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);
    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutLogGroupDeletionProtectionCommand
    );
    expect(call).toBeDefined();
    const input = call?.[0].input as { deletionProtectionEnabled: boolean };
    expect(input.deletionProtectionEnabled).toBe(false);
  });

  it('update with unchanged DeletionProtectionEnabled value is a no-op', async () => {
    const same = { LogGroupName: PHYSICAL_ID, DeletionProtectionEnabled: true };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, same, same);
    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutLogGroupDeletionProtectionCommand
    );
    expect(call).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // BearerTokenAuthenticationEnabled round-trip
  // ---------------------------------------------------------------

  it('create() with BearerTokenAuthenticationEnabled=true issues a separate PutBearerTokenAuthentication call', async () => {
    // BearerTokenAuthenticationEnabled is NOT part of CreateLogGroupRequest;
    // it must be applied via a separate PutBearerTokenAuthentication call
    // after the log group exists.
    mockSend.mockResolvedValue({});
    await provider.create('L', RESOURCE_TYPE, {
      LogGroupName: PHYSICAL_ID,
      BearerTokenAuthenticationEnabled: true,
    });
    const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateLogGroupCommand);
    expect(createCall).toBeDefined();
    const createInput = createCall?.[0].input as {
      bearerTokenAuthenticationEnabled?: boolean;
    };
    // CreateLogGroupRequest has no such field — input must NOT include it.
    expect(createInput.bearerTokenAuthenticationEnabled).toBeUndefined();

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutBearerTokenAuthenticationCommand
    );
    expect(putCall).toBeDefined();
    const putInput = putCall?.[0].input as {
      logGroupIdentifier: string;
      bearerTokenAuthenticationEnabled: boolean;
    };
    expect(putInput.logGroupIdentifier).toBe(PHYSICAL_ID);
    expect(putInput.bearerTokenAuthenticationEnabled).toBe(true);
  });

  it('update from undefined -> true on BearerTokenAuthenticationEnabled fires PutBearerTokenAuthentication', async () => {
    const oldProps = { LogGroupName: PHYSICAL_ID };
    const newProps = { LogGroupName: PHYSICAL_ID, BearerTokenAuthenticationEnabled: true };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);
    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutBearerTokenAuthenticationCommand
    );
    expect(call).toBeDefined();
    const input = call?.[0].input as { bearerTokenAuthenticationEnabled: boolean };
    expect(input.bearerTokenAuthenticationEnabled).toBe(true);
  });

  it('update from true -> false on BearerTokenAuthenticationEnabled fires PutBearerTokenAuthentication(false)', async () => {
    const oldProps = { LogGroupName: PHYSICAL_ID, BearerTokenAuthenticationEnabled: true };
    const newProps = { LogGroupName: PHYSICAL_ID, BearerTokenAuthenticationEnabled: false };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);
    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutBearerTokenAuthenticationCommand
    );
    expect(call).toBeDefined();
    const input = call?.[0].input as { bearerTokenAuthenticationEnabled: boolean };
    expect(input.bearerTokenAuthenticationEnabled).toBe(false);
  });

  it('update from true -> undefined on BearerTokenAuthenticationEnabled disables (lands at default false)', async () => {
    const oldProps = { LogGroupName: PHYSICAL_ID, BearerTokenAuthenticationEnabled: true };
    const newProps = { LogGroupName: PHYSICAL_ID };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);
    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutBearerTokenAuthenticationCommand
    );
    expect(call).toBeDefined();
    const input = call?.[0].input as { bearerTokenAuthenticationEnabled: boolean };
    expect(input.bearerTokenAuthenticationEnabled).toBe(false);
  });

  it('update with unchanged BearerTokenAuthenticationEnabled value is a no-op', async () => {
    const same = { LogGroupName: PHYSICAL_ID, BearerTokenAuthenticationEnabled: true };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, same, same);
    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutBearerTokenAuthenticationCommand
    );
    expect(call).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // FieldIndexPolicies round-trip
  // ---------------------------------------------------------------

  it('create() with a single FieldIndexPolicies entry issues PutIndexPolicy with the JSON-stringified document', async () => {
    mockSend.mockResolvedValue({});
    const policy = { Fields: ['requestId'] };
    await provider.create('L', RESOURCE_TYPE, {
      LogGroupName: PHYSICAL_ID,
      FieldIndexPolicies: [policy],
    });
    const call = mockSend.mock.calls.find((c) => c[0] instanceof PutIndexPolicyCommand);
    expect(call).toBeDefined();
    const input = call?.[0].input as { logGroupIdentifier: string; policyDocument: string };
    expect(input.logGroupIdentifier).toBe(PHYSICAL_ID);
    expect(JSON.parse(input.policyDocument)).toEqual(policy);
  });

  it('update from undefined -> [policy] fires PutIndexPolicy', async () => {
    const policy = { Fields: ['requestId'] };
    const oldProps = { LogGroupName: PHYSICAL_ID };
    const newProps = { LogGroupName: PHYSICAL_ID, FieldIndexPolicies: [policy] };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);
    const call = mockSend.mock.calls.find((c) => c[0] instanceof PutIndexPolicyCommand);
    expect(call).toBeDefined();
    const input = call?.[0].input as { policyDocument: string };
    expect(JSON.parse(input.policyDocument)).toEqual(policy);
  });

  it('update from [policyA] -> [policyB] fires PutIndexPolicy with the new document (replaces)', async () => {
    const policyA = { Fields: ['requestId'] };
    const policyB = { Fields: ['sessionId', 'userId'] };
    const oldProps = { LogGroupName: PHYSICAL_ID, FieldIndexPolicies: [policyA] };
    const newProps = { LogGroupName: PHYSICAL_ID, FieldIndexPolicies: [policyB] };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);
    const putCalls = mockSend.mock.calls.filter((c) => c[0] instanceof PutIndexPolicyCommand);
    const deleteCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DeleteIndexPolicyCommand
    );
    expect(putCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
    const input = putCalls[0]?.[0].input as { policyDocument: string };
    expect(JSON.parse(input.policyDocument)).toEqual(policyB);
  });

  it('update from [policy] -> [] fires DeleteIndexPolicy', async () => {
    const policy = { Fields: ['requestId'] };
    const oldProps = { LogGroupName: PHYSICAL_ID, FieldIndexPolicies: [policy] };
    const newProps = { LogGroupName: PHYSICAL_ID, FieldIndexPolicies: [] };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);
    const deleteCall = mockSend.mock.calls.find((c) => c[0] instanceof DeleteIndexPolicyCommand);
    expect(deleteCall).toBeDefined();
    const input = deleteCall?.[0].input as { logGroupIdentifier: string };
    expect(input.logGroupIdentifier).toBe(PHYSICAL_ID);
  });

  it('update with unchanged FieldIndexPolicies is a no-op (no PutIndexPolicy / DeleteIndexPolicy)', async () => {
    const policy = { Fields: ['requestId'] };
    const same = { LogGroupName: PHYSICAL_ID, FieldIndexPolicies: [policy] };
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, same, same);
    const putCalls = mockSend.mock.calls.filter((c) => c[0] instanceof PutIndexPolicyCommand);
    const deleteCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DeleteIndexPolicyCommand
    );
    expect(putCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
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

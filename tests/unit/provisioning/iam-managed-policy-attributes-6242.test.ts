import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetPolicyCommand } from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';

/**
 * go-to-k/cdkd#6242: a managed policy also records `AttachmentCount`,
 * `PermissionsBoundaryUsageCount`, `IsAttachable`, `CreateDate` and
 * `UpdateDate` from IAM's `Policy`, as of the END of the operation: CREATE
 * answers `AttachmentCount: 0` before this create attaches the policy to a
 * role, so an attaching create re-reads it (real CloudFormation answered 1
 * with one role attached, 2026-11-14).
 */
const ARN = 'arn:aws:iam::123456789012:policy/MyManagedPolicy';
const DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};
const CREATED = new Date('2026-11-14T07:49:22Z');
const LATER = new Date('2026-11-14T08:00:05Z');
const policy = (over: Record<string, unknown> = {}) => ({
  Arn: ARN,
  PolicyId: 'ANPAEXAMPLE',
  DefaultVersionId: 'v1',
  AttachmentCount: 0,
  PermissionsBoundaryUsageCount: 0,
  IsAttachable: true,
  CreateDate: CREATED,
  UpdateDate: CREATED,
  ...over,
});
/** A record written after this change: every key present. */
const FULL_RECORD = {
  PolicyArn: ARN,
  PolicyId: 'ANPAEXAMPLE',
  DefaultVersionId: 'v1',
  AttachmentCount: 1,
  PermissionsBoundaryUsageCount: 0,
  IsAttachable: true,
  CreateDate: '2026-11-14T07:49:22Z',
  UpdateDate: '2026-11-14T07:49:22Z',
};
const commandsSent = (): string[] =>
  mockSend.mock.calls.map((call) => (call[0] as { constructor: { name: string } }).constructor.name);

describe('IAMManagedPolicyProvider attributes (#6242)', () => {
  let provider: IAMManagedPolicyProvider;
  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMManagedPolicyProvider();
  });

  it('create with no principals records the CreatePolicy answer, with no extra call', async () => {
    mockSend.mockResolvedValueOnce({ Policy: policy() });
    const result = await provider.create('P', 'AWS::IAM::ManagedPolicy', { PolicyDocument: DOC });
    // Numbers and a boolean keep their JSON type; dates are IAM's ISO text
    // with no `.000` (CloudFormation's `Optional[...]` text is not copied).
    expect(result.attributes).toStrictEqual({
      PolicyArn: ARN,
      PolicyId: 'ANPAEXAMPLE',
      DefaultVersionId: 'v1',
      AttachmentCount: 0,
      PermissionsBoundaryUsageCount: 0,
      IsAttachable: true,
      CreateDate: '2026-11-14T07:49:22Z',
      UpdateDate: '2026-11-14T07:49:22Z',
    });
    expect(commandsSent()).toStrictEqual(['CreatePolicyCommand']);
  });

  it('create that attaches a role records the count IAM reports AFTER the attach', async () => {
    mockSend.mockResolvedValueOnce({ Policy: policy() }); // CreatePolicy: AttachmentCount 0
    mockSend.mockResolvedValueOnce({}); // AttachRolePolicy
    mockSend.mockResolvedValueOnce({ Policy: policy({ AttachmentCount: 1 }) }); // GetPolicy
    const result = await provider.create('P', 'AWS::IAM::ManagedPolicy', {
      PolicyDocument: DOC,
      Roles: ['MyRole'],
    });
    expect(result.attributes?.['AttachmentCount']).toBe(1);
    expect(commandsSent()).toStrictEqual([
      'CreatePolicyCommand',
      'AttachRolePolicyCommand',
      'GetPolicyCommand',
    ]);
    expect((mockSend.mock.calls[2]![0] as GetPolicyCommand).input).toStrictEqual({ PolicyArn: ARN });
  });

  it('create whose re-read fails keeps the create but drops the stale count', async () => {
    mockSend.mockResolvedValueOnce({ Policy: policy() });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockRejectedValueOnce(new Error('Rate exceeded'));
    const result = await provider.create('P', 'AWS::IAM::ManagedPolicy', {
      PolicyDocument: DOC,
      Users: ['u'],
    });
    expect(result.physicalId).toBe(ARN);
    expect(result.attributes).toStrictEqual({
      PolicyArn: ARN,
      PolicyId: 'ANPAEXAMPLE',
      DefaultVersionId: 'v1',
      PermissionsBoundaryUsageCount: 0,
      IsAttachable: true,
      CreateDate: '2026-11-14T07:49:22Z',
      // An attach does not move UpdateDate (measured), so it is kept.
      UpdateDate: '2026-11-14T07:49:22Z',
    });
  });

  it('create ignores a re-read that answers for another policy', async () => {
    mockSend.mockResolvedValueOnce({ Policy: policy() });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Policy: policy({ Arn: 'arn:aws:iam::123456789012:policy/Other', AttachmentCount: 9 }),
    });
    const result = await provider.create('P', 'AWS::IAM::ManagedPolicy', {
      PolicyDocument: DOC,
      Groups: ['g'],
    });
    expect(result.attributes).not.toHaveProperty('AttachmentCount');
  });

  it('a tag-only update of a full record carries every value, with no read', async () => {
    mockSend.mockResolvedValue({}); // TagPolicy
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: DOC, Roles: ['MyRole'], Tags: [{ Key: 'k', Value: 'v' }] },
      { PolicyDocument: DOC, Roles: ['MyRole'] },
      { recordedAttributes: FULL_RECORD }
    );
    expect(result.attributes).toStrictEqual(FULL_RECORD);
    expect(commandsSent()).not.toContain('GetPolicyCommand');
  });

  it('an update that detaches a role re-reads the count', async () => {
    mockSend.mockResolvedValueOnce({}); // DetachRolePolicy
    mockSend.mockResolvedValueOnce({ Policy: policy({ AttachmentCount: 0 }) }); // GetPolicy
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: DOC },
      { PolicyDocument: DOC, Roles: ['MyRole'] },
      { recordedAttributes: FULL_RECORD }
    );
    expect(commandsSent()).toStrictEqual(['DetachRolePolicyCommand', 'GetPolicyCommand']);
    expect(result.attributes?.['AttachmentCount']).toBe(0);
  });

  it('a document change re-reads UpdateDate and the new default version', async () => {
    mockSend.mockResolvedValueOnce({ Versions: [], IsTruncated: false }); // ListPolicyVersions
    mockSend.mockResolvedValueOnce({ PolicyVersion: { VersionId: 'v2' } }); // CreatePolicyVersion
    mockSend.mockResolvedValueOnce({
      Policy: policy({ DefaultVersionId: 'v2', AttachmentCount: 1, UpdateDate: LATER }),
    });
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: { ...DOC, Statement: [...DOC.Statement, { Sid: 'x' }] } },
      { PolicyDocument: DOC },
      { recordedAttributes: FULL_RECORD }
    );
    expect(result.attributes).toStrictEqual({
      ...FULL_RECORD,
      DefaultVersionId: 'v2',
      UpdateDate: '2026-11-14T08:00:05Z',
    });
  });

  it('a no-op update of a record written before #6242 re-reads once and fills it', async () => {
    mockSend.mockResolvedValueOnce({ Policy: policy({ AttachmentCount: 2 }) });
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: DOC },
      { PolicyDocument: DOC },
      { recordedAttributes: { PolicyArn: ARN, PolicyId: 'ANPAEXAMPLE', DefaultVersionId: 'v1' } }
    );
    expect(commandsSent()).toStrictEqual(['GetPolicyCommand']);
    expect(result.attributes).toStrictEqual({ ...FULL_RECORD, AttachmentCount: 2 });
  });

  it('a document change whose re-read fails drops only UpdateDate', async () => {
    mockSend.mockResolvedValueOnce({ Versions: [], IsTruncated: false });
    mockSend.mockResolvedValueOnce({ PolicyVersion: { VersionId: 'v2' } });
    mockSend.mockRejectedValueOnce(new Error('denied'));
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: { ...DOC, Statement: [...DOC.Statement, { Sid: 'x' }] } },
      { PolicyDocument: DOC },
      { recordedAttributes: FULL_RECORD }
    );
    const { UpdateDate: _dropped, ...rest } = FULL_RECORD;
    expect(result.attributes).toStrictEqual({ ...rest, DefaultVersionId: 'v2' });
  });

  it('never carries a recorded date that is not one (a mask)', async () => {
    mockSend.mockRejectedValueOnce(new Error('denied')); // the re-read the gap triggers
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: DOC },
      { PolicyDocument: DOC },
      { recordedAttributes: { ...FULL_RECORD, CreateDate: '***' } }
    );
    expect(result.attributes).not.toHaveProperty('CreateDate');
    expect(result.attributes?.['UpdateDate']).toBe('2026-11-14T07:49:22Z');
  });

  it('import by ARN records the full set from GetPolicy', async () => {
    mockSend.mockResolvedValueOnce({ Policy: policy({ AttachmentCount: 3 }) });
    const result = await provider.import({
      logicalId: 'P',
      resourceType: 'AWS::IAM::ManagedPolicy',
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: ARN,
    });
    expect(result?.attributes).toStrictEqual({ ...FULL_RECORD, AttachmentCount: 3 });
  });

  it('getAttribute serves the new keys from GetPolicy', async () => {
    mockSend.mockResolvedValue({ Policy: policy({ AttachmentCount: 4 }) });
    const get = (name: string) => provider.getAttribute(ARN, 'AWS::IAM::ManagedPolicy', name);
    await expect(get('AttachmentCount')).resolves.toBe(4);
    await expect(get('IsAttachable')).resolves.toBe(true);
    await expect(get('PermissionsBoundaryUsageCount')).resolves.toBe(0);
    await expect(get('CreateDate')).resolves.toBe('2026-11-14T07:49:22Z');
    await expect(get('UpdateDate')).resolves.toBe('2026-11-14T07:49:22Z');
  });
});

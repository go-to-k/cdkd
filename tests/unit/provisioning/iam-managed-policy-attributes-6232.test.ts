import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetPolicyCommand, ListPoliciesCommand } from '@aws-sdk/client-iam';

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
 * go-to-k/cdkd#6232: the provider recorded only `PolicyArn`, so
 * `Fn::GetAtt [P, PolicyId]` / `[P, DefaultVersionId]` fell back to the ARN.
 * Every writer of the record (create, update, import) now records what IAM
 * reported, and leaves a value it does not have ABSENT, never a placeholder.
 */
const ARN = 'arn:aws:iam::123456789012:policy/MyManagedPolicy';
const DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};
const commandsSent = (): string[] =>
  mockSend.mock.calls.map((call) => (call[0] as { constructor: { name: string } }).constructor.name);

describe('IAMManagedPolicyProvider attributes (#6232)', () => {
  let provider: IAMManagedPolicyProvider;
  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMManagedPolicyProvider();
  });

  it('create records PolicyId and DefaultVersionId from the CreatePolicy response', async () => {
    mockSend.mockResolvedValueOnce({
      Policy: { Arn: ARN, PolicyId: 'ANPAEXAMPLE', DefaultVersionId: 'v1' },
    });
    const result = await provider.create('P', 'AWS::IAM::ManagedPolicy', { PolicyDocument: DOC });
    expect(result.attributes).toStrictEqual({
      PolicyArn: ARN,
      PolicyId: 'ANPAEXAMPLE',
      DefaultVersionId: 'v1',
    });
  });

  it('create leaves them absent when the response omits them, never an empty string', async () => {
    mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN, PolicyId: '', DefaultVersionId: '' } });
    const result = await provider.create('P', 'AWS::IAM::ManagedPolicy', { PolicyDocument: DOC });
    expect(result.attributes).toStrictEqual({ PolicyArn: ARN });
  });

  it('update records the NEW version id after a document change, and carries the recorded PolicyId', async () => {
    mockSend.mockResolvedValueOnce({
      Versions: [{ VersionId: 'v1', IsDefaultVersion: true, CreateDate: new Date(2024, 0, 1) }],
      IsTruncated: false,
    }); // ListPolicyVersions (capacity)
    mockSend.mockResolvedValueOnce({ PolicyVersion: { VersionId: 'v2' } }); // CreatePolicyVersion
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: { ...DOC, Statement: [...DOC.Statement, { Sid: 'new' }] } },
      { PolicyDocument: DOC },
      { recordedAttributes: { PolicyArn: ARN, PolicyId: 'ANPAEXAMPLE', DefaultVersionId: 'v1' } }
    );
    expect(result.attributes).toStrictEqual({
      PolicyArn: ARN,
      PolicyId: 'ANPAEXAMPLE',
      DefaultVersionId: 'v2',
    });
    // No extra read: the values come from the response and the record.
    expect(commandsSent()).toStrictEqual(['ListPolicyVersionsCommand', 'CreatePolicyVersionCommand']);
  });

  it('update with no document change keeps the recorded DefaultVersionId', async () => {
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: DOC, Description: 'same' },
      { PolicyDocument: DOC, Description: 'same' },
      { recordedAttributes: { PolicyArn: ARN, PolicyId: 'ANPAEXAMPLE', DefaultVersionId: 'v3' } }
    );
    expect(result.attributes).toStrictEqual({
      PolicyArn: ARN,
      PolicyId: 'ANPAEXAMPLE',
      DefaultVersionId: 'v3',
    });
  });

  it('update never carries a redacted or missing recorded value', async () => {
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: DOC },
      { PolicyDocument: DOC },
      { recordedAttributes: { PolicyArn: ARN, PolicyId: '***' } }
    );
    expect(result.attributes).toStrictEqual({ PolicyArn: ARN });
  });

  it('update never carries an id the state redaction spliced a dynamic reference into', async () => {
    const result = await provider.update(
      'MyManagedPolicy',
      ARN,
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: DOC },
      { PolicyDocument: DOC },
      {
        recordedAttributes: {
          PolicyArn: ARN,
          PolicyId: 'ANPA{{resolve:secretsmanager:s}}XYZ',
          DefaultVersionId: 'v{{resolve:ssm:p}}',
        },
      }
    );
    expect(result.attributes).toStrictEqual({ PolicyArn: ARN });
  });

  it('import by ARN records what GetPolicy reports', async () => {
    mockSend.mockResolvedValueOnce({
      Policy: { Arn: ARN, PolicyId: 'ANPAEXAMPLE', DefaultVersionId: 'v4' },
    });
    const result = await provider.import({
      logicalId: 'P',
      resourceType: 'AWS::IAM::ManagedPolicy',
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: ARN,
    });
    expect(result).toStrictEqual({
      physicalId: ARN,
      attributes: { PolicyArn: ARN, PolicyId: 'ANPAEXAMPLE', DefaultVersionId: 'v4' },
    });
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(GetPolicyCommand);
  });

  it('import by name records them from the ListPolicies entry, with no extra call', async () => {
    mockSend.mockResolvedValueOnce({
      Policies: [
        { PolicyName: 'Other', Arn: 'arn:aws:iam::123456789012:policy/Other' },
        { PolicyName: 'MyManagedPolicy', Arn: ARN, PolicyId: 'ANPAEXAMPLE', DefaultVersionId: 'v5' },
      ],
      IsTruncated: false,
    });
    const result = await provider.import({
      logicalId: 'P',
      resourceType: 'AWS::IAM::ManagedPolicy',
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'MyManagedPolicy',
    });
    expect(result).toStrictEqual({
      physicalId: ARN,
      attributes: { PolicyArn: ARN, PolicyId: 'ANPAEXAMPLE', DefaultVersionId: 'v5' },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(ListPoliciesCommand);
  });

  it('getAttribute serves PolicyId / DefaultVersionId from GetPolicy', async () => {
    mockSend.mockResolvedValue({
      Policy: { Arn: ARN, PolicyId: 'ANPAEXAMPLE', DefaultVersionId: 'v6' },
    });
    await expect(provider.getAttribute(ARN, 'AWS::IAM::ManagedPolicy', 'PolicyId')).resolves.toBe(
      'ANPAEXAMPLE'
    );
    await expect(
      provider.getAttribute(ARN, 'AWS::IAM::ManagedPolicy', 'DefaultVersionId')
    ).resolves.toBe('v6');
    await expect(provider.getAttribute(ARN, 'AWS::IAM::ManagedPolicy', 'PolicyArn')).resolves.toBe(
      ARN
    );
  });
});

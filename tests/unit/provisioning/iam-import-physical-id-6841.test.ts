/**
 * go-to-k/cdkd#6841: an import is handed CloudFormation's `PhysicalResourceId`
 * by `--migrate-from-cloudformation` / auto mode, and for an inline
 * `AWS::IAM::Policy` that is a generated id naming no IAM object. The record
 * must carry the id cdkd's own `create()` records — the `PolicyName` — or the
 * first `cdkd drift` reports the policy DELETED. The class sweep found
 * `AWS::IAM::UserToGroupAddition` taking the handed id verbatim too, where
 * `create()` records the logical id.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';

const CFN_ID = 'main--Cover-LxKVLoikcQa9';

function policyInput(properties: Record<string, unknown>, knownPhysicalId?: string) {
  return {
    logicalId: 'CoverageAuditRoleDefaultPolicy8A0E635C',
    resourceType: 'AWS::IAM::Policy',
    stackName: 'main',
    region: 'us-east-1',
    properties,
    ...(knownPhysicalId !== undefined && { knownPhysicalId }),
  };
}

describe('AWS::IAM::Policy import records the PolicyName (#6841)', () => {
  const document = { Version: '2012-10-17', Statement: [] };

  it("records the template's PolicyName, not CloudFormation's generated id", async () => {
    const result = await new IAMPolicyProvider().import(
      policyInput(
        {
          PolicyName: 'CoverageAuditRoleDefaultPolicy8A0E635C',
          PolicyDocument: document,
          Roles: ['role-a'],
        },
        CFN_ID
      )
    );
    expect(result).toEqual({ physicalId: 'CoverageAuditRoleDefaultPolicy8A0E635C', attributes: {} });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps the handed id when it already is the PolicyName', async () => {
    const result = await new IAMPolicyProvider().import(
      policyInput({ PolicyName: 'P1', PolicyDocument: document, Roles: ['r'] }, 'P1')
    );
    expect(result?.physicalId).toBe('P1');
  });

  it.each([
    ['an unresolved intrinsic', { 'Fn::Join': ['', ['a', 'b']] }],
    ['a dynamic reference', '{{resolve:ssm:/policy/name}}'],
    ['an empty string', ''],
    ['an absent key', undefined],
  ])('keeps the handed id when PolicyName is %s', async (_label, policyName) => {
    const properties: Record<string, unknown> = { PolicyDocument: document, Roles: ['r'] };
    if (policyName !== undefined) properties['PolicyName'] = policyName;
    const result = await new IAMPolicyProvider().import(policyInput(properties, CFN_ID));
    expect(result?.physicalId).toBe(CFN_ID);
  });

  it('still finds nothing without a handed id', async () => {
    const result = await new IAMPolicyProvider().import(
      policyInput({ PolicyName: 'P1', PolicyDocument: document, Roles: ['r'] })
    );
    expect(result).toBeNull();
  });
});

describe('AWS::IAM::UserToGroupAddition import records the logical id (#6841 class sweep)', () => {
  const input = {
    logicalId: 'AddUsers',
    resourceType: 'AWS::IAM::UserToGroupAddition',
    stackName: 'main',
    region: 'us-east-1',
    properties: { GroupName: 'g', Users: ['u'] },
  };

  it("records the logical id create() records, not CloudFormation's id", async () => {
    const result = await new IAMUserGroupProvider().import({
      ...input,
      knownPhysicalId: 'main-AddUsers-1ABCDEFGHIJK',
    });
    expect(result).toEqual({ physicalId: 'AddUsers', attributes: {} });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('still finds nothing without a handed id', async () => {
    expect(await new IAMUserGroupProvider().import(input)).toBeNull();
  });
});

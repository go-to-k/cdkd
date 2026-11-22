/**
 * go-to-k/cdkd#6841: an import is handed CloudFormation's `PhysicalResourceId`
 * by `--migrate-from-cloudformation` / auto mode, and for an inline
 * `AWS::IAM::Policy` that is a generated id naming no IAM object. The record
 * must carry the id cdkd's own `create()` records — the `PolicyName` — or the
 * first `cdkd drift` reports the policy DELETED.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';

const CFN_ID = 'main--Cover-LxKVLoikcQa9';

function policyInput(
  properties: Record<string, unknown>,
  knownPhysicalId?: string,
  fromCloudFormation = true
) {
  return {
    logicalId: 'CoverageAuditRoleDefaultPolicy8A0E635C',
    resourceType: 'AWS::IAM::Policy',
    stackName: 'main',
    region: 'us-east-1',
    properties,
    ...(knownPhysicalId !== undefined && { knownPhysicalId }),
    ...(knownPhysicalId !== undefined &&
      fromCloudFormation && { knownPhysicalIdFromCloudFormation: true }),
  };
}

describe('AWS::IAM::Policy import records the PolicyName (#6841)', () => {
  const document = { Version: '2012-10-17', Statement: [] };
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("records the PolicyName, not CloudFormation's generated id, once a listed role holds it", async () => {
    mockSend.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'GetRolePolicyCommand' && command.input['RoleName'] === 'role-b') {
        return { PolicyDocument: encodeURIComponent(JSON.stringify(document)) };
      }
      throw new NoSuchEntityException({ message: 'not found', $metadata: {} });
    });
    const result = await new IAMPolicyProvider().import(
      policyInput(
        {
          PolicyName: 'CoverageAuditRoleDefaultPolicy8A0E635C',
          PolicyDocument: document,
          Roles: ['role-a', 'role-b'],
        },
        CFN_ID
      )
    );
    expect(result).toEqual({ physicalId: 'CoverageAuditRoleDefaultPolicy8A0E635C', attributes: {} });
    const asked = mockSend.mock.calls.map((c) => (c[0] as { input: Record<string, unknown> }).input);
    expect(asked).toEqual([
      { RoleName: 'role-a', PolicyName: 'CoverageAuditRoleDefaultPolicy8A0E635C' },
      { RoleName: 'role-b', PolicyName: 'CoverageAuditRoleDefaultPolicy8A0E635C' },
    ]);
  });

  it.each([
    ['no listed principal holds it', () => {
      throw new NoSuchEntityException({ message: 'not found', $metadata: {} });
    }],
    ['the lookup fails', () => {
      const denied = new Error('User is not authorized to perform: iam:GetRolePolicy');
      denied.name = 'AccessDenied';
      throw denied;
    }],
  ])("keeps CloudFormation's id, and warns naming the logical id only, when %s", async (_label, answer) => {
    mockSend.mockImplementation(async () => answer());
    const provider = new IAMPolicyProvider();
    const warn = vi.spyOn(provider.logger, 'warn').mockImplementation(() => undefined);
    const result = await provider.import(
      policyInput(
        { PolicyName: 'RenamedInCode', PolicyDocument: document, Roles: ['role-a'], Users: ['u'] },
        CFN_ID
      )
    );
    expect(result?.physicalId).toBe(CFN_ID);
    const warned = warn.mock.calls.flat().join(' ');
    expect(warned).toContain('CoverageAuditRoleDefaultPolicy8A0E635C');
    expect(warned).not.toContain('RenamedInCode');
    expect(warned).not.toContain('role-a');
  });

  it("keeps CloudFormation's id when the principal list cannot be read", async () => {
    const result = await new IAMPolicyProvider().import(
      policyInput({ PolicyName: 'P1', PolicyDocument: document, Roles: [{ Ref: 'Gone' }] }, CFN_ID)
    );
    expect(result?.physicalId).toBe(CFN_ID);
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
    ['not an IAM policy name (a `:` delete would split as policy:role)', 'a:victimRole'],
    ['an absent key', undefined],
  ])('keeps the handed id when PolicyName is %s', async (_label, policyName) => {
    const properties: Record<string, unknown> = { PolicyDocument: document, Roles: ['r'] };
    if (policyName !== undefined) properties['PolicyName'] = policyName;
    const result = await new IAMPolicyProvider().import(policyInput(properties, CFN_ID));
    expect(result?.physicalId).toBe(CFN_ID);
  });

  it('keeps an id the OPERATOR passed with --resource, whatever the template names', async () => {
    const result = await new IAMPolicyProvider().import(
      policyInput({ PolicyName: 'P1', PolicyDocument: document, Roles: ['r'] }, 'legacy-name', false)
    );
    expect(result?.physicalId).toBe('legacy-name');
  });

  it('still finds nothing without a handed id', async () => {
    const result = await new IAMPolicyProvider().import(
      policyInput({ PolicyName: 'P1', PolicyDocument: document, Roles: ['r'] })
    );
    expect(result).toBeNull();
  });
});

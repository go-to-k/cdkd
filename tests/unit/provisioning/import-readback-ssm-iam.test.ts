import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSsmSend = vi.fn();
const mockIamSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSsmSend, config: { region: () => Promise.resolve('us-east-1') } },
    iam: { send: mockIamSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn().mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/t' }),
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';

/**
 * Issue #3627: these `import()`s returned less than `create()` records, so
 * after `cdkd import` a sibling's `Fn::GetAtt` resolved wrong:
 *  - SSM Parameter `Type` / `Value` → the parameter NAME;
 *  - IAM InstanceProfile / User / Group `Arn` under a non-`/` `Path` → a
 *    path-less ARN the resolver builds from the name, silently.
 */
const input = (resourceType: string, knownPhysicalId: string) => ({
  logicalId: 'X',
  resourceType,
  stackName: 'S',
  region: 'us-east-1',
  properties: {},
  knownPhysicalId,
});

describe('import() read-back (issue #3627)', () => {
  beforeEach(() => {
    mockSsmSend.mockReset();
    mockIamSend.mockReset();
  });

  it('SSM Parameter records Type / Value / Arn from GetParameter', async () => {
    mockSsmSend.mockResolvedValueOnce({
      Parameter: {
        Name: 'my-param',
        Type: 'StringList',
        Value: 'a,b',
        ARN: 'arn:aws:ssm:us-east-1:123456789012:parameter/my-param',
      },
    });
    const result = await new SSMParameterProvider().import({
      ...input('AWS::SSM::Parameter', 'my-param'),
      properties: { Type: 'StringList', Value: 'a,b' },
    });
    // Never decrypted: a SecureString adopted via `--resource` yields ciphertext.
    expect(mockSsmSend.mock.calls[0]![0].input.WithDecryption).toBeFalsy();
    expect(result).toStrictEqual({
      physicalId: 'my-param',
      attributes: {
        Type: 'StringList',
        Value: 'a,b',
        Arn: 'arn:aws:ssm:us-east-1:123456789012:parameter/my-param',
      },
    });
  });

  // A dynamic reference or a `Ref` (e.g. to a NoEcho parameter) puts a
  // plaintext in the parameter that no needle on the import / heal path
  // covers, so `Value` is recorded only for a literal.
  it.each([
    ['a {{resolve:...}} dynamic reference', '{{resolve:secretsmanager:db:SecretString:password}}'],
    ['a Ref to a parameter', { Ref: 'DbPassword' }],
    ['a redacted record token', 'x{{resolve:ssm:/secret}}y'],
    ['no declared Value', undefined],
  ])('SSM Parameter does not record Value when the template declares %s', async (_label, value) => {
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Name: 'p', Type: 'String', Value: 'PLAINTEXT-SECRET', ARN: 'arn:aws:ssm:us-east-1:123456789012:parameter/p' },
    });
    const result = await new SSMParameterProvider().import({
      ...input('AWS::SSM::Parameter', 'p'),
      properties: value === undefined ? {} : { Value: value },
    });
    expect(result?.attributes).not.toHaveProperty('Value');
    expect(JSON.stringify(result)).not.toContain('PLAINTEXT-SECRET');
  });

  it('IAM InstanceProfile records the path-bearing Arn from GetInstanceProfile', async () => {
    const arn = 'arn:aws:iam::123456789012:instance-profile/app/my-profile';
    mockIamSend.mockResolvedValueOnce({ InstanceProfile: { Arn: arn, Path: '/app/' } });
    const result = await new IAMInstanceProfileProvider().import(
      input('AWS::IAM::InstanceProfile', 'my-profile')
    );
    expect(result).toStrictEqual({ physicalId: 'my-profile', attributes: { Arn: arn } });
  });

  it('IAM User records the path-bearing Arn from GetUser', async () => {
    const arn = 'arn:aws:iam::123456789012:user/team/alice';
    mockIamSend.mockResolvedValueOnce({ User: { Arn: arn, Path: '/team/' } });
    const result = await new IAMUserGroupProvider().import(input('AWS::IAM::User', 'alice'));
    expect(result).toStrictEqual({ physicalId: 'alice', attributes: { Arn: arn } });
  });

  it('IAM Group records the path-bearing Arn from GetGroup', async () => {
    const arn = 'arn:aws:iam::123456789012:group/team/devs';
    mockIamSend.mockResolvedValueOnce({ Group: { Arn: arn, Path: '/team/' } });
    const result = await new IAMUserGroupProvider().import(input('AWS::IAM::Group', 'devs'));
    expect(result).toStrictEqual({ physicalId: 'devs', attributes: { Arn: arn } });
  });
});

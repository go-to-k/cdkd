import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

const mockSsmSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: {
      send: mockSsmSend,
    },
  }),
}));

/**
 * The CDK default synthesizer emits a `BootstrapVersion` SSM-typed parameter
 * referenced ONLY by the `Rules.CheckBootstrapVersion` assertion (which cdkd
 * never evaluates). Resolving it eagerly makes every deploy require
 * `cdk bootstrap` in the target region — GetParameter throws
 * ParameterNotFound in a never-bootstrapped region — defeating cdkd-owned
 * asset storage (issue #1002). These tests pin the skip-unreferenced rule.
 */
describe('resolveParameters - unreferenced SSM parameter skip', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    mockSsmSend.mockReset();
    mockSsmSend.mockResolvedValue({ Parameter: { Value: 'resolved-ssm-value' } });
  });

  const bootstrapVersionParam = {
    Type: 'AWS::SSM::Parameter::Value<String>',
    Default: '/cdk-bootstrap/hnb659fds/version',
    Description:
      'Version of the CDK Bootstrap resources in this environment, automatically retrieved from SSM Parameter Store. [cdk:skip]',
  };

  it('skips SSM resolution for a parameter referenced by nothing in Resources/Outputs/Conditions (BootstrapVersion shape)', async () => {
    const template = {
      Parameters: { BootstrapVersion: bootstrapVersionParam },
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
      // The real template also carries Rules.CheckBootstrapVersion referencing
      // the parameter — cdkd never evaluates Rules, so it must not count as a
      // reference. (Rules is not part of the CloudFormationTemplate type;
      // parsed JSON carries it as an extra field.)
      Rules: {
        CheckBootstrapVersion: {
          Assertions: [
            {
              Assert: {
                'Fn::Not': [{ 'Fn::Contains': [['1', '2'], { Ref: 'BootstrapVersion' }] }],
              },
            },
          ],
        },
      },
    } as unknown as CloudFormationTemplate;

    const parameters = await resolver.resolveParameters(template);

    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(parameters).not.toHaveProperty('BootstrapVersion');
  });

  it('resolves an SSM parameter referenced by a resource property', async () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        AmiId: {
          Type: 'AWS::SSM::Parameter::Value<String>',
          Default: '/my/ami/id',
        },
      },
      Resources: {
        Instance: {
          Type: 'AWS::EC2::Instance',
          Properties: { ImageId: { Ref: 'AmiId' } },
        },
      },
    } as unknown as CloudFormationTemplate;

    const parameters = await resolver.resolveParameters(template);

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(parameters['AmiId']).toBe('resolved-ssm-value');
  });

  it('resolves an SSM parameter referenced only via an Fn::Sub placeholder in Outputs', async () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        DomainName: {
          Type: 'AWS::SSM::Parameter::Value<String>',
          Default: '/my/domain',
        },
      },
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
      Outputs: {
        Url: { Value: { 'Fn::Sub': 'https://${DomainName}/path' } },
      },
    } as unknown as CloudFormationTemplate;

    const parameters = await resolver.resolveParameters(template);

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(parameters['DomainName']).toBe('resolved-ssm-value');
  });

  it('resolves an SSM parameter referenced only inside a Condition definition', async () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        Stage: {
          Type: 'AWS::SSM::Parameter::Value<String>',
          Default: '/my/stage',
        },
      },
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {}, Condition: 'IsProd' },
      },
      Conditions: {
        IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] },
      },
    } as unknown as CloudFormationTemplate;

    const parameters = await resolver.resolveParameters(template);

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(parameters['Stage']).toBe('resolved-ssm-value');
  });

  it('resolves an SSM parameter referenced only inside an Fn::If branch (generic-recursion shape)', async () => {
    // Fn::If is NOT special-cased in TemplateParser.extractRefsFromValue —
    // it is covered by the generic Object.values fall-through. This test
    // makes that fall-through load-bearing for the skip rule: a future
    // early-return for Fn::If would now silently skip SSM resolution (an
    // unresolved Ref at provisioning), not just drop a DAG edge.
    const template: CloudFormationTemplate = {
      Parameters: {
        BucketName: {
          Type: 'AWS::SSM::Parameter::Value<String>',
          Default: '/my/bucket/name',
        },
      },
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: { 'Fn::If': ['UseCustomName', { Ref: 'BucketName' }, 'default-name'] },
          },
        },
      },
    } as unknown as CloudFormationTemplate;

    const parameters = await resolver.resolveParameters(template);

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(parameters['BucketName']).toBe('resolved-ssm-value');
  });

  it('resolves an SSM parameter referenced only via an Fn::Sub 2-arg variable-map VALUE', async () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        Suffix: {
          Type: 'AWS::SSM::Parameter::Value<String>',
          Default: '/my/suffix',
        },
      },
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: { 'Fn::Sub': ['bucket-${S}', { S: { Ref: 'Suffix' } }] },
          },
        },
      },
    } as unknown as CloudFormationTemplate;

    const parameters = await resolver.resolveParameters(template);

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(parameters['Suffix']).toBe('resolved-ssm-value');
  });

  it('skips an SSM parameter whose only body appearance is SHADOWED by an Fn::Sub 2-arg map key', async () => {
    // ${Shadowed} in the body resolves from the variable map, not the
    // template parameter — so the parameter is genuinely unreferenced and
    // its SSM default must not be fetched.
    const template = {
      Parameters: {
        Shadowed: {
          Type: 'AWS::SSM::Parameter::Value<String>',
          Default: '/never/fetched',
        },
      },
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: { 'Fn::Sub': ['bucket-${Shadowed}', { Shadowed: 'literal-value' }] },
          },
        },
      },
    } as unknown as CloudFormationTemplate;

    const parameters = await resolver.resolveParameters(template);

    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(parameters).not.toHaveProperty('Shadowed');
  });

  it('user-provided value for an unreferenced SSM parameter still takes precedence, with no SSM call', async () => {
    const template = {
      Parameters: { BootstrapVersion: bootstrapVersionParam },
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    } as unknown as CloudFormationTemplate;

    const parameters = await resolver.resolveParameters(template, { BootstrapVersion: '99' });

    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(parameters['BootstrapVersion']).toBe('99');
  });

  it('unreferenced NON-SSM parameters keep their literal default (behavior unchanged)', async () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        UnusedFlag: { Type: 'String', Default: 'off' },
      },
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    } as unknown as CloudFormationTemplate;

    const parameters = await resolver.resolveParameters(template);

    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(parameters['UnusedFlag']).toBe('off');
  });
});

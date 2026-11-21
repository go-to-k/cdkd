import { describe, expect, it } from 'vite-plus/test';
import { signalPlanOf } from '../../../src/deployment/deploy-engine/signal-receiver.js';
import { getAttReadsOf } from '../../../src/deployment/deploy-engine/signal-receiver-run.js';

describe('getAttReadsOf (go-to-k/cdkd#6705 receiver metadata refusal)', () => {
  it('finds GetAtt reads in both spellings and in Fn::Sub, at any depth', () => {
    const metadata = {
      'AWS::CloudFormation::Authentication': {
        S3Auth: {
          accessKeyId: { Ref: 'Key' },
          secretKey: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] },
        },
      },
      'AWS::CloudFormation::Init': {
        config: {
          files: {
            '/a': { content: { 'Fn::Sub': 'x=${Client.ClientSecret} y=${AWS::Region} z=${Plain}' } },
            '/b': { content: { 'Fn::Sub': ['${Api.ApiKey}', {}] } },
            '/c': { content: { 'Fn::GetAtt': 'Bucket.Arn' } },
          },
        },
      },
    };
    expect(getAttReadsOf(metadata)).toEqual([
      ['Key', 'SecretAccessKey'],
      ['Client', 'ClientSecret'],
      ['Api', 'ApiKey'],
      ['Bucket', 'Arn'],
    ]);
  });

  it('finds nothing in literal metadata', () => {
    expect(getAttReadsOf({ a: ['x', { b: 'Fn::GetAtt' }] })).toEqual([]);
  });
});


/** CDK's `applyCloudFormationInit` user data, as `cdk synth` writes it. */
function cdkUserData(logicalId: string, includeRole: boolean): unknown {
  const role = includeRole ? [' --role ', { Ref: 'InstanceRole' }] : [];
  return {
    'Fn::Base64': {
      'Fn::Join': [
        '',
        [
          '#!/bin/bash\n# fingerprint: f7496e39736dd724\n(\n  set +e\n  /opt/aws/bin/cfn-init -v --region ',
          { Ref: 'AWS::Region' },
          ' --stack ',
          { Ref: 'AWS::StackName' },
          ` --resource ${logicalId}`,
          ...role,
          ' -c default\n  /opt/aws/bin/cfn-signal -e $? --region ',
          { Ref: 'AWS::Region' },
          ' --stack ',
          { Ref: 'AWS::StackName' },
          ` --resource ${logicalId}`,
          ...role,
          '\n  cat /var/log/cfn-init.log >&2\n)',
        ],
      ],
    },
  };
}

const instance = (logicalId: string, includeRole: boolean) => ({
  Type: 'AWS::EC2::Instance',
  CreationPolicy: { ResourceSignal: { Count: 1, Timeout: 'PT10M' } },
  Metadata: { 'AWS::CloudFormation::Init': { config: {} } },
  Properties: { UserData: cdkUserData(logicalId, includeRole) },
});

describe('signalPlanOf: fail-safe signed-call detection (go-to-k/cdkd#6705)', () => {
  const policy = { ResourceSignal: { Count: 1, Timeout: 'PT10M' } };
  const init = { 'AWS::CloudFormation::Init': { config: {} } };
  const plan = (resources: Record<string, unknown>) => signalPlanOf({ Resources: resources } as never);
  const armed = (resources: Record<string, unknown>) => [...plan(resources).candidates.keys()];

  it('arms CDK includeRole: true and refuses the default', () => {
    const resources = { Signed: instance('Signed', true), Unsigned: instance('Unsigned', false) };
    expect(armed(resources)).toEqual(['Signed']);
    expect(plan(resources).unsigned).toEqual(['Unsigned']);
  });

  it('an unsigned cfn-init before a signed cfn-signal makes the resource unsigned', () => {
    const userData = 'cfn-init --resource X -c default\ncfn-signal -e $? --resource X --role r\n';
    expect(plan({ X: { CreationPolicy: policy, Properties: { UserData: { 'Fn::Base64': userData } } } }).unsigned).toEqual(['X']);
  });

  it('reads Windows .exe calls', () => {
    const userData = '<script>\ncfn-init.exe -v -s S -r W\ncfn-signal.exe -e %ERRORLEVEL% --stack S --resource W\n</script>';
    expect(plan({ W: { CreationPolicy: policy, Properties: { UserData: { 'Fn::Base64': userData } } } }).unsigned).toEqual(['W']);
  });

  it('a credential flag of another command on the next Join element does not sign the call', () => {
    const userData = { 'Fn::Base64': { 'Fn::Join': ['\n', ['cfn-signal -e $? --stack x --resource I', 'rm -f /tmp/lock', 'tail -f x | tee --role y']] } };
    expect(plan({ I: { CreationPolicy: policy, Properties: { UserData: userData } } }).unsigned).toEqual(['I']);
  });

  it('a line continuation carries --role onto the call', () => {
    const userData = { 'Fn::Base64': 'cfn-signal -e $? --stack x \\\n  --resource I \\\n  --role R\n' };
    expect(armed({ I: { CreationPolicy: policy, Properties: { UserData: userData } } })).toEqual(['I']);
  });

  it('a signal sent from ANOTHER resource arms a handle-less wait condition (any user data, any depth)', () => {
    const resources = {
      Wait: { Type: 'AWS::CloudFormation::WaitCondition', CreationPolicy: policy },
      Lt: {
        Properties: {
          LaunchTemplateData: {
            UserData: { 'Fn::Base64': { 'Fn::Sub': '\tcfn-signal --role ${Role} --resource Wait -e 0' } },
          },
        },
      },
    };
    expect(armed(resources)).toEqual(['Wait']);
  });

  it('a signed aws cloudformation signal-resource arms; nothing found does not', () => {
    const viaCli = { 'Fn::Base64': 'aws cloudformation signal-resource --stack-name S --logical-resource-id G --unique-id i --status SUCCESS' };
    expect(armed({ G: { CreationPolicy: policy, Properties: { UserData: viaCli } } })).toEqual(['G']);
    expect(armed({ G: { CreationPolicy: policy, Properties: { UserData: { 'Fn::Base64': 'echo hi' } } } })).toEqual([]);
    expect(armed({ Wait: { Type: 'AWS::CloudFormation::WaitCondition', CreationPolicy: policy } })).toEqual([]);
  });

  it('reads a cloud-config list and a literal base64 body', () => {
    const cloudConfig = '#cloud-config\nruncmd:\n  - ["/opt/aws/bin/cfn-signal", "-e", "0", "--resource", "C", "--role", "R"]\n';
    expect(armed({ C: { CreationPolicy: policy, Properties: { UserData: Buffer.from(cloudConfig).toString('base64') } } })).toEqual(['C']);
  });

  it('a resource reference as --resource names nothing', () => {
    const userData = { 'Fn::Base64': { 'Fn::Join': ['', ['cfn-signal --role r --resource ', { Ref: 'Name' }]] } };
    expect(armed({ I: { CreationPolicy: policy, Properties: { UserData: userData } } })).toEqual([]);
  });

  it('serves cfn-init metadata alone only when a signed cfn-init reads it', () => {
    const metadataOnly = (includeRole: boolean) => ({ ...instance('M', includeRole), CreationPolicy: undefined });
    expect(armed({ M: metadataOnly(true) })).toEqual(['M']);
    expect(armed({ M: metadataOnly(false) })).toEqual([]);
    expect(armed({ M: { Metadata: init } })).toEqual([]);
  });
});

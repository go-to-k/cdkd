import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockCloudControlConfigRegion = vi.fn();
const mockCloudFormationSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: mockCloudControlConfigRegion },
    },
    // DescribeType for write-only property resolution on the update path.
    cloudFormation: { send: mockCloudFormationSend },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
    eventBridge: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return {
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import {
  clearWriteOnlyPropertiesCache,
  getWriteOnlyKeysKeptWhenOmitted,
} from '../../../src/provisioning/write-only-properties.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';

/**
 * go-to-k/cdkd#6788: a Cloud Control UPDATE must not re-add an unchanged
 * write-only key whose handler keeps it when omitted and either acts on a
 * re-send (a password re-set, a canary's code redeployed) or refuses it.
 */

type PatchOp = { op: string; path: string; value?: unknown };

function schema(writeOnly: string[]): string {
  return JSON.stringify({ writeOnlyProperties: writeOnly.map((p) => `/properties/${p}`) });
}

function wireUpdateSuccess(): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'UpdateResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS', Identifier: 'id-1' } });
    }
    return Promise.resolve({});
  });
}

function sentPatch(): PatchOp[] {
  const call = mockCloudControlSend.mock.calls.find(
    (c) => c[0]?.constructor?.name === 'UpdateResourceCommand'
  );
  expect(call).toBeDefined();
  return JSON.parse(
    (call![0] as { input: { PatchDocument: string } }).input.PatchDocument
  ) as PatchOp[];
}

const TAGS_A = [{ Key: 'k', Value: 'a' }];
const TAGS_B = [{ Key: 'k', Value: 'b' }];

describe('CloudControlProvider update: unchanged measured write-only keys are not re-added (go-to-k/cdkd#6788)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
    clearCreateOnlyPropertiesCache();
    wireUpdateSuccess();
    provider = new CloudControlProvider();
  });

  it("leaves a Redshift cluster's unchanged MasterUserPassword out of a Tags-only patch", async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: schema(['MasterUserPassword', 'ManageMasterPassword', 'SnapshotIdentifier']),
    });

    await provider.update(
      'Cluster',
      'cluster-1',
      'AWS::Redshift::Cluster',
      { MasterUserPassword: 'Passw0rd!', NodeType: 'ra3.large', Tags: TAGS_B },
      { MasterUserPassword: 'Passw0rd!', NodeType: 'ra3.large', Tags: TAGS_A }
    );

    expect(sentPatch()).toEqual([{ op: 'replace', path: '/Tags', value: TAGS_B }]);
  });

  it("still sends a Redshift cluster's changed MasterUserPassword", async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: schema(['MasterUserPassword']) });

    await provider.update(
      'Cluster',
      'cluster-1',
      'AWS::Redshift::Cluster',
      { MasterUserPassword: 'N3wPassw0rd!', Tags: TAGS_A },
      { MasterUserPassword: 'Passw0rd!', Tags: TAGS_A }
    );

    expect(sentPatch()).toEqual([{ op: 'add', path: '/MasterUserPassword', value: 'N3wPassw0rd!' }]);
  });

  it('re-adds an unchanged Serverless namespace password when AdminUsername changes', async () => {
    // UpdateNamespace takes the two together.
    mockCloudFormationSend.mockResolvedValue({ Schema: schema(['AdminUserPassword']) });

    await provider.update(
      'Ns',
      'ns-1',
      'AWS::RedshiftServerless::Namespace',
      { AdminUserPassword: 'Passw0rd!', AdminUsername: 'admin2' },
      { AdminUserPassword: 'Passw0rd!', AdminUsername: 'admin' }
    );

    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'add', path: '/AdminUserPassword', value: 'Passw0rd!' });
    expect(patch).toContainEqual({ op: 'replace', path: '/AdminUsername', value: 'admin2' });
    expect(patch).toHaveLength(2);
  });

  it("leaves a canary's unchanged Code out, and re-adds it beside a RuntimeVersion change", async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: schema(['Code/S3Bucket', 'Code/S3Key', 'Code/Script', 'StartCanaryAfterCreation']),
    });
    const code = { Handler: 'index.handler', S3Bucket: 'assets', S3Key: 'canary.zip' };

    await provider.update(
      'Canary',
      'canary-1',
      'AWS::Synthetics::Canary',
      { Code: { ...code }, RuntimeVersion: 'syn-nodejs-puppeteer-9.1', Tags: TAGS_B },
      { Code: code, RuntimeVersion: 'syn-nodejs-puppeteer-9.1', Tags: TAGS_A }
    );
    expect(sentPatch()).toEqual([{ op: 'replace', path: '/Tags', value: TAGS_B }]);

    mockCloudControlSend.mockClear();
    await provider.update(
      'Canary',
      'canary-1',
      'AWS::Synthetics::Canary',
      { Code: { ...code }, RuntimeVersion: 'syn-nodejs-puppeteer-10.0' },
      { Code: code, RuntimeVersion: 'syn-nodejs-puppeteer-9.1' }
    );
    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'add', path: '/Code', value: code });
    expect(patch.map((op) => op.path).sort()).toEqual(['/Code', '/RuntimeVersion']);
  });

  it("leaves a state machine alias's unchanged DeploymentPreference out of a Description patch", async () => {
    // Re-sent, the handler refused it against the read model's RoutingConfiguration.
    mockCloudFormationSend.mockResolvedValue({ Schema: schema(['DeploymentPreference']) });
    const preference = {
      StateMachineVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:sm:1',
      Type: 'ALL_AT_ONCE',
    };

    await provider.update(
      'Alias',
      'alias-arn',
      'AWS::StepFunctions::StateMachineAlias',
      { DeploymentPreference: { ...preference }, Description: 'b' },
      { DeploymentPreference: preference, Description: 'a' }
    );

    expect(sentPatch()).toEqual([{ op: 'replace', path: '/Description', value: 'b' }]);
  });

  it('re-adds an unchanged MasterUserPassword beside a declared write-only ManageMasterPassword', async () => {
    // The sibling is re-added on every update; sending it alone was never measured.
    mockCloudFormationSend.mockResolvedValue({
      Schema: schema(['MasterUserPassword', 'ManageMasterPassword']),
    });

    await provider.update(
      'Cluster',
      'cluster-1',
      'AWS::Redshift::Cluster',
      { MasterUserPassword: 'Passw0rd!', ManageMasterPassword: false, Tags: TAGS_B },
      { MasterUserPassword: 'Passw0rd!', ManageMasterPassword: false, Tags: TAGS_A }
    );

    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'add', path: '/MasterUserPassword', value: 'Passw0rd!' });
    expect(patch).toContainEqual({ op: 'add', path: '/ManageMasterPassword', value: false });
    expect(patch).toHaveLength(3);
  });

  it('re-adds unchanged OptionSettings beside a declared write-only TemplateName', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: schema(['OptionSettings', 'TemplateName']) });
    const options = [{ Namespace: 'aws:autoscaling:asg', OptionName: 'MaxSize', Value: '2' }];

    await provider.update(
      'Env',
      'env-1',
      'AWS::ElasticBeanstalk::Environment',
      { OptionSettings: options, TemplateName: 'tpl', Description: 'b' },
      { OptionSettings: options, TemplateName: 'tpl', Description: 'a' }
    );

    expect(sentPatch().map((op) => op.path).sort()).toEqual([
      '/Description',
      '/OptionSettings',
      '/TemplateName',
    ]);
  });

  it('still sends a password recorded as a {{resolve:...}} reference', async () => {
    // State keeps the reference, the desired side holds the resolved value:
    // they never compare equal, so a rotated secret still reaches AWS.
    mockCloudFormationSend.mockResolvedValue({ Schema: schema(['MasterUserPassword']) });

    await provider.update(
      'Cluster',
      'cluster-1',
      'AWS::Redshift::Cluster',
      { MasterUserPassword: 'resolved-plaintext', Tags: TAGS_B },
      {
        MasterUserPassword: '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:db:SecretString:password::}}',
        Tags: TAGS_A,
      }
    );

    const patch = sentPatch();
    expect(patch).toContainEqual({
      op: 'add',
      path: '/MasterUserPassword',
      value: 'resolved-plaintext',
    });
    expect(patch).toHaveLength(2);
  });

  it('still re-adds an unmeasured write-only key of a type with an entry', async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: schema(['AuthToken', 'SecurityGroupIds']),
    });

    await provider.update(
      'Rg',
      'rg-1',
      'AWS::ElastiCache::ReplicationGroup',
      { AuthToken: 'token-0123456789abcdef', SecurityGroupIds: ['sg-1'], Tags: TAGS_B },
      { AuthToken: 'token-0123456789abcdef', SecurityGroupIds: ['sg-1'], Tags: TAGS_A }
    );

    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'add', path: '/SecurityGroupIds', value: ['sg-1'] });
    expect(patch.map((op) => op.path).sort()).toEqual(['/SecurityGroupIds', '/Tags']);
  });
});

describe('getWriteOnlyKeysKeptWhenOmitted rows (go-to-k/cdkd#6788)', () => {
  const kept = (
    type: string,
    properties: Record<string, unknown> = {},
    previous: Record<string, unknown> = {}
  ): string[] => [...getWriteOnlyKeysKeptWhenOmitted(type, properties, previous)].sort();

  it.each([
    ['AWS::AmazonMQ::Broker', ['Configuration', 'EngineVersion', 'Users']],
    ['AWS::AppFabric::AppAuthorization', ['Credential']],
    ['AWS::Batch::ComputeEnvironment', ['ReplaceComputeEnvironment', 'UpdatePolicy']],
    ['AWS::BedrockAgentCore::ApiKeyCredentialProvider', ['ApiKey']],
    ['AWS::BedrockAgentCore::OAuth2CredentialProvider', ['Oauth2ProviderConfigInput']],
    ['AWS::Bedrock::Flow', ['DefinitionString']],
    ['AWS::CloudFront::KeyValueStore', ['ImportSource']],
    ['AWS::Connect::User', ['Password']],
    ['AWS::DMS::Endpoint', ['Password']],
    ['AWS::DataSync::LocationAzureBlob', ['AzureBlobSasConfiguration']],
    ['AWS::DocDBElastic::Cluster', ['AdminUserPassword']],
    ['AWS::EC2::VPNConnection', ['VpnTunnelOptionsSpecifications']],
    ['AWS::ElastiCache::ReplicationGroup', ['AuthToken']],
    ['AWS::ElastiCache::User', ['Passwords']],
    ['AWS::ElasticBeanstalk::Environment', ['OptionSettings']],
    ['AWS::FSx::StorageVirtualMachine', ['SvmAdminPassword']],
    ['AWS::MemoryDB::User', ['AuthenticationMode']],
    ['AWS::Redshift::Cluster', ['MasterUserPassword']],
    ['AWS::RedshiftServerless::Namespace', ['AdminUserPassword']],
    ['AWS::Route53Resolver::FirewallDomainList', ['Domains']],
    ['AWS::StepFunctions::StateMachineAlias', ['DeploymentPreference']],
    ['AWS::Synthetics::Canary', ['Code']],
  ])('names %s %j while no sibling it travels with changed', (type, keys) => {
    expect(kept(type)).toEqual(keys);
  });

  it.each([
    ['AWS::Batch::ComputeEnvironment', 'ComputeResources', 'ReplaceComputeEnvironment'],
    ['AWS::Batch::ComputeEnvironment', 'ComputeResources', 'UpdatePolicy'],
    ['AWS::BedrockAgentCore::ApiKeyCredentialProvider', 'ApiKeySecretConfig', 'ApiKey'],
    ['AWS::BedrockAgentCore::ApiKeyCredentialProvider', 'ApiKeySecretSource', 'ApiKey'],
    ['AWS::Bedrock::Flow', 'DefinitionSubstitutions', 'DefinitionString'],
    ['AWS::DataSync::LocationAzureBlob', 'AzureBlobAuthenticationType', 'AzureBlobSasConfiguration'],
    ['AWS::DataSync::LocationAzureBlob', 'CmkSecretConfig', 'AzureBlobSasConfiguration'],
    ['AWS::DataSync::LocationAzureBlob', 'CustomSecretConfig', 'AzureBlobSasConfiguration'],
    ['AWS::ElastiCache::User', 'AuthenticationMode', 'Passwords'],
    ['AWS::ElastiCache::User', 'NoPasswordRequired', 'Passwords'],
    ['AWS::ElasticBeanstalk::Environment', 'TemplateName', 'OptionSettings'],
    ['AWS::ElasticBeanstalk::Environment', 'PlatformArn', 'OptionSettings'],
    ['AWS::Redshift::Cluster', 'ManageMasterPassword', 'MasterUserPassword'],
    ['AWS::RedshiftServerless::Namespace', 'AdminUsername', 'AdminUserPassword'],
    ['AWS::RedshiftServerless::Namespace', 'ManageAdminPassword', 'AdminUserPassword'],
    ['AWS::Route53Resolver::FirewallDomainList', 'DomainFileUrl', 'Domains'],
    ['AWS::Synthetics::Canary', 'RuntimeVersion', 'Code'],
  ])('%s: a %s change re-adds %s', (type, sibling, key) => {
    expect(kept(type, { [sibling]: 'next' }, { [sibling]: 'prev' })).not.toContain(key);
    expect(kept(type, { [sibling]: 'same' }, { [sibling]: 'same' })).toContain(key);
  });

  it('leaves a key out of the result while a sibling is write-only and declared', () => {
    const writeOnly = new Set(['MasterUserPassword', 'ManageMasterPassword']);
    const declared = { ManageMasterPassword: false };
    expect([
      ...getWriteOnlyKeysKeptWhenOmitted('AWS::Redshift::Cluster', declared, declared, writeOnly),
    ]).toEqual([]);
    // Undeclared, it is not re-added, so the key stays omitted.
    expect([
      ...getWriteOnlyKeysKeptWhenOmitted('AWS::Redshift::Cluster', {}, {}, writeOnly),
    ]).toEqual(['MasterUserPassword']);
  });

  it('names nothing for a measured row that is not in the table', () => {
    // Omitting is unsafe or unmeasured for these (go-to-k/cdkd#6788).
    expect(kept('AWS::Lex::Bot')).toEqual([]);
    expect(kept('AWS::Config::ConformancePack')).toEqual([]);
    expect(kept('AWS::KinesisAnalyticsV2::Application')).toEqual([]);
    expect(kept('AWS::Lightsail::Database')).toEqual([]);
    expect(kept('AWS::CodeBuild::SourceCredential')).toEqual([]);
  });
});

/**
 * `CloudControlProvider.create` / `update` narrow the recorded `attributes` to
 * the type's `Fn::GetAtt` attributes (issue #2925), the deploy-side half of
 * the import narrowing (#2847, #3735).
 *
 * Each case pairs the masked key's PRESENCE with its value: a dropped key
 * would make `Fn::GetAtt` fall back to the physical id, so "the secret is not
 * there" alone would pass on the outcome this design rejects.
 *
 * `AWS::StepFunctions::Activity` is the fixture type: it has no SDK provider,
 * its registry `readOnlyProperties` hold only `Arn`, and the generated table
 * certifies the writable `Name` (issue #3735), so one model exercises all
 * three classes: read-only, writable attribute, writable non-attribute.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockCloudFormationSend = vi.fn();
const mockRdsSend = vi.fn();

vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const original = await importOriginal<typeof import('@aws-sdk/client-rds')>();
  return {
    ...original,
    RDSClient: class {
      send = mockRdsSend;
    },
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: vi.fn() } },
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
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { clearReadOnlyPropertiesCache } from '../../../src/provisioning/read-only-properties.js';
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';
import { describeTypeRetryDelays } from '../../../src/provisioning/describe-type.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

const TYPE = 'AWS::StepFunctions::Activity';
const ARN = 'arn:aws:states:us-east-1:123456789012:activity:act';
const SCHEMA = JSON.stringify({ readOnlyProperties: ['/properties/Arn'] });
const MODEL = {
  Arn: ARN,
  Name: 'act',
  EncryptionConfiguration: { Type: 'CUSTOMER_MANAGED_KMS_KEY', KmsKeyId: 'key-1' },
  Tags: [{ Key: 'k', Value: 'v' }],
};

function wire(operation: 'Create' | 'Update', model: Record<string, unknown>): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === `${operation}ResourceCommand`) {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({
        ProgressEvent: {
          OperationStatus: 'SUCCESS',
          Identifier: ARN,
          ResourceModel: JSON.stringify(model),
        },
      });
    }
    if (name === 'GetResourceCommand') {
      return Promise.resolve({
        ResourceDescription: { Identifier: ARN, Properties: JSON.stringify(model) },
      });
    }
    return Promise.resolve({});
  });
}

const NARROWED = {
  Arn: ARN,
  Name: 'act',
  EncryptionConfiguration: { Type: SECRET_MASK, KmsKeyId: SECRET_MASK },
  Tags: [{ Key: SECRET_MASK, Value: SECRET_MASK }],
};

describe('CloudControlProvider create/update attribute narrowing (issue #2925)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearReadOnlyPropertiesCache();
    clearWriteOnlyPropertiesCache();
    describeTypeRetryDelays.sleep = async () => {};
  });
  afterEach(() => {
    delete describeTypeRetryDelays.sleep;
  });

  it('create: keeps read-only and writable Fn::GetAtt attributes, masks the rest in place', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: SCHEMA });
    wire('Create', MODEL);

    const result = await new CloudControlProvider().create('Act', TYPE, { Name: 'act' });

    expect({ ...result.attributes }).toEqual(NARROWED);
    expect(JSON.stringify(result.attributes)).not.toContain('key-1');
  });

  it('update: narrows the same way', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: SCHEMA });
    wire('Update', MODEL);

    const result = await new CloudControlProvider().update(
      'Act',
      ARN,
      TYPE,
      { Name: 'act', Tags: [{ Key: 'k', Value: 'v2' }] },
      { Name: 'act', Tags: [{ Key: 'k', Value: 'v' }] }
    );

    expect({ ...result.attributes }).toEqual(NARROWED);
  });

  it('records the whole model when the schema cannot be resolved (fail-open, today’s behaviour)', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    wire('Create', MODEL);

    const result = await new CloudControlProvider().create('Act', TYPE, { Name: 'act' });

    expect({ ...result.attributes }).toEqual(MODEL);
  });

  it('never masks a key the enrichment adds (flat dotted names are attributes by construction)', async () => {
    // RDS DBCluster: the enrichment computes `Endpoint.Address` and friends as
    // FLAT keys, which no top-level attribute set lists.
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ readOnlyProperties: ['/properties/Endpoint/Address'] }),
    });
    mockRdsSend.mockResolvedValue({
      DBClusters: [{ Endpoint: 'db.example.com', Port: 5432 }],
    });
    wire('Create', {
      DBClusterIdentifier: 'db',
      Endpoint: { Address: 'db.example.com', Port: '5432' },
      DatabaseName: 'appdb',
    });

    const result = await new CloudControlProvider().create('Db', 'AWS::RDS::DBCluster', {});

    expect(result.attributes?.['Endpoint']).toEqual({ Address: 'db.example.com', Port: '5432' });
    expect(result.attributes?.['Endpoint.Address']).toBe('db.example.com');
    expect(result.attributes?.['DatabaseName']).toBe(SECRET_MASK);
  });

  it('masks a non-attribute key the sparse read-back brings, after the read-back ran', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: SCHEMA });
    // A model carrying only the identifier echo is sparse, so the read-back
    // runs and its whole model wins the merge. What this pins is the ORDER:
    // narrowing before the read-back would leave the read-back's
    // non-attribute keys unmasked.
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'CreateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({
          ProgressEvent: {
            OperationStatus: 'SUCCESS',
            Identifier: ARN,
            ResourceModel: JSON.stringify({ Arn: ARN }),
          },
        });
      }
      if (name === 'GetResourceCommand') {
        return Promise.resolve({
          ResourceDescription: { Identifier: ARN, Properties: JSON.stringify(MODEL) },
        });
      }
      return Promise.resolve({});
    });

    const result = await new CloudControlProvider().create('Act', TYPE, { Name: 'act' });

    expect({ ...result.attributes }).toEqual(NARROWED);
  });

  it('keeps a model key named __proto__ as an own, masked key', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: SCHEMA });
    wire('Create', JSON.parse(`{"Arn":"${ARN}","__proto__":"x","Name":"act"}`));

    const result = await new CloudControlProvider().create('Act', TYPE, { Name: 'act' });

    expect(Object.keys(result.attributes ?? {})).toEqual(['Arn', '__proto__', 'Name']);
    expect(Object.getOwnPropertyDescriptor(result.attributes, '__proto__')?.value).toBe(
      SECRET_MASK
    );
  });

  it('keeps a shape-mismatched Fn::GetAtt attribute (DocDB Port) that the import would mask, and still masks a non-attribute', async () => {
    // CDK's `allowDefaultPortFrom` emits `Fn::GetAtt [Cluster, Port]`, which
    // CloudFormation accepts; refusing it on deploy would be a regression.
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ readOnlyProperties: ['/properties/Endpoint'] }),
    });
    wire('Create', {
      DBClusterIdentifier: 'docdb-1',
      Endpoint: 'docdb-1.cluster.example.com',
      Port: 27017,
      StorageType: 'iopt1',
    });

    const result = await new CloudControlProvider().create('Cluster', 'AWS::DocDB::DBCluster', {});

    expect(result.attributes?.['Port']).toBe(27017);
    expect(result.attributes?.['Endpoint']).toBe('docdb-1.cluster.example.com');
    expect(result.attributes?.['StorageType']).toBe(SECRET_MASK);
  });

  // The provider receives RESOLVED properties: what tells a secret apart is
  // the run's secret masker, which knows every value this deploy resolved
  // from a secret (a `{{resolve:...}}` text is normally gone by now).
  const masker = (text: string): string => text.replaceAll('s3cr3t-plaintext', '***');

  it.each([
    ['an ordinary value is recorded', 'plain-value', 'what-aws-holds'],
    ['a value the run resolved from a secret is masked', 's3cr3t-plaintext', SECRET_MASK],
    ['a {{resolve:...}} left unresolved is masked', '{{resolve:ssm:/secret/source}}', SECRET_MASK],
  ])('SSM Parameter create: %s', async (_label, declared, expected) => {
    mockCloudFormationSend.mockResolvedValue({ Schema: JSON.stringify({}) });
    wire('Create', { Name: '/p', Type: 'String', Value: 'what-aws-holds' });

    const result = await new CloudControlProvider().create(
      'Param',
      'AWS::SSM::Parameter',
      { Name: '/p', Type: 'String', Value: declared },
      { maskSecrets: masker }
    );

    expect(result.attributes?.['Value']).toBe(expected);
    // `Type` is a certified writable attribute either way.
    expect(result.attributes?.['Type']).toBe('String');
  });

  it('SSM Parameter update: the same rule, with the update context\u2019s masker', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: JSON.stringify({}) });
    wire('Update', { Name: '/p', Type: 'String', Value: 'what-aws-holds' });

    const result = await new CloudControlProvider().update(
      'Param',
      '/p',
      'AWS::SSM::Parameter',
      { Name: '/p', Type: 'String', Value: 's3cr3t-plaintext' },
      { Name: '/p', Type: 'String', Value: 'old' },
      { maskSecrets: masker }
    );

    expect(result.attributes?.['Value']).toBe(SECRET_MASK);
  });

  it('keeps the Value exception to SSM Parameter: another type\u2019s non-attribute Value is masked', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: SCHEMA });
    wire('Create', { ...MODEL, Value: 'plain' });

    const result = await new CloudControlProvider().create('Act', TYPE, {
      Name: 'act',
      Value: 'plain',
    });

    expect(result.attributes?.['Value']).toBe(SECRET_MASK);
  });

  it('runs the schema lookup alongside the create, not after it', async () => {
    const order: string[] = [];
    mockCloudFormationSend.mockImplementation(() => {
      order.push('DescribeType');
      return Promise.resolve({ Schema: SCHEMA });
    });
    wire('Create', MODEL);
    const ccSend = mockCloudControlSend.getMockImplementation()!;
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      order.push(cmd.constructor.name);
      return ccSend(cmd);
    });

    await new CloudControlProvider().create('Act', TYPE, { Name: 'act' });

    // Sent while the create is still being polled: a lookup started only
    // after the create would come after the last status poll.
    expect(order.indexOf('DescribeType')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('DescribeType')).toBeLessThan(
      order.lastIndexOf('GetResourceRequestStatusCommand')
    );
  });
});

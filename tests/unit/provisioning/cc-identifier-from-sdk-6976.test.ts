import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const fields = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/cc-import-identifier.js', () => ({
  getPrimaryIdentifierFields: fields,
}));

import { ccIdentifierFromSdkRecord } from '../../../src/provisioning/cc-identifier-from-sdk.js';

/**
 * go-to-k/cdkd#6976: the Cloud Control identifier an SDK-recorded resource is
 * addressed by on the deploy that moves it onto Cloud Control. Field orders
 * are the live schemas' (measured 2026-11-25).
 */
const SCHEMA: Record<string, readonly string[]> = {
  'AWS::ApiGateway::Deployment': ['DeploymentId', 'RestApiId'],
  'AWS::Glue::Table': ['CatalogId', 'DatabaseName', 'Name'],
  'AWS::EMR::InstanceFleetConfig': ['ClusterId', 'InstanceFleetId'],
  'AWS::EC2::EIP': ['PublicIp', 'AllocationId'],
  'AWS::SQS::Queue': ['QueueUrl'],
  'AWS::Route53::RecordSet': ['Name', 'HostedZoneId', 'Type', 'SetIdentifier'],
  'AWS::ECS::Service': ['ServiceArn', 'Cluster'],
  'AWS::WAFv2::WebACL': ['Name', 'Id', 'Scope'],
};

beforeEach(() => {
  fields.mockImplementation((type: string) => Promise.resolve(SCHEMA[type]));
});

describe('ccIdentifierFromSdkRecord (#6976)', () => {
  it('fills the one field the record lacks with the SDK id', async () => {
    await expect(
      ccIdentifierFromSdkRecord({
        resourceType: 'AWS::ApiGateway::Deployment',
        physicalId: 'abc123',
        properties: { RestApiId: 'r1' },
      })
    ).resolves.toBe('abc123|r1');
    await expect(
      ccIdentifierFromSdkRecord({
        resourceType: 'AWS::EMR::InstanceFleetConfig',
        physicalId: 'if-1',
        properties: { ClusterId: 'j-1' },
      })
    ).resolves.toBe('j-1|if-1');
  });

  it('strips the leading fields the SDK id already carries', async () => {
    await expect(
      ccIdentifierFromSdkRecord({
        resourceType: 'AWS::Glue::Table',
        physicalId: 'db|t|x',
        properties: { CatalogId: '123456789012', DatabaseName: 'db' },
      })
    ).resolves.toBe('123456789012|db|t|x');
  });

  it('reads a field from the attributes when the properties lack it', async () => {
    await expect(
      ccIdentifierFromSdkRecord({
        resourceType: 'AWS::EC2::EIP',
        physicalId: 'eipalloc-1',
        properties: {},
        attributes: { PublicIp: '203.0.113.1' },
      })
    ).resolves.toBe('203.0.113.1|eipalloc-1');
  });

  it.each([
    ['a single-field identifier', 'AWS::SQS::Queue', 'https://q', {}],
    ['an unreadable schema', 'AWS::Unknown::Type', 'x', {}],
    ['two fields missing', 'AWS::Glue::Table', 'db|t', { DatabaseName: 'db' }],
    ['a masked field', 'AWS::ApiGateway::Deployment', 'd', { RestApiId: '***' }],
    ['a secret reference', 'AWS::ApiGateway::Deployment', 'd', { RestApiId: '{{resolve:ssm:/x}}' }],
    ['a `|` in a known field', 'AWS::ApiGateway::Deployment', 'd', { RestApiId: 'a|b' }],
    ['a `|` in a middle missing field', 'AWS::EC2::EIP', 'a|b', { AllocationId: 'eipalloc-1' }],
    // The missing field is one the template left unset, not one the SDK id holds.
    [
      'a record set without SetIdentifier',
      'AWS::Route53::RecordSet',
      'Z1|www.example.com.|A',
      { HostedZoneId: 'Z1', Name: 'www.example.com.', Type: 'A' },
    ],
    [
      'an ECS service on the default cluster',
      'AWS::ECS::Service',
      'arn:aws:ecs:us-east-1:1:service/default/s',
      { ServiceArn: 'arn:aws:ecs:us-east-1:1:service/default/s' },
    ],
    [
      'an unnamed web ACL',
      'AWS::WAFv2::WebACL',
      'arn:aws:wafv2:us-east-1:1:regional/webacl/n/id1',
      { Id: 'id1', Scope: 'REGIONAL' },
    ],
  ])('keeps the SDK id for %s', async (_label, resourceType, physicalId, properties) => {
    await expect(ccIdentifierFromSdkRecord({ resourceType, physicalId, properties })).resolves.toBe(
      physicalId
    );
  });
});

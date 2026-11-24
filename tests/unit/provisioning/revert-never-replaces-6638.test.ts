/**
 * go-to-k/cdkd#6638: `cdkd drift --revert` never replaces a resource. Each SDK
 * provider whose `update()` can delete and re-create the resource itself
 * refuses that branch when the caller is the revert
 * (`desiredFromAwsReadback`), before any write, with the update-not-supported
 * error the revert reports as "could not revert". A deploy (no flag) keeps the
 * replacement exactly as before — both polarities per branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetSubscriptionAttributesCommand,
  NotFoundException,
  SetSubscriptionAttributesCommand,
  SubscribeCommand,
  UnsubscribeCommand,
} from '@aws-sdk/client-sns';
import {
  AuthorizeSecurityGroupIngressCommand,
  UpdateSecurityGroupRuleDescriptionsIngressCommand,
  CreateRouteCommand,
  DeleteRouteCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { AddPermissionCommand, RemovePermissionCommand } from '@aws-sdk/client-lambda';
import { CreateResourceCommand, DeleteResourceCommand } from '@aws-sdk/client-api-gateway';
import { PutRolePolicyCommand } from '@aws-sdk/client-iam';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => {
  const client = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };
  return {
    getAwsClients: () => ({
      sns: client,
      acm: client,
      ec2: client,
      ec2SingleSend: client,
      lambda: client,
      apiGateway: client,
      iam: client,
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';
import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const REVERT = { desiredFromAwsReadback: true } as const;

const sent = (ctor: new (...args: never[]) => unknown): unknown[] =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof ctor);

/** The refusal, naming the resource and what forces the replacement. */
async function expectRefusal(
  call: Promise<unknown>,
  logicalId: string,
  reason: RegExp
): Promise<void> {
  const error = await call.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
  const message = (error as Error).message;
  expect(message).toContain(`(${logicalId})`);
  expect(message).toMatch(reason);
  expect(message).toContain('a drift revert never replaces a resource');
  expect(message).toContain('--replace');
}

beforeEach(() => {
  mockSend.mockReset();
});

describe('AWS::SNS::Subscription', () => {
  const TYPE = 'AWS::SNS::Subscription';
  const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:orders';
  const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:orders-queue';
  const SUB_ARN = `${TOPIC_ARN}:5f2c0b44-0000-4000-8000-000000000001`;
  const NEW_SUB_ARN = `${TOPIC_ARN}:9a1d7e30-0000-4000-8000-000000000002`;
  const BASE = { TopicArn: TOPIC_ARN, Protocol: 'sqs', Endpoint: QUEUE_ARN };
  const live = (extra: Record<string, string> = {}): Record<string, string> => ({
    SubscriptionArn: SUB_ARN,
    ...BASE,
    PendingConfirmation: 'false',
    RawMessageDelivery: 'false',
    ...extra,
  });
  const respond = (attributes: Record<string, string>): void => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof GetSubscriptionAttributesCommand) {
        return Promise.resolve({ Attributes: attributes });
      }
      if (command instanceof SubscribeCommand) {
        return Promise.resolve({ SubscriptionArn: NEW_SUB_ARN });
      }
      return Promise.resolve({});
    });
  };
  const writes = (): unknown[] => [...sent(UnsubscribeCommand), ...sent(SubscribeCommand)];

  const POLICY_AND_SCOPE = {
    ...BASE,
    FilterPolicy: { color: ['red'] },
    FilterPolicyScope: 'MessageBody',
  };

  it.each([
    [
      'FilterPolicy and FilterPolicyScope drift together',
      live({ FilterPolicy: '{"color":["blue"]}', FilterPolicyScope: 'MessageAttributes' }),
      POLICY_AND_SCOPE,
      /FilterPolicy and FilterPolicyScope change together/,
    ],
    [
      'the subscription is PendingConfirmation',
      live({ PendingConfirmation: 'true' }),
      { ...BASE, RawMessageDelivery: true },
      /still PendingConfirmation/,
    ],
    [
      'the readback spells a create-only field differently',
      live({ Endpoint: `${QUEUE_ARN}-other` }),
      { ...BASE, RawMessageDelivery: true },
      /its Endpoint differs from the live subscription's/,
    ],
    [
      'an attribute SNS cannot reset is live but not in the baseline',
      live({ DeliveryPolicy: '{"healthyRetryPolicy":{"numRetries":5}}' }),
      { ...BASE },
      /DeliveryPolicy removed, which SNS cannot reset/,
    ],
  ])('revert refuses when %s, and never unsubscribes', async (_l, attributes, desired, reason) => {
    respond(attributes);
    const provider = new SNSSubscriptionProvider();
    await expectRefusal(
      provider.update('OrdersSub', SUB_ARN, TYPE, desired, { ...BASE }, REVERT),
      'OrdersSub',
      reason
    );
    expect(writes()).toEqual([]);
  });

  it.each<[string, string, () => unknown, RegExp]>([
    [
      'its record names the PendingConfirmation placeholder',
      'PendingConfirmation',
      () => Promise.resolve({ Attributes: live() }),
      /PendingConfirmation placeholder/,
    ],
    [
      'AWS no longer has it',
      SUB_ARN,
      () => Promise.reject(new NotFoundException({ message: 'gone', $metadata: {} })),
      /no longer has the subscription/,
    ],
    [
      'AWS returns no attributes',
      SUB_ARN,
      () => Promise.resolve({}),
      /returned no attributes/,
    ],
  ])('revert refuses when %s', async (_l, physicalId, get, reason) => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof GetSubscriptionAttributesCommand ? get() : Promise.resolve({})
    );
    const provider = new SNSSubscriptionProvider();
    await expectRefusal(
      provider.update('OrdersSub', physicalId, TYPE, { ...BASE, RawMessageDelivery: true }, { ...BASE }, REVERT),
      'OrdersSub',
      reason
    );
    expect(writes()).toEqual([]);
  });

  it('deploy still replaces it (delete first) when FilterPolicy and FilterPolicyScope change together', async () => {
    respond(live({ FilterPolicy: '{"color":["blue"]}', FilterPolicyScope: 'MessageAttributes' }));
    const provider = new SNSSubscriptionProvider();
    const result = await provider.update('OrdersSub', SUB_ARN, TYPE, POLICY_AND_SCOPE, { ...BASE });
    expect(sent(UnsubscribeCommand)).toHaveLength(1);
    expect(sent(SubscribeCommand)).toHaveLength(1);
    expect(result).toMatchObject({ physicalId: NEW_SUB_ARN, wasReplaced: true });
  });

  it('deploy still replaces a PendingConfirmation subscription', async () => {
    respond(live({ PendingConfirmation: 'true' }));
    const provider = new SNSSubscriptionProvider();
    const result = await provider.update(
      'OrdersSub',
      SUB_ARN,
      TYPE,
      { ...BASE, RawMessageDelivery: true },
      { ...BASE }
    );
    expect(sent(UnsubscribeCommand)).toHaveLength(1);
    expect(sent(SubscribeCommand)).toHaveLength(1);
    expect(result).toMatchObject({ physicalId: NEW_SUB_ARN, wasReplaced: true });
  });

  it('revert still updates a mutable attribute in place', async () => {
    respond(live());
    const provider = new SNSSubscriptionProvider();
    const result = await provider.update(
      'OrdersSub',
      SUB_ARN,
      TYPE,
      { ...BASE, RawMessageDelivery: true },
      { ...BASE },
      REVERT
    );
    expect(writes()).toEqual([]);
    expect(
      sent(SetSubscriptionAttributesCommand).map(
        (c) => (c as SetSubscriptionAttributesCommand).input
      )
    ).toEqual([
      { SubscriptionArn: SUB_ARN, AttributeName: 'RawMessageDelivery', AttributeValue: 'true' },
    ]);
    expect(result).toMatchObject({ physicalId: SUB_ARN, wasReplaced: false });
  });
});

describe('AWS::CertificateManager::Certificate', () => {
  const TYPE = 'AWS::CertificateManager::Certificate';
  const CERT_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/old-0000';
  const NEW_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/new-1111';
  const RECORD = {
    DomainName: 'app.example.com',
    SubjectAlternativeNames: ['www.example.com'],
    ValidationMethod: 'DNS',
  };
  // AWS echoes the DomainName among the SANs: the no-observed-baseline shape
  // the issue names. A deploy still reads it as a change; a revert does not.
  const ECHO = { ...RECORD, SubjectAlternativeNames: ['app.example.com', 'www.example.com'] };

  const spies = (provider: ACMCertificateProvider) => ({
    create: vi.spyOn(provider, 'create').mockResolvedValue({ physicalId: NEW_ARN }),
    delete: vi.spyOn(provider, 'delete').mockResolvedValue(undefined),
  });

  it.each([
    ['SubjectAlternativeNames', { ...RECORD, SubjectAlternativeNames: ['api.example.com'] }],
    ['DomainName', { ...RECORD, DomainName: 'other.example.com' }],
    ['KeyAlgorithm', { ...RECORD, KeyAlgorithm: 'EC_prime256v1' }],
  ])('revert refuses a %s difference, requesting and deleting nothing', async (key, previous) => {
    const provider = new ACMCertificateProvider();
    const { create, delete: del } = spies(provider);
    await expectRefusal(
      provider.update('Cert', CERT_ARN, TYPE, { ...RECORD }, previous, REVERT),
      'Cert',
      new RegExp(`its ${key} differs from the live certificate's`)
    );
    expect(create).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('revert reads the DomainName echo in SubjectAlternativeNames as no change, and updates tags in place', async () => {
    const provider = new ACMCertificateProvider();
    const { create, delete: del } = spies(provider);
    mockSend.mockResolvedValue({});
    const noSans = { DomainName: 'app.example.com', ValidationMethod: 'DNS' };
    const result = await provider.update(
      'Cert',
      CERT_ARN,
      TYPE,
      { ...noSans, Tags: [{ Key: 'team', Value: 'a' }] },
      { ...noSans, SubjectAlternativeNames: ['app.example.com'], Tags: [{ Key: 'team', Value: 'b' }] },
      REVERT
    );
    expect(create).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(result).toMatchObject({ physicalId: CERT_ARN, wasReplaced: false });
    expect(mockSend.mock.calls.map((c) => c[0] as { constructor: { name: string }; input: unknown }).map((c) => [c.constructor.name, c.input])).toEqual([
      ['AddTagsToCertificateCommand', { CertificateArn: CERT_ARN, Tags: [{ Key: 'team', Value: 'a' }] }],
    ]);
  });

  it('revert reads recorded SANs [www] against live [app, www] (DomainName app) as no change', async () => {
    const provider = new ACMCertificateProvider();
    const { create, delete: del } = spies(provider);
    mockSend.mockResolvedValue({});
    const result = await provider.update(
      'Cert',
      CERT_ARN,
      TYPE,
      { ...RECORD, Tags: [{ Key: 'team', Value: 'a' }] },
      { ...ECHO, Tags: [{ Key: 'team', Value: 'b' }] },
      REVERT
    );
    expect(create).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(result).toMatchObject({ physicalId: CERT_ARN, wasReplaced: false });
  });

  it('deploy still requests a new certificate and deletes the old one', async () => {
    const provider = new ACMCertificateProvider();
    const { create, delete: del } = spies(provider);
    const result = await provider.update('Cert', CERT_ARN, TYPE, { ...RECORD }, ECHO);
    expect(create).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ physicalId: NEW_ARN, wasReplaced: true });
  });
});

describe('AWS::EC2::SecurityGroupIngress', () => {
  const TYPE = 'AWS::EC2::SecurityGroupIngress';
  const GROUP_ID = 'sg-0123456789abcdef0';
  const RULE_ID = 'sgr-0a1b2c3d4e5f60718';
  const NEW_RULE_ID = 'sgr-0ddddddddddddddd0';
  const PHYSICAL_ID = `${GROUP_ID}|tcp|443|443`;
  const RECORD = {
    GroupId: GROUP_ID,
    IpProtocol: 'tcp',
    FromPort: 443,
    ToPort: 443,
    CidrIp: '10.0.0.0/16',
  };
  // Someone ran ModifySecurityGroupRules on the rule: same sgr- id, new ports.
  const MODIFIED = { ...RECORD, FromPort: 8443, ToPort: 8443 };

  beforeEach(() => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof AuthorizeSecurityGroupIngressCommand
        ? Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: NEW_RULE_ID }] })
        : Promise.resolve({ Return: true })
    );
  });

  it.each([
    ['ports', MODIFIED],
    ['source', { ...RECORD, CidrIp: '0.0.0.0/0' }],
  ])('revert refuses a live %s change, revoking and authorizing nothing', async (_l, previous) => {
    const provider = new EC2Provider();
    await expectRefusal(
      provider.update('HttpsRule', PHYSICAL_ID, TYPE, { ...RECORD }, previous, {
        ...REVERT,
        recordedAttributes: { Id: RULE_ID },
      }),
      'HttpsRule',
      /protocol, ports or source differ/
    );
    expect(sent(RevokeSecurityGroupIngressCommand)).toEqual([]);
    expect(sent(AuthorizeSecurityGroupIngressCommand)).toEqual([]);
  });

  it.each([
    [
      'the recorded description is redacted',
      { ...RECORD, Description: '***' },
      () => Promise.resolve({ Return: true }),
    ],
    [
      'the description update finds no rule',
      { ...RECORD, Description: 'https' },
      () =>
        Promise.reject(
          Object.assign(new Error('no such rule'), { name: 'InvalidPermission.NotFound' })
        ),
    ],
  ])('revert refuses when %s, revoking and authorizing nothing', async (_l, desired, onDescribe) => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof UpdateSecurityGroupRuleDescriptionsIngressCommand
        ? onDescribe()
        : Promise.resolve({ Return: true })
    );
    const provider = new EC2Provider();
    await expectRefusal(
      provider.update('HttpsRule', PHYSICAL_ID, TYPE, desired, { ...RECORD, Description: 'old' }, {
        ...REVERT,
        recordedAttributes: { Id: RULE_ID },
      }),
      'HttpsRule',
      /cannot reach its record in place/
    );
    expect(sent(RevokeSecurityGroupIngressCommand)).toEqual([]);
    expect(sent(AuthorizeSecurityGroupIngressCommand)).toEqual([]);
  });

  it('a non-revert caller still revokes and re-authorizes, minting a new rule id', async () => {
    const provider = new EC2Provider();
    const result = await provider.update('HttpsRule', PHYSICAL_ID, TYPE, { ...RECORD }, MODIFIED, {
      recordedAttributes: { Id: RULE_ID },
    });
    expect(sent(RevokeSecurityGroupIngressCommand)).toHaveLength(1);
    expect(sent(AuthorizeSecurityGroupIngressCommand)).toHaveLength(1);
    expect(result).toMatchObject({ wasReplaced: true, attributes: { Id: NEW_RULE_ID } });
  });
});

describe('AWS::Lambda::Permission', () => {
  const TYPE = 'AWS::Lambda::Permission';
  const RECORD = {
    FunctionName: 'my-function',
    Action: 'lambda:InvokeFunction',
    Principal: 's3.amazonaws.com',
    SourceArn: 'arn:aws:s3:::my-bucket',
  };
  const LIVE = { ...RECORD, SourceArn: 'arn:aws:s3:::someone-elses-bucket' };

  it.each([
    ['an SDK-written statement id', 'MyPerm'],
    ['a Cloud Control-shaped id', 'my-function|MyPerm'],
  ])('revert refuses with %s, removing and adding nothing', async (_l, physicalId) => {
    mockSend.mockResolvedValue({});
    const provider = new LambdaPermissionProvider();
    await expectRefusal(
      provider.update('MyPerm', physicalId, TYPE, { ...RECORD }, LIVE, REVERT),
      'MyPerm',
      /no update API/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['an SDK-written statement id', 'MyPerm'],
    ['a Cloud Control-shaped id', 'my-function|MyPerm'],
  ])('a non-revert caller with %s still removes and re-adds the statement', async (_l, physicalId) => {
    mockSend.mockResolvedValue({});
    const provider = new LambdaPermissionProvider();
    const result = await provider.update('MyPerm', physicalId, TYPE, { ...RECORD }, LIVE);
    const removed = sent(RemovePermissionCommand) as RemovePermissionCommand[];
    const added = sent(AddPermissionCommand) as AddPermissionCommand[];
    expect(removed.map((c) => c.input.StatementId)).toEqual(['MyPerm']);
    expect(added).toHaveLength(1);
    // The re-added statement's id, bare: a Cloud Control-shaped id changes.
    expect(result.physicalId).toBe(added[0]!.input.StatementId);
    expect(result.physicalId).not.toContain('|');
  });
});

describe('AWS::ApiGateway::Resource', () => {
  const TYPE = 'AWS::ApiGateway::Resource';
  const RECORD = { RestApiId: 'api123', ParentId: 'root01', PathPart: 'orders' };
  const LIVE = { ...RECORD, PathPart: 'Orders' };

  it('revert refuses a PathPart difference, creating and deleting nothing', async () => {
    mockSend.mockResolvedValue({ id: 'new001' });
    const provider = new ApiGatewayProvider();
    await expectRefusal(
      provider.update('OrdersResource', 'res001', TYPE, { ...RECORD }, LIVE, REVERT),
      'OrdersResource',
      /its PathPart differs/
    );
    expect(sent(CreateResourceCommand)).toEqual([]);
    expect(sent(DeleteResourceCommand)).toEqual([]);
  });

  it('deploy still creates the new resource and deletes the old one', async () => {
    mockSend.mockResolvedValue({ id: 'new001' });
    const provider = new ApiGatewayProvider();
    const result = await provider.update('OrdersResource', 'res001', TYPE, { ...RECORD }, LIVE);
    expect(sent(CreateResourceCommand)).toHaveLength(1);
    expect(sent(DeleteResourceCommand)).toHaveLength(1);
    expect(result).toMatchObject({ physicalId: 'new001', wasReplaced: true });
  });
});

describe('AWS::EC2::Route', () => {
  const TYPE = 'AWS::EC2::Route';
  const RECORDED_ID = 'rtb-1|10.1.0.0/16';
  // The bag names another route than the physical id: a readback spelling
  // mismatch is the only way a revert gets here.
  const DESIRED = { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.2.0.0/16', GatewayId: 'igw-1' };
  const PREVIOUS = { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.1.0.0/16', GatewayId: 'igw-1' };

  it('revert refuses a bag naming another route, deleting and creating nothing', async () => {
    mockSend.mockResolvedValue({});
    const provider = new EC2Provider();
    await expectRefusal(
      provider.update('DefaultRoute', RECORDED_ID, TYPE, DESIRED, PREVIOUS, REVERT),
      'DefaultRoute',
      /route table or destination differs/
    );
    expect(sent(DeleteRouteCommand)).toEqual([]);
    expect(sent(CreateRouteCommand)).toEqual([]);
  });

  it('deploy still deletes the recorded route and creates the desired one', async () => {
    mockSend.mockResolvedValue({});
    const provider = new EC2Provider();
    const result = await provider.update('DefaultRoute', RECORDED_ID, TYPE, DESIRED, PREVIOUS);
    expect(sent(DeleteRouteCommand)).toHaveLength(1);
    expect(sent(CreateRouteCommand)).toHaveLength(1);
    expect(result).toMatchObject({ physicalId: 'rtb-1|10.2.0.0/16', wasReplaced: true });
  });
});

describe('AWS::IAM::Policy (the backstop must not misfire on a legacy id)', () => {
  const TYPE = 'AWS::IAM::Policy';
  const DOC = { Version: '2012-10-17', Statement: [] };
  const BAG = { PolicyName: 'MyPolicy', PolicyDocument: DOC, Roles: ['MyRole'] };

  it('revert keeps a legacy policyName:roleName id when the name is unchanged', async () => {
    mockSend.mockResolvedValue({});
    const provider = new IAMPolicyProvider();
    const result = await provider.update('Pol', 'MyPolicy:MyRole', TYPE, BAG, { ...BAG }, REVERT);
    expect(sent(PutRolePolicyCommand)).toHaveLength(1);
    expect(result).toMatchObject({ physicalId: 'MyPolicy:MyRole', wasReplaced: false });
  });

  it.each([
    ['another name', 'OtherPolicy'],
    ['a case-only difference', 'mypolicy'],
  ])('revert refuses a PolicyName that differs from the recorded one (%s), writing nothing', async (_l, name) => {
    mockSend.mockResolvedValue({});
    const provider = new IAMPolicyProvider();
    await expectRefusal(
      provider.update('Pol', 'MyPolicy', TYPE, { ...BAG, PolicyName: name }, { ...BAG }, REVERT),
      'Pol',
      /its PolicyName differs/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('deploy still moves the legacy id to the bare name', async () => {
    mockSend.mockResolvedValue({});
    const provider = new IAMPolicyProvider();
    const result = await provider.update('Pol', 'MyPolicy:MyRole', TYPE, BAG, { ...BAG });
    expect(result).toMatchObject({ physicalId: 'MyPolicy', wasReplaced: false });
  });
});

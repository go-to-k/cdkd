/**
 * A state record whose `physicalId` is not a string is REFUSED where the
 * resolver reads the record, above every arm (issue
 * [#3576](https://github.com/go-to-k/cdkd/issues/3576)).
 *
 * Nothing in `src/state/` checks the id's type, so a hand edit or a foreign
 * writer can leave a number. The arms then called `.startsWith` / `.replace`
 * on it (a bare `TypeError`), handed it to an AWS call, or built a value from
 * it. One case per arm that reads the id, each with a CONTROL driving the SAME
 * arm with a string id to that arm's own answer, so a case that stopped
 * reaching its arm cannot pass. The numeric cases also assert that no AWS call
 * was made: the refusal sits above every read.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/** Every non-STS AWS call the resolver makes; each one fails, as a denied read would. */
const aws = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../../../src/utils/aws-clients.js', () => {
  const failing = (service: string) => ({
    send: async (command: { constructor: { name: string } }) => {
      aws.calls.push(`${service}:${command.constructor.name}`);
      throw new Error('AccessDenied');
    },
  });
  const clients = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      if (prop === 'sts') return { send: async () => ({ Account: '123456789012' }) };
      // Absent, so `clientsForRegion` takes the test-double arm.
      if (prop === 'withRegion' || prop === 'then' || typeof prop === 'symbol') return undefined;
      return failing(prop);
    },
  });
  return { getAwsClients: () => clients };
});

vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-servicediscovery')>();
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(function () {
      return {
        send: async (command: { constructor: { name: string } }) => {
          aws.calls.push(`servicediscovery:${command.constructor.name}`);
          throw new Error('AccessDenied');
        },
      };
    }),
  };
});

interface Outcome {
  value?: unknown;
  error?: unknown;
}

async function resolveAgainst(
  intrinsic: unknown,
  resourceType: string,
  physicalId: unknown,
  attributes?: Record<string, unknown>
): Promise<Outcome> {
  const record: Record<string, unknown> = { resourceType, properties: {}, dependencies: [] };
  if (physicalId !== OMIT) record['physicalId'] = physicalId;
  if (attributes) record['attributes'] = attributes;
  try {
    const value = await new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false }).resolve(
      intrinsic,
      {
        template: {
          Resources: { Thing: { Type: resourceType } },
        } as unknown as CloudFormationTemplate,
        resources: { Thing: record },
      } as unknown as ResolverContext
    );
    return { value };
  } catch (error) {
    return { error };
  }
}

const OMIT = Symbol('omit');

function expectPhysicalIdRefusal(outcome: Outcome, via: string, got: string): void {
  expect(outcome.error, `resolved to ${JSON.stringify(outcome.value)}`).toBeInstanceOf(
    IntrinsicResolutionRefusalError
  );
  const error = outcome.error as IntrinsicResolutionRefusalError;
  expect(error.code).toBe('STATE_PHYSICAL_ID_NOT_STRING');
  expect(isMarkedNonRetryable(error)).toBe(true);
  expect(error.message).toBe(
    `${via} Thing: the state record's physical id is ${got}, not a string. cdkd always ` +
      `records a string id, so this record was edited by hand or written by another tool. ` +
      `Set the resource's "physicalId" in the stack's state.json back to the id AWS knows ` +
      `the resource by.`
  );
}

function errorMessage(outcome: Outcome): string {
  expect(outcome.error, `resolved to ${JSON.stringify(outcome.value)}`).toBeInstanceOf(Error);
  return (outcome.error as Error).message;
}

beforeEach(() => {
  resetAccountInfoCache();
  aws.calls.length = 0;
});

describe('every non-string id type is refused at the record read (#3576)', () => {
  it.each<[string, unknown]>([
    ['number', 123],
    ['null', null],
    ['undefined', OMIT],
    ['boolean', true],
    ['object', { id: 'vpc-0abc' }],
    ['object', ['vpc-0abc']],
  ])('%s: %j', async (got, physicalId) => {
    expectPhysicalIdRefusal(
      await resolveAgainst({ Ref: 'Thing' }, 'AWS::EC2::VPC', physicalId),
      'Ref',
      got
    );
  });

  it('CONTROL: a string id, the empty one included, is not this refusal', async () => {
    expect(await resolveAgainst({ Ref: 'Thing' }, 'AWS::EC2::VPC', 'vpc-0abc')).toEqual({
      value: 'vpc-0abc',
    });
    expect(await resolveAgainst({ Ref: 'Thing' }, 'AWS::EC2::VPC', '')).toEqual({ value: '' });
  });

  it('CONTROL: a NULL record still misses like an absent one', async () => {
    const outcome = await new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false })
      .resolve({ Ref: 'Thing' }, {
        template: { Resources: {} } as unknown as CloudFormationTemplate,
        resources: { Thing: null },
      } as unknown as ResolverContext)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
    expect(errorMessage(outcome)).toBe('Ref Thing not found');
  });
});

describe('one case per arm that reads the id: refused before the arm, with no AWS call (#3576)', () => {
  // [arm, intrinsic, resource type, CONTROL string id, the control's own answer]
  const arms: Array<[string, unknown, string, string, (o: Outcome) => void]> = [
    [
      'Ref (WAFv2 WebACL: `.startsWith` on the id)',
      { Ref: 'Thing' },
      'AWS::WAFv2::WebACL',
      'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123',
      (o) => expect(o.value).toBe('my-acl|abc-123|REGIONAL'),
    ],
    [
      'Fn::GetAtt VPC DefaultSecurityGroup (the shape-refusal render)',
      { 'Fn::GetAtt': ['Thing', 'DefaultSecurityGroup'] },
      'AWS::EC2::VPC',
      'vpc-*',
      (o) => expect(errorMessage(o)).toContain(`physical id "vpc-*" is not a VPC id`),
    ],
    [
      'Fn::GetAtt SecurityGroup VpcId (the shape-refusal render)',
      { 'Fn::GetAtt': ['Thing', 'VpcId'] },
      'AWS::EC2::SecurityGroup',
      'not-a-group',
      (o) => expect(errorMessage(o)).toContain('is not a security group id'),
    ],
    [
      'Fn::GetAtt CloudFront DomainName (refuseUnservedAttribute after a failed read)',
      { 'Fn::GetAtt': ['Thing', 'DomainName'] },
      'AWS::CloudFront::Distribution',
      'E1ABCDEF',
      (o) => expect(errorMessage(o)).toContain('The physical id "E1ABCDEF"'),
    ],
    [
      'Fn::GetAtt DBProxy VpcId (the read-less refusal render)',
      { 'Fn::GetAtt': ['Thing', 'VpcId'] },
      'AWS::RDS::DBProxy',
      'my-proxy',
      (o) => expect(errorMessage(o)).toContain('the physical id "my-proxy" is a name'),
    ],
    [
      'Fn::GetAtt on an unmodelled attribute (guardedPhysicalIdFallback: `.startsWith`)',
      { 'Fn::GetAtt': ['Thing', 'WidgetArn'] },
      'AWS::Widget::Thing',
      'plain-id',
      (o) => expect(errorMessage(o)).toContain('fallback "plain-id" is not'),
    ],
    [
      'Fn::GetAtt SQS QueueName (`.startsWith` on the URL)',
      { 'Fn::GetAtt': ['Thing', 'QueueName'] },
      'AWS::SQS::Queue',
      'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
      (o) => expect(o.value).toBe('my-queue'),
    ],
    [
      'Fn::GetAtt VPC Ipv6CidrBlocks (warn-and-degrade after a failed read)',
      { 'Fn::GetAtt': ['Thing', 'Ipv6CidrBlocks'] },
      'AWS::EC2::VPC',
      'vpc-0abc',
      (o) => expect(o).toEqual({ value: [] }),
    ],
    [
      'Fn::GetAtt ServiceDiscovery HostedZoneId (warn-and-degrade after a failed read)',
      { 'Fn::GetAtt': ['Thing', 'HostedZoneId'] },
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      'ns-0abc',
      (o) => expect(o).toEqual({ value: undefined }),
    ],
    [
      'Fn::GetAtt LaunchTemplate LatestVersionNumber (falls back after a failed read)',
      { 'Fn::GetAtt': ['Thing', 'LatestVersionNumber'] },
      'AWS::EC2::LaunchTemplate',
      'lt-0abc',
      (o) => expect(o).toEqual({ value: '$Latest' }),
    ],
    [
      'Fn::Sub ${Thing} (the Ref form, not laundered into a kept literal)',
      { 'Fn::Sub': 'id=${Thing}' },
      'AWS::EC2::VPC',
      'vpc-0abc',
      (o) => expect(o).toEqual({ value: 'id=vpc-0abc' }),
    ],
    [
      'Fn::Sub ${Thing.QueueName} (the Fn::GetAtt form, not laundered into a kept literal)',
      { 'Fn::Sub': 'q=${Thing.QueueName}' },
      'AWS::SQS::Queue',
      'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
      (o) => expect(o).toEqual({ value: 'q=my-queue' }),
    ],
  ];

  it.each(arms)('%s', async (_arm, intrinsic, resourceType, controlId, control) => {
    // `Fn::Sub` reaches the record through `Ref` for `${Thing}`, through
    // `Fn::GetAtt` for `${Thing.Attr}`.
    const text = JSON.stringify(intrinsic);
    const via = text.startsWith('{"Ref"') || text.includes('${Thing}') ? 'Ref' : 'Fn::GetAtt';
    expectPhysicalIdRefusal(await resolveAgainst(intrinsic, resourceType, 123), via, 'number');
    expect(aws.calls).toEqual([]);

    control(await resolveAgainst(intrinsic, resourceType, controlId));
  });

  it('a stored attribute is not served from a record with a non-string id', async () => {
    const attributes = { Arn: 'arn:aws:sqs:us-east-1:123456789012:my-queue' };
    const intrinsic = { 'Fn::GetAtt': ['Thing', 'Arn'] };
    expectPhysicalIdRefusal(
      await resolveAgainst(intrinsic, 'AWS::SQS::Queue', 123, attributes),
      'Fn::GetAtt',
      'number'
    );
    expect(
      await resolveAgainst(intrinsic, 'AWS::SQS::Queue', 'https://example/q', attributes)
    ).toEqual({ value: attributes.Arn });
  });
});

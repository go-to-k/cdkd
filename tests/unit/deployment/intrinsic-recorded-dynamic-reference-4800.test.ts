/**
 * Issue [#4800](https://github.com/go-to-k/cdkd/issues/4800): a value served
 * out of a PERSISTED record of this stack can be a leaf state stores as its
 * `{{resolve:...}}` spelling (an SQS `Arn` around a queue named from a secret
 * persists as `arn:...:{{resolve:secretsmanager:...}}`). Served as it is, the
 * reader sent that spelling to AWS. Every serving branch now re-resolves it;
 * one case per branch, each through the REAL resolver.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  SECRET_MASK,
  clearRecordedSecretExpressions,
  markSameGenerationBag,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const QUEUE_REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const QUEUE_NAME = 'sdin-q-1';
const CIDR_REF = '{{resolve:secretsmanager:sdin:SecretString:cidr::}}';
const CIDR = '10.42.0.0/16';
const RECORDED_ARN = `arn:aws:sqs:us-east-1:123456789012:${QUEUE_REF}`;
const PLAIN_ARN = `arn:aws:sqs:us-east-1:123456789012:${QUEUE_NAME}`;

/** How many Secrets Manager lookups reached the SDK. */
const smCalls = vi.hoisted(() => ({ count: 0 }));

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

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: vi.fn(async (command: { input?: { SecretId?: string } }) => {
        smCalls.count += 1;
        if (command.input?.SecretId === 'sdin') {
          return { SecretString: JSON.stringify({ queue: 'sdin-q-1', cidr: '10.42.0.0/16' }) };
        }
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }),
    },
  }),
}));

import type { RedactedAttributeRead } from '../../../src/deployment/intrinsic-function-resolver.js';

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

beforeEach(() => {
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  smCalls.count = 0;
});

function record(
  resourceType: string,
  physicalId: string,
  properties: Record<string, unknown>,
  attributes: Record<string, unknown>
): ResourceState {
  return { physicalId, resourceType, properties, attributes, dependencies: [] } as ResourceState;
}

interface Opts {
  bag?: RecordedSecretValues;
  skip?: boolean;
  reads?: RedactedAttributeRead[];
  /** The producer's template `Properties`; its record's `properties` by default. */
  templateProperties?: Record<string, unknown>;
}

function contextFor(
  producer: ResourceState,
  opts: Opts = {}
): Record<string, unknown> {
  return {
    template: {
      Resources: {
        Producer: {
          Type: producer.resourceType,
          Properties: opts.templateProperties ?? producer.properties ?? {},
        },
      },
    } as CloudFormationTemplate,
    resources: { Producer: producer },
    parameters: {},
    conditions: {},
    ...(opts.bag !== undefined && { recordedSecretValues: opts.bag }),
    ...(opts.skip === true && { skipDynamicReferences: true }),
    ...(opts.reads !== undefined && { redactedAttributeReads: opts.reads }),
  };
}

async function resolveWith(
  producer: ResourceState,
  value: unknown,
  opts: Opts = {}
): Promise<unknown> {
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  return await resolver.resolve(value, contextFor(producer, opts) as never);
}

const QUEUE = record(
  'AWS::SQS::Queue',
  `https://sqs.us-east-1.amazonaws.com/123456789012/${QUEUE_NAME}`,
  { QueueName: QUEUE_REF },
  { Arn: RECORDED_ARN }
);

describe('a value served from a persisted record is re-resolved (#4800)', () => {
  it('Fn::GetAtt of a flat attribute: the reader gets the plaintext, and persists the expression', async () => {
    const bag: RecordedSecretValues = new Map();
    const source = { Value: { 'Fn::GetAtt': ['Producer', 'Arn'] } };
    const resolved = (await resolveWith(QUEUE, source, { bag })) as Record<string, unknown>;
    expect(resolved).toEqual({ Value: PLAIN_ARN });
    // The reader's own record keeps no plaintext.
    const persisted = redactSecretsForState(
      markSameGenerationBag(structuredClone(resolved)),
      bag,
      source
    );
    expect(persisted).toEqual({ Value: RECORDED_ARN });
  });

  it('Fn::GetAtt of a whole-token attribute (a custom resource Data echo)', async () => {
    const producer = record('Custom::Thing', 'cr-phys', { Name: QUEUE_REF }, { Name: QUEUE_REF });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Name'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe(QUEUE_NAME);
  });

  it('Fn::GetAtt through the nested-path walk', async () => {
    const producer = record(
      'Custom::Thing',
      'cr-phys',
      { Name: QUEUE_REF },
      { Endpoint: { Address: RECORDED_ARN } }
    );
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Endpoint.Address'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe(PLAIN_ARN);
  });

  it('an Events rule Arn built around a persisted EventBusName', async () => {
    const producer = record('AWS::Events::Rule', 'my-rule', { EventBusName: QUEUE_REF }, {});
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe(`arn:aws:events:us-east-1:123456789012:rule/${QUEUE_NAME}/my-rule`);
  });

  it('a VPC CidrBlock served from the persisted properties', async () => {
    const producer = record('AWS::EC2::VPC', 'vpc-0123456789abcdef0', { CidrBlock: CIDR_REF }, {});
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'CidrBlock'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe(CIDR);
  });

  it('a Ref served from the persisted properties (S3Tables TableName)', async () => {
    const producer = record(
      'AWS::S3Tables::Table',
      'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/0b1c2d3e',
      { TableName: QUEUE_REF },
      {}
    );
    const resolved = await resolveWith(producer, { Ref: 'Producer' }, { bag: new Map() });
    expect(resolved).toBe(QUEUE_NAME);
  });

  it('two whole-token attributes resolving to one value each persist their own expression', async () => {
    // A rotating secret's two stages during `AWSPENDING`: one plaintext, so
    // only the per-leaf source key keeps the reader's leaves apart (#2059).
    const cur = '{{resolve:secretsmanager:sdin:SecretString:queue:AWSCURRENT}}';
    const prev = '{{resolve:secretsmanager:sdin:SecretString:queue:AWSPREVIOUS}}';
    const producer = record('Custom::Thing', 'cr-phys', { Cur: cur, Prev: prev }, { Cur: cur, Prev: prev });
    const bag: RecordedSecretValues = new Map();
    const source = {
      X: { 'Fn::GetAtt': ['Producer', 'Cur'] },
      Y: { 'Fn::GetAtt': ['Producer', 'Prev'] },
    };
    const resolved = (await resolveWith(producer, source, { bag })) as Record<string, unknown>;
    expect(resolved).toEqual({ X: QUEUE_NAME, Y: QUEUE_NAME });
    const persisted = redactSecretsForState(
      markSameGenerationBag(structuredClone(resolved)),
      bag,
      source
    );
    expect(persisted).toEqual({ X: cur, Y: prev });
  });

  it('a token the producer read from another region is served as it is, never resolved here', async () => {
    const producer = record('AWS::SQS::Queue', 'u', {}, { Arn: RECORDED_ARN });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
      templateProperties: {
        QueueName: {
          'Fn::GetStackOutput': { StackName: 'P', OutputName: 'N', Region: 'us-west-2' },
        },
      },
    });
    expect(resolved).toBe(RECORDED_ARN);
    expect(smCalls.count).toBe(0);
  });

  it('a template that also spells the token literally beside a cross-region read proves nothing', async () => {
    const producer = record('AWS::SQS::Queue', 'u', {}, { Arn: RECORDED_ARN });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
      templateProperties: {
        QueueName: {
          'Fn::GetStackOutput': { StackName: 'P', OutputName: 'N', Region: 'us-west-2' },
        },
        Tags: [{ Key: 'k', Value: QUEUE_REF }],
      },
    });
    expect(resolved).toBe(RECORDED_ARN);
    expect(smCalls.count).toBe(0);
  });

  it('a token the template assembles with an intrinsic is served as it is', async () => {
    const producer = record('AWS::SQS::Queue', 'u', {}, { Arn: RECORDED_ARN });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
      templateProperties: {
        QueueName: { 'Fn::Join': ['', ['{{resolve:secretsmanager:sdin:', 'SecretString:queue::}}']] },
      },
    });
    expect(resolved).toBe(RECORDED_ARN);
    expect(smCalls.count).toBe(0);
  });

  it('a diff context keeps the secret expression and fetches nothing', async () => {
    const resolved = await resolveWith(QUEUE, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
      skip: true,
    });
    expect(resolved).toBe(RECORDED_ARN);
    expect(smCalls.count).toBe(0);
  });

  it('a context with no bag to record the plaintext into is served the record as it is', async () => {
    const resolved = await resolveWith(QUEUE, { 'Fn::GetAtt': ['Producer', 'Arn'] });
    expect(resolved).toBe(RECORDED_ARN);
    expect(smCalls.count).toBe(0);
  });

  it('a value carrying the mask is left for the deploy to refuse, reported once as an attribute read', async () => {
    const data = { Password: SECRET_MASK, Queue: QUEUE_REF };
    const producer = record('Custom::Thing', 'cr-phys', { Name: QUEUE_REF }, { Data: data });
    const reads: RedactedAttributeRead[] = [];
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Data'] }, {
      bag: new Map(),
      reads,
    });
    expect(resolved).toEqual(data);
    expect(reads.map((r) => r.kind)).toEqual(['attribute']);
    expect(smCalls.count).toBe(0);
  });

  it('a plain attribute is served with no lookup', async () => {
    const producer = record('AWS::SQS::Queue', 'u', {}, { Arn: PLAIN_ARN });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe(PLAIN_ARN);
    expect(smCalls.count).toBe(0);
  });
});

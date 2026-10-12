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
const QUEUE_URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${QUEUE_NAME}`;
/** A custom resource whose physical id carries the name its Data echoes. */
const CR_ID = `cr-${QUEUE_NAME}`;

/** How many Secrets Manager lookups reached the SDK. */
const smCalls = vi.hoisted(() => ({ count: 0 }));

const warnSpy = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((...a: unknown[]) => warnSpy.calls.push(a.map(String).join(' '))),
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
          return {
            SecretString: JSON.stringify({
              queue: 'sdin-q-1',
              cidr: '10.42.0.0/16',
              short: 'q1',
              four: 'abcd',
              upper: 'SDIN-Q-1',
            }),
          };
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
  warnSpy.calls = [];
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
    const producer = record('Custom::Thing', CR_ID, { Name: QUEUE_REF }, { Name: QUEUE_REF });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Name'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe(QUEUE_NAME);
  });

  it('Fn::GetAtt through the nested-path walk', async () => {
    const producer = record(
      'Custom::Thing',
      CR_ID,
      { Name: QUEUE_REF },
      { Endpoint: { Address: RECORDED_ARN } }
    );
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Endpoint.Address'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe(PLAIN_ARN);
  });

  it('a Ref served from the persisted properties whose physical id cannot prove it is served as recorded', async () => {
    // A Cloud Control S3Tables table: its physical id is an ARN ending in a
    // UUID, so nothing proves which value of the secret the table was named
    // with (go-to-k/cdkd#4800 review M1).
    const producer = record(
      'AWS::S3Tables::Table',
      'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/0b1c2d3e',
      { TableName: QUEUE_REF },
      {}
    );
    const resolved = await resolveWith(producer, { Ref: 'Producer' }, { bag: new Map() });
    expect(resolved).toBe(QUEUE_REF);
    expect(warnSpy.calls.join('\n')).toContain('cdkd cannot confirm the secret still holds the value');
  });

  it('a Ref served from the persisted attributes whose physical id holds the name is resolved', async () => {
    // An AppSync data source's Ref is its recorded DataSourceArn, and its
    // physical id is `<apiId>|<name>`.
    const producer = record(
      'AWS::AppSync::DataSource',
      `api1|${QUEUE_NAME}`,
      { Name: QUEUE_REF },
      { DataSourceArn: `arn:aws:appsync:us-east-1:123456789012:apis/api1/datasources/${QUEUE_REF}` }
    );
    const resolved = await resolveWith(producer, { Ref: 'Producer' }, { bag: new Map() });
    expect(resolved).toBe(`arn:aws:appsync:us-east-1:123456789012:apis/api1/datasources/${QUEUE_NAME}`);
  });

  it('a secret rotated since the producer was deployed is not resolved to its new value', async () => {
    // The queue still has the name it was deployed with (`sdin-q-0`); the
    // secret now holds `sdin-q-1`, and the diff left the queue NO_CHANGE.
    const producer = record(
      'AWS::SQS::Queue',
      'https://sqs.us-east-1.amazonaws.com/123456789012/sdin-q-0',
      { QueueName: QUEUE_REF },
      { Arn: RECORDED_ARN }
    );
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe(RECORDED_ARN);
    const warned = warnSpy.calls.join('\n');
    expect(warned).toContain('cdkd cannot confirm the secret still holds the value');
    expect(warned).not.toContain(QUEUE_NAME);
  });

  it('two whole-token attributes resolving to one value each persist their own expression', async () => {
    // A rotating secret's two stages during `AWSPENDING`: one plaintext, so
    // only the per-leaf source key keeps the reader's leaves apart (#2059).
    const cur = '{{resolve:secretsmanager:sdin:SecretString:queue:AWSCURRENT}}';
    const prev = '{{resolve:secretsmanager:sdin:SecretString:queue:AWSPREVIOUS}}';
    const producer = record('Custom::Thing', CR_ID, { Cur: cur, Prev: prev }, { Cur: cur, Prev: prev });
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

  it.each([
    ['Fn::ImportValue', { 'Fn::ImportValue': 'X' }],
    ['a nested stack output', { 'Fn::GetAtt': ['Child', 'Outputs.N'] }],
    ['a nested stack output, string form', { 'Fn::GetAtt': 'Child.Outputs.N' }],
    ['a GetAtt with a non-literal attribute name', { 'Fn::GetAtt': ['Child', { Ref: 'P' }] }],
  ])('a literal token beside %s proves nothing', async (_l, read) => {
    const producer = record('AWS::SQS::Queue', 'u', {}, { Arn: RECORDED_ARN });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
      templateProperties: { QueueName: read, Tags: [{ Key: 'k', Value: QUEUE_REF }] },
    });
    expect(resolved).toBe(RECORDED_ARN);
    expect(smCalls.count).toBe(0);
  });

  it('a literal token beside an ordinary GetAtt is still resolved', async () => {
    const producer = record('AWS::SQS::Queue', QUEUE_URL, {}, { Arn: RECORDED_ARN });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
      templateProperties: {
        QueueName: QUEUE_REF,
        Policy: { 'Fn::GetAtt': ['Other', 'Arn'] },
      },
    });
    expect(resolved).toBe(PLAIN_ARN);
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

  it.each([
    ['in one leaf', { Arn: `${RECORDED_ARN}/${CIDR_REF}` }, `${RECORDED_ARN}/${CIDR_REF}`, 'Arn'],
    ['in two leaves', { Pair: { A: RECORDED_ARN, B: CIDR_REF } }, { A: RECORDED_ARN, B: CIDR_REF }, 'Pair'],
  ])('a literal token beside one the template assembles (%s) proves nothing', async (_l, attributes, stored, attr) => {
    // Every token must be proven: one spelled literally does not vouch for
    // another that only an `Fn::Join` builds.
    const producer = record('Custom::Thing', CR_ID, {}, attributes);
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', attr] }, {
      bag: new Map(),
      templateProperties: {
        Name: QUEUE_REF,
        Other: { 'Fn::Join': ['', ['{{resolve:secretsmanager:sdin:', 'SecretString:cidr::}}']] },
      },
    });
    expect(resolved).toEqual(stored);
    expect(smCalls.count).toBe(0);
  });

  it('two nested attributes resolving to one value each persist their own expression', async () => {
    const cur = '{{resolve:secretsmanager:sdin:SecretString:queue:AWSCURRENT}}';
    const prev = '{{resolve:secretsmanager:sdin:SecretString:queue:AWSPREVIOUS}}';
    const producer = record(
      'Custom::Thing',
      CR_ID,
      { Cur: cur, Prev: prev },
      { Endpoint: { Cur: cur, Prev: prev } }
    );
    const bag: RecordedSecretValues = new Map();
    const source = {
      X: { 'Fn::GetAtt': ['Producer', 'Endpoint.Cur'] },
      Y: { 'Fn::GetAtt': ['Producer', 'Endpoint.Prev'] },
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

  it.each([
    [true, PLAIN_ARN],
    [false, RECORDED_ARN],
  ])('an Fn::If counts only its taken branch (condition %s)', async (verdict, want) => {
    const producer = record('AWS::SQS::Queue', QUEUE_URL, {}, { Arn: RECORDED_ARN });
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = {
      ...contextFor(producer, { bag: new Map() }),
      template: {
        Resources: {
          Producer: {
            Type: 'AWS::SQS::Queue',
            Properties: { QueueName: { 'Fn::If': ['UseSecret', QUEUE_REF, 'plain-queue'] } },
          },
        },
      },
      conditions: { UseSecret: verdict },
    };
    const resolved = await resolver.resolve({ 'Fn::GetAtt': ['Producer', 'Arn'] }, context as never);
    expect(resolved).toBe(want);
  });

  it.each([
    ['in one leaf', { Arn: `${RECORDED_ARN}/${CIDR_REF}` }, 'Arn'],
    ['in two leaves', { Pair: { A: RECORDED_ARN, B: CIDR_REF } }, 'Pair'],
  ])(
    'every token must match the physical id: a second, rotated one (%s) is served as stored',
    async (_l, attributes, attr) => {
      // Test review N1 on PR #4804: both tokens are spelled literally (proven
      // local); the first resolves to text the physical id holds, the second
      // does not, so the value as a whole cannot be proven.
      const producer = record('Custom::Thing', CR_ID, { Name: QUEUE_REF, Cidr: CIDR_REF }, attributes);
      const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', attr] }, {
        bag: new Map(),
      });
      expect(resolved).toEqual(attributes[attr as keyof typeof attributes]);
      expect(warnSpy.calls.join('\n')).toContain('cdkd cannot confirm the secret still holds the value');
    }
  );

  it('the physical-id check ignores case (a service that folds a name)', async () => {
    const upperRef = '{{resolve:secretsmanager:sdin:SecretString:upper::}}';
    const producer = record('Custom::Thing', CR_ID, { Name: upperRef }, { Name: upperRef });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Name'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe('SDIN-Q-1');
  });

  it('a value of exactly the needle floor counts', async () => {
    const fourRef = '{{resolve:secretsmanager:sdin:SecretString:four::}}';
    const producer = record('Custom::Thing', 'cr-abcd', { Name: fourRef }, { Name: fourRef });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Name'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe('abcd');
  });

  it.each([
    ['unknown, token in the then-branch', ['Unknown', QUEUE_REF, 'plain-queue'], {}],
    ['unknown, token in the else-branch', ['Unknown', 'plain-queue', QUEUE_REF], {}],
    ['a non-boolean verdict', ['C', QUEUE_REF, 'plain-queue'], { C: undefined }],
    ['no conditions at all', ['C', QUEUE_REF, 'plain-queue'], undefined],
  ])('an Fn::If whose condition cannot be read walks both branches (%s)', async (_l, args, conditions) => {
    const producer = record('AWS::SQS::Queue', QUEUE_URL, {}, { Arn: RECORDED_ARN });
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const base = contextFor(producer, { bag: new Map() });
    const context = {
      ...base,
      template: {
        Resources: {
          Producer: { Type: 'AWS::SQS::Queue', Properties: { QueueName: { 'Fn::If': args } } },
        },
      },
      conditions,
    };
    const resolved = await resolver.resolve({ 'Fn::GetAtt': ['Producer', 'Arn'] }, context as never);
    expect(resolved).toBe(PLAIN_ARN);
  });

  it('a diff context keeps the secret expression and fetches nothing', async () => {
    const resolved = await resolveWith(QUEUE, { 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      bag: new Map(),
      skip: true,
    });
    expect(resolved).toBe(RECORDED_ARN);
    expect(smCalls.count).toBe(0);
    // The reference stays unresolved here, so there is no generation to doubt.
    expect(warnSpy.calls).toEqual([]);
  });

  it('a value under the needle floor proves nothing, even where the physical id contains it', async () => {
    const shortRef = '{{resolve:secretsmanager:sdin:SecretString:short::}}';
    const producer = record('Custom::Thing', 'cr-q1', { Name: shortRef }, { Name: shortRef });
    const resolved = await resolveWith(producer, { 'Fn::GetAtt': ['Producer', 'Name'] }, {
      bag: new Map(),
    });
    expect(resolved).toBe(shortRef);
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

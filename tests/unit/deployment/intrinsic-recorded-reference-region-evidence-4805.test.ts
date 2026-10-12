/**
 * Issue [#4805](https://github.com/go-to-k/cdkd/issues/4805): a value served
 * out of a persisted record carrying a `{{resolve:...}}` reference was
 * re-resolved (go-to-k/cdkd#4800) only when the producer's template spelled the
 * token literally and read no other stack. Every other shape (a name assembled
 * by `Fn::Join` / `Fn::Sub`, CDK's `secretValueFromJson`, a literal beside an
 * imported DLQ, a `GetAtt` chain) sent the `{{resolve:` spelling to AWS. The
 * region is now proven by the deploy's producer-region evidence too: complete,
 * with no producer in another region, a region-less token in this stack's
 * record was resolved here.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  clearRecordedSecretExpressions,
  markSameGenerationBag,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const QUEUE_REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const QUEUE_NAME = 'sdin-q-1';
const RECORDED_ARN = `arn:aws:sqs:us-east-1:123456789012:${QUEUE_REF}`;
const PLAIN_ARN = `arn:aws:sqs:us-east-1:123456789012:${QUEUE_NAME}`;
const QUEUE_URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${QUEUE_NAME}`;

const smCalls = vi.hoisted(() => ({ count: 0 }));
const SDIN_WEST_ARN = vi.hoisted(
  () => 'arn:aws:secretsmanager:us-west-2:123456789012:secret:sdin-AbCdEf'
);
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
        if (command.input?.SecretId === 'sdin' || command.input?.SecretId === SDIN_WEST_ARN) {
          return { SecretString: JSON.stringify({ queue: QUEUE_NAME }) };
        }
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }),
    },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

beforeEach(() => {
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  smCalls.count = 0;
  warnSpy.calls = [];
});

type Evidence = { regions: readonly string[]; complete: boolean } | undefined;

/** CDK's `secret.secretValueFromJson('queue')` on a secret in the same stack. */
const JOINED_NAME = {
  'Fn::Join': [
    '',
    ['{{resolve:secretsmanager:', { Ref: 'Secret' }, ':SecretString:queue::}}'],
  ],
};

function queue(physicalId = QUEUE_URL, arn = RECORDED_ARN): ResourceState {
  return {
    physicalId,
    resourceType: 'AWS::SQS::Queue',
    properties: { QueueName: QUEUE_REF },
    attributes: { Arn: arn },
    dependencies: [],
  } as ResourceState;
}

async function readArn(
  templateProperties: Record<string, unknown>,
  evidence: Evidence | 'absent',
  opts: { bag?: RecordedSecretValues; producer?: ResourceState } = {}
): Promise<unknown> {
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  return await resolver.resolve({ 'Fn::GetAtt': ['Producer', 'Arn'] }, {
    template: {
      Resources: { Producer: { Type: 'AWS::SQS::Queue', Properties: templateProperties } },
    } as CloudFormationTemplate,
    resources: { Producer: opts.producer ?? queue() },
    parameters: {},
    conditions: {},
    recordedSecretValues: opts.bag ?? new Map(),
    ...(evidence !== 'absent' && { secretRegionEvidence: () => evidence }),
  } as never);
}

describe('a recorded reference is re-resolved on producer-region evidence (#4805)', () => {
  it("CDK's secretValueFromJson name: the reader gets the plaintext and persists the reference", async () => {
    const bag: RecordedSecretValues = new Map();
    const resolved = await readArn({ QueueName: JOINED_NAME }, { regions: [], complete: true }, { bag });
    expect(resolved).toBe(PLAIN_ARN);
    const source = { Value: { 'Fn::GetAtt': ['Producer', 'Arn'] } };
    expect(
      redactSecretsForState(markSameGenerationBag({ Value: resolved }), bag, source)
    ).toEqual({ Value: RECORDED_ARN });
  });

  it.each([
    ['an Fn::Sub-assembled name', { QueueName: { 'Fn::Sub': '{{resolve:secretsmanager:${S}:SecretString:queue::}}' } }],
    [
      'a literal name beside an imported dead-letter queue',
      {
        QueueName: QUEUE_REF,
        RedrivePolicy: { deadLetterTargetArn: { 'Fn::ImportValue': 'Dlq' }, maxReceiveCount: 3 },
      },
    ],
    ['a name read by GetAtt from another resource (a chain)', { QueueName: { 'Fn::GetAtt': ['A', 'QueueName'] } }],
    ['a name read from a same-region stack output', { QueueName: { 'Fn::ImportValue': 'Name' } }],
    ['a name read from a parameter', { QueueName: { Ref: 'QueueNameParam' } }],
  ])('%s, with no producer in another region', async (_l, props) => {
    expect(await readArn(props, { regions: [], complete: true })).toBe(PLAIN_ARN);
  });

  it("counts a recorded producer in this stack's own region as local", async () => {
    expect(await readArn({ QueueName: JOINED_NAME }, { regions: ['US-EAST-1'], complete: true })).toBe(
      PLAIN_ARN
    );
  });

  it.each<[string, Evidence | 'absent']>([
    ['a producer on record in another region', { regions: ['us-east-1', 'us-west-2'], complete: true }],
    ['incomplete evidence (a nested child whose parent is unknown)', { regions: [], complete: false }],
    ['no evidence getter (a command other than deploy)', 'absent'],
    ['a getter answering nothing', undefined],
  ])('serves the record as it is with %s', async (_l, evidence) => {
    expect(await readArn({ QueueName: JOINED_NAME }, evidence)).toBe(RECORDED_ARN);
    expect(smCalls.count).toBe(0);
  });

  it('a token naming its region by ARN resolves there, beside a producer on record in that region', async () => {
    const token = `{{resolve:secretsmanager:${SDIN_WEST_ARN}:SecretString:queue::}}`;
    const producer = queue(QUEUE_URL, `arn:aws:sqs:us-east-1:123456789012:${token}`);
    const resolved = await readArn(
      { QueueName: { 'Fn::Join': ['', ['{{resolve:secretsmanager:', SDIN_WEST_ARN, ':SecretString:queue::}}']] } },
      { regions: ['us-west-2'], complete: true },
      { producer }
    );
    expect(resolved).toBe(PLAIN_ARN);
    expect(smCalls.count).toBe(1);
  });

  it('still refuses a value the physical id cannot prove (a rotated secret), with a warning', async () => {
    const rotated = queue(QUEUE_URL.replace(QUEUE_NAME, 'sdin-q-0'));
    expect(
      await readArn({ QueueName: JOINED_NAME }, { regions: [], complete: true }, { producer: rotated })
    ).toBe(RECORDED_ARN);
    expect(warnSpy.calls.join('\n')).toContain('as recorded');
  });

  it('a literal token needs no evidence (go-to-k/cdkd#4800), and asks for none', async () => {
    const evidence = vi.fn(() => ({ regions: ['us-west-2'], complete: true }));
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = await resolver.resolve({ 'Fn::GetAtt': ['Producer', 'Arn'] }, {
      template: {
        Resources: { Producer: { Type: 'AWS::SQS::Queue', Properties: { QueueName: QUEUE_REF } } },
      } as CloudFormationTemplate,
      resources: { Producer: queue() },
      parameters: {},
      conditions: {},
      recordedSecretValues: new Map(),
      secretRegionEvidence: evidence,
    } as never);
    expect(resolved).toBe(PLAIN_ARN);
    expect(evidence).not.toHaveBeenCalled();
  });
});

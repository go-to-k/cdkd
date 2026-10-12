/**
 * Issue [#4802](https://github.com/go-to-k/cdkd/issues/4802): a reader served
 * an attribute of a producer resolved in THIS run records the producer's own
 * (plaintext, reference) pairs the value carries, so it persists the reference
 * form. One case per rule of `recordProducerSecretPairs`, through the real
 * resolver.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  SECRET_MASK,
  clearRecordedSecretExpressions,
  markSameGenerationBag,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

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
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const NAME = 'sdin-q-1';
const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const ARN = `arn:aws:sqs:us-east-1:123456789012:${NAME}`;
const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${NAME}`;

beforeEach(() => {
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
});

/** Resolve `Fn::GetAtt Producer.Arn` with `producer` as the producer's own bag. */
async function read(
  producer: RecordedSecretValues | undefined,
  bag: RecordedSecretValues,
  arn: string = ARN,
  /** `null`: the run loaded no record of the producer. */
  preRun: string | null = URL,
  physicalId: string = URL
): Promise<unknown> {
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  return await resolver.resolve({ 'Fn::GetAtt': ['Producer', 'Arn'] }, {
    template: {
      Resources: { Producer: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } } },
    } as CloudFormationTemplate,
    resources: {
      Producer: {
        physicalId,
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: NAME },
        attributes: { Arn: arn },
        dependencies: [],
      },
    },
    parameters: {},
    conditions: {},
    recordedSecretValues: bag,
    producerSecrets: (id: string) => (id === 'Producer' ? producer : undefined),
    producerPreRunPhysicalId: (id: string) => (id === 'Producer' ? (preRun ?? undefined) : undefined),
  } as never);
}

describe("a reader of an in-run producer's attribute (#4802)", () => {
  it("records the producer's pair the value carries, so the reader persists the reference", async () => {
    const bag: RecordedSecretValues = new Map();
    const resolved = await read(new Map([[NAME, REF]]), bag);
    expect(resolved).toBe(ARN);
    expect(bag.get(NAME)).toBe(REF);
    const source = { Value: { 'Fn::GetAtt': ['Producer', 'Arn'] } };
    expect(
      redactSecretsForState(markSameGenerationBag({ Value: resolved }), bag, source)
    ).toEqual({ Value: `arn:aws:sqs:us-east-1:123456789012:${REF}` });
  });

  it('records nothing for a producer not resolved this run', async () => {
    const bag: RecordedSecretValues = new Map();
    await read(undefined, bag);
    expect(bag.size).toBe(0);
  });

  it.each([
    ['a mask-only entry (the NoEcho arms answer it)', new Map([[NAME, SECRET_MASK]])],
    ['a plaintext under the needle floor', new Map([['q-1', REF]])],
  ])('skips %s', async (_l, producer) => {
    const bag: RecordedSecretValues = new Map();
    await read(producer as RecordedSecretValues, bag);
    expect(bag.size).toBe(0);
  });

  it('skips a pair the served value does not carry', async () => {
    // The pair passes every other gate (the loaded id embeds NAME); only the
    // value lacks it.
    const bag: RecordedSecretValues = new Map();
    await read(new Map([[NAME, REF]]), bag, 'arn:aws:sqs:us-east-1:123456789012:unrelated');
    expect(bag.size).toBe(0);
  });

  it.each([
    ['an array', [ARN, 'unrelated']],
    ['an object', { Arn: ARN, Other: 'unrelated' }],
  ])('walks the leaves of %s-valued attribute', async (_l, value) => {
    const bag: RecordedSecretValues = new Map();
    await read(new Map([[NAME, REF]]), bag, value as never);
    expect(bag.get(NAME)).toBe(REF);
  });

  it.each([
    ['a producer CREATED this run (no loaded id)', null, URL],
    ['a producer REPLACED this run (a new id)', URL, URL.replace(NAME, 'sdin-q-2')],
  ])('copies nothing for %s', async (_l, preRun, physicalId) => {
    const bag: RecordedSecretValues = new Map();
    await read(new Map([[NAME, REF]]), bag, ARN, preRun, physicalId);
    expect(bag.size).toBe(0);
  });

  it("copies only a plaintext the producer's loaded id embeds", async () => {
    // `arn:aws:sqs` is in the ARN the reader is served, never in a queue URL.
    const bag: RecordedSecretValues = new Map();
    await read(new Map([['arn:aws:sqs', REF]]), bag);
    expect(bag.size).toBe(0);
  });

  it("matches the loaded id case-insensitively, as go-to-k/cdkd#4800's check does", async () => {
    const upper = URL.replace(NAME, NAME.toUpperCase());
    const bag: RecordedSecretValues = new Map();
    await read(new Map([[NAME, REF]]), bag, ARN, upper, upper);
    expect(bag.get(NAME)).toBe(REF);
  });

  it("never overwrites a pair the reader's own resolution recorded", async () => {
    const own = '{{resolve:secretsmanager:mine:SecretString:q::}}';
    const bag: RecordedSecretValues = new Map([[NAME, own]]);
    await read(new Map([[NAME, REF]]), bag);
    expect(bag.get(NAME)).toBe(own);
  });
});

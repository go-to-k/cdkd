/**
 * Issue [#4819](https://github.com/go-to-k/cdkd/issues/4819): a reader's copy
 * of a secret-named resource's physical id is kept as the id is (go-to-k/cdkd#4810)
 * only for a copy read by `Ref` / `Fn::GetAtt` in the same stack. Two more
 * sources are covered here:
 *
 * - the `NoEcho` twin: a queue named from a `NoEcho` parameter, read by a reader
 *   that also reads the parameter, so the reader's bag carries the value as a
 *   CONTAINMENT needle and the URL copy was flattened to `***`;
 * - a cross-stack read (`Fn::ImportValue`): the producer stored the URL in
 *   plaintext, and the consumer's bag holding the name rewrote it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  SECRET_MASK,
  clearRecordedSecretExpressions,
  markSameGenerationBag,
  recordNoEchoParameterFreshValue,
  recordPhysicalNameCopy,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const NAME = 'sdin-q-1';
const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${NAME}`;

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
      send: vi.fn(async () => ({ SecretString: JSON.stringify({ queue: NAME }) })),
    },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

beforeEach(() => {
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
});

/** A state backend whose `Producer` stack records the queue (URL) as a physical id. */
function producerBackend(ids: string[] = [URL]) {
  const resources = Object.fromEntries(ids.map((id, i) => [`R${i}`, { physicalId: id }]));
  return {
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => ({ state: { resources }, etag: 'e' })),
  };
}

describe('a reader copy of a physical id from other sources (#4819)', () => {
  it('the NoEcho containment arm keeps a copy, and still flattens the value elsewhere', () => {
    const bag: RecordedSecretValues = new Map();
    recordNoEchoParameterFreshValue(NAME, bag);
    recordPhysicalNameCopy(bag, URL);
    expect(
      redactSecretsForState({ Queues: [URL], Other: `name=${NAME}` }, bag)
    ).toEqual({ Queues: [URL], Other: SECRET_MASK });
  });

  it('control: without the copy, the NoEcho containment arm flattens the URL', () => {
    const bag: RecordedSecretValues = new Map();
    recordNoEchoParameterFreshValue(NAME, bag);
    expect(redactSecretsForState({ Queues: [URL] }, bag)).toEqual({ Queues: [SECRET_MASK] });
  });

  it("an Fn::ImportValue of a plaintext URL is kept, beside the reader's own literal reference", async () => {
    // The producer stored its exported URL in plaintext (its own physical id
    // read by `Ref`); the consumer reads it and also spells the reference.
    const exportIndex = {
      lookup: vi.fn(async () => ({
        value: URL,
        producerStack: 'Producer',
        producerRegion: 'us-east-1',
      })),
    };
    const bag: RecordedSecretValues = new Map();
    const source = {
      Queues: [{ 'Fn::ImportValue': 'QueueUrl' }],
      Resource: `arn:aws:sqs:us-east-1:123456789012:${REF}`,
    };
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const resolved = (await resolver.resolve(source, {
      template: { Resources: {} } as CloudFormationTemplate,
      resources: {},
      parameters: {},
      conditions: {},
      stackName: 'Consumer',
      stateBackend: producerBackend(),
      exportIndex,
      recordedImports: [],
      recordedSecretValues: bag,
    } as never)) as Record<string, unknown>;
    // Premise: the import resolved, and the literal reference put the name in the bag.
    expect(resolved['Queues']).toEqual([URL]);
    expect(bag.get(NAME)).toBe(REF);
    expect(redactSecretsForState(markSameGenerationBag({ ...resolved }), bag, source)).toEqual({
      Queues: [URL],
      Resource: `arn:aws:sqs:us-east-1:123456789012:${REF}`,
    });
  });

  it.each([
    ['a same-account producer output holding one of its physical ids', [URL], 'us-east-1', { crossAccount: false }, [URL]],
    [
      'a producer output that is NOT a physical id (a plaintext a scrub has not reached)',
      ['https://sqs.us-east-1.amazonaws.com/123456789012/other'],
      'us-east-1',
      { crossAccount: false },
      [`https://sqs.us-east-1.amazonaws.com/123456789012/${REF}`],
    ],
    [
      "a read across an ACCOUNT boundary (its bucket is not this account's)",
      [URL],
      'us-east-1',
      { crossAccount: true },
      [`https://sqs.us-east-1.amazonaws.com/123456789012/${REF}`],
    ],
    [
      'a read naming no producer stack (a nested Outputs read, this stack\'s own value)',
      [URL],
      'us-east-1',
      undefined,
      [`https://sqs.us-east-1.amazonaws.com/123456789012/${REF}`],
    ],
  ])('a cross-stack plaintext is a copy only for %s', async (_l, ids, region, output, want) => {
    const bag: RecordedSecretValues = new Map([[NAME, REF]]);
    const resolver = new IntrinsicFunctionResolver('us-east-1') as unknown as {
      reresolveCrossStackValue: (...args: unknown[]) => Promise<unknown>;
    };
    const producerOutput =
      output === undefined
        ? undefined
        : { stackName: 'Producer', region: 'us-east-1', outputKey: 'QueueUrl', ...output };
    await resolver.reresolveCrossStackValue(
      URL,
      region,
      {
        template: { Resources: {} },
        resources: {},
        recordedSecretValues: bag,
        stateBackend: producerBackend(ids),
      },
      'origin',
      undefined,
      producerOutput
    );
    expect(redactSecretsForState({ Queues: [URL] }, bag)).toEqual({ Queues: want });
  });

  it('a producer whose state cannot be read keeps nothing (fail closed)', async () => {
    const bag: RecordedSecretValues = new Map([[NAME, REF]]);
    const resolver = new IntrinsicFunctionResolver('us-east-1') as unknown as {
      reresolveCrossStackValue: (...args: unknown[]) => Promise<unknown>;
    };
    await resolver.reresolveCrossStackValue(
      URL,
      'us-east-1',
      {
        template: { Resources: {} },
        resources: {},
        recordedSecretValues: bag,
        stateBackend: { getState: vi.fn(async () => Promise.reject(new Error('AccessDenied'))) },
      },
      'origin',
      undefined,
      { stackName: 'Producer', region: 'us-east-1', outputKey: 'QueueUrl' }
    );
    expect(redactSecretsForState({ Queues: [URL] }, bag)).toEqual({
      Queues: [`https://sqs.us-east-1.amazonaws.com/123456789012/${REF}`],
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { Readable } from 'node:stream';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';

/**
 * go-to-k/cdkd#5432: `EvaluatorConfig.LlmAsAJudge.RatingScale.MultiDimensional`
 * must reach the wire, and come back from it. Below
 * `@aws-sdk/client-bedrock-agentcore-control` 3.1156.0 the `RatingScale`
 * union has no `multiDimensional` member, so the SDK's own serializer drops
 * the block from `CreateEvaluator` / `UpdateEvaluator` and its deserializer
 * drops it from `GetEvaluator` — the provider's command input carries it
 * either way, which is why these tests run the real client down to the HTTP
 * request and stub only the handler.
 */

interface Sent {
  path: string;
  body: Record<string, unknown>;
}
const sent: Sent[] = [];
let getEvaluatorBody: Record<string, unknown> = {};

const client = new BedrockAgentCoreControlClient({
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
  maxAttempts: 1,
  requestHandler: {
    handle: async (request: { path: string; method: string; body?: unknown }) => {
      // The JSON body arrives as a Buffer-like chunk, not a string.
      const text = request.body === undefined ? '' : String(request.body);
      sent.push({ path: request.path, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      const answer =
        request.method === 'GET' && request.path.includes('/tags/')
          ? { tags: {} }
          : request.method === 'GET'
            ? getEvaluatorBody
            : {
                evaluatorArn: EVALUATOR_ARN,
                evaluatorId: EVALUATOR_ID,
                status: 'ACTIVE',
                createdAt: 1_790_000_000,
                updatedAt: 1_790_000_000,
              };
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: Readable.from([Buffer.from(JSON.stringify(answer))]),
        },
      };
    },
  } as never,
});

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ bedrockAgentCoreControl: client }),
}));

import { AgentCoreEvaluatorProvider } from '../../../../src/provisioning/providers/agentcore-evaluator-provider.js';

const EVALUATOR_ID = 'ev-1';
const EVALUATOR_ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/${EVALUATOR_ID}`;
const RESOURCE_TYPE = 'AWS::BedrockAgentCore::Evaluator';
const MODEL_CONFIG = {
  BedrockEvaluatorModelConfig: { ModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
};

const MULTI_DIMENSIONAL = [
  {
    DimensionName: 'accuracy',
    DimensionInstruction: 'Is the answer correct?',
    DimensionRatingScale: { Numerical: [{ Value: 1, Label: 'wrong', Definition: 'incorrect' }] },
  },
  {
    DimensionName: 'tone',
    DimensionInstruction: 'Is the answer polite?',
    DimensionRatingScale: { Categorical: [{ Label: 'polite', Definition: 'courteous' }] },
  },
];
const MULTI_DIMENSIONAL_WIRE = [
  {
    dimensionName: 'accuracy',
    dimensionInstruction: 'Is the answer correct?',
    dimensionRatingScale: { numerical: [{ value: 1, label: 'wrong', definition: 'incorrect' }] },
  },
  {
    dimensionName: 'tone',
    dimensionInstruction: 'Is the answer polite?',
    dimensionRatingScale: { categorical: [{ label: 'polite', definition: 'courteous' }] },
  },
];

const config = (ratingScale: Record<string, unknown>) => ({
  LlmAsAJudge: { Instructions: 'Judge it.', RatingScale: ratingScale, ModelConfig: MODEL_CONFIG },
});
const props = (ratingScale: Record<string, unknown>) => ({
  EvaluatorName: 'my_evaluator',
  Level: 'TRACE',
  EvaluatorConfig: config(ratingScale),
});

/** The `ratingScale` the one write request carried on the wire. */
function sentRatingScale(): unknown {
  const writes = sent.filter((s) => s.path.startsWith('/evaluators'));
  expect(writes).toHaveLength(1);
  const evaluatorConfig = writes[0]!.body['evaluatorConfig'] as {
    llmAsAJudge: { ratingScale: unknown };
  };
  return evaluatorConfig.llmAsAJudge.ratingScale;
}

describe('AgentCoreEvaluatorProvider: a multi-dimensional rating scale on the wire (#5432)', () => {
  let provider: AgentCoreEvaluatorProvider;

  beforeEach(() => {
    sent.length = 0;
    provider = new AgentCoreEvaluatorProvider();
  });

  it('create sends MultiDimensional in the CreateEvaluator body', async () => {
    await provider.create('Ev', RESOURCE_TYPE, props({ MultiDimensional: MULTI_DIMENSIONAL }));

    expect(sentRatingScale()).toEqual({ multiDimensional: MULTI_DIMENSIONAL_WIRE });
  });

  it('create sends no multiDimensional member for a single-scale evaluator', async () => {
    const numerical = [{ Value: 1, Label: 'bad', Definition: 'poor' }];
    await provider.create('Ev', RESOURCE_TYPE, props({ Numerical: numerical }));

    expect(sentRatingScale()).toEqual({
      numerical: [{ value: 1, label: 'bad', definition: 'poor' }],
    });
  });

  it('update sends a MultiDimensional the previous config lacked', async () => {
    const numerical = [{ Value: 1, Label: 'bad', Definition: 'poor' }];
    await provider.update(
      'Ev',
      EVALUATOR_ARN,
      RESOURCE_TYPE,
      props({ MultiDimensional: MULTI_DIMENSIONAL }),
      props({ Numerical: numerical })
    );

    expect(sentRatingScale()).toEqual({ multiDimensional: MULTI_DIMENSIONAL_WIRE });
  });

  it('readCurrentState surfaces the MultiDimensional GetEvaluator returns, in CFn shape', async () => {
    getEvaluatorBody = {
      evaluatorArn: EVALUATOR_ARN,
      evaluatorId: EVALUATOR_ID,
      evaluatorName: 'my_evaluator',
      level: 'TRACE',
      status: 'ACTIVE',
      evaluatorConfig: {
        llmAsAJudge: {
          instructions: 'Judge it.',
          ratingScale: { multiDimensional: MULTI_DIMENSIONAL_WIRE },
          modelConfig: {
            bedrockEvaluatorModelConfig: { modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
          },
        },
      },
    };

    const observed = (await provider.readCurrentState(EVALUATOR_ARN, 'Ev', RESOURCE_TYPE)) as
      | Record<string, unknown>
      | undefined;

    expect(observed?.['EvaluatorConfig']).toEqual(config({ MultiDimensional: MULTI_DIMENSIONAL }));
  });
});

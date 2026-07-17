import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    bedrockAgentCoreControl: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
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

import { AgentCoreEvaluatorProvider } from '../../../../src/provisioning/providers/agentcore-evaluator-provider.js';

const EVALUATOR_ID = 'my_evaluator-Ab12Cd34Ef';
const EVALUATOR_ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/${EVALUATOR_ID}`;
const RESOURCE_TYPE = 'AWS::BedrockAgentCore::Evaluator';

describe('AgentCoreEvaluatorProvider read-update round-trip', () => {
  let provider: AgentCoreEvaluatorProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentCoreEvaluatorProvider();
  });

  it('round-trip: readCurrentState placeholders survive update() without AWS-invalid inputs', async () => {
    // Mechanical guard for the latent bug classes documented in
    // docs/provider-development.md § "Read-update round-trip test":
    // a `cdkd drift --revert` feeds a readCurrentState snapshot back
    // through update(), so every always-emit placeholder must produce
    // a valid UpdateEvaluator input.

    // Step 1: AWS-minimum GetEvaluator response — required fields only,
    // optionals (description, kmsKeyArn) undefined; no tags.
    mockSend
      .mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        evaluatorName: 'my_evaluator',
        evaluatorConfig: {
          codeBased: {
            lambdaConfig: {
              lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-eval-fn',
            },
          },
        },
        level: 'TRACE',
        status: 'ACTIVE',
      })
      .mockResolvedValueOnce({ tags: {} });

    const observed = await provider.readCurrentState(EVALUATOR_ARN, 'L', RESOURCE_TYPE);

    // Always-emit placeholder contract: absent description surfaces as ''.
    expect(observed?.['Description']).toBe('');
    expect(observed?.['Tags']).toEqual([]);
    // Optionals AWS did not surface must stay absent (not null/'' shims
    // that would then reach UpdateEvaluator with a bogus value).
    expect(observed).not.toHaveProperty('KmsKeyArn');

    // Step 2: round-trip the snapshot through update() (no drift — a
    // logical no-op on AWS).
    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({
      evaluatorArn: EVALUATOR_ARN,
      evaluatorId: EVALUATOR_ID,
      status: 'ACTIVE',
      updatedAt: new Date('2026-07-17T00:00:00Z'),
    });

    await provider.update('L', EVALUATOR_ARN, RESOURCE_TYPE, observed!, observed!);

    // Only the UpdateEvaluator call — equal tags produce no tag API calls.
    expect(mockSend).toHaveBeenCalledTimes(1);
    const updateCall = mockSend.mock.calls[0][0];
    expect(updateCall.constructor.name).toBe('UpdateEvaluatorCommand');
    expect(updateCall.input.evaluatorId).toBe(EVALUATOR_ID);
    // Truthy-gate guard: the '' placeholder must REACH the update input
    // (a truthy gate would silently drop it — the drift --revert silent
    // fail mode).
    expect(updateCall.input.description).toBe('');
    expect(updateCall.input.level).toBe('TRACE');
    // The config must round-trip back to the exact SDK camelCase shape.
    expect(updateCall.input.evaluatorConfig).toEqual({
      codeBased: {
        lambdaConfig: {
          lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-eval-fn',
        },
      },
    });
    // createOnly / absent optionals must NOT sneak into the input.
    expect(updateCall.input.evaluatorName).toBeUndefined();
    expect(updateCall.input.kmsKeyArn).toBeUndefined();
  });

  it('round-trip: additionalModelRequestFields survives read -> update verbatim', async () => {
    mockSend
      .mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        evaluatorName: 'my_evaluator',
        evaluatorConfig: {
          llmAsAJudge: {
            instructions: 'Rate.',
            ratingScale: { numerical: [{ value: 1, label: 'Bad', definition: 'Poor' }] },
            modelConfig: {
              bedrockEvaluatorModelConfig: {
                modelId: 'model-id',
                additionalModelRequestFields: { top_k: 40, Nested_Doc: { keep_me: true } },
              },
            },
          },
        },
        level: 'SESSION',
        status: 'ACTIVE',
      })
      .mockResolvedValueOnce({ tags: {} });

    const observed = await provider.readCurrentState(EVALUATOR_ARN, 'L', RESOURCE_TYPE);

    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({
      evaluatorArn: EVALUATOR_ARN,
      evaluatorId: EVALUATOR_ID,
      status: 'ACTIVE',
      updatedAt: new Date('2026-07-17T00:00:00Z'),
    });

    await provider.update('L', EVALUATOR_ARN, RESOURCE_TYPE, observed!, observed!);

    const updateCall = mockSend.mock.calls[0][0];
    // The free-form document must arrive back at the SDK byte-identical
    // (no case conversion applied on either leg of the round-trip).
    expect(
      updateCall.input.evaluatorConfig.llmAsAJudge.modelConfig.bedrockEvaluatorModelConfig
        .additionalModelRequestFields
    ).toEqual({ top_k: 40, Nested_Doc: { keep_me: true } });
  });
});

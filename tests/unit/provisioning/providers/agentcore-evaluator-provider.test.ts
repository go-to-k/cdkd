import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ResourceNotFoundException } from '@aws-sdk/client-bedrock-agentcore-control';

// Mock AWS clients before importing the provider
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

import {
  AgentCoreEvaluatorProvider,
  evaluatorIdFromArn,
} from '../../../../src/provisioning/providers/agentcore-evaluator-provider.js';

const EVALUATOR_ID = 'my-evaluator-Ab12Cd34Ef';
const EVALUATOR_ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/${EVALUATOR_ID}`;

const LLM_JUDGE_CONFIG = {
  LlmAsAJudge: {
    Instructions: 'Rate the agent response quality.',
    RatingScale: {
      Numerical: [{ Value: 1, Label: 'Bad', Definition: 'Poor quality' }],
    },
    ModelConfig: {
      BedrockEvaluatorModelConfig: {
        ModelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        InferenceConfig: { Temperature: 0.5, MaxTokens: 512 },
        AdditionalModelRequestFields: { top_k: 40, Custom_Field: 'verbatim' },
      },
    },
  },
};

const CODE_BASED_CONFIG = {
  CodeBased: {
    LambdaConfig: {
      LambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-eval-fn',
      LambdaTimeoutInSeconds: 60,
    },
  },
};

describe('evaluatorIdFromArn', () => {
  it('should extract the id from an evaluator ARN', () => {
    expect(evaluatorIdFromArn(EVALUATOR_ARN)).toBe(EVALUATOR_ID);
  });

  it('should pass a bare id through verbatim', () => {
    expect(evaluatorIdFromArn(EVALUATOR_ID)).toBe(EVALUATOR_ID);
  });
});

describe('AgentCoreEvaluatorProvider', () => {
  let provider: AgentCoreEvaluatorProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentCoreEvaluatorProvider();
  });

  describe('create', () => {
    it('should create an evaluator with a code-based config', async () => {
      mockSend.mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        createdAt: new Date('2026-07-17T00:00:00Z'),
      });

      const result = await provider.create('MyEvaluator', 'AWS::BedrockAgentCore::Evaluator', {
        EvaluatorName: 'my-evaluator',
        EvaluatorConfig: CODE_BASED_CONFIG,
        Level: 'TRACE',
        Description: 'Test evaluator',
      });

      expect(result.physicalId).toBe(EVALUATOR_ARN);
      expect(result.attributes).toEqual({
        EvaluatorArn: EVALUATOR_ARN,
        EvaluatorId: EVALUATOR_ID,
        Status: 'ACTIVE',
        CreatedAt: '2026-07-17T00:00:00.000Z',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateEvaluatorCommand');
      expect(createCall.input.evaluatorName).toBe('my-evaluator');
      expect(createCall.input.level).toBe('TRACE');
      expect(createCall.input.description).toBe('Test evaluator');
      expect(createCall.input.evaluatorConfig).toEqual({
        codeBased: {
          lambdaConfig: {
            lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-eval-fn',
            lambdaTimeoutInSeconds: 60,
          },
        },
      });
    });

    it('should convert an LLM-as-a-Judge config to camelCase but preserve AdditionalModelRequestFields verbatim', async () => {
      mockSend.mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        createdAt: new Date('2026-07-17T00:00:00Z'),
      });

      await provider.create('MyEvaluator', 'AWS::BedrockAgentCore::Evaluator', {
        EvaluatorName: 'my-evaluator',
        EvaluatorConfig: LLM_JUDGE_CONFIG,
        Level: 'SESSION',
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.evaluatorConfig).toEqual({
        llmAsAJudge: {
          instructions: 'Rate the agent response quality.',
          ratingScale: {
            numerical: [{ value: 1, label: 'Bad', definition: 'Poor quality' }],
          },
          modelConfig: {
            bedrockEvaluatorModelConfig: {
              modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
              inferenceConfig: { temperature: 0.5, maxTokens: 512 },
              // Free-form model request fields must NOT be case-converted.
              additionalModelRequestFields: { top_k: 40, Custom_Field: 'verbatim' },
            },
          },
        },
      });
    });

    it('should wire KmsKeyArn into the create input', async () => {
      mockSend.mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        createdAt: new Date('2026-07-17T00:00:00Z'),
      });

      await provider.create('MyEvaluator', 'AWS::BedrockAgentCore::Evaluator', {
        EvaluatorName: 'my-evaluator',
        EvaluatorConfig: CODE_BASED_CONFIG,
        Level: 'TRACE',
        KmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.kmsKeyArn).toBe(
        'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555'
      );
    });

    it('should convert the CFn tag list to the SDK tag map', async () => {
      mockSend.mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        createdAt: new Date('2026-07-17T00:00:00Z'),
      });

      await provider.create('MyEvaluator', 'AWS::BedrockAgentCore::Evaluator', {
        EvaluatorName: 'my-evaluator',
        EvaluatorConfig: CODE_BASED_CONFIG,
        Level: 'TOOL_CALL',
        Tags: [
          { Key: 'env', Value: 'test' },
          { Key: 'team', Value: 'agents' },
        ],
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.tags).toEqual({ env: 'test', team: 'agents' });
    });

    it.each([
      [{ EvaluatorConfig: CODE_BASED_CONFIG, Level: 'TRACE' }, 'EvaluatorName is required'],
      [{ EvaluatorName: 'my-evaluator', Level: 'TRACE' }, 'EvaluatorConfig is required'],
      [
        { EvaluatorName: 'my-evaluator', EvaluatorConfig: CODE_BASED_CONFIG },
        'Level is required',
      ],
    ])('should throw ProvisioningError when a required property is missing', async (props, msg) => {
      await expect(
        provider.create('MyEvaluator', 'AWS::BedrockAgentCore::Evaluator', props)
      ).rejects.toThrow(msg);
    });

    it('should throw ProvisioningError on SDK failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.create('MyEvaluator', 'AWS::BedrockAgentCore::Evaluator', {
          EvaluatorName: 'my-evaluator',
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'TRACE',
        })
      ).rejects.toThrow('Failed to create BedrockAgentCore Evaluator MyEvaluator');
    });
  });

  describe('update', () => {
    it('should update mutable properties via UpdateEvaluator with the id extracted from the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        updatedAt: new Date('2026-07-17T01:00:00Z'),
      });

      const result = await provider.update(
        'MyEvaluator',
        EVALUATOR_ARN,
        'AWS::BedrockAgentCore::Evaluator',
        {
          EvaluatorName: 'my-evaluator',
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'SESSION',
          Description: 'Updated description',
        },
        {
          EvaluatorName: 'my-evaluator',
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'TRACE',
          Description: 'Old description',
        }
      );

      expect(result.physicalId).toBe(EVALUATOR_ARN);
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({
        EvaluatorArn: EVALUATOR_ARN,
        EvaluatorId: EVALUATOR_ID,
        Status: 'ACTIVE',
        UpdatedAt: '2026-07-17T01:00:00.000Z',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const updateCall = mockSend.mock.calls[0][0];
      expect(updateCall.constructor.name).toBe('UpdateEvaluatorCommand');
      expect(updateCall.input.evaluatorId).toBe(EVALUATOR_ID);
      expect(updateCall.input.level).toBe('SESSION');
      expect(updateCall.input.description).toBe('Updated description');
      // EvaluatorName is createOnly: never part of the update input.
      expect(updateCall.input.evaluatorName).toBeUndefined();
    });

    it('should sync tag changes via UntagResource and TagResource', async () => {
      mockSend.mockResolvedValue({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        updatedAt: new Date('2026-07-17T01:00:00Z'),
      });

      await provider.update(
        'MyEvaluator',
        EVALUATOR_ARN,
        'AWS::BedrockAgentCore::Evaluator',
        {
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'TRACE',
          Tags: [
            { Key: 'env', Value: 'prod' },
            { Key: 'new', Value: 'yes' },
          ],
        },
        {
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'TRACE',
          Tags: [
            { Key: 'env', Value: 'test' },
            { Key: 'obsolete', Value: 'yes' },
          ],
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(3);
      const untagCall = mockSend.mock.calls[1][0];
      expect(untagCall.constructor.name).toBe('UntagResourceCommand');
      expect(untagCall.input.resourceArn).toBe(EVALUATOR_ARN);
      expect(untagCall.input.tagKeys).toEqual(['obsolete']);
      const tagCall = mockSend.mock.calls[2][0];
      expect(tagCall.constructor.name).toBe('TagResourceCommand');
      expect(tagCall.input.resourceArn).toBe(EVALUATOR_ARN);
      expect(tagCall.input.tags).toEqual({ env: 'prod', new: 'yes' });
    });

    it('should untag everything (and never call TagResource) when Tags is removed entirely', async () => {
      mockSend.mockResolvedValue({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        updatedAt: new Date('2026-07-17T01:00:00Z'),
      });

      await provider.update(
        'MyEvaluator',
        EVALUATOR_ARN,
        'AWS::BedrockAgentCore::Evaluator',
        { EvaluatorConfig: CODE_BASED_CONFIG, Level: 'TRACE' },
        {
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'TRACE',
          Tags: [
            { Key: 'env', Value: 'test' },
            { Key: 'team', Value: 'agents' },
          ],
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(2);
      const untagCall = mockSend.mock.calls[1][0];
      expect(untagCall.constructor.name).toBe('UntagResourceCommand');
      expect(untagCall.input.tagKeys.sort()).toEqual(['env', 'team']);
    });

    it('should only call TagResource when tags are added to a previously untagged evaluator', async () => {
      mockSend.mockResolvedValue({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        updatedAt: new Date('2026-07-17T01:00:00Z'),
      });

      await provider.update(
        'MyEvaluator',
        EVALUATOR_ARN,
        'AWS::BedrockAgentCore::Evaluator',
        {
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'TRACE',
          Tags: [{ Key: 'env', Value: 'test' }],
        },
        { EvaluatorConfig: CODE_BASED_CONFIG, Level: 'TRACE' }
      );

      expect(mockSend).toHaveBeenCalledTimes(2);
      const tagCall = mockSend.mock.calls[1][0];
      expect(tagCall.constructor.name).toBe('TagResourceCommand');
      expect(tagCall.input.tags).toEqual({ env: 'test' });
    });

    it('should wire KmsKeyArn into the update input', async () => {
      mockSend.mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        updatedAt: new Date('2026-07-17T01:00:00Z'),
      });

      await provider.update(
        'MyEvaluator',
        EVALUATOR_ARN,
        'AWS::BedrockAgentCore::Evaluator',
        {
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'TRACE',
          KmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
        },
        { EvaluatorConfig: CODE_BASED_CONFIG, Level: 'TRACE' }
      );

      const updateCall = mockSend.mock.calls[0][0];
      expect(updateCall.input.kmsKeyArn).toBe(
        'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555'
      );
    });

    it('should not call tag APIs when tags are unchanged', async () => {
      mockSend.mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        updatedAt: new Date('2026-07-17T01:00:00Z'),
      });

      await provider.update(
        'MyEvaluator',
        EVALUATOR_ARN,
        'AWS::BedrockAgentCore::Evaluator',
        {
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'TRACE',
          Tags: [{ Key: 'env', Value: 'test' }],
        },
        {
          EvaluatorConfig: CODE_BASED_CONFIG,
          Level: 'TRACE',
          Tags: [{ Key: 'env', Value: 'test' }],
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should throw ProvisioningError on SDK failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Throttling'));

      await expect(
        provider.update(
          'MyEvaluator',
          EVALUATOR_ARN,
          'AWS::BedrockAgentCore::Evaluator',
          { EvaluatorConfig: CODE_BASED_CONFIG, Level: 'TRACE' },
          { EvaluatorConfig: CODE_BASED_CONFIG, Level: 'TRACE' }
        )
      ).rejects.toThrow('Failed to update BedrockAgentCore Evaluator MyEvaluator');
    });
  });

  describe('delete', () => {
    it('should delete an evaluator with the id extracted from the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'DELETING',
      });

      await provider.delete('MyEvaluator', EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const deleteCall = mockSend.mock.calls[0][0];
      expect(deleteCall.constructor.name).toBe('DeleteEvaluatorCommand');
      expect(deleteCall.input.evaluatorId).toBe(EVALUATOR_ID);
    });

    it('should skip deletion when the evaluator does not exist (ResourceNotFoundException)', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ $metadata: {}, message: 'not found' })
      );

      await provider.delete('MyEvaluator', EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator', undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should fail loudly when NotFound arrives from a mismatched region', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ $metadata: {}, message: 'not found' })
      );

      await expect(
        provider.delete('MyEvaluator', EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator', undefined, {
          expectedRegion: 'eu-west-1',
        })
      ).rejects.toThrow(/region/i);
    });

    it('should throw ProvisioningError on unexpected failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.delete('MyEvaluator', EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator')
      ).rejects.toThrow('Failed to delete BedrockAgentCore Evaluator MyEvaluator');
    });
  });

  describe('getAttribute', () => {
    it('should return EvaluatorArn and EvaluatorId without AWS calls', async () => {
      await expect(
        provider.getAttribute(EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator', 'EvaluatorArn')
      ).resolves.toBe(EVALUATOR_ARN);
      await expect(
        provider.getAttribute(EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator', 'EvaluatorId')
      ).resolves.toBe(EVALUATOR_ID);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should fetch Status / CreatedAt / UpdatedAt live via GetEvaluator', async () => {
      mockSend.mockResolvedValue({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
        createdAt: new Date('2026-07-17T00:00:00Z'),
        updatedAt: new Date('2026-07-17T01:00:00Z'),
      });

      await expect(
        provider.getAttribute(EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator', 'Status')
      ).resolves.toBe('ACTIVE');
      await expect(
        provider.getAttribute(EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator', 'CreatedAt')
      ).resolves.toBe('2026-07-17T00:00:00.000Z');
      await expect(
        provider.getAttribute(EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator', 'UpdatedAt')
      ).resolves.toBe('2026-07-17T01:00:00.000Z');

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetEvaluatorCommand');
      expect(getCall.input.evaluatorId).toBe(EVALUATOR_ID);
    });

    it('should throw on unsupported attribute', async () => {
      await expect(
        provider.getAttribute(EVALUATOR_ARN, 'AWS::BedrockAgentCore::Evaluator', 'Bogus')
      ).rejects.toThrow('Unsupported attribute: Bogus');
    });
  });

  describe('readCurrentState', () => {
    it('should surface the CFn-shaped current state incl. tags', async () => {
      mockSend
        .mockResolvedValueOnce({
          evaluatorArn: EVALUATOR_ARN,
          evaluatorId: EVALUATOR_ID,
          evaluatorName: 'my-evaluator',
          description: 'Test evaluator',
          evaluatorConfig: {
            codeBased: {
              lambdaConfig: {
                lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-eval-fn',
                lambdaTimeoutInSeconds: 60,
              },
            },
          },
          level: 'TRACE',
          status: 'ACTIVE',
        })
        .mockResolvedValueOnce({ tags: { env: 'test' } });

      const state = await provider.readCurrentState(
        EVALUATOR_ARN,
        'MyEvaluator',
        'AWS::BedrockAgentCore::Evaluator'
      );

      expect(state).toEqual({
        EvaluatorName: 'my-evaluator',
        Description: 'Test evaluator',
        EvaluatorConfig: CODE_BASED_CONFIG,
        Level: 'TRACE',
        Tags: [{ Key: 'env', Value: 'test' }],
      });
    });

    it('should preserve additionalModelRequestFields keys verbatim on the read path', async () => {
      mockSend
        .mockResolvedValueOnce({
          evaluatorArn: EVALUATOR_ARN,
          evaluatorId: EVALUATOR_ID,
          evaluatorName: 'my-evaluator',
          evaluatorConfig: {
            llmAsAJudge: {
              instructions: 'Rate.',
              ratingScale: { numerical: [{ value: 1, label: 'Bad', definition: 'Poor' }] },
              modelConfig: {
                bedrockEvaluatorModelConfig: {
                  modelId: 'model-id',
                  additionalModelRequestFields: { top_k: 40, Custom_Field: 'verbatim' },
                },
              },
            },
          },
          level: 'SESSION',
          status: 'ACTIVE',
        })
        .mockResolvedValueOnce({ tags: {} });

      const state = await provider.readCurrentState(
        EVALUATOR_ARN,
        'MyEvaluator',
        'AWS::BedrockAgentCore::Evaluator'
      );

      expect(
        (state as Record<string, any>)['EvaluatorConfig'].LlmAsAJudge.ModelConfig
          .BedrockEvaluatorModelConfig.AdditionalModelRequestFields
      ).toEqual({ top_k: 40, Custom_Field: 'verbatim' });
    });

    it('should return undefined when the evaluator is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ $metadata: {}, message: 'not found' })
      );

      await expect(
        provider.readCurrentState(EVALUATOR_ARN, 'MyEvaluator', 'AWS::BedrockAgentCore::Evaluator')
      ).resolves.toBeUndefined();
    });
  });

  describe('import', () => {
    it('should accept an evaluator ARN verbatim', async () => {
      const result = await provider.import({
        logicalId: 'MyEvaluator',
        resourceType: 'AWS::BedrockAgentCore::Evaluator',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: EVALUATOR_ARN,
      });

      expect(result).toEqual({
        physicalId: EVALUATOR_ARN,
        attributes: { EvaluatorArn: EVALUATOR_ARN, EvaluatorId: EVALUATOR_ID },
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should resolve a bare evaluator id to the canonical ARN via GetEvaluator', async () => {
      mockSend.mockResolvedValueOnce({
        evaluatorArn: EVALUATOR_ARN,
        evaluatorId: EVALUATOR_ID,
        status: 'ACTIVE',
      });

      const result = await provider.import({
        logicalId: 'MyEvaluator',
        resourceType: 'AWS::BedrockAgentCore::Evaluator',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: EVALUATOR_ID,
      });

      expect(result).toEqual({
        physicalId: EVALUATOR_ARN,
        attributes: { EvaluatorArn: EVALUATOR_ARN, EvaluatorId: EVALUATOR_ID },
      });
    });

    it('should return null without a known physical id (no tag-based auto-lookup)', async () => {
      await expect(
        provider.import({
          logicalId: 'MyEvaluator',
          resourceType: 'AWS::BedrockAgentCore::Evaluator',
          stackName: 'MyStack',
          region: 'us-east-1',
          properties: {},
        })
      ).resolves.toBeNull();
    });
  });
});

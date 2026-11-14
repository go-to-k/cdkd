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

/**
 * go-to-k/cdkd#6242: `EvaluatorType` / `Provider` come only from
 * `GetEvaluator` (real CloudFormation, 2026-11-14: a code-based evaluator
 * answers `CustomCode` / `Custom`). Every path records the full set, so an
 * update no longer drops `CreatedAt` either.
 */
const TYPE = 'AWS::BedrockAgentCore::Evaluator';
const ID = 'my_eval-abc123';
const ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/${ID}`;
const CONFIG = { CodeBased: { LambdaConfig: { LambdaArn: 'arn:aws:lambda:us-east-1:1:function:f' } } };
const CREATED = new Date('2026-11-14T12:15:33.943Z');
const UPDATED = new Date('2026-11-14T13:00:00.500Z');
const got = (over: Record<string, unknown> = {}) => ({
  evaluatorArn: ARN,
  evaluatorId: ID,
  status: 'ACTIVE',
  createdAt: CREATED,
  updatedAt: CREATED,
  evaluatorType: 'CustomCode',
  provider: 'Custom',
  ...over,
});
const FULL = {
  EvaluatorArn: ARN,
  EvaluatorId: ID,
  Status: 'ACTIVE',
  CreatedAt: '2026-11-14T12:15:33.943Z',
  UpdatedAt: '2026-11-14T12:15:33.943Z',
  EvaluatorType: 'CustomCode',
  Provider: 'Custom',
};
const names = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);
const props = (over: Record<string, unknown> = {}) => ({
  EvaluatorName: 'my_eval',
  Level: 'TRACE',
  EvaluatorConfig: CONFIG,
  ...over,
});

describe('AgentCoreEvaluatorProvider attributes (#6242)', () => {
  let provider: AgentCoreEvaluatorProvider;
  beforeEach(() => {
    mockSend.mockReset();
    provider = new AgentCoreEvaluatorProvider();
  });

  it('create reads the evaluator back for EvaluatorType / Provider', async () => {
    mockSend.mockResolvedValueOnce({ evaluatorArn: ARN, evaluatorId: ID, status: 'ACTIVE', createdAt: CREATED });
    mockSend.mockResolvedValueOnce(got());
    const result = await provider.create('Ev', TYPE, props());
    expect(result.attributes).toStrictEqual(FULL);
    expect(names()).toStrictEqual(['CreateEvaluatorCommand', 'GetEvaluatorCommand']);
    expect(mockSend.mock.calls[1]![0].input).toStrictEqual({ evaluatorId: ID });
  });

  it('create whose read-back fails records the create answer, without the two', async () => {
    mockSend.mockResolvedValueOnce({ evaluatorArn: ARN, evaluatorId: ID, status: 'ACTIVE', createdAt: CREATED });
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const result = await provider.create('Ev', TYPE, props());
    expect(result.attributes).toStrictEqual({
      EvaluatorArn: ARN,
      EvaluatorId: ID,
      Status: 'ACTIVE',
      CreatedAt: '2026-11-14T12:15:33.943Z',
    });
  });

  it('an update of a full record that keeps the config carries the rest, with no read', async () => {
    mockSend.mockResolvedValueOnce({ evaluatorArn: ARN, evaluatorId: ID, status: 'ACTIVE', updatedAt: UPDATED });
    const result = await provider.update(
      'Ev',
      ARN,
      TYPE,
      props({ Level: 'SESSION' }),
      props(),
      { recordedAttributes: FULL }
    );
    expect(result.attributes).toStrictEqual({ ...FULL, UpdatedAt: '2026-11-14T13:00:00.500Z' });
    expect(names()).toStrictEqual(['UpdateEvaluatorCommand']);
  });

  it('an update that changes the config reads the type / provider back', async () => {
    mockSend.mockResolvedValueOnce({ evaluatorArn: ARN, evaluatorId: ID, status: 'ACTIVE', updatedAt: UPDATED });
    mockSend.mockResolvedValueOnce(got({ evaluatorType: 'Custom', updatedAt: UPDATED }));
    const result = await provider.update(
      'Ev',
      ARN,
      TYPE,
      props({ EvaluatorConfig: { LlmAsAJudge: { Instructions: 'x' } } }),
      props(),
      { recordedAttributes: FULL }
    );
    expect(names()).toStrictEqual(['UpdateEvaluatorCommand', 'GetEvaluatorCommand']);
    expect(result.attributes?.['EvaluatorType']).toBe('Custom');
  });

  it('a config change whose read fails drops the possibly-stale type / provider', async () => {
    mockSend.mockResolvedValueOnce({ evaluatorArn: ARN, evaluatorId: ID, status: 'ACTIVE', updatedAt: UPDATED });
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const result = await provider.update(
      'Ev',
      ARN,
      TYPE,
      props({ EvaluatorConfig: { LlmAsAJudge: { Instructions: 'x' } } }),
      props(),
      { recordedAttributes: FULL }
    );
    expect(result.attributes).toStrictEqual({
      EvaluatorArn: ARN,
      EvaluatorId: ID,
      Status: 'ACTIVE',
      CreatedAt: '2026-11-14T12:15:33.943Z',
      UpdatedAt: '2026-11-14T13:00:00.500Z',
    });
  });

  it('an update of a record written before #6242 reads once and fills it', async () => {
    mockSend.mockResolvedValueOnce({ evaluatorArn: ARN, evaluatorId: ID, status: 'ACTIVE', updatedAt: UPDATED });
    mockSend.mockResolvedValueOnce(got({ updatedAt: UPDATED }));
    const result = await provider.update('Ev', ARN, TYPE, props({ Level: 'SESSION' }), props(), {
      recordedAttributes: { EvaluatorArn: ARN, EvaluatorId: ID, Status: 'ACTIVE' },
    });
    expect(result.attributes).toStrictEqual({ ...FULL, UpdatedAt: '2026-11-14T13:00:00.500Z' });
  });

  it('import records the full set from GetEvaluator', async () => {
    mockSend.mockResolvedValueOnce(got());
    const result = await provider.import({
      logicalId: 'Ev',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: ARN,
    });
    expect(result?.attributes).toStrictEqual(FULL);
  });

  it('getAttribute serves EvaluatorType / Provider from GetEvaluator', async () => {
    mockSend.mockResolvedValue(got());
    await expect(provider.getAttribute(ARN, TYPE, 'EvaluatorType')).resolves.toBe('CustomCode');
    await expect(provider.getAttribute(ARN, TYPE, 'Provider')).resolves.toBe('Custom');
  });
});

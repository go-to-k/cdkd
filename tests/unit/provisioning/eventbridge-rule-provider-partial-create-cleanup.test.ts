import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';

const RESOURCE_TYPE = 'AWS::Events::Rule';

describe('EventBridgeRuleProvider partial-create cleanup (Issue #376)', () => {
  let provider: EventBridgeRuleProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new EventBridgeRuleProvider();
  });

  it('issues RemoveTargets + DeleteRule when PutTargets fails after PutRule succeeded', async () => {
    mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/MyRule' }); // PutRuleCommand
    mockSend.mockRejectedValueOnce(new Error('PutTargets boom')); // PutTargetsCommand
    mockSend.mockResolvedValueOnce({ Targets: [{ Id: 'Target1' }, { Id: 'Target2' }] }); // ListTargetsByRule
    mockSend.mockResolvedValueOnce({}); // RemoveTargetsCommand
    mockSend.mockResolvedValueOnce({}); // DeleteRuleCommand

    await expect(
      provider.create('MyRule', RESOURCE_TYPE, {
        Name: 'MyRule',
        EventPattern: { source: ['aws.s3'] },
        Targets: [
          { Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' },
          { Id: 'Target2', Arn: 'arn:aws:sqs:us-east-1:123:queue2' },
        ],
      })
    ).rejects.toThrow('Failed to create EventBridge rule');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'PutRuleCommand',
      'PutTargetsCommand',
      'ListTargetsByRuleCommand',
      'RemoveTargetsCommand',
      'DeleteRuleCommand',
    ]);
    expect(mockSend.mock.calls[3][0].input.Ids).toEqual(['Target1', 'Target2']);
  });

  it('issues only DeleteRule when PutTargets fails and ListTargets returns empty', async () => {
    mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/MyRule' });
    mockSend.mockRejectedValueOnce(new Error('PutTargets boom (no targets attached)'));
    mockSend.mockResolvedValueOnce({ Targets: [] }); // ListTargetsByRule — nothing attached
    mockSend.mockResolvedValueOnce({}); // DeleteRuleCommand

    await expect(
      provider.create('MyRule', RESOURCE_TYPE, {
        Name: 'MyRule',
        Targets: [{ Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' }],
      })
    ).rejects.toThrow('Failed to create EventBridge rule');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'PutRuleCommand',
      'PutTargetsCommand',
      'ListTargetsByRuleCommand',
      'DeleteRuleCommand',
    ]);
  });

  it('does NOT issue cleanup when PutRule itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('PutRule boom'));

    await expect(
      provider.create('MyRule', RESOURCE_TYPE, {
        Name: 'MyRule',
        EventPattern: { source: ['aws.s3'] },
      })
    ).rejects.toThrow('Failed to create EventBridge rule');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('PutRuleCommand');
  });

  it('re-throws the original error even when cleanup itself fails (warn includes full 3-command recovery hint)', async () => {
    mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/MyRule' });
    mockSend.mockRejectedValueOnce(new Error('PutTargets boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('ListTargets also failed'));

    await expect(
      provider.create('MyRule', RESOURCE_TYPE, {
        Name: 'MyRule',
        Targets: [{ Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' }],
      })
    ).rejects.toThrow('PutTargets boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    // Full recovery hint chains list-targets-by-rule -> remove-targets -> delete-rule.
    // Regression-guard: if the recovery hint loses any of these, drift detection
    // assistance to the operator degrades silently.
    expect(warnMsg).toContain('aws events list-targets-by-rule --rule MyRule');
    expect(warnMsg).toContain('aws events remove-targets --rule MyRule');
    expect(warnMsg).toContain('aws events delete-rule --name MyRule');
  });

  it('threads EventBusName through every cleanup SDK call AND into the recovery-hint WARN', async () => {
    mockSend.mockResolvedValueOnce({
      RuleArn: 'arn:aws:events:us-east-1:123:rule/MyBus/MyRule',
    }); // PutRuleCommand
    mockSend.mockRejectedValueOnce(new Error('PutTargets boom'));
    mockSend.mockResolvedValueOnce({ Targets: [{ Id: 'Target1' }] }); // ListTargetsByRule
    mockSend.mockResolvedValueOnce({}); // RemoveTargetsCommand
    mockSend.mockResolvedValueOnce({}); // DeleteRuleCommand

    await expect(
      provider.create('MyRule', RESOURCE_TYPE, {
        Name: 'MyRule',
        EventBusName: 'MyBus',
        Targets: [{ Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' }],
      })
    ).rejects.toThrow('Failed to create EventBridge rule');

    // Cleanup must thread EventBusName through all three calls. Without
    // it, AWS would look up the rule on the default bus (miss) and the
    // orphan would persist on the non-default bus.
    expect(mockSend.mock.calls[2][0].input.EventBusName).toBe('MyBus'); // ListTargetsByRule
    expect(mockSend.mock.calls[3][0].input.EventBusName).toBe('MyBus'); // RemoveTargets
    expect(mockSend.mock.calls[4][0].input.EventBusName).toBe('MyBus'); // DeleteRule
  });

  it('threads EventBusName into the recovery-hint WARN when cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/MyBus/MyRule' });
    mockSend.mockRejectedValueOnce(new Error('PutTargets boom'));
    mockSend.mockRejectedValueOnce(new Error('ListTargets also failed'));

    await expect(
      provider.create('MyRule', RESOURCE_TYPE, {
        Name: 'MyRule',
        EventBusName: 'MyBus',
        Targets: [{ Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' }],
      })
    ).rejects.toThrow('PutTargets boom');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('--event-bus-name MyBus');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { WITHHELD_AWS_COMMAND } from '../../../src/provisioning/replacement-protection-advice.js';

const { mockSend, describeRuleSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  // The lookup before the create (go-to-k/cdkd#4403) goes to its own spy, so
  // each case's primed PutRule / PutTargets / cleanup sequence stays as is.
  describeRuleSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: {
      send: (command: { constructor: { name: string } }) =>
        command.constructor.name === 'DescribeRuleCommand'
          ? describeRuleSend(command)
          : mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    },
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

import { ResourceNotFoundException } from '@aws-sdk/client-eventbridge';
import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';
import {
  FORGED_CTRL,
  FORGED_QUOTE,
  expectWithheld,
} from './pasteable-aws-command-assert.js';

const RESOURCE_TYPE = 'AWS::Events::Rule';

describe('EventBridgeRuleProvider partial-create cleanup (Issue #376)', () => {
  let provider: EventBridgeRuleProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    describeRuleSend.mockReset();
    describeRuleSend.mockRejectedValue(
      new ResourceNotFoundException({ $metadata: {}, message: 'Rule MyRule does not exist.' })
    );
    provider = new EventBridgeRuleProvider();
  });

  describe('a rule that held the name before PutRule overwrote it (go-to-k/cdkd#4403)', () => {
    const props = {
      Name: 'MyRule',
      EventBusName: 'their-bus',
      EventPattern: { source: ['aws.s3'] },
      Targets: [{ Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' }],
    };

    it('is neither stripped of its targets nor deleted when the wiring fails', async () => {
      describeRuleSend.mockReset();
      describeRuleSend.mockResolvedValueOnce({ Name: 'MyRule', Arn: 'arn:aws:events:us-east-1:123:rule/their-bus/MyRule' });
      mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/their-bus/MyRule' });
      mockSend.mockRejectedValueOnce(new Error('PutTargets boom'));

      await expect(provider.create('MyRule', RESOURCE_TYPE, props)).rejects.toThrow('PutTargets boom');

      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toEqual([
        'PutRuleCommand',
        'PutTargetsCommand',
      ]);
      expect(describeRuleSend.mock.calls[0]![0].input).toEqual({
        Name: 'MyRule',
        EventBusName: 'their-bus',
      });
      const warned = String(warnSpy.mock.calls[0]?.[0]);
      expect(warned).toContain('already existed before this create');
      expect(warned).toContain('did not delete');
    });

    it('is not deleted when the lookup could not answer, and the warning names the manual cleanup', async () => {
      describeRuleSend.mockReset();
      describeRuleSend.mockRejectedValueOnce(
        // A message a text match would read as "not found": only the error
        // NAME may decide.
        Object.assign(new Error('Rule MyRule does not exist, or you are not authorized'), {
          name: 'AccessDeniedException',
        })
      );
      mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/their-bus/MyRule' });
      mockSend.mockRejectedValueOnce(new Error('PutTargets boom'));

      await expect(provider.create('MyRule', RESOURCE_TYPE, props)).rejects.toThrow('PutTargets boom');

      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toEqual([
        'PutRuleCommand',
        'PutTargetsCommand',
      ]);
      const warned = String(warnSpy.mock.calls[0]?.[0]);
      expect(warned).toContain('could not tell whether this create made');
      expect(warned).toContain('aws events delete-rule --name MyRule --event-bus-name their-bus');
    });

    it.each(['held', 'unknown'] as const)('masks a secret-derived rule name in the %s warning', async (arm) => {
      describeRuleSend.mockReset();
      if (arm === 'held') {
        describeRuleSend.mockResolvedValueOnce({ Name: 'rule-SECRETVALUE' });
      } else {
        describeRuleSend.mockRejectedValueOnce(
          Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
        );
      }
      mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/rule-SECRETVALUE' });
      mockSend.mockRejectedValueOnce(new Error('PutTargets boom'));

      await expect(
        provider.create(
          'MyRule',
          RESOURCE_TYPE,
          { ...props, Name: 'rule-SECRETVALUE' },
          { maskSecrets: (t: string) => t.split('SECRETVALUE').join('***') }
        )
      ).rejects.toThrow('PutTargets boom');

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).not.toBe('');
      expect(warned).not.toContain('SECRETVALUE');
    });

    it('masks a secret-derived rule name in the warning of a cleanup that itself failed', async () => {
      // The name is free (the default), so the cleanup runs, and fails.
      mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/rule-SECRETVALUE' });
      mockSend.mockRejectedValueOnce(new Error('PutTargets boom'));
      mockSend.mockRejectedValueOnce(new Error('ListTargetsByRule boom for rule-SECRETVALUE'));

      await expect(
        provider.create(
          'MyRule',
          RESOURCE_TYPE,
          { ...props, Name: 'rule-SECRETVALUE' },
          { maskSecrets: (t: string) => t.split('SECRETVALUE').join('***') }
        )
      ).rejects.toThrow('PutTargets boom');

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('Failed to clean up partially-created EventBridge rule');
      expect(warned).not.toContain('SECRETVALUE');
    });

    it('asks nothing for a rule without targets, whose create has no step to fail', async () => {
      mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/MyRule' });

      await provider.create('MyRule', RESOURCE_TYPE, { Name: 'MyRule', EventPattern: { source: ['aws.s3'] } });

      expect(describeRuleSend).not.toHaveBeenCalled();
    });
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

  it.each([
    ['the default bus', undefined],
    ['a named bus', 'my.bus-1'],
  ])('hands the listed target ids to --ids as ONE JSON word, so an id cannot become an option, on %s (go-to-k/cdkd#4199)', async (_label, bus) => {
    mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/MyRule' });
    mockSend.mockRejectedValueOnce(new Error('PutTargets boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('ListTargets also failed'));
    await expect(
      provider.create('MyRule', RESOURCE_TYPE, {
        Name: 'MyRule',
        ...(bus ? { EventBusName: bus } : {}),
        Targets: [{ Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' }],
      })
    ).rejects.toThrow('PutTargets boom (original)');
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    const command = warnMsg.slice(warnMsg.indexOf('aws events remove-targets'));
    // A target Id may start with `-` (`[.\-_A-Za-z0-9]+`). With `jq | xargs`
    // each id was its own word after `--ids`, so `--region` / `--profile` ids
    // redirected the call. Run the printed command under bash with `aws`
    // stubbed: the listing prints such ids, and remove-targets must get them
    // as the ONE argument after `--ids`.
    // The listing stub also checks the rule / bus words INSIDE `$(...)`
    // arrived intact, printing ids only for the expected argv.
    const listArgv = ['events', 'list-targets-by-rule', '--rule', 'MyRule', ...(bus ? ['--event-bus-name', bus] : []), '--query', 'Targets[].Id', '--output', 'json'].join(' ');
    const script =
      `aws() { case "$2" in list-targets-by-rule) [ "$*" = '${listArgv}' ] && printf '%s' '["a","--region","eu-west-3"]';; ` +
      `remove-targets) printf '%s\\n' "$@";; esac; }\n${command}\n`;
    const out = spawnSync('bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    const argv = out.stdout.split('\n').slice(0, -1);
    expect(argv).toEqual([
      'events',
      'remove-targets',
      '--rule',
      'MyRule',
      ...(bus ? ['--event-bus-name', bus] : []),
      '--ids',
      '["a","--region","eu-west-3"]',
    ]);
    expect(warnMsg).not.toContain('xargs');
  });

  it('says an empty-list remove-targets error is harmless, and the pasted delete-rule still runs after it', async () => {
    mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/MyRule' });
    mockSend.mockRejectedValueOnce(new Error('PutTargets boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('ListTargets also failed'));
    await expect(
      provider.create('MyRule', RESOURCE_TYPE, {
        Name: 'MyRule',
        Targets: [{ Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' }],
      })
    ).rejects.toThrow('PutTargets boom (original)');
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain(
      'If the rule has no targets left, the remove-targets step reports an empty id list; that error is harmless and the delete-rule step still runs'
    );
    // A rule whose targets are already gone: the listing prints `[]`, the
    // stubbed remove-targets fails the way the CLI's min-length validation
    // does, and the delete-rule after the `;` still runs.
    const command = warnMsg.slice(warnMsg.indexOf('aws events remove-targets'));
    const script =
      `aws() { case "$2" in list-targets-by-rule) printf '%s' '[]';; ` +
      `remove-targets) [ "$6" = '[]' ] && { echo 'ParamValidation' >&2; return 252; };; ` +
      `delete-rule) echo DELETED;; esac; }\n${command}\n`;
    const out = spawnSync('bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8' });
    expect(out.stderr).toContain('ParamValidation');
    expect(out.stdout).toBe('DELETED\n');
  });

  it('omits the empty-list note when the command itself is withheld', async () => {
    mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/MyRule' });
    mockSend.mockRejectedValueOnce(new Error('PutTargets boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('ListTargets also failed'));
    await expect(
      provider.create('MyRule', RESOURCE_TYPE, {
        Name: 'file://rule',
        Targets: [{ Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' }],
      })
    ).rejects.toThrow('PutTargets boom (original)');
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain(WITHHELD_AWS_COMMAND);
    expect(warnMsg).not.toContain('remove-targets step');
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

  describe('the recovery command names the rule and bus through pasteableAwsCommand (issue #3136)', () => {
    async function warnFor(name: string, eventBusName: string): Promise<string> {
      mockSend.mockResolvedValueOnce({ RuleArn: 'arn:aws:events:us-east-1:123:rule/MyBus/MyRule' });
      mockSend.mockRejectedValueOnce(new Error('PutTargets boom'));
      mockSend.mockRejectedValueOnce(new Error('ListTargets also failed'));
      await expect(
        provider.create('MyRule', RESOURCE_TYPE, {
          Name: name,
          EventBusName: eventBusName,
          Targets: [{ Id: 'Target1', Arn: 'arn:aws:sqs:us-east-1:123:queue1' }],
        })
      ).rejects.toThrow('PutTargets boom');
      return String(warnSpy.mock.calls[0][0]);
    }

    // A shell-active character withholds it (go-to-k/cdkd#3950).
    it('withholds the whole command for a rule name or a bus name carrying a quote', async () => {
      expectWithheld(await warnFor(FORGED_QUOTE, 'MyBus'), 'aws events');
      warnSpy.mockClear();
      expectWithheld(await warnFor('MyRule', `bus${FORGED_QUOTE}`), 'aws events');
    });

    it('withholds the whole command when only the BUS carries a control byte', async () => {
      expectWithheld(await warnFor('MyRule', `bus${FORGED_CTRL}`), 'aws events');
    });

    it('withholds the whole command for a rule name carrying a control byte', async () => {
      expectWithheld(await warnFor(FORGED_CTRL, 'MyBus'), 'aws events');
    });
  });
});

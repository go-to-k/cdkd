import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, ownershipSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  // The by-name lookup before a create (go-to-k/cdkd#4403) goes to its own
  // spy, so each case's primed create / wiring / cleanup sequence stays as is.
  ownershipSend: vi.fn(),
  warnSpy: vi.fn(),
}));

/** The lookup's answer when the name is free: the type's own not-found. */
function nameIsFree(command: { constructor: { name: string } }): Promise<never> {
  return Promise.reject(
    Object.assign(new Error('One or more resources not found'), {
      name:
        command.constructor.name === 'DescribeTargetGroupsCommand'
          ? 'TargetGroupNotFoundException'
          : 'LoadBalancerNotFoundException',
    })
  );
}

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-elastic-load-balancing-v2')
  >('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: (command: { input?: { Names?: unknown } }) =>
        command.input?.Names !== undefined ? ownershipSend(command) : mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    // The `active` wait (issue #1274) lives inside the same try/catch this
    // suite exercises. Stub it so these cases keep testing the
    // ModifyLoadBalancerAttributes failure path; the wait-failure branch of
    // the same cleanup is covered by elbv2-loadbalancer-active-wait.test.ts.
    waitUntilLoadBalancerAvailable: vi.fn().mockResolvedValue({ state: 'SUCCESS' }),
  };
});

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

import { waitUntilLoadBalancerAvailable } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import {
  FORGED_CTRL,
  FORGED_QUOTE,
  expectWithheld,
} from './pasteable-aws-command-assert.js';

const RESOURCE_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/MyLb/abcdef1234567890';

describe('ELBv2Provider createLoadBalancer partial-create cleanup (Issue #376)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    ownershipSend.mockReset();
    ownershipSend.mockImplementation(nameIsFree);
    provider = new ELBv2Provider();
  });

  it('issues DeleteLoadBalancerCommand when ModifyLoadBalancerAttributes fails after CreateLoadBalancer succeeded', async () => {
    mockSend.mockResolvedValueOnce({
      LoadBalancers: [
        {
          LoadBalancerArn: LB_ARN,
          DNSName: 'mylb-123.us-east-1.elb.amazonaws.com',
          CanonicalHostedZoneId: 'Z123',
          LoadBalancerName: 'MyLb',
        },
      ],
    }); // CreateLoadBalancerCommand
    mockSend.mockRejectedValueOnce(new Error('ModifyLBAttributes boom')); // ModifyLoadBalancerAttributesCommand
    mockSend.mockResolvedValueOnce({}); // DeleteLoadBalancerCommand cleanup

    await expect(
      provider.create('MyLb', RESOURCE_TYPE, {
        Name: 'MyLb',
        Subnets: ['subnet-aaa', 'subnet-bbb'],
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      })
    ).rejects.toThrow('Failed to create LoadBalancer');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateLoadBalancerCommand',
      'ModifyLoadBalancerAttributesCommand',
      'DeleteLoadBalancerCommand',
    ]);
    expect(mockSend.mock.calls[2][0].input).toEqual({ LoadBalancerArn: LB_ARN });
  });

  it('does NOT issue DeleteLoadBalancerCommand when CreateLoadBalancer itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateLoadBalancer boom'));

    await expect(
      provider.create('MyLb', RESOURCE_TYPE, {
        Name: 'MyLb',
        Subnets: ['subnet-aaa'],
      })
    ).rejects.toThrow('Failed to create LoadBalancer');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateLoadBalancerCommand');
  });

  it('re-throws the original error even when cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({
      LoadBalancers: [
        {
          LoadBalancerArn: LB_ARN,
          DNSName: 'mylb-123.us-east-1.elb.amazonaws.com',
          CanonicalHostedZoneId: 'Z123',
          LoadBalancerName: 'MyLb',
        },
      ],
    });
    mockSend.mockRejectedValueOnce(new Error('ModifyLBAttributes boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('DeleteLoadBalancer also failed'));

    await expect(
      provider.create('MyLb', RESOURCE_TYPE, {
        Name: 'MyLb',
        Subnets: ['subnet-aaa'],
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      })
    ).rejects.toThrow('ModifyLBAttributes boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws elbv2 delete-load-balancer --load-balancer-arn');
    expect(warnMsg).toContain(LB_ARN);
  });
});

// Issue #3136: the load balancer and target group ARNs are AWS-minted (off the
// create response) but embed the TEMPLATE-chosen name, and both manual-delete
// commands route them through `pasteableAwsCommand`.
describe('ELBv2Provider partial-create manual-delete commands (issue #3136)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    ownershipSend.mockReset();
    ownershipSend.mockImplementation(nameIsFree);
    provider = new ELBv2Provider();
  });

  async function lbWarn(arn: string): Promise<string> {
    mockSend.mockResolvedValueOnce({
      LoadBalancers: [{ LoadBalancerArn: arn, DNSName: 'd', CanonicalHostedZoneId: 'Z', LoadBalancerName: 'MyLb' }],
    });
    mockSend.mockRejectedValueOnce(new Error('ModifyLBAttributes boom'));
    mockSend.mockRejectedValueOnce(new Error('DeleteLoadBalancer also failed'));
    await expect(
      provider.create('MyLb', RESOURCE_TYPE, {
        Name: 'MyLb',
        Subnets: ['subnet-aaa'],
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      })
    ).rejects.toThrow('ModifyLBAttributes boom');
    return String(warnSpy.mock.calls[0][0]);
  }

  async function tgWarn(arn: string): Promise<string> {
    mockSend.mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: arn, TargetGroupName: 'MyTg' }] });
    mockSend.mockRejectedValueOnce(new Error('ModifyTGAttributes boom'));
    mockSend.mockRejectedValueOnce(new Error('DeleteTargetGroup also failed'));
    await expect(
      provider.create('MyTg', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
        Name: 'MyTg',
        Port: 80,
        Protocol: 'HTTP',
        VpcId: 'vpc-aaa',
        TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
      })
    ).rejects.toThrow('ModifyTGAttributes boom');
    return String(warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('TargetGroup')));
  }

  it.each([
    ['LoadBalancer', lbWarn, 'aws elbv2 delete-load-balancer --load-balancer-arn ', LB_ARN],
    [
      'TargetGroup',
      tgWarn,
      'aws elbv2 delete-target-group --target-group-arn ',
      'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/MyTg/abc',
    ],
  ] as const)('%s: a clean ARN is bare; a forged one withholds the command', async (_t, warnFor, flag, arn) => {
    expect(await warnFor(arn)).toContain(`${flag}${arn}`);
    warnSpy.mockReset();
    // A shell-active character withholds it (go-to-k/cdkd#3950).
    expectWithheld(await warnFor(`${arn}${FORGED_QUOTE}`), flag.trim());
    warnSpy.mockReset();
    expectWithheld(await warnFor(`${arn}${FORGED_CTRL}`), flag.trim());
  });

  it('withholds the target group command for an ARN the caller masker would change', async () => {
    const arn = 'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/MyTg-s3cr3t/abc';
    mockSend.mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: arn, TargetGroupName: 'MyTg' }] });
    mockSend.mockRejectedValueOnce(new Error('ModifyTGAttributes boom'));
    mockSend.mockRejectedValueOnce(new Error('DeleteTargetGroup also failed'));
    await expect(
      provider.create(
        'MyTg',
        'AWS::ElasticLoadBalancingV2::TargetGroup',
        {
          Name: 'MyTg',
          Port: 80,
          Protocol: 'HTTP',
          VpcId: 'vpc-aaa',
          TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
        },
        { maskSecrets: (t: string) => t.replaceAll('s3cr3t', '***') }
      )
    ).rejects.toThrow('ModifyTGAttributes boom');
    expectWithheld(
      warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('TargetGroup'))!,
      'aws elbv2 delete-target-group'
    );
  });

  it('withholds the load balancer command for an ARN the caller masker would change', async () => {
    const arn = `${LB_ARN}-s3cr3t`;
    mockSend.mockResolvedValueOnce({
      LoadBalancers: [{ LoadBalancerArn: arn, DNSName: 'd', CanonicalHostedZoneId: 'Z', LoadBalancerName: 'MyLb' }],
    });
    mockSend.mockRejectedValueOnce(new Error('ModifyLBAttributes boom'));
    mockSend.mockRejectedValueOnce(new Error('DeleteLoadBalancer also failed'));
    await expect(
      provider.create(
        'MyLb',
        RESOURCE_TYPE,
        {
          Name: 'MyLb',
          Subnets: ['subnet-aaa'],
          LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
        },
        { maskSecrets: (t: string) => t.replaceAll('s3cr3t', '***') }
      )
    ).rejects.toThrow('ModifyLBAttributes boom');
    expectWithheld(String(warnSpy.mock.calls[0][0]), 'aws elbv2 delete-load-balancer');
  });
});

describe('ELBv2Provider partial-create cleanup of a handed-back resource (go-to-k/cdkd#4403)', () => {
  let provider: ELBv2Provider;
  const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/MyTg/abc';

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    ownershipSend.mockReset();
    ownershipSend.mockImplementation(nameIsFree);
    provider = new ELBv2Provider();
  });

  const cases = [
    {
      label: 'LoadBalancer',
      type: RESOURCE_TYPE,
      lookup: 'DescribeLoadBalancersCommand',
      held: { LoadBalancers: [{ LoadBalancerArn: LB_ARN, LoadBalancerName: 'MyLb' }] },
      created: { LoadBalancers: [{ LoadBalancerArn: LB_ARN, LoadBalancerName: 'MyLb' }] },
      // `_` is sent as `-`: the lookup must ask for the SENT spelling.
      props: {
        Name: 'My_Lb',
        Subnets: ['subnet-aaa'],
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      },
      sent: 'My-Lb',
      wiring: 'ModifyLoadBalancerAttributesCommand',
      cleanup: 'DeleteLoadBalancerCommand',
      command: `aws elbv2 delete-load-balancer --load-balancer-arn ${LB_ARN}`,
    },
    {
      label: 'TargetGroup',
      type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      lookup: 'DescribeTargetGroupsCommand',
      held: { TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'MyTg' }] },
      created: { TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'MyTg' }] },
      props: {
        Name: 'My_Tg',
        Port: 80,
        Protocol: 'HTTP',
        VpcId: 'vpc-aaa',
        TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
      },
      sent: 'My-Tg',
      wiring: 'ModifyTargetGroupAttributesCommand',
      cleanup: 'DeleteTargetGroupCommand',
      command: `aws elbv2 delete-target-group --target-group-arn ${TG_ARN}`,
    },
  ] as const;

  describe.each(cases)('$label', (c) => {
    const sentNames = (): string[] => mockSend.mock.calls.map((x) => x[0].constructor.name);

    it('looks the SENT name up before the create, and deletes what a free name produced', async () => {
      mockSend.mockResolvedValueOnce(c.created);
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));
      mockSend.mockResolvedValueOnce({});

      await expect(provider.create('Res', c.type, c.props)).rejects.toThrow('wiring boom');

      const lookup = ownershipSend.mock.calls[0]![0] as {
        constructor: { name: string };
        input: Record<string, unknown>;
      };
      expect(lookup.constructor.name).toBe(c.lookup);
      expect(lookup.input).toEqual({ Names: [c.sent] });
      // BEFORE the create: asked after it, the name is always held by what
      // the create just made, and no cleanup would ever run.
      expect(ownershipSend.mock.invocationCallOrder[0]).toBeLessThan(
        mockSend.mock.invocationCallOrder[0]!
      );
      expect(sentNames()).toContain(c.cleanup);
    });

    it('does not delete a resource that held the name before the create', async () => {
      ownershipSend.mockReset();
      ownershipSend.mockResolvedValue(c.held);
      mockSend.mockResolvedValueOnce(c.created);
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));

      await expect(provider.create('Res', c.type, c.props)).rejects.toThrow('wiring boom');

      expect(sentNames()).not.toContain(c.cleanup);
      const warned = String(warnSpy.mock.calls[0]?.[0]);
      expect(warned).toContain('already existed before this create');
      // For a holder that is an earlier failed cdkd deploy's own leftover.
      expect(warned).toContain(c.command);
    });

    it('reads an empty list with no not-found error as no answer, and does not delete', async () => {
      // Absence is answered by the service's not-found ERROR; an empty list
      // without one is not proof the name is free.
      ownershipSend.mockReset();
      ownershipSend.mockResolvedValue(
        c.type === RESOURCE_TYPE ? { LoadBalancers: [] } : { TargetGroups: [] }
      );
      mockSend.mockResolvedValueOnce(c.created);
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));

      await expect(provider.create('Res', c.type, c.props)).rejects.toThrow('wiring boom');

      expect(sentNames()).not.toContain(c.cleanup);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('could not tell whether this create made');
    });

    it('does not delete when the lookup did not answer, and names the manual delete', async () => {
      ownershipSend.mockReset();
      ownershipSend.mockRejectedValue(
        Object.assign(new Error('One or more resources not found, or not authorized'), {
          name: 'AccessDenied',
        })
      );
      mockSend.mockResolvedValueOnce(c.created);
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));

      await expect(provider.create('Res', c.type, c.props)).rejects.toThrow('wiring boom');

      expect(sentNames()).not.toContain(c.cleanup);
      const warned = String(warnSpy.mock.calls[0]?.[0]);
      expect(warned).toContain('could not tell whether this create made');
      expect(warned).toContain(c.command);
    });
  });

  // Each condition of the wiring gate, alone: dropping one leaves that step
  // running with no lookup, and a held name deleted again.
  it.each([
    {
      label: 'the active wait',
      noWait: false,
      props: { Name: 'MyLb', Subnets: ['subnet-aaa'] },
      fail: 'wait',
    },
    {
      label: 'LoadBalancerAttributes',
      noWait: true,
      props: {
        Name: 'MyLb',
        Subnets: ['subnet-aaa'],
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      },
      fail: 'send',
    },
    {
      label: 'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
      noWait: true,
      props: {
        Name: 'MyLb',
        Type: 'network',
        Subnets: ['subnet-aaa'],
        SecurityGroups: ['sg-1'],
        EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'on',
      },
      fail: 'send',
    },
    {
      label: 'MinimumLoadBalancerCapacity',
      noWait: true,
      props: { Name: 'MyLb', Subnets: ['subnet-aaa'], MinimumLoadBalancerCapacity: { CapacityUnits: 100 } },
      fail: 'send',
    },
  ])('keeps a held load balancer whose $label step fails', async ({ noWait, props, fail }) => {
    if (noWait) vi.stubEnv('CDKD_NO_WAIT', 'true');
    try {
      ownershipSend.mockReset();
      ownershipSend.mockResolvedValue({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
      mockSend.mockResolvedValueOnce({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
      if (fail === 'wait') {
        vi.mocked(waitUntilLoadBalancerAvailable).mockRejectedValueOnce(new Error('wiring boom'));
      } else {
        mockSend.mockRejectedValueOnce(new Error('wiring boom'));
      }

      await expect(provider.create('Res', RESOURCE_TYPE, props)).rejects.toThrow('wiring boom');

      expect(ownershipSend).toHaveBeenCalled();
      expect(mockSend.mock.calls.map((x) => x[0].constructor.name)).not.toContain(
        'DeleteLoadBalancerCommand'
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps a held target group whose targets step fails (no attributes declared)', async () => {
    ownershipSend.mockReset();
    ownershipSend.mockResolvedValue({ TargetGroups: [{ TargetGroupArn: TG_ARN }] });
    mockSend.mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: TG_ARN }] });
    mockSend.mockRejectedValueOnce(new Error('RegisterTargets boom'));

    await expect(
      provider.create('Res', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
        Name: 'MyTg',
        TargetType: 'lambda',
        Targets: [{ Id: 'arn:aws:lambda:us-east-1:123:function:f' }],
      })
    ).rejects.toThrow('RegisterTargets boom');

    expect(ownershipSend).toHaveBeenCalled();
    expect(mockSend.mock.calls.map((x) => x[0].constructor.name)).not.toContain(
      'DeleteTargetGroupCommand'
    );
  });

  it.each([
    ['held', 'TargetGroup'],
    ['unknown', 'TargetGroup'],
    ['held', 'LoadBalancer'],
    ['unknown', 'LoadBalancer'],
  ] as const)(
    'masks a secret-derived name in the %s warning (%s)',
    async (arm, kind) => {
      const isTg = kind === 'TargetGroup';
      const secretArn = isTg
        ? 'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/tg-SECRETVALUE/abc'
        : 'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/lb-SECRETVALUE/abc';
      const answer = isTg
        ? { TargetGroups: [{ TargetGroupArn: secretArn }] }
        : { LoadBalancers: [{ LoadBalancerArn: secretArn }] };
      ownershipSend.mockReset();
      if (arm === 'held') {
        ownershipSend.mockResolvedValue(answer);
      } else {
        ownershipSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
      }
      mockSend.mockResolvedValueOnce(answer);
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));

      await expect(
        provider.create(
          'Res',
          isTg ? 'AWS::ElasticLoadBalancingV2::TargetGroup' : RESOURCE_TYPE,
          isTg
            ? {
                Name: 'tg-SECRETVALUE',
                TargetType: 'lambda',
                TargetGroupAttributes: [{ Key: 'k', Value: 'v' }],
              }
            : {
                Name: 'lb-SECRETVALUE',
                Subnets: ['subnet-aaa'],
                LoadBalancerAttributes: [{ Key: 'k', Value: 'v' }],
              },
          { maskSecrets: (t: string) => t.split('SECRETVALUE').join('***') }
        )
      ).rejects.toThrow();

      const warned = warnSpy.mock.calls.map((x) => String(x[0])).join('\n');
      expect(warned).not.toBe('');
      expect(warned).not.toContain('SECRETVALUE');
    }
  );

  it('asks nothing for a target group without a wiring step', async () => {
    mockSend.mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: TG_ARN }] });

    await provider.create('Res', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'MyTg',
      TargetType: 'lambda',
    });

    expect(ownershipSend).not.toHaveBeenCalled();
  });

  it('asks nothing for a load balancer under --no-wait without a wiring step', async () => {
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    try {
      mockSend.mockResolvedValueOnce({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });

      await provider.create('Res', RESOURCE_TYPE, { Name: 'MyLb', Subnets: ['subnet-aaa'] });

      expect(ownershipSend).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

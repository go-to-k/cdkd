import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3989: the TargetGroup update derives DeregisterTargets from the
// gap between the desired and the recorded `Targets`, and used to read a
// present-but-malformed value (or drop a malformed entry) as empty. On a
// rollback (desired side = a recorded bag) `Targets: {}` deregistered every
// target. A malformed DESIRED side is now refused before any call; a malformed
// RECORDED side is read from the live group ADD-only.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: (command: { constructor: { name: string }; input?: { Names?: unknown } }) =>
        // The by-name lookup before a create (go-to-k/cdkd#4403): the name is free.
        command.input?.Names !== undefined
          ? Promise.reject(
              Object.assign(new Error('One or more resources not found'), {
                name:
                  command.constructor.name === 'DescribeTargetGroupsCommand'
                    ? 'TargetGroupNotFoundException'
                    : 'LoadBalancerNotFoundException',
              })
            )
          : mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const warned: string[] = [];

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warned.push(message);
    }),
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

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TG_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const TG_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/issue3989/1234567890abcdef';
const SECRET_REF = '{{resolve:secretsmanager:issue3989/target:SecretString:id::}}';
/** A distinctive needle per malformed value, so a message echoing it is caught. */
const NEEDLE = 'issue3989-needle';

const MALFORMED: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an object', { Id: NEEDLE }],
  ['a false', false],
  ['a null entry', [null]],
  ['a string entry', [NEEDLE]],
  ['a list entry', [[NEEDLE]]],
  ['an entry with no Id', [{ Port: 80, AvailabilityZone: NEEDLE }]],
  ['an entry with an empty Id', [{ Id: '' }]],
  ['an entry with a numeric Id', [{ Id: 42, AvailabilityZone: NEEDLE }]],
  ['an entry with an unresolved-intrinsic Id', [{ Id: { Ref: NEEDLE } }]],
  ['an entry with a non-integer Port', [{ Id: '10.0.0.1', Port: NEEDLE }]],
  ['an entry with a fractional Port', [{ Id: '10.0.0.1', Port: 80.5 }]],
  ['an entry with a numeric AvailabilityZone', [{ Id: '10.0.0.1', AvailabilityZone: 7 }]],
  ['a valid entry beside a malformed one', [{ Id: '10.0.0.1' }, { Id: 42 }]],
];

function sent(name: string): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0].constructor.name === name)
    .map((c) => c[0].input as Record<string, unknown>);
}

function sentNames(): string[] {
  return mockSend.mock.calls.map((c) => c[0].constructor.name as string);
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

let provider: ELBv2Provider;

beforeEach(() => {
  vi.clearAllMocks();
  warned.length = 0;
  provider = new ELBv2Provider();
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'CreateTargetGroupCommand':
        return Promise.resolve({
          TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'issue3989' }],
        });
      case 'DescribeTargetGroupsCommand':
        return Promise.resolve({ TargetGroups: [{ TargetGroupArn: TG_ARN }] });
      default:
        return Promise.resolve({});
    }
  });
});

describe('TargetGroup update — a malformed DESIRED Targets is refused before any call (#3989)', () => {
  it.each(MALFORMED)('%s sends nothing', async (_label, value) => {
    const err = await rejection(
      provider.update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 80, Targets: value },
        { Port: 80, Targets: [{ Id: '10.0.0.1' }, { Id: '10.0.0.2' }] }
      )
    );
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err.message).toMatch(/^desired Targets of TargetGroup Tg is not a list of targets/);
    expect(err.message).toContain('the target group was not updated');
    expect(err.message).not.toContain(NEEDLE);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a rollback replay (replayingState)', { replayingState: true }],
    ['drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
  ])('refuses on %s too', async (_label, context) => {
    const err = await rejection(
      provider.update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 80, Targets: {} },
        { Port: 80, Targets: [{ Id: '10.0.0.1' }] },
        context
      )
    );
    expect(err.message).toMatch(/^desired Targets of TargetGroup Tg/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a dynamic reference', SECRET_REF],
    ['its mask', '***'],
  ])('refuses a desired Id holding %s, naming the cause', async (_label, id) => {
    const err = await rejection(
      provider.update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 80, Targets: [{ Id: id }] },
        { Port: 80, Targets: [{ Id: '10.0.0.1' }] }
      )
    );
    expect(err.message).toContain('an Id holds a dynamic reference or its mask');
    expect(err.message).not.toContain('secretsmanager');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a plain malformed list gets no dynamic-reference cause clause', async () => {
    const err = await rejection(
      provider.update('Tg', TG_ARN, TG_TYPE, { Targets: [{ Id: 42 }] }, {})
    );
    expect(err.message).not.toContain('dynamic reference');
  });
});

describe('TargetGroup update — valid Targets (#3989 positive polarity)', () => {
  it('sends exactly Modify, one Register, one Deregister, then the describe', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 80, Targets: [{ Id: '10.0.0.1' }, { Id: '10.0.0.3', Port: '8080' }] },
      { Port: 80, Targets: [{ Id: '10.0.0.1' }, { Id: '10.0.0.2' }] }
    );
    expect(sentNames()).toEqual([
      'ModifyTargetGroupCommand',
      'RegisterTargetsCommand',
      'DeregisterTargetsCommand',
      'DescribeTargetGroupsCommand',
    ]);
    expect(sent('RegisterTargetsCommand')[0]!['Targets']).toEqual([{ Id: '10.0.0.3', Port: 8080 }]);
    expect(sent('DeregisterTargetsCommand')[0]!['Targets']).toEqual([
      { Id: '10.0.0.2', Port: 80 },
    ]);
  });

  it('a null or absent desired Targets still deregisters every recorded target', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 80, Targets: null },
      { Port: 80, Targets: [{ Id: '10.0.0.1' }] }
    );
    expect(sent('DeregisterTargetsCommand')[0]!['Targets']).toEqual([
      { Id: '10.0.0.1', Port: 80 },
    ]);
    expect(sent('RegisterTargetsCommand')).toHaveLength(0);
  });

  it('accepts a null Port / AvailabilityZone member as absent', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 80, Targets: [{ Id: '10.0.0.4', Port: null, AvailabilityZone: null }] },
      { Port: 80 }
    );
    expect(sent('RegisterTargetsCommand')[0]!['Targets']).toEqual([{ Id: '10.0.0.4', Port: 80 }]);
  });

  it('keeps a recorded secret-derived Id out of the deregister set', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 80, Targets: [] },
      { Port: 80, Targets: [{ Id: SECRET_REF }, { Id: '***' }, { Id: '10.0.0.9' }] }
    );
    expect(sent('DeregisterTargetsCommand')).toEqual([
      { TargetGroupArn: TG_ARN, Targets: [{ Id: '10.0.0.9', Port: 80 }] },
    ]);
    expect(sent('DescribeTargetHealthCommand')).toHaveLength(0);
  });

  it('a null recorded Targets reads as empty, with no live read', async () => {
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 80, Targets: [{ Id: '10.0.0.1' }] },
      { Port: 80, Targets: null }
    );
    expect(sent('DescribeTargetHealthCommand')).toHaveLength(0);
    expect(sent('RegisterTargetsCommand')[0]!['Targets']).toEqual([{ Id: '10.0.0.1', Port: 80 }]);
  });
});

describe('TargetGroup update — a malformed RECORDED Targets is read from the live group ADD-only (#3989)', () => {
  function primeLive(descriptions: unknown[]): void {
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'DescribeTargetHealthCommand'
        ? Promise.resolve({ TargetHealthDescriptions: descriptions })
        : base(cmd)
    );
  }

  it('reads an import-style [{ Id: { Ref } }] record live, registers only what is missing, deregisters nothing', async () => {
    primeLive([
      { Target: { Id: '10.0.0.1', Port: 80 }, TargetHealth: { State: 'healthy' } },
      { Target: { Id: '10.0.0.7', Port: 80 }, TargetHealth: { State: 'healthy' } },
      // Draining counts as not held: a desired one is registered again.
      { Target: { Id: '10.0.0.2', Port: 80 }, TargetHealth: { State: 'draining' } },
    ]);
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 80, Targets: [{ Id: '10.0.0.1' }, { Id: '10.0.0.2' }, { Id: '10.0.0.3' }] },
      { Port: 80, Targets: [{ Id: { Ref: 'Instance' } }] }
    );
    expect(sentNames()).toEqual([
      'DescribeTargetHealthCommand',
      'ModifyTargetGroupCommand',
      'RegisterTargetsCommand',
      'DescribeTargetGroupsCommand',
    ]);
    expect(sent('DescribeTargetHealthCommand')[0]).toEqual({ TargetGroupArn: TG_ARN });
    expect(sent('RegisterTargetsCommand')[0]!['Targets']).toEqual([
      { Id: '10.0.0.2', Port: 80 },
      { Id: '10.0.0.3', Port: 80 },
    ]);
    expect(sent('DeregisterTargetsCommand')).toHaveLength(0);
    const warning = warned.find((w) => w.includes('Targets of TargetGroup Tg'));
    expect(warning).toContain('holds 1 target(s) the desired Targets does not name');
    expect(warning).not.toContain('10.0.0.7');
  });

  it('matches a live target in any zone when the desired entry names none', async () => {
    primeLive([
      {
        Target: { Id: '10.0.0.1', Port: 80, AvailabilityZone: 'us-east-1a' },
        TargetHealth: { State: 'healthy' },
      },
    ]);
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 80, Targets: [{ Id: '10.0.0.1' }] },
      { Port: 80, Targets: 'unreadable' }
    );
    expect(sent('RegisterTargetsCommand')).toHaveLength(0);
    expect(sent('DeregisterTargetsCommand')).toHaveLength(0);
    expect(warned).toHaveLength(0);
  });

  it('does not count a live target on another port as held: the desired one is registered', async () => {
    primeLive([{ Target: { Id: '10.0.0.1', Port: 80 }, TargetHealth: { State: 'healthy' } }]);
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 80, Targets: [{ Id: '10.0.0.1', Port: 8080 }] },
      { Port: 80, Targets: {} }
    );
    expect(sent('RegisterTargetsCommand')[0]!['Targets']).toEqual([{ Id: '10.0.0.1', Port: 8080 }]);
    expect(sent('DeregisterTargetsCommand')).toHaveLength(0);
    expect(warned.some((w) => w.includes('holds 1 target(s)'))).toBe(true);
  });

  it('does not count a live target in another zone as held when the desired entry names one', async () => {
    primeLive([
      {
        Target: { Id: '10.0.0.1', Port: 80, AvailabilityZone: 'us-east-1a' },
        TargetHealth: { State: 'healthy' },
      },
    ]);
    await provider.update(
      'Tg',
      TG_ARN,
      TG_TYPE,
      { Port: 80, Targets: [{ Id: '10.0.0.1', AvailabilityZone: 'all' }] },
      { Port: 80, Targets: {} }
    );
    expect(sent('RegisterTargetsCommand')[0]!['Targets']).toEqual([
      { Id: '10.0.0.1', Port: 80, AvailabilityZone: 'all' },
    ]);
  });

  it('ignores a live description with no target id, and matches a portless (lambda) target', async () => {
    const fn = 'arn:aws:lambda:us-east-1:123456789012:function:issue3989';
    primeLive([
      { TargetHealth: { State: 'healthy' } },
      { Target: { Id: '' }, TargetHealth: { State: 'healthy' } },
      { Target: { Id: fn }, TargetHealth: { State: 'healthy' } },
    ]);
    await provider.update('Tg', TG_ARN, TG_TYPE, { Targets: [{ Id: fn }] }, { Targets: {} });
    expect(sent('RegisterTargetsCommand')).toHaveLength(0);
    expect(sent('DeregisterTargetsCommand')).toHaveLength(0);
    expect(warned).toHaveLength(0);
  });

  it('deregisters nothing when the desired Targets is absent, and warns', async () => {
    primeLive([{ Target: { Id: '10.0.0.1', Port: 80 }, TargetHealth: { State: 'healthy' } }]);
    await provider.update('Tg', TG_ARN, TG_TYPE, { Port: 80 }, { Port: 80, Targets: {} });
    expect(sent('DeregisterTargetsCommand')).toHaveLength(0);
    expect(sent('RegisterTargetsCommand')).toHaveLength(0);
    expect(warned.some((w) => w.includes('cdkd left them registered'))).toBe(true);
  });

  it('refuses, sending no write, when the live read fails — retryable', async () => {
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'DescribeTargetHealthCommand'
        ? Promise.reject(new Error('Rate exceeded'))
        : base(cmd)
    );
    const err = await rejection(
      provider.update(
        'Tg',
        TG_ARN,
        TG_TYPE,
        { Port: 80, Targets: [{ Id: '10.0.0.1' }] },
        { Port: 80, Targets: [{ Id: 42 }] }
      )
    );
    expect(err.message).toContain('could not be read from Elastic Load Balancing');
    expect(isMarkedNonRetryable(err)).toBe(false);
    // The retry classifies through `cause`, so the AWS error must ride there.
    expect((err as ProvisioningError).cause).toBeInstanceOf(Error);
    expect(((err as ProvisioningError).cause as Error).message).toBe('Rate exceeded');
    expect(sentNames()).toEqual(['DescribeTargetHealthCommand']);
  });

  it('a malformed desired side is refused before the live read of a malformed record', async () => {
    const err = await rejection(
      provider.update('Tg', TG_ARN, TG_TYPE, { Targets: 'x' }, { Targets: 'y' })
    );
    expect(err.message).toMatch(/^desired Targets/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('TargetGroup create — a malformed Targets is refused before CreateTargetGroup (#3989)', () => {
  it.each(MALFORMED)('%s sends nothing', async (_label, value) => {
    const err = await rejection(
      provider.create('Tg', TG_TYPE, { Name: 'issue3989', Port: 80, Targets: value })
    );
    expect(err.message).toMatch(/^Targets of TargetGroup Tg is not a list of targets/);
    expect(err.message).toContain('the target group was not created');
    expect(err.message).not.toContain(NEEDLE);
    expect(err.message).not.toContain('dynamic reference');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a dynamic reference', SECRET_REF],
    ['its mask', '***'],
  ])('names the cause when an Id holds %s', async (_label, id) => {
    const err = await rejection(
      provider.create('Tg', TG_TYPE, { Name: 'issue3989', Port: 80, Targets: [{ Id: id }] })
    );
    expect(err.message).toContain('an Id holds a dynamic reference or its mask');
    expect(err.message).toContain('the target group was not created');
    expect(err.message).not.toContain('secretsmanager');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('registers a valid list after CreateTargetGroup', async () => {
    await provider.create('Tg', TG_TYPE, {
      Name: 'issue3989',
      Port: 80,
      Targets: [{ Id: '10.0.0.1', Port: '8080', AvailabilityZone: 'all' }, { Id: '10.0.0.2' }],
    });
    expect(sentNames()).toEqual(['CreateTargetGroupCommand', 'RegisterTargetsCommand']);
    expect(sent('RegisterTargetsCommand')[0]).toEqual({
      TargetGroupArn: TG_ARN,
      Targets: [{ Id: '10.0.0.1', Port: 8080, AvailabilityZone: 'all' }, { Id: '10.0.0.2' }],
    });
  });

  it('an absent Targets registers nothing', async () => {
    await provider.create('Tg', TG_TYPE, { Name: 'issue3989', Port: 80 });
    expect(sentNames()).toEqual(['CreateTargetGroupCommand']);
  });
});

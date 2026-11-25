import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * A custom resource whose handler role cdkd just wrote waits for IAM to
 * propagate the write before the handler runs; nothing else waits. Without
 * it the CDK Provider framework's `onEvent` is denied invoking the user
 * handler and sits out its 300s `waitUntilFunctionActiveV2` before the
 * transient-authz retry can recycle it.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: { send: mockSend } }),
}));

import {
  IAM_PROPAGATION_SETTLE_MS,
  deferIamPropagationSettle,
  iamPropagationSettleClock,
} from '../../../src/provisioning/iam-propagation-settle.js';
import {
  withDeferredReadinessScope,
  type DeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';
import { DeferredReadinessRun } from '../../../src/deployment/deferred-readiness-run.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';

function scopeFor(logicalId: string, resourceType: string): DeferredReadinessScope {
  return {
    logicalId,
    resourceType,
    deferred: new Map(),
    awaitUpstreamReadiness: async () => undefined,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource: () => undefined,
  };
}

describe('deferIamPropagationSettle', () => {
  let now: number;
  const realNow = iamPropagationSettleClock.now;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    iamPropagationSettleClock.now = () => now;
  });

  afterEach(() => {
    iamPropagationSettleClock.now = realNow;
    vi.useRealTimers();
  });

  it('reports an iam-propagation wait for the physical id, unstarted', async () => {
    const scope = scopeFor('HandlerPolicy', 'AWS::IAM::Policy');
    await withDeferredReadinessScope(scope, async () =>
      deferIamPropagationSettle('HandlerPolicy', 'AWS::IAM::Policy', 'handler-policy')
    );
    expect([...scope.deferred.keys()]).toStrictEqual(['handler-policy']);
    expect(scope.deferred.get('handler-policy')!.kind).toBe('iam-propagation');
    expect(scope.deferred.get('handler-policy')!.remainingMs!()).toBe(IAM_PROPAGATION_SETTLE_MS);
    now += IAM_PROPAGATION_SETTLE_MS + 1;
    expect(scope.deferred.get('handler-policy')!.remainingMs!()).toBe(0);
  });

  it('does nothing outside a deploy operation, or for another logical id', async () => {
    deferIamPropagationSettle('HandlerPolicy', 'AWS::IAM::Policy', 'handler-policy');
    const scope = scopeFor('Other', 'AWS::IAM::Policy');
    await withDeferredReadinessScope(scope, async () =>
      deferIamPropagationSettle('HandlerPolicy', 'AWS::IAM::Policy', 'handler-policy')
    );
    expect(scope.deferred.size).toBe(0);
  });

  it('waits only for what remains of the settle, counted from the write', async () => {
    const scope = scopeFor('HandlerPolicy', 'AWS::IAM::Policy');
    await withDeferredReadinessScope(scope, async () =>
      deferIamPropagationSettle('HandlerPolicy', 'AWS::IAM::Policy', 'handler-policy')
    );
    // The custom resource needs it 4s after the write.
    now += 4_000;
    let done = false;
    const waited = scope.deferred
      .get('handler-policy')!
      .wait(new AbortController().signal)
      .then(() => (done = true));
    await vi.advanceTimersByTimeAsync(IAM_PROPAGATION_SETTLE_MS - 4_000 - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waited;
    expect(done).toBe(true);
  });

  it('does not wait at all once the settle has passed', async () => {
    const scope = scopeFor('HandlerPolicy', 'AWS::IAM::Policy');
    await withDeferredReadinessScope(scope, async () =>
      deferIamPropagationSettle('HandlerPolicy', 'AWS::IAM::Policy', 'handler-policy')
    );
    now += IAM_PROPAGATION_SETTLE_MS + 5_000;
    let done = false;
    const waited = scope.deferred
      .get('handler-policy')!
      .wait(new AbortController().signal)
      .then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    await waited;
    expect(done).toBe(true);
  });

  it('stops when the deploy aborts the wait', async () => {
    const scope = scopeFor('HandlerPolicy', 'AWS::IAM::Policy');
    await withDeferredReadinessScope(scope, async () =>
      deferIamPropagationSettle('HandlerPolicy', 'AWS::IAM::Policy', 'handler-policy')
    );
    const controller = new AbortController();
    const waited = scope.deferred.get('handler-policy')!.wait(controller.signal);
    controller.abort();
    await expect(waited).rejects.toThrow('readiness wait aborted');
  });
});

describe('the wait line names IAM propagation, not --no-wait', () => {
  type LogFn = (message: string, ...args: unknown[]) => void;

  function runWith(
    info: LogFn,
    debug: LogFn,
    options: { remainingMs?: number; mask?: (logicalId: string, text: string) => string } = {}
  ) {
    const run = new DeferredReadinessRun({
      logger: { info, debug },
      region: 'us-east-1',
      budget: () => ({ warnAfterMs: 60_000, timeoutMs: 120_000 }),
      interrupted: () => false,
      ...(options.mask && { mask: options.mask }),
    });
    const remainingMs = options.remainingMs ?? 5_000;
    for (const [id, type] of [
      ['HandlerRole', 'AWS::IAM::Role'],
      ['HandlerPolicy', 'AWS::IAM::Policy'],
    ] as const) {
      run.record(
        id,
        type,
        'CREATE',
        new Map([
          [
            `${id}-phys`,
            {
              wait: async () => undefined,
              inContext: (fn) => fn(),
              kind: 'iam-propagation',
              remainingMs: () => remainingMs,
            },
          ],
        ])
      );
    }
    return run;
  }

  it('prints one line for the settles a custom resource starts, naming each', async () => {
    const info = vi.fn<LogFn>();
    const debug = vi.fn<LogFn>();
    const run = runWith(info, debug);
    await run.awaitAll(
      ['HandlerRole', 'Unrelated', 'HandlerPolicy'],
      'custom resource Seed is invoked after it'
    );
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toContain('Waiting for IAM to propagate 2 permission write(s) of this deploy');
    expect(line).toContain('HandlerRole, HandlerPolicy');
    expect(line).toContain('custom resource Seed is invoked after it');
    expect(line).not.toContain('--no-wait');
    // Per resource only in debug.
    expect(debug.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Waiting for IAM to propagate HandlerPolicy (AWS::IAM::Policy)'
    );
  });

  it('prints nothing when every settle has already passed: nothing waits', async () => {
    const info = vi.fn<LogFn>();
    const run = runWith(info, vi.fn<LogFn>(), { remainingMs: 0 });
    await run.awaitAll(['HandlerRole', 'HandlerPolicy'], 'custom resource Seed is invoked after it');
    expect(info).not.toHaveBeenCalled();
  });

  it("masks the line with each named settle's secrets", async () => {
    const info = vi.fn<LogFn>();
    const masked: string[] = [];
    const mask = (logicalId: string, text: string): string => {
      masked.push(logicalId);
      return logicalId === 'HandlerPolicy' ? text.replaceAll('prod-billing-x7', '***') : text;
    };
    const run = runWith(info, vi.fn<LogFn>(), { mask });
    await run.awaitAll(
      ['HandlerRole', 'HandlerPolicy'],
      'custom resource prod-billing-x7-seed is invoked after it'
    );
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toContain('Waiting for IAM to propagate 2');
    expect(line).toContain('custom resource ***-seed is invoked after it');
    expect(line).not.toContain('prod-billing-x7');
    expect(masked).toEqual(expect.arrayContaining(['HandlerRole', 'HandlerPolicy']));
  });

  it('prints nothing for settles an earlier consumer already started', async () => {
    const info = vi.fn<LogFn>();
    const run = runWith(info, vi.fn<LogFn>());
    await run.awaitAll(['HandlerRole', 'HandlerPolicy'], 'custom resource First is invoked after it');
    info.mockClear();
    await run.awaitAll(['HandlerRole', 'HandlerPolicy'], 'custom resource Second is invoked after it');
    expect(info).not.toHaveBeenCalled();
  });
});

describe('the IAM providers report the settle after a write', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        // Echo the requested name, so a replacement's new physical id comes through.
        case 'CreateRoleCommand':
        case 'GetRoleCommand': {
          const name = (command as unknown as { input: { RoleName?: string } }).input.RoleName ?? 'handler-role';
          return Promise.resolve({
            Role: { RoleName: name, Arn: `arn:aws:iam::123456789012:role/${name}`, RoleId: `AROA-${name}` },
          });
        }
        case 'CreatePolicyCommand':
        case 'GetPolicyCommand': {
          const input = (command as unknown as { input: { PolicyName?: string; PolicyArn?: string } }).input;
          const name = input.PolicyName ?? input.PolicyArn?.split('/').pop() ?? 'mp';
          return Promise.resolve({
            Policy: {
              PolicyName: name,
              Arn: `arn:aws:iam::123456789012:policy/${name}`,
              PolicyId: `ANPA-${name}`,
              DefaultVersionId: 'v1',
            },
          });
        }
        default:
          return Promise.resolve({});
      }
    });
  });

  const document = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: '*' }],
  };

  it('AWS::IAM::Policy create', async () => {
    const scope = scopeFor('HandlerPolicy', 'AWS::IAM::Policy');
    await withDeferredReadinessScope(scope, () =>
      new IAMPolicyProvider().create('HandlerPolicy', 'AWS::IAM::Policy', {
        PolicyName: 'handler-policy',
        PolicyDocument: document,
        Roles: ['handler-role'],
      })
    );
    expect(scope.deferred.get('handler-policy')?.kind).toBe('iam-propagation');
  });

  it('AWS::IAM::Role create', async () => {
    const scope = scopeFor('HandlerRole', 'AWS::IAM::Role');
    await withDeferredReadinessScope(scope, () =>
      new IAMRoleProvider().create('HandlerRole', 'AWS::IAM::Role', {
        RoleName: 'handler-role',
        AssumeRolePolicyDocument: document,
      })
    );
    expect(scope.deferred.get('handler-role')?.kind).toBe('iam-propagation');
  });

  it('AWS::IAM::ManagedPolicy create', async () => {
    const scope = scopeFor('HandlerManagedPolicy', 'AWS::IAM::ManagedPolicy');
    await withDeferredReadinessScope(scope, () =>
      new IAMManagedPolicyProvider().create('HandlerManagedPolicy', 'AWS::IAM::ManagedPolicy', {
        ManagedPolicyName: 'mp',
        PolicyDocument: document,
      })
    );
    expect(scope.deferred.get('arn:aws:iam::123456789012:policy/mp')?.kind).toBe(
      'iam-propagation'
    );
  });

  it('AWS::IAM::Policy update', async () => {
    const scope = scopeFor('HandlerPolicy', 'AWS::IAM::Policy');
    const previous = { PolicyName: 'handler-policy', PolicyDocument: document, Roles: ['handler-role'] };
    await withDeferredReadinessScope(scope, () =>
      new IAMPolicyProvider().update(
        'HandlerPolicy',
        'handler-policy',
        'AWS::IAM::Policy',
        { ...previous, PolicyDocument: { ...document, Statement: [...document.Statement, document.Statement[0]] } },
        previous
      )
    );
    expect(scope.deferred.get('handler-policy')?.kind).toBe('iam-propagation');
  });

  it('AWS::IAM::Role update', async () => {
    const scope = scopeFor('HandlerRole', 'AWS::IAM::Role');
    const previous = { RoleName: 'handler-role', AssumeRolePolicyDocument: document };
    await withDeferredReadinessScope(scope, () =>
      new IAMRoleProvider().update(
        'HandlerRole',
        'handler-role',
        'AWS::IAM::Role',
        { ...previous, Policies: [{ PolicyName: 'inline', PolicyDocument: document }] },
        previous
      )
    );
    expect(scope.deferred.get('handler-role')?.kind).toBe('iam-propagation');
  });

  it('AWS::IAM::ManagedPolicy update', async () => {
    const arn = 'arn:aws:iam::123456789012:policy/mp';
    const scope = scopeFor('HandlerManagedPolicy', 'AWS::IAM::ManagedPolicy');
    const previous = { ManagedPolicyName: 'mp', PolicyDocument: document, Roles: [] as string[] };
    await withDeferredReadinessScope(scope, () =>
      new IAMManagedPolicyProvider().update(
        'HandlerManagedPolicy',
        arn,
        'AWS::IAM::ManagedPolicy',
        { ...previous, Roles: ['handler-role'] },
        previous
      )
    );
    expect(scope.deferred.get(arn)?.kind).toBe('iam-propagation');
  });

  it('AWS::IAM::Role replacing update (RoleName change) settles the NEW role', async () => {
    const scope = scopeFor('HandlerRole', 'AWS::IAM::Role');
    const previous = { RoleName: 'handler-role', AssumeRolePolicyDocument: document };
    const result = await withDeferredReadinessScope(scope, () =>
      new IAMRoleProvider().update(
        'HandlerRole',
        'handler-role',
        'AWS::IAM::Role',
        { ...previous, RoleName: 'handler-role-2' },
        previous
      )
    );
    expect(result.wasReplaced).toBe(true);
    expect(scope.deferred.get('handler-role-2')?.kind).toBe('iam-propagation');
  });

  it('AWS::IAM::ManagedPolicy replacing update (name change) settles the NEW policy', async () => {
    const scope = scopeFor('HandlerManagedPolicy', 'AWS::IAM::ManagedPolicy');
    const previous = { ManagedPolicyName: 'mp', PolicyDocument: document };
    const result = await withDeferredReadinessScope(scope, () =>
      new IAMManagedPolicyProvider().update(
        'HandlerManagedPolicy',
        'arn:aws:iam::123456789012:policy/mp',
        'AWS::IAM::ManagedPolicy',
        { ...previous, ManagedPolicyName: 'mp-2' },
        previous
      )
    );
    expect(result.wasReplaced).toBe(true);
    expect(scope.deferred.get('arn:aws:iam::123456789012:policy/mp-2')?.kind).toBe(
      'iam-propagation'
    );
  });

  it('AWS::IAM::Policy rename (in place, no replacement) settles under the new name', async () => {
    const scope = scopeFor('HandlerPolicy', 'AWS::IAM::Policy');
    const previous = { PolicyName: 'handler-policy', PolicyDocument: document, Roles: ['handler-role'] };
    await withDeferredReadinessScope(scope, () =>
      new IAMPolicyProvider().update(
        'HandlerPolicy',
        'handler-policy',
        'AWS::IAM::Policy',
        { ...previous, PolicyName: 'handler-policy-2' },
        previous
      )
    );
    expect(scope.deferred.get('handler-policy-2')?.kind).toBe('iam-propagation');
  });

  it('a failed write reports nothing', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('User is not authorized to perform this action'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 403 },
      })
    );
    const scope = scopeFor('HandlerPolicy', 'AWS::IAM::Policy');
    await expect(
      withDeferredReadinessScope(scope, () =>
        new IAMPolicyProvider().create('HandlerPolicy', 'AWS::IAM::Policy', {
          PolicyName: 'handler-policy',
          PolicyDocument: document,
          Roles: ['handler-role'],
        })
      )
    ).rejects.toThrow();
    expect(scope.deferred.size).toBe(0);
  });
});

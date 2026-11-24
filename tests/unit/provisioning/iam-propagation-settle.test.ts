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

  it('reports an iam-propagation wait for the physical id, unstarted', () => {
    const scope = scopeFor('HandlerPolicy', 'AWS::IAM::Policy');
    void withDeferredReadinessScope(scope, async () =>
      deferIamPropagationSettle('HandlerPolicy', 'AWS::IAM::Policy', 'handler-policy')
    );
    expect([...scope.deferred.keys()]).toStrictEqual(['handler-policy']);
    expect(scope.deferred.get('handler-policy')!.kind).toBe('iam-propagation');
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
  function runWith(info: ReturnType<typeof vi.fn>, debug: ReturnType<typeof vi.fn>) {
    const run = new DeferredReadinessRun({
      logger: { info, debug },
      region: 'us-east-1',
      budget: () => ({ warnAfterMs: 60_000, timeoutMs: 120_000 }),
      interrupted: () => false,
    });
    for (const [id, type] of [
      ['HandlerRole', 'AWS::IAM::Role'],
      ['HandlerPolicy', 'AWS::IAM::Policy'],
    ] as const) {
      run.record(
        id,
        type,
        'CREATE',
        new Map([
          [`${id}-phys`, { wait: async () => undefined, inContext: (fn) => fn(), kind: 'iam-propagation' }],
        ])
      );
    }
    return run;
  }

  it('prints one line for the settles a custom resource starts, naming each', async () => {
    const info = vi.fn();
    const debug = vi.fn();
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

  it('prints nothing for settles an earlier consumer already started', async () => {
    const info = vi.fn();
    const run = runWith(info, vi.fn());
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
        case 'CreateRoleCommand':
          return Promise.resolve({
            Role: { RoleName: 'handler-role', Arn: 'arn:aws:iam::123456789012:role/handler-role', RoleId: 'AROA1' },
          });
        case 'GetRoleCommand':
          return Promise.resolve({
            Role: { RoleName: 'handler-role', Arn: 'arn:aws:iam::123456789012:role/handler-role', RoleId: 'AROA1' },
          });
        case 'CreatePolicyCommand':
          return Promise.resolve({
            Policy: { PolicyName: 'mp', Arn: 'arn:aws:iam::123456789012:policy/mp', PolicyId: 'ANPA1', DefaultVersionId: 'v1' },
          });
        case 'GetPolicyCommand':
          return Promise.resolve({
            Policy: { PolicyName: 'mp', Arn: 'arn:aws:iam::123456789012:policy/mp', PolicyId: 'ANPA1', DefaultVersionId: 'v1' },
          });
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

  it('a failed write reports nothing', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
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

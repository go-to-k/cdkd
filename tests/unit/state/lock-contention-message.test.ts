import { describe, expect, it, vi } from 'vite-plus/test';
import {
  buildForceUnlockCommand,
  buildLockContentionMessage,
} from '../../../src/state/lock-contention-message.js';
import type { LockManager } from '../../../src/state/lock-manager.js';

/**
 * A `getLockInfo`-only stand-in. The helper's parameter is
 * `Pick<LockManager, 'getLockInfo'>` precisely so a test does not have to
 * construct a real one; the cast keeps that visible.
 */
function lockManagerReturning(info: unknown, spy = vi.fn()): Pick<LockManager, 'getLockInfo'> {
  return {
    getLockInfo: spy.mockResolvedValue(info),
  } as unknown as Pick<LockManager, 'getLockInfo'>;
}

function lockManagerRejecting(err: unknown): Pick<LockManager, 'getLockInfo'> {
  return {
    getLockInfo: vi.fn().mockRejectedValue(err),
  } as unknown as Pick<LockManager, 'getLockInfo'>;
}

describe('buildForceUnlockCommand (issue #2170)', () => {
  it('always carries --stack-region', () => {
    expect(buildForceUnlockCommand('MyStack', 'us-east-1')).toBe(
      'cdkd force-unlock MyStack --stack-region us-east-1'
    );
  });

  it('propagates every flag that decides WHICH lock force-unlock resolves to', () => {
    // The whole point of the issue: `force-unlock` re-resolves the bucket from
    // the ambient profile, so after `cdkd destroy --profile prod` a hint that
    // carried only --stack-region pointed at a different ACCOUNT.
    expect(
      buildForceUnlockCommand('MyStack', 'eu-west-1', {
        profile: 'prod',
        stateBucket: 'cdkd-state-111122223333',
        statePrefix: 'team-a',
      })
    ).toBe(
      'cdkd force-unlock MyStack --stack-region eu-west-1 --profile prod ' +
        '--state-bucket cdkd-state-111122223333 --state-prefix team-a'
    );
  });

  it('omits a flag that was never set rather than emitting an empty value', () => {
    const cmd = buildForceUnlockCommand('MyStack', 'us-east-1', { profile: undefined });
    expect(cmd).not.toContain('--profile');
    expect(cmd).toBe('cdkd force-unlock MyStack --stack-region us-east-1');
  });

  it('quotes a value that would otherwise truncate when pasted', () => {
    const cmd = buildForceUnlockCommand('MyStack', 'us-east-1', { profile: 'my prod' });
    expect(cmd).toContain(`--profile 'my prod'`);
  });

  it('escapes an embedded single quote instead of ending the quoted run', () => {
    const cmd = buildForceUnlockCommand('MyStack', 'us-east-1', { statePrefix: `it's` });
    // The POSIX close-escape-reopen form; pasting this yields the literal value.
    expect(cmd).toContain(`--state-prefix 'it'\\''s'`);
  });
});

describe('buildLockContentionMessage (issue #2170)', () => {
  const base = { stackName: 'MyStack', region: 'us-east-1' };

  it('names the holder, the operation and the expiry', async () => {
    // The finding this closes: the message asked the user to decide whether
    // another process was live while printing none of the evidence.
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning({
        owner: 'alice@host:4242',
        operation: 'deploy',
        expiresAt: Date.now() + 12 * 60_000,
      }),
    });
    expect(msg).toContain('held by alice@host:4242');
    expect(msg).toContain('operation: deploy');
    expect(msg).toMatch(/expires in ~1[12]m/);
  });

  it('reads the holder for the region it was asked about', async () => {
    const spy = vi.fn();
    await buildLockContentionMessage({
      stackName: 'MyStack',
      region: 'ap-northeast-1',
      lockManager: lockManagerReturning(null, spy),
    });
    expect(spy).toHaveBeenCalledWith('MyStack', 'ap-northeast-1');
  });

  it('degrades to the evidence-free wording when the lock has vanished', async () => {
    // A lock released between the failed acquire and this read is a race, not
    // an error — the acquire still legitimately failed.
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning(null),
    });
    expect(msg).toContain('another cdkd process holds it');
    expect(msg).not.toContain('held by');
  });

  it('degrades rather than replacing the contention with a read error', async () => {
    // Load-bearing: the caller is already on its way to throwing, and an S3
    // failure here would lose the reason it is throwing.
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerRejecting(new Error('AccessDenied')),
    });
    expect(msg).toContain('another cdkd process holds it');
    expect(msg).not.toContain('AccessDenied');
  });

  it('omits the operation clause when the lock records none', async () => {
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning({ owner: 'bob@host:1', expiresAt: Date.now() + 60_000 }),
    });
    expect(msg).toContain('held by bob@host:1');
    expect(msg).not.toContain('operation:');
  });

  it('reports an already-expired lock as such rather than as a negative duration', async () => {
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning({ owner: 'bob@host:1', expiresAt: Date.now() - 60_000 }),
    });
    expect(msg).toContain('already expired');
    expect(msg).not.toContain('-1m');
  });

  it('varies only the noun across subjects, so one grep finds every spelling', async () => {
    // The third finding: the nine sites had drifted to three spellings, so a
    // user grepping CI logs for one of them found two of three.
    const lockManager = lockManagerReturning(null);
    const [stack, nested, child] = await Promise.all([
      buildLockContentionMessage({ ...base, lockManager }),
      buildLockContentionMessage({ ...base, lockManager, subject: 'nested stack' }),
      buildLockContentionMessage({ ...base, lockManager, subject: 'nested-stack child' }),
    ]);
    for (const msg of [stack, nested, child]) {
      expect(msg).toContain('Could not acquire lock for');
    }
    expect(stack).toContain(`lock for stack 'MyStack'`);
    expect(nested).toContain(`lock for nested stack 'MyStack'`);
    expect(child).toContain(`lock for nested-stack child 'MyStack'`);
  });

  it('keeps a caller-supplied held clause and still adds the evidence', async () => {
    // `cdkd export`'s nested children retry first, so "holds it" would be a
    // less accurate statement than "held it through the retry window".
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning({ owner: 'carol@host:9', expiresAt: Date.now() + 60_000 }),
      heldClause: 'another cdkd process held it through the retry window',
      subject: 'nested-stack child',
    });
    expect(msg).toContain('held it through the retry window — held by carol@host:9');
  });

  it('appends a caller-supplied suffix verbatim', async () => {
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning(null),
      suffix: 'No CloudFormation changeset has been submitted; cdkd state is unchanged.',
    });
    expect(msg.endsWith('No CloudFormation changeset has been submitted; cdkd state is unchanged.')).toBe(
      true
    );
  });

  it('carries the fully-qualified recovery command', async () => {
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning(null),
      recovery: { profile: 'prod', stateBucket: 'bkt' },
    });
    expect(msg).toContain(
      `'cdkd force-unlock MyStack --stack-region us-east-1 --profile prod --state-bucket bkt'`
    );
  });
});

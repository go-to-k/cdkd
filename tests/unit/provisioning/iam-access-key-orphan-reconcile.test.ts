import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy, infoSpy, errorSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  infoSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
    }),
  };
});

import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { markReplayFollowedAmbiguous } from '../../../src/provisioning/providers/ambiguous-create.js';

const transient500 = (): Error =>
  Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'InternalError',
    $metadata: { httpStatusCode: 500 },
  });

/**
 * A fake IAM modelling the one thing that matters here: `CreateAccessKey` has NO
 * idempotency token, so a replay really does mint a second key. The fake keeps
 * the live key list so a test can assert what SURVIVES, which is the property
 * the issue cares about — not how many calls were made.
 */
class FakeIam {
  readonly keys = new Map<string, Date>();
  private nextId = 1;
  /** Make the next CreateAccessKey mint its key and then lose the response. */
  loseNextCreateResponse = false;
  /**
   * The SDK replayed the next CreateAccessKey inside its `send` (issue #4687):
   * the first attempt minted a key and lost its response to a socket reset, the
   * replay minted ANOTHER and returned it with `$metadata.attempts: 2`, an
   * output the 5xx-refusing client marks as following an ambiguous attempt.
   */
  replayNextCreate = false;
  /**
   * The SDK retried the next CreateAccessKey after a THROTTLE: IAM did nothing
   * on the first attempt, so ONE key exists, returned with
   * `$metadata.attempts: 2` and no ambiguous-attempt mark.
   */
  throttleNextCreate = false;
  /** Make DeleteAccessKey fail. */
  failDelete = false;
  /** Make ListAccessKeys fail (a role without `iam:ListAccessKeys`). */
  failList = false;
  /**
   * Microtask yields injected inside CreateAccessKey. With no per-user lock a
   * sibling create runs to completion inside them, which is what reproduces the
   * concurrent two-key case; with the lock the sibling is queued and these are
   * simply idle turns, so the test terminates either way and uses no timers.
   */
  yieldsInsideCreate = 0;
  /**
   * Per-call override of {@link yieldsInsideCreate}, keyed by 1-based call
   * order. Lets a test park one create IN FLIGHT — minted but not yet returned
   * — while a sibling's reconcile runs, which is the only window the
   * created-by-this-process id set cannot cover.
   */
  readonly yieldsByCreateIndex = new Map<number, number>();
  /** Records create() entry/exit so a test can assert they never overlap. */
  readonly createSpans: string[] = [];

  private async createAccessKey(userName: string): Promise<unknown> {
    const callIndex = this.nextId;
    this.createSpans.push(`enter:${userName}:${callIndex}`);
    const accessKeyId = `AKIA${String(this.nextId++).padStart(4, '0')}`;
    this.keys.set(accessKeyId, new Date());
    const yields = this.yieldsByCreateIndex.get(callIndex) ?? this.yieldsInsideCreate;
    for (let i = 0; i < yields; i++) {
      await Promise.resolve();
    }
    this.createSpans.push(`exit:${accessKeyId}`);
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw transient500();
    }
    if (this.replayNextCreate) {
      this.replayNextCreate = false;
      const replayedId = `AKIA${String(this.nextId++).padStart(4, '0')}`;
      this.keys.set(replayedId, new Date());
      const output = {
        AccessKey: { AccessKeyId: replayedId, SecretAccessKey: `secret-${replayedId}` },
        $metadata: { attempts: 2 },
      };
      markReplayFollowedAmbiguous(output);
      return output;
    }
    if (this.throttleNextCreate) {
      this.throttleNextCreate = false;
      return {
        AccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: `secret-${accessKeyId}` },
        $metadata: { attempts: 2 },
      };
    }
    return {
      AccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: `secret-${accessKeyId}` },
      $metadata: { attempts: 1 },
    };
  }

  send = (command: { constructor: { name: string }; input: Record<string, unknown> }): unknown => {
    const input = command.input;
    switch (command.constructor.name) {
      case 'ListAccessKeysCommand': {
        if (this.failList) {
          return Promise.reject(new Error('AccessDenied: iam:ListAccessKeys'));
        }
        return Promise.resolve({
          AccessKeyMetadata: [...this.keys].map(([AccessKeyId, CreateDate]) => ({
            AccessKeyId,
            CreateDate,
          })),
        });
      }
      case 'CreateAccessKeyCommand':
        return this.createAccessKey(String(input['UserName']));
      case 'DeleteAccessKeyCommand': {
        if (this.failDelete) {
          return Promise.reject(new Error('AccessDenied: iam:DeleteAccessKey'));
        }
        this.keys.delete(command.input['AccessKeyId'] as string);
        return Promise.resolve({});
      }
      default:
        return Promise.resolve({});
    }
  };
}

/**
 * The retry's sleep, with the clock advanced.
 *
 * Unlike the EC2 / Route 53 suites -- where an advancing clock is what makes a
 * `Date.now()`-derived token discriminate -- nothing here is derived from a
 * clock. What the faked `Date` buys this suite is a DETERMINISTIC comparison
 * between an attempt's start and a key's `CreateDate`, which is the fence for
 * the unattributable-key case; the advance keeps that ordering realistic across
 * a retry rather than collapsing every attempt onto one instant.
 */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

describe('IAMAccessKeyProvider orphaned-key reconcile (issue #2039)', () => {
  let provider: IAMAccessKeyProvider;
  let aws: FakeIam;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    aws = new FakeIam();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    for (const spy of [warnSpy, debugSpy, infoSpy, errorSpy]) spy.mockReset();
    provider = new IAMAccessKeyProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves exactly ONE access key alive when a lost-response create is retried', async () => {
    aws.loseNextCreateResponse = true;

    const result = await withRetry(
      () => provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      'Key',
      { sleep: advancingSleep }
    );

    // The recorded key is the one the deploy can actually use; the key minted by
    // the attempt whose response was lost is unusable (its secret went with the
    // response) and must not survive the deploy.
    expect([...aws.keys.keys()]).toEqual([result.physicalId]);
    expect(aws.keys.size).toBe(1);
  });

  it('names the deleted orphan so the operator can audit it', async () => {
    aws.loseNextCreateResponse = true;

    await withRetry(
      () => provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      'Key',
      { sleep: advancingSleep }
    );

    expect(warnSpy.mock.calls.map(([m]) => String(m)).join('\n')).toContain('AKIA0001');
  });

  it('never deletes a key the user already held', async () => {
    aws.keys.set('AKIA-PRE-EXISTING', new Date(Date.now() - 86_400_000));
    aws.loseNextCreateResponse = true;

    const result = await withRetry(
      () => provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      'Key',
      { sleep: advancingSleep }
    );

    expect([...aws.keys.keys()].sort()).toEqual(['AKIA-PRE-EXISTING', result.physicalId].sort());
  });

  it('degrades to the pre-fix behaviour, without failing, when ListAccessKeys is denied', async () => {
    aws.failList = true;
    aws.loseNextCreateResponse = true;

    const result = await withRetry(
      () => provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      'Key',
      { sleep: advancingSleep }
    );

    // The create still succeeds — a missing read permission must not turn a
    // working deploy into a broken one over a safety net.
    expect(result.physicalId).toBeDefined();
    expect(aws.keys.size).toBe(2);
  });

  // --- the two-resource concurrent case (the reviewers' blocker) -------------
  // One IAM user carrying two `AWS::IAM::AccessKey` resources is the ordinary
  // two-key rotation shape, and the deploy engine dispatches both at once at
  // the default --concurrency 10. A single-resource test cannot see any of
  // this: the sibling IS the discriminator.

  it('does not delete a SIBLING resource key when its own attempt fails concurrently', async () => {
    // KeyA loses its response after minting; while it is inside CreateAccessKey,
    // KeyB completes. Without the per-user lock, KeyA's reconcile sees KeyB's
    // key as "appeared since my baseline" and deletes a live credential that is
    // already in cdkd state and already piped into a downstream secret.
    aws.yieldsInsideCreate = 20;
    aws.loseNextCreateResponse = true;

    const keyA = withRetry(
      () => provider.create('KeyA', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      'KeyA',
      { sleep: advancingSleep }
    );
    const keyB = provider.create('KeyB', 'AWS::IAM::AccessKey', { UserName: 'ci-user' });
    const [resultA, resultB] = await Promise.all([keyA, keyB]);

    // Both recorded keys must be alive: the deploy reported both to state.
    expect([...aws.keys.keys()].sort()).toEqual([resultA.physicalId, resultB.physicalId].sort());
    expect(aws.keys.has(resultB.physicalId)).toBe(true);
  });

  it('does not delete a sibling key that is still IN FLIGHT when its reconcile runs', async () => {
    // The window the created-by-this-process id set cannot close: KeyB has
    // MINTED its key but has not returned yet, so nothing has recorded it as
    // cdkd-owned, while KeyA's failed attempt reconciles. Only the per-user
    // lock keeps these two apart.
    aws.loseNextCreateResponse = true; // consumed by the first create (KeyA)
    aws.yieldsByCreateIndex.set(1, 0); // KeyA: mint and fail immediately
    aws.yieldsByCreateIndex.set(2, 30); // KeyB: still inside create()

    const keyA = withRetry(
      () => provider.create('KeyA', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      'KeyA',
      { sleep: advancingSleep }
    );
    const keyB = provider.create('KeyB', 'AWS::IAM::AccessKey', { UserName: 'ci-user' });
    const [resultA, resultB] = await Promise.all([keyA, keyB]);

    // The id KeyB reports to state must still exist in AWS.
    expect(aws.keys.has(resultB.physicalId)).toBe(true);
    expect([...aws.keys.keys()].sort()).toEqual([resultA.physicalId, resultB.physicalId].sort());
  });

  it('never deletes a key cdkd itself created, even when the baseline read missed it', async () => {
    // The per-user lock closes the in-process sibling race, so this covers what
    // the lock cannot: a key cdkd owns that is ABSENT from the baseline. IAM's
    // list calls are eventually consistent, so a key created seconds earlier
    // can be missing from one page and present in the next — and the same shape
    // appears when a SECOND cdkd process shares the user. The baseline can only
    // ever say "newer than my snapshot", which is equally true of my orphan and
    // of a key that is already recorded in someone's state.
    const owned = await provider.create('KeyA', 'AWS::IAM::AccessKey', { UserName: 'ci-user' });

    let hideOwnedKey = true;
    aws.loseNextCreateResponse = true;
    mockSend.mockImplementation(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'ListAccessKeysCommand' && hideOwnedKey) {
          // The BASELINE read misses it; the post-failure read sees it.
          hideOwnedKey = false;
          const hidden = new Map(aws.keys);
          hidden.delete(owned.physicalId);
          return Promise.resolve({
            AccessKeyMetadata: [...hidden].map(([AccessKeyId, CreateDate]) => ({
              AccessKeyId,
              CreateDate,
            })),
          });
        }
        return aws.send(command as never);
      }
    );

    await withRetry(
      () => provider.create('KeyB', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      'KeyB',
      { sleep: advancingSleep }
    );

    expect(aws.keys.has(owned.physicalId)).toBe(true);
  });

  it('serializes concurrent creates on the same user', async () => {
    aws.yieldsInsideCreate = 20;

    await Promise.all([
      provider.create('KeyA', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      provider.create('KeyB', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
    ]);

    // enter/exit must nest, never interleave. Without the lock the spans read
    // enter, enter, exit, exit.
    expect(aws.createSpans).toHaveLength(4);
    expect(aws.createSpans[0]).toMatch(/^enter:/);
    expect(aws.createSpans[1]).toMatch(/^exit:/);
    expect(aws.createSpans[2]).toMatch(/^enter:/);
    expect(aws.createSpans[3]).toMatch(/^exit:/);
  });

  it('runs creates for DIFFERENT users concurrently', async () => {
    // The lock is per user; serializing every access key in the deploy would be
    // a gratuitous throughput loss.
    aws.yieldsInsideCreate = 20;

    await Promise.all([
      provider.create('KeyA', 'AWS::IAM::AccessKey', { UserName: 'user-one' }),
      provider.create('KeyB', 'AWS::IAM::AccessKey', { UserName: 'user-two' }),
    ]);

    expect(aws.createSpans[0]).toMatch(/^enter:/);
    expect(aws.createSpans[1]).toMatch(/^enter:/);
  });

  it('leaves a key it cannot attribute to this attempt, and says so', async () => {
    // A key whose CreateDate predates the attempt cannot be this attempt's
    // orphan, however new it is relative to the baseline. The safe direction is
    // to leave it and report it.
    aws.loseNextCreateResponse = true;
    const planted = 'AKIA-OUT-OF-BAND';
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'ListAccessKeysCommand' && aws.keys.size > 0) {
        // Appears only on the post-failure read, dated well before the attempt.
        aws.keys.set(planted, new Date(Date.now() - 3_600_000));
      }
      return aws.send(command as never);
    });

    await withRetry(
      () => provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      'Key',
      { sleep: advancingSleep }
    );

    expect(aws.keys.has(planted)).toBe(true);
    const warnings = warnSpy.mock.calls.map(([m]) => String(m)).join('\n');
    expect(warnings).toContain('cannot attribute it to this attempt');
    expect(warnings).not.toContain(`${planted} was minted`);
  });

  it('re-baselines after a successful create instead of reusing a stale snapshot', async () => {
    const first = await provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'ci-user' });

    // A `--replace` re-create of the same logical id: the key the first create
    // made is now part of the user's legitimate baseline and must survive.
    aws.loseNextCreateResponse = true;
    const second = await withRetry(
      () => provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
      'Key',
      { sleep: advancingSleep }
    );

    expect([...aws.keys.keys()].sort()).toEqual([first.physicalId, second.physicalId].sort());
  });

  describe('a CreateAccessKey the SDK replayed inside its send (issue #4687)', () => {
    const create = () =>
      withRetry(
        () => provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'ci-user' }),
        'Key',
        { sleep: advancingSleep }
      );
    const warnings = (): string => warnSpy.mock.calls.map(([m]) => String(m)).join('\n');
    const calls = (): string[] =>
      mockSend.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name);

    it('deletes the key the first attempt minted and keeps the one the replay returned', async () => {
      aws.replayNextCreate = true;

      const result = await create();

      expect(result.physicalId).toBe('AKIA0002');
      expect([...aws.keys.keys()]).toEqual(['AKIA0002']);
      expect(calls()).toEqual([
        'ListAccessKeysCommand',
        'CreateAccessKeyCommand',
        'ListAccessKeysCommand',
        'DeleteAccessKeyCommand',
      ]);
      const deleted = mockSend.mock.calls
        .filter(([c]) => (c as { constructor: { name: string } }).constructor.name === 'DeleteAccessKeyCommand')
        .map(([c]) => (c as { input: Record<string, unknown> }).input['AccessKeyId']);
      expect(deleted).toEqual(['AKIA0001']);
      expect(warnings()).toContain('AKIA0001 was minted on user ci-user by the CreateAccessKey attempt for Key that the AWS SDK then sent again');
    });

    it('never logs the returned key\'s secret nor the deleted key\'s, on any channel', async () => {
      aws.replayNextCreate = true;

      const result = await create();

      // AKIA0001 is the deleted key; its secret (`secret-AKIA0001` in this
      // fake's naming) left with the lost response.
      expect(aws.keys.has('AKIA0001')).toBe(false);
      const everything = [debugSpy, infoSpy, warnSpy, errorSpy]
        .flatMap((spy) => spy.mock.calls.flat())
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join('\n');
      // The channels did carry the reconcile, so the absence below is meaningful.
      expect(everything).toContain('AKIA0001');
      expect(result.attributes?.['SecretAccessKey']).toBe('secret-AKIA0002');
      expect(everything).not.toContain('secret-AKIA0002');
      expect(everything).not.toContain('secret-AKIA0001');
      expect(everything).not.toContain('secret-');
    });

    it('a replay after a THROTTLE deletes nothing and makes no extra call', async () => {
      // A key that appears mid-create, dated inside the attempt and unknown to
      // this process, would pass all three conditions: only the gate keeps it.
      mockSend.mockImplementation(
        (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (command.constructor.name === 'CreateAccessKeyCommand') {
            aws.keys.set('AKIA-OTHER-PROCESS', new Date());
          }
          return aws.send(command as never);
        }
      );
      aws.throttleNextCreate = true;

      const result = await create();

      expect(result.physicalId).toBe('AKIA0001');
      expect(calls()).toEqual(['ListAccessKeysCommand', 'CreateAccessKeyCommand']);
      expect([...aws.keys.keys()].sort()).toEqual(['AKIA-OTHER-PROCESS', 'AKIA0001']);
      expect(warnings()).toBe('');
    });

    it('never deletes a key the user already held, nor one dated before the attempt', async () => {
      aws.keys.set('AKIA-PRE-EXISTING', new Date(Date.now() - 86_400_000));
      const planted = 'AKIA-OUT-OF-BAND';
      mockSend.mockImplementation(
        (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (command.constructor.name === 'ListAccessKeysCommand' && aws.keys.size > 1) {
            // Appears only on the post-replay read, dated well before the attempt.
            aws.keys.set(planted, new Date(Date.now() - 3_600_000));
          }
          return aws.send(command as never);
        }
      );
      aws.replayNextCreate = true;

      const result = await create();

      expect([...aws.keys.keys()].sort()).toEqual(
        ['AKIA-PRE-EXISTING', planted, result.physicalId].sort()
      );
      expect(warnings()).toContain('cannot attribute it to this attempt');
      expect(warnings()).toContain(
        `aws iam delete-access-key --user-name ci-user --access-key-id ${planted}`
      );
    });

    it('a single-attempt create reads the key list once (the baseline) and deletes nothing', async () => {
      const result = await create();

      expect(calls()).toEqual(['ListAccessKeysCommand', 'CreateAccessKeyCommand']);
      expect([...aws.keys.keys()]).toEqual([result.physicalId]);
    });

    it('a failed delete warns with the command and still returns the recorded key', async () => {
      aws.replayNextCreate = true;
      aws.failDelete = true;

      const result = await create();

      expect(result.physicalId).toBe('AKIA0002');
      expect(aws.keys.has('AKIA0001')).toBe(true);
      expect(warnings()).toContain(
        'aws iam delete-access-key --user-name ci-user --access-key-id AKIA0001'
      );
    });

    it('a failed ListAccessKeys after the replay warns and still returns the recorded key', async () => {
      mockSend.mockImplementation(
        (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (command.constructor.name === 'ListAccessKeysCommand' && aws.keys.size > 0) {
            return Promise.reject(new Error('AccessDenied: iam:ListAccessKeys'));
          }
          return aws.send(command as never);
        }
      );
      aws.replayNextCreate = true;

      const result = await create();

      expect(result.physicalId).toBe('AKIA0002');
      expect(calls()).not.toContain('DeleteAccessKeyCommand');
      expect(warnings()).toContain('Could not list existing access keys for user ci-user');
    });
  });
});

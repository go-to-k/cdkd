import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy, sentVia, baseStrategy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  /** `[command name, client config]` per send, so a test can see WHICH client sent it. */
  sentVia: [] as Array<[string, { retryStrategy: () => Promise<unknown> }]>,
  /** A stand-in for the SDK's resolved V2 retry strategy. */
  baseStrategy: {
    acquireInitialRetryToken: async (_scope: string) => 'token',
    refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
      'retry-token',
    recordSuccess: (_token: unknown) => undefined,
  },
}));

vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kms')>();
  return {
    ...actual,
    KMSClient: vi.fn().mockImplementation(() => {
      const config = {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      };
      return {
        config,
        send: (command: { constructor: { name: string } }) => {
          sentVia.push([command.constructor.name, config]);
          return mockSend(command);
        },
      };
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  KMSProvider,
  resetKmsCreateRetryStateForTests,
} from '../../../src/provisioning/providers/kms-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'KMSInternalException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/** A throttle: the service did nothing, so it must not arm the latch. */
const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

/** A definite refusal: AWS did nothing, and the message is an IAM-propagation retry pattern. */
const propagationDenied = (): Error =>
  Object.assign(
    new Error('User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: kms:X'),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 400 } }
  );

/**
 * Advance the fake clock on every backoff, per issue #2080 acceptance item 3:
 * with a no-op sleep two attempts land in the same millisecond and a
 * time-window check passes by coincidence.
 */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

/**
 * A backoff far past the 5 s skew margin (real retries back off up to 8 s,
 * longer on the IAM-propagation schedule). With the 1-2 s of `advancingSleep`,
 * a window anchored on the LOOKUP time instead of the ambiguous attempt would
 * still cover the orphan by accident.
 */
const longSleep = (): Promise<void> => {
  vi.setSystemTime(Date.now() + 30_000);
  return Promise.resolve();
};

interface FakeKey {
  KeyId: string;
  Arn: string;
  KeyManager: 'CUSTOMER' | 'AWS';
  KeyState: string;
  CreationDate: Date;
  KeySpec: string;
  KeyUsage: string;
  Origin: string;
  MultiRegion: boolean;
  Description: string;
}

/**
 * A fake KMS. `keys` counts RESOURCES, not calls -- the discriminator issue
 * #2080's acceptance item 2 asks for: a retry may repeat a call, but must not
 * leave a second key behind.
 */
class FakeKms {
  readonly keys: FakeKey[] = [];
  readonly calls: string[] = [];
  /** Per command name: errors to throw on the next calls, in order. */
  readonly failNext = new Map<string, Error[]>();
  /** CreateKey creates the key, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** DisableKey takes effect, THEN throws this (a lost response). */
  loseNextDisableResponse: Error | undefined;
  /** Keys per `ListKeys` page. */
  pageSize = 1000;
  /** The service clock's offset from ours, applied to every `CreationDate`. */
  skewMs = 0;
  private nextId = 1;

  seed(key: Partial<FakeKey> & { KeyId: string }): void {
    this.keys.push({
      Arn: `arn:aws:kms:us-east-1:1:key/${key.KeyId}`,
      KeyManager: 'CUSTOMER',
      KeyState: 'Enabled',
      CreationDate: new Date(Date.now()),
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyUsage: 'ENCRYPT_DECRYPT',
      Origin: 'AWS_KMS',
      MultiRegion: false,
      Description: '',
      ...key,
    });
  }

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    const input = command.input;
    switch (name) {
      case 'CreateKeyCommand': {
        const id = `key-${String(this.nextId++).padStart(3, '0')}`;
        const origin = (input['Origin'] as string | undefined) ?? 'AWS_KMS';
        this.seed({
          KeyId: id,
          CreationDate: new Date(Date.now() + this.skewMs),
          KeySpec: (input['KeySpec'] as string | undefined) ?? 'SYMMETRIC_DEFAULT',
          KeyUsage: (input['KeyUsage'] as string | undefined) ?? 'ENCRYPT_DECRYPT',
          Description: (input['Description'] as string | undefined) ?? '',
          MultiRegion: input['MultiRegion'] === true,
          Origin: origin,
          // An EXTERNAL key has no material until one is imported.
          KeyState: origin === 'EXTERNAL' ? 'PendingImport' : 'Enabled',
        });
        if (this.loseNextCreateResponse) {
          const error = this.loseNextCreateResponse;
          this.loseNextCreateResponse = undefined;
          throw error;
        }
        const key = this.keys[this.keys.length - 1]!;
        return { KeyMetadata: { ...key } };
      }
      case 'DescribeKeyCommand': {
        const key = this.keys.find((k) => k.KeyId === input['KeyId']);
        if (!key) {
          throw Object.assign(new Error('not found'), {
            name: 'NotFoundException',
            $metadata: { httpStatusCode: 400 },
          });
        }
        return { KeyMetadata: { ...key } };
      }
      case 'ListKeysCommand': {
        const start = input['Marker'] === undefined ? 0 : Number(input['Marker']);
        const end = start + this.pageSize;
        return {
          Keys: this.keys.slice(start, end).map((k) => ({ KeyId: k.KeyId, KeyArn: k.Arn })),
          Truncated: end < this.keys.length,
          ...(end < this.keys.length && { NextMarker: String(end) }),
        };
      }
      case 'DisableKeyCommand': {
        const key = this.keys.find((k) => k.KeyId === input['KeyId']);
        if (key) key.KeyState = 'Disabled';
        if (this.loseNextDisableResponse) {
          const error = this.loseNextDisableResponse;
          this.loseNextDisableResponse = undefined;
          throw error;
        }
        return {};
      }
      default:
        return {};
    }
  };

  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

const KEY_PROPS = { EnableKeyRotation: true };

describe('KMSProvider CreateKey retry safety (issue #2080)', () => {
  let provider: KMSProvider;
  let aws: FakeKms;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetKmsCreateRetryStateForTests();
    aws = new FakeKms();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    sentVia.length = 0;
    provider = new KMSProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createWithRetry = (props: Record<string, unknown> = KEY_PROPS, logicalId = 'Key') =>
    withRetry(() => provider.create(logicalId, 'AWS::KMS::Key', props), logicalId, {
      sleep: advancingSleep,
    });

  describe('a follow-up call failing after CreateKey succeeded', () => {
    it('a 500 on EnableKeyRotation is retried onto the SAME key: exactly one key exists', async () => {
      aws.failNext.set('EnableKeyRotationCommand', [transient500()]);

      const result = await createWithRetry();

      expect(aws.keys.map((k) => k.KeyId)).toEqual(['key-001']);
      expect(aws.count('CreateKeyCommand')).toBe(1);
      expect(aws.count('EnableKeyRotationCommand')).toBe(2);
      expect(result.physicalId).toBe('key-001');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:kms:us-east-1:1:key/key-001',
        KeyId: 'key-001',
      });
    });

    it('an IAM-propagation denial on DisableKey is retried onto the SAME key', async () => {
      aws.failNext.set('DisableKeyCommand', [propagationDenied(), propagationDenied()]);

      const result = await createWithRetry({ Enabled: false });

      expect(aws.keys).toHaveLength(1);
      expect(aws.count('CreateKeyCommand')).toBe(1);
      expect(result.physicalId).toBe('key-001');
    });

    it('warns with the key id while it is held for the retry, since an exhausted retry orphans it', async () => {
      aws.failNext.set('EnableKeyRotationCommand', [transient500()]);

      await createWithRetry();

      const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('key-001'));
      expect(line).toContain('reuses that key');
      // The delete command is for AFTER a failed deploy: run mid-retry it
      // would push the key to PendingDeletion and force a second key.
      expect(line).toContain('do not delete it while the deploy is still retrying');
      expect(line).toContain('aws kms schedule-key-deletion --key-id key-001');
    });

    it('a later create with DIFFERENT inputs does not inherit the held key, and names it', async () => {
      aws.failNext.set('EnableKeyRotationCommand', [propagationDenied()]);
      await expect(provider.create('Key', 'AWS::KMS::Key', KEY_PROPS)).rejects.toThrow();

      const result = await provider.create('Key', 'AWS::KMS::Key', {
        ...KEY_PROPS,
        Description: 'other',
      });

      expect(result.physicalId).toBe('key-002');
      expect(aws.count('CreateKeyCommand')).toBe(2);
      const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('different inputs'));
      expect(line).toContain('key-001');
    });

    it('does not resume a key someone scheduled for deletion in between', async () => {
      aws.failNext.set('EnableKeyRotationCommand', [propagationDenied()]);
      await expect(provider.create('Key', 'AWS::KMS::Key', KEY_PROPS)).rejects.toThrow();
      aws.keys[0]!.KeyState = 'PendingDeletion';

      const result = await provider.create('Key', 'AWS::KMS::Key', KEY_PROPS);

      expect(result.physicalId).toBe('key-002');
      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('PendingDeletion'));
      expect(line).toContain('key-001');
    });

    it('a TRANSIENT DescribeKey failure keeps the key held, so the next retry still resumes it', async () => {
      aws.failNext.set('EnableKeyRotationCommand', [propagationDenied()]);
      aws.failNext.set('DescribeKeyCommand', [transient500()]);

      const result = await createWithRetry();

      expect(aws.keys).toHaveLength(1);
      expect(aws.count('CreateKeyCommand')).toBe(1);
      expect(aws.count('DescribeKeyCommand')).toBe(2);
      expect(result.physicalId).toBe('key-001');
    });

    it('resumes a key a lost DisableKey response already DISABLED: exactly one key', async () => {
      aws.loseNextDisableResponse = transient500();

      const result = await createWithRetry({ Enabled: false });

      expect(aws.keys.map((k) => [k.KeyId, k.KeyState])).toEqual([['key-001', 'Disabled']]);
      expect(result.physicalId).toBe('key-001');
    });

    it('resumes an EXTERNAL-origin key, which sits in PendingImport: exactly one key', async () => {
      aws.failNext.set('EnableKeyRotationCommand', [propagationDenied()]);

      const result = await createWithRetry({ ...KEY_PROPS, Origin: 'EXTERNAL' });

      expect(aws.keys.map((k) => k.KeyState)).toEqual(['PendingImport']);
      expect(result.physicalId).toBe('key-001');
    });

    it('a DEFINITE DescribeKey failure on the held key creates a fresh key and names the old one', async () => {
      aws.failNext.set('EnableKeyRotationCommand', [propagationDenied()]);
      await expect(provider.create('Key', 'AWS::KMS::Key', KEY_PROPS)).rejects.toThrow();
      aws.failNext.set('DescribeKeyCommand', [
        Object.assign(new Error('not found'), {
          name: 'NotFoundException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        }),
      ]);

      const result = await provider.create('Key', 'AWS::KMS::Key', KEY_PROPS);

      expect(result.physicalId).toBe('key-002');
      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('reading it back failed'));
      expect(line).toContain('key-001');
    });

    it('a later create asking for LESS follow-up (rotation off) does not inherit a key that has it on', async () => {
      aws.failNext.set('DisableKeyCommand', [propagationDenied()]);
      await expect(
        provider.create('Key', 'AWS::KMS::Key', { EnableKeyRotation: true, Enabled: false })
      ).rejects.toThrow();

      const result = await provider.create('Key', 'AWS::KMS::Key', { Enabled: false });

      expect(result.physicalId).toBe('key-002');
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('different inputs'))).toBe(true);
    });

    it('a later create asking for an ENABLED key does not inherit one an earlier attempt disabled', async () => {
      // DisableKey took effect and its response was lost; the create then gave
      // up (a direct call has no retry), holding a DISABLED key.
      aws.loseNextDisableResponse = transient500();
      await expect(provider.create('Key', 'AWS::KMS::Key', { Enabled: false })).rejects.toThrow();
      expect(aws.keys[0]!.KeyState).toBe('Disabled');

      const result = await provider.create('Key', 'AWS::KMS::Key', {});

      expect(result.physicalId).toBe('key-002');
      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('different inputs'));
      expect(line).toContain('key-001');
    });

    it('a key held longer than the TTL is not resumed', async () => {
      aws.failNext.set('EnableKeyRotationCommand', [propagationDenied()]);
      await expect(provider.create('Key', 'AWS::KMS::Key', KEY_PROPS)).rejects.toThrow();
      vi.setSystemTime(Date.now() + 31 * 60_000);

      const result = await provider.create('Key', 'AWS::KMS::Key', KEY_PROPS);

      expect(result.physicalId).toBe('key-002');
      expect(aws.count('DescribeKeyCommand')).toBe(0);
    });

    it('a create after a SUCCESSFUL one mints a fresh key (the hold is released on success)', async () => {
      await provider.create('Key', 'AWS::KMS::Key', KEY_PROPS);
      const second = await provider.create('Key', 'AWS::KMS::Key', KEY_PROPS);

      expect(second.physicalId).toBe('key-002');
      expect(aws.count('DescribeKeyCommand')).toBe(0);
    });
  });

  describe('an AMBIGUOUS CreateKey failure (detection only)', () => {
    it('names the key the lost response created, and neither adopts nor deletes it', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry();

      // Detection only: the orphan survives and is reported, not adopted.
      expect(aws.keys.map((k) => k.KeyId)).toEqual(['key-001', 'key-002']);
      expect(result.physicalId).toBe('key-002');
      expect(aws.calls).not.toContain('ScheduleKeyDeletionCommand');
      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'))!;
      expect(line).toContain('key-001');
      expect(line).toContain('does not adopt or delete');
      // READ first; deletion only after confirming (a candidate may be foreign).
      const read = line.indexOf('aws kms describe-key --key-id key-001');
      const del = line.indexOf('aws kms schedule-key-deletion --key-id key-001');
      expect(read).toBeGreaterThan(-1);
      expect(del).toBeGreaterThan(read);
      expect(line.slice(read, del)).toContain('Only after confirming');
    });

    it('does not report a key created BEFORE the ambiguous attempt, an AWS-managed key, or one this process recorded', async () => {
      aws.seed({ KeyId: 'old-key', CreationDate: new Date(Date.now() - 60_000) });
      aws.seed({ KeyId: 'aws-managed', KeyManager: 'AWS' });
      const earlier = await provider.create('Other', 'AWS::KMS::Key', KEY_PROPS);
      aws.loseNextCreateResponse = transient500();

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'));
      expect(line).toContain('key-002');
      expect(line).not.toContain('old-key');
      expect(line).not.toContain('aws-managed');
      expect(line).not.toContain(earlier.physicalId);
    });

    it.each([
      ['key spec', { KeySpec: 'RSA_2048' }],
      ['key usage', { KeyUsage: 'GENERATE_VERIFY_MAC' }],
      ['origin', { Origin: 'EXTERNAL' }],
      ['multi-Region flag', { MultiRegion: true }],
      ['description', { Description: 'someone else' }],
      ['state', { KeyState: 'PendingDeletion' }],
    ])('does not report a key whose %s differs from the requested one', async (_what, diff) => {
      aws.seed({ KeyId: 'different-key', ...diff });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'));
      expect(line).toContain('key-001');
      expect(line).not.toContain('different-key');
    });

    it('still finds the orphan after a backoff far past the skew margin', async () => {
      aws.loseNextCreateResponse = transient500();

      await withRetry(() => provider.create('Key', 'AWS::KMS::Key', KEY_PROPS), 'Key', {
        sleep: longSleep,
      });

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'));
      expect(line).toContain('key-001');
    });

    it('finds an orphan whose CreationDate the service stamped slightly BEHIND our clock', async () => {
      aws.skewMs = -2_000;
      aws.loseNextCreateResponse = transient500();

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'));
      expect(line).toContain('key-001');
    });

    it('does not report a matching key created AFTER the ambiguous attempt ended', async () => {
      aws.loseNextCreateResponse = transient500();
      await expect(provider.create('Key', 'AWS::KMS::Key', KEY_PROPS)).rejects.toThrow();
      vi.setSystemTime(Date.now() + 60_000);
      aws.seed({ KeyId: 'later-key' });

      await provider.create('Key', 'AWS::KMS::Key', KEY_PROPS);

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'));
      expect(line).toContain('key-001');
      expect(line).not.toContain('later-key');
    });

    it('an ambiguous failure older than the latch TTL triggers no lookup', async () => {
      aws.loseNextCreateResponse = transient500();
      await expect(provider.create('Key', 'AWS::KMS::Key', KEY_PROPS)).rejects.toThrow();
      vi.setSystemTime(Date.now() + 31 * 60_000);

      await provider.create('Key', 'AWS::KMS::Key', KEY_PROPS);

      expect(aws.count('ListKeysCommand')).toBe(0);
    });

    it('does not report a key another create in this process holds for its retry', async () => {
      aws.failNext.set('EnableKeyRotationCommand', [propagationDenied()]);
      await expect(provider.create('Held', 'AWS::KMS::Key', KEY_PROPS)).rejects.toThrow();
      aws.loseNextCreateResponse = transient500();

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'));
      expect(line).toContain('key-002');
      expect(line).not.toContain('key-001');
    });

    it('follows ListKeys pagination to an orphan on a later page', async () => {
      aws.pageSize = 1;
      aws.seed({ KeyId: 'old-1', CreationDate: new Date(Date.now() - 60_000) });
      aws.seed({ KeyId: 'old-2', CreationDate: new Date(Date.now() - 60_000) });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'));
      expect(line).toContain('key-001');
    });

    it('says the search was incomplete when a candidate cannot be described, or the list is cut short', async () => {
      aws.pageSize = 1;
      for (let i = 0; i < 25; i++) {
        aws.seed({ KeyId: `old-${i}`, CreationDate: new Date(Date.now() - 60_000) });
      }
      aws.loseNextCreateResponse = transient500();

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('search was incomplete'));
      expect(line).toContain('cut at 20 pages');
    });

    it('describes the NEWEST keys first when the describe cap cuts the list', async () => {
      for (let i = 0; i < 250; i++) {
        aws.seed({ KeyId: `old-${i}`, CreationDate: new Date(Date.now() - 60_000) });
      }
      aws.loseNextCreateResponse = transient500();

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'));
      // The orphan is the LAST key listed, past the 200-key cap from the front.
      expect(line).toContain('key-001');
      expect(line).toContain('search was incomplete');
    });

    it('warns (not debug) when an unreadable key leaves an empty search incomplete', async () => {
      aws.seed({ KeyId: 'unreadable', CreationDate: new Date(Date.now() - 60_000) });
      aws.failNext.set('CreateKeyCommand', [transient500()]);
      aws.failNext.set('DescribeKeyCommand', [propagationDenied()]);

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('search was incomplete'));
      expect(line).toContain('1 could not be read');
    });

    it('two ambiguous attempts in a row: the lookup after the second still names the FIRST orphan', async () => {
      aws.loseNextCreateResponse = transient500();
      let lists = 0;
      mockSend.mockImplementation(async (command: Parameters<typeof aws.send>[0]) => {
        if (command.constructor.name === 'ListKeysCommand' && lists++ === 0) {
          aws.loseNextCreateResponse = transient500();
        }
        return aws.send(command);
      });

      // 30 s apart, so attempt 2's own window (5 s margin) cannot reach key 1.
      const result = await withRetry(
        () => provider.create('Key', 'AWS::KMS::Key', KEY_PROPS),
        'Key',
        { sleep: longSleep }
      );

      expect(result.physicalId).toBe('key-003');
      const lines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('earlier CreateKey attempt'));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('key-001');
      expect(lines[1]).toContain('key-002');
    });

    it('names at most five candidates, then an ellipsis', async () => {
      for (let i = 0; i < 6; i++) aws.seed({ KeyId: `twin-${i}` });
      aws.failNext.set('CreateKeyCommand', [transient500()]);

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('earlier CreateKey attempt'))!;
      expect(line).toContain('6 customer managed key(s)');
      expect(line).toContain(', ...');
    });

    it('omits the zero-count clauses of an incomplete search', async () => {
      aws.seed({ KeyId: 'unreadable', CreationDate: new Date(Date.now() - 60_000) });
      aws.failNext.set('CreateKeyCommand', [transient500()]);
      aws.failNext.set('DescribeKeyCommand', [propagationDenied()]);

      await createWithRetry();

      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('search was incomplete'))!;
      expect(line).toContain('The search was incomplete: 1 could not be read.');
    });

    it('a THROTTLED CreateKey triggers no lookup', async () => {
      aws.failNext.set('CreateKeyCommand', [throttled()]);

      await createWithRetry();

      expect(aws.count('ListKeysCommand')).toBe(0);
      expect(aws.keys).toHaveLength(1);
    });

    it('a DEFINITE CreateKey failure (a 4xx) triggers no lookup', async () => {
      aws.failNext.set('CreateKeyCommand', [propagationDenied()]);

      await createWithRetry();

      expect(aws.count('ListKeysCommand')).toBe(0);
      expect(aws.keys).toHaveLength(1);
    });

    it('a failed ListKeys warns and lets the create proceed', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set('ListKeysCommand', [propagationDenied()]);

      const result = await createWithRetry();

      expect(result.physicalId).toBe('key-002');
      const line = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('could not list keys'));
      expect(line).toBeDefined();
    });
  });

  describe('the SDK-internal retry (#3978 layer (b))', () => {
    it('sends CreateKey through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
      await createWithRetry({ ...KEY_PROPS });

      const createConfig = sentVia.find(([name]) => name === 'CreateKeyCommand')![1];
      const strategy = (await createConfig.retryStrategy()) as typeof baseStrategy;
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
      ).rejects.toThrow();
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
      ).resolves.toBe('retry-token');
      // The follow-up calls keep the full SDK retry.
      const rotationConfig = sentVia.find(([name]) => name === 'EnableKeyRotationCommand')![1];
      expect(await rotationConfig.retryStrategy()).toBe(baseStrategy);
    });
  });
});
